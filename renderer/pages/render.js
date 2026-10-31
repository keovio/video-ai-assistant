"use strict";
// 合成导出页：左边是即梦内嵌浏览器（进页面自动打开，登录一次后保持），
// 右边是操作面板：合成（开始/进度/烧字幕开关）→ 最近成片（打开/文件夹/重跑/提示）→ 每镜素材（配音与画面状态、
// 即梦生成 / 导入 / 清除片段）。即梦自动操作失败时视图保持在左边，可手动生成下载后用“导入”导进来。
(function () {
  const { h } = window.Shell;
  const api = window.app;
  const fmt = (s) => (Math.round(Number(s || 0) * 10) / 10) + " 秒";
  const STATUS = { queued: ["排队中", ""], running: ["合成中", "warn"], done: ["已完成", "ok"], failed: ["失败", "err"] };
  let pollTimer = null;
  let currentId = null;
  let browser = null;

  async function unwrap(r) {
    if (!r || !r.ok) throw new Error((r && r.error) || "操作失败");
    return r;
  }

  window.Shell.registerPage({
    id: "render",
    title: "合成导出",
    icon: "film",
    order: 25,
    render(root) {
      root.classList.add("page-wide");
      browser = window.EmbedBrowser.create({
        kind: "jimeng", pageId: "render", title: "生成网站", api: api.video.jimeng,
        emptyText: "可以用即梦、可灵、海螺、Vidu 等任意网站生成视频；在这里下载的视频会自动收进右边“浏览器下载”。",
      });
      // 浏览器里下载完成时刷新右栏（只在本页可见时）
      api.video.downloads.onChanged(() => { if (root.isConnected && currentId && !root.hidden) load(root).catch(() => {}); });
      root._bar = window.ProjectPicker.bar({
        onSwitch: (id) => { currentId = id; return load(root); },
        actions: [h("button", { class: "btn", onclick: () => window.Shell.navigate("editor") }, "← 分镜编辑")],
      });
      root._side = h("div", { class: "workbench-side", id: "render-body" });
      root.append(root._bar.el, h("div", { class: "workbench" }, browser.el, root._side));
    },
    async onShow(root) {
      currentId = window.VideoApp.currentProjectId();
      if (browser) browser.show();
      await root._bar.refresh();
      load(root).catch((e) => window.Shell.toast(e.message, "error"));
    },
    async onHide() {
      stopPoll();
      if (browser) browser.hide();
    },
  });

  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function load(root) {
    stopPoll();
    const side = root._side;
    const showEmpty = () => {
      root._bar.setMeta("");
      side.replaceChildren(h("section", { class: "side-card" }, window.ProjectPicker.emptyState(root._bar.projects, async (id) => {
        window.VideoApp.openProject(id); currentId = id;
        await root._bar.refresh();
        await load(root);
      }, "左边的即梦可以先登录好；合成要先选一个项目。")));
    };
    if (!currentId) { showEmpty(); return; }
    let data;
    try { data = await unwrap(await api.video.projects.get(currentId)); }
    catch (e) {
      window.Shell.toast("打开项目失败：" + e.message, "error");
      window.VideoApp.openProject(null); currentId = null;
      await root._bar.refresh();
      showEmpty();
      return;
    }
    const ff = await api.video.ffmpeg.status().catch(() => ({ ok: false, warning: "检测失败" }));
    const renders = await api.video.renders.list(currentId).catch(() => ({ renders: [] }));
    const list = renders.renders || [];
    const latest = list[0] || null;
    const running = list.some((r) => r.status === "queued" || r.status === "running");
    const shots = data.shots || [];
    const voiced = shots.filter((s) => s.audioAssetId).length;
    const withClip = shots.filter((s) => s.videoAssetId).length;

    root._bar.setMeta(`${shots.length} 镜 · 约 ${fmt(data.project.totalSeconds)} · ${data.project.aspect}`);

    // ---- 合成 ----
    const burnInput = h("input", { type: "checkbox", role: "switch", checked: latest ? latest.burnSubtitles !== false : true });
    const startBtn = h("button", { class: "btn primary block lg", disabled: running || !ff.ok, onclick: async () => {
      startBtn.disabled = true;
      try {
        const r = await api.video.renders.start(currentId, { burnSubtitles: burnInput.checked });
        if (!r.ok) window.Shell.toast(r.error || "开始合成失败", "error");
        await load(root);
      } catch (e) { window.Shell.toast(e.message, "error"); startBtn.disabled = false; }
    } }, running ? "合成中…" : "开始合成");
    // ---- 背景音乐（0.6.6）：循环铺满全片、结尾淡出；音量 0 = 自动（有配音 18%，无配音 80%） ----
    const voice = data.project.voice || {};
    const hasBgm = !!voice.bgm;
    const bgmInput = h("input", { type: "file", accept: ".mp3,.wav,.m4a,.ogg,.flac,.aac,.opus,audio/*", hidden: true,
      onchange: async () => {
        const f = bgmInput.files && bgmInput.files[0]; if (!f) return;
        try {
          const r = await api.video.projects.setBgm(currentId, { name: f.name, data: await f.arrayBuffer() });
          if (!r.ok) window.Shell.toast(r.error || "设置背景音乐失败", "error");
          else window.Shell.toast("背景音乐已设置：" + f.name, "success");
        } catch (e) { window.Shell.toast(e.message, "error"); }
        bgmInput.value = "";
        await load(root);
      } });
    const volPct = Math.round((Number(voice.bgmVolume) || 0) * 100);
    const volLabel = h("span", { class: "muted small-text" });
    const drawVol = (v) => { volLabel.textContent = v > 0 ? v + "%" : (voiced ? "自动（18%）" : "自动（80%）"); };
    const volInput = h("input", { type: "range", min: 0, max: 100, step: 5, value: String(volPct), disabled: !hasBgm });
    drawVol(volPct);
    volInput.addEventListener("input", () => drawVol(Number(volInput.value)));
    volInput.addEventListener("change", async () => {
      const r = await api.video.projects.update(currentId, { voice: { ...voice, bgmVolume: Number(volInput.value) / 100 } });
      if (!r || !r.ok) window.Shell.toast((r && r.error) || "保存音量失败", "error");
      else voice.bgmVolume = Number(volInput.value) / 100;
    });
    const bgmBlock = h("div", { class: "bgm-block" },
      h("div", { class: "bgm-line" },
        h("b", {}, "背景音乐"),
        h("span", { class: "muted small-text grow", title: voice.bgmName || voice.bgm || "" }, hasBgm ? (voice.bgmName || voice.bgm.split("/").pop()) : "未设置"),
        h("button", { class: "btn small", onclick: () => bgmInput.click() }, hasBgm ? "更换" : "选择音乐"),
        hasBgm ? h("button", { class: "btn small danger-ghost", onclick: async () => {
          const r = await api.video.projects.clearBgm(currentId);
          if (!r.ok) window.Shell.toast(r.error || "移除失败", "error");
          await load(root);
        } }, "移除") : "",
        bgmInput),
      hasBgm ? h("div", { class: "bgm-volume" }, h("span", { class: "small-text" }, "音量"), volInput, volLabel) : "");
    const progressBar = h("div", {});
    const progressText = h("p", { class: "muted small-text" });
    const progress = h("div", { hidden: !running }, h("div", { class: "render-progress" }, progressBar), progressText);
    const drawProgress = (r) => {
      if (!r) return;
      progressBar.style.width = Math.max(2, Math.min(100, Number(r.pct) || 0)) + "%";
      progressText.textContent = `${r.message || "处理中"} · ${Number(r.pct) || 0}%`;
    };
    if (running) drawProgress(list.find((r) => r.status === "queued" || r.status === "running"));

    const readiness = h("div", { class: "stat-line" },
      h("span", { class: "chip " + (voiced === shots.length && shots.length ? "ok" : "warn") }, `配音 ${voiced}/${shots.length}`),
      h("span", { class: "chip " + (withClip === shots.length && shots.length ? "ok" : "") }, `画面 ${withClip}/${shots.length}`),
      h("span", { class: "chip " + (ff.ok ? "ok" : "err") }, ff.ok ? "ffmpeg 可用" : "缺少 ffmpeg"));
    const renderCard = h("section", { class: "side-card compose-card" },
      h("h3", {}, "合成"),
      readiness,
      ff.ok ? "" : h("div", { class: "hint-bar warn" }, h("span", { class: "grow" }, ff.warning || "合成前请先安装 ffmpeg"),
        h("button", { class: "btn small", onclick: () => (window.Shell.openSettings ? window.Shell.openSettings("video-system") : window.Shell.navigate("settings")) }, "查看")),
      h("label", { class: "switch-line" }, h("span", {}, "烧入字幕"), h("span", { class: "switch" }, burnInput, h("span", { class: "slider" }))),
      bgmBlock,
      startBtn,
      progress,
      h("p", { class: "muted small-text" }, "没有画面的镜头用黑场，没有配音的用静音；纯画面镜头可在分镜编辑里设时长。背景音乐自动循环到片尾并淡出。烧字幕失败时只输出 SRT。"));

    // ---- 最近成片 ----
    let latestCard = null;
    if (latest) {
      const [label, cls] = STATUS[latest.status] || [latest.status, ""];
      const hasOut = !!latest.outputPath && latest.status === "done";
      latestCard = h("section", { class: "side-card" },
        h("h3", {}, h("span", { class: "grow" }, "最近成片"), h("span", { class: "chip " + cls }, label)),
        latest.status === "failed" ? h("p", { class: "error small-text" }, latest.error || latest.message || "合成失败") : "",
        hasOut ? h("p", { class: "muted small-text" }, latest.outputPath.split("/").pop() + (latest.srtPath ? " · 附 SRT 字幕" : "")) : "",
        ...(latest.warnings || []).slice(0, 4).map((w) => h("p", { class: "muted small-text" }, "· " + w)),
        h("div", { class: "actions" },
          hasOut ? h("button", { class: "btn primary", onclick: async () => {
            const r = await api.video.renders.openOutput(latest.id);
            if (!r.ok) window.Shell.toast(r.error || "打开失败", "error");
          } }, "播放成片") : "",
          hasOut ? h("button", { class: "btn", onclick: async () => {
            const r = await api.video.renders.openFolder(latest.id);
            if (!r.ok) window.Shell.toast(r.error || "打开失败", "error");
          } }, "打开文件夹") : "",
          latest.status === "failed" ? h("button", { class: "btn", disabled: running, onclick: async () => {
            const r = await api.video.renders.retry(latest.id);
            if (!r.ok) window.Shell.toast(r.error || "重跑失败", "error");
            else await load(root);
          } }, "重跑") : ""));
    }

    // ---- 每镜素材 ----
    const clipList = h("div", { class: "clip-list" });
    shots.forEach((s, i) => {
      const audioChip = s.audioAssetId ? h("span", { class: "chip ok" }, "配音 " + fmt(s.audioSeconds)) : h("span", { class: "chip warn" }, "无配音");
      const videoChip = s.videoAssetId
        ? h("span", { class: "chip ok" }, "片段" + (s.clipSeconds ? " " + fmt(s.clipSeconds) : ""))
        : s.error ? h("span", { class: "chip err", title: s.error }, "生成失败") : h("span", { class: "chip" }, "黑场");
      const genBtn = h("button", { class: "btn small", title: "用这镜的生视频提示词在左边即梦里生成并自动下载", onclick: async () => {
        genBtn.disabled = true; genBtn.textContent = "生成中…";
        try {
          const r = await api.video.shots.generateClip(s.id);
          if (!r.ok) window.Shell.toast(r.manual ? "转手动：" + r.error : (r.error || "生成片段失败"), "error");
          else window.Shell.toast(`第 ${i + 1} 镜片段已挂上`, "success");
          await load(root);
        } catch (e) { window.Shell.toast(e.message, "error"); }
        finally { genBtn.disabled = false; genBtn.textContent = "即梦生成"; }
      } }, "即梦生成");
      const importInput = h("input", { type: "file", accept: ".mp4,.mov,.webm,.mkv,.m4v,video/*", hidden: true,
        onchange: async () => {
          const f = importInput.files && importInput.files[0]; if (!f) return;
          try {
            const d = await f.arrayBuffer();
            const r = await api.video.shots.importVideo(s.id, { name: f.name, data: d });
            if (!r.ok) window.Shell.toast(r.error || "导入片段失败", "error");
            else window.Shell.toast(`第 ${i + 1} 镜片段已导入`, "success");
            await load(root);
          } catch (e) { window.Shell.toast(e.message, "error"); }
          importInput.value = "";
        } });
      const importBtn = h("button", { class: "btn small", onclick: () => importInput.click() }, "导入");
      const clearBtn = s.videoAssetId ? h("button", { class: "btn small ghost", onclick: async () => {
        const r = await api.video.shots.clearVideo(s.id);
        if (r.ok) await load(root);
        else window.Shell.toast(r.error || "清除失败", "error");
      } }, "清除") : "";
      clipList.append(h("div", { class: "clip-row compact" },
        h("div", { class: "clip-row-head" },
          h("b", {}, `#${i + 1}`),
          h("span", { class: "clip-row-text grow", title: s.narration || "" }, s.narration || "（没有口播）"),
          audioChip, videoChip),
        h("div", { class: "clip-row-foot" },
          h("span", { class: "muted small-text grow" }, `${fmt(s.start)} – ${fmt(s.end)}`),
          genBtn, importBtn, clearBtn, importInput)));
    });
    const shotsCard = h("section", { class: "side-card" },
      h("h3", {}, h("span", { class: "grow" }, "每镜画面"), h("span", { class: "muted small-text" }, `${withClip}/${shots.length} 有片段`)),
      h("p", { class: "muted small-text" }, "“即梦生成”会在左边即梦里自动生成并下载；用其他网站（可灵、海螺、Vidu…）就在左边生成后点下载，视频会出现在“浏览器下载”里。也可以“导入”本机文件。"),
      shots.length ? clipList : h("p", { class: "muted small-text" }, "这个项目还没有镜头。"));

    // ---- 浏览器下载（0.6.9）：左边任意生成网站里下载的视频，挂到某一镜 ----
    const dl = await api.video.downloads.list().catch(() => ({ files: [] }));
    const files = (dl && dl.files) || [];
    let downloadsCard = null;
    if (files.length && shots.length) {
      const firstEmpty = Math.max(0, shots.findIndex((s) => !s.videoAssetId));
      const dlList = h("div", { class: "clip-list" });
      files.forEach((f) => {
        const target = h("select", { class: "input small-select" }, ...shots.map((s, i) => h("option", { value: s.id }, `第 ${i + 1} 镜${s.videoAssetId ? "（替换）" : ""}`)));
        target.value = shots[firstEmpty] ? shots[firstEmpty].id : shots[0].id;
        const attachBtn = h("button", { class: "btn small primary", onclick: async () => {
          attachBtn.disabled = true;
          const r = await api.video.downloads.attach(f.name, target.value).catch((e) => ({ ok: false, error: e.message }));
          if (!r.ok) { window.Shell.toast(r.error || "挂上失败", "error"); attachBtn.disabled = false; return; }
          window.Shell.toast("片段已挂上" + (r.seconds ? `（${fmt(r.seconds)}）` : ""), "success");
          await load(root);
        } }, "挂上");
        const delBtn = h("button", { class: "btn small ghost", title: "删除这个下载", onclick: async () => {
          await api.video.downloads.remove(f.name).catch(() => {});
          await load(root);
        } }, "删除");
        dlList.append(h("div", { class: "clip-row compact" },
          h("div", { class: "clip-row-head" },
            h("span", { class: "clip-row-text grow", title: f.label }, f.label),
            h("span", { class: "muted small-text" }, (f.bytes / 1048576).toFixed(1) + " MB")),
          h("div", { class: "clip-row-foot" }, h("span", { class: "grow" }), target, attachBtn, delBtn)));
      });
      downloadsCard = h("section", { class: "side-card" },
        h("h3", {}, h("span", { class: "grow" }, "浏览器下载"), h("button", { class: "btn small ghost", onclick: () => api.video.downloads.openFolder() }, "打开文件夹")),
        h("p", { class: "muted small-text" }, "在左边网站里下载的视频会出现在这里，选好镜头点“挂上”。"),
        dlList);
    }

    // 顺序按做事的先后：先给每镜配画面，再合成，最后看成片
    side.replaceChildren(...(downloadsCard ? [downloadsCard] : []), shotsCard, renderCard, ...(latestCard ? [latestCard] : []));
    browser.refresh();

    if (running) {
      pollTimer = setInterval(async () => {
        const r = await api.video.renders.list(currentId).catch(() => ({ renders: [] }));
        const cur = (r.renders || []).find((x) => x.status === "queued" || x.status === "running");
        if (cur) drawProgress(cur);
        else {
          stopPoll();
          const done = (r.renders || [])[0];
          if (done && done.status === "done") window.Shell.toast("成片已合成", "success");
          else if (done && done.status === "failed") window.Shell.toast("合成失败：" + (done.error || done.message || ""), "error");
          await load(root);
        }
      }, 1500);
    }
  }
})();
