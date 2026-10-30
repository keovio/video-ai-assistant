"use strict";
// 合成导出页（M3）：ffmpeg 状态、每镜音画状态、开始合成、失败重跑、
// 打开输出文件夹 / 用系统播放器打开成片。即梦片段生成与导入也在此页，
// 自动操作失败时会把即梦窗口交给用户手动完成，再用“导入片段”导进来。
(function () {
  const { h, card, modules } = window.Shell;
  const api = window.app;
  const fmt = (s) => (Math.round(Number(s || 0) * 10) / 10) + " 秒";
  let pollTimer = null;
  let currentId = null;

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
      root._body = h("div", { id: "render-body" });
      root.append(root._body);
      currentId = window.VideoApp ? window.VideoApp.currentProjectId() : null;
      load(root).catch((e) => window.Shell.toast(e.message, "error"));
    },
    async onShow(root) {
      currentId = window.VideoApp ? window.VideoApp.currentProjectId() : null;
      if (root._body) load(root).catch((e) => window.Shell.toast(e.message, "error"));
    },
  });

  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function load(root) {
    stopPoll();
    const body = root._body || root;
    if (!currentId) {
      body.textContent = "";
      body.append(h("header", { class: "page-head" },
        h("div", {}, h("h1", {}, "合成导出"), h("p", { class: "sub" }, "先在“项目”页打开一个项目，再回来合成。"))),
        h("button", { class: "btn primary", onclick: () => window.Shell.navigate("projects") }, "去项目列表"));
      return;
    }
    let data;
    try { data = await unwrap(await api.video.projects.get(currentId)); }
    catch (e) { body.textContent = ""; body.append(h("p", {}, "加载失败：" + e.message)); return; }
    const ff = await api.video.ffmpeg.status().catch(() => ({ ok: false, warning: "检测失败" }));
    const renders = await api.video.renders.list(currentId).catch(() => ({ renders: [] }));
    const list = renders.renders || [];
    const latest = list[0] || null;
    const running = list.some((r) => r.status === "queued" || r.status === "running");
    const burnInput = h("input", { type: "checkbox", checked: true });
    const shotsBox = h("div", {});
    data.shots.forEach((s, i) => {
      const videoText = s.videoAssetId
        ? `画面：片段已挂（${s.clipSeconds ? fmt(s.clipSeconds) : "时长未知"}）`
        : s.error ? `画面：失败（${s.error}）` : "画面：暂无片段（合成时该镜用黑场兜底，配音保留）";
      const audioText = s.audioAssetId ? `配音：已挂（${fmt(s.audioSeconds)}）` : "配音：暂无";
      const genBtn = h("button", { class: "btn small", onclick: async () => {
        genBtn.disabled = true; genBtn.textContent = "生成中…";
        try {
          const r = await api.video.shots.generateClip(s.id);
          if (!r.ok) window.Shell.toast(r.manual ? "自动操作已转手动：" + r.error : (r.error || "生成片段失败"), "error");
          else window.Shell.toast("片段已生成并挂到该镜头", "success");
          await load(root);
        } catch (e) { window.Shell.toast(e.message, "error"); }
        finally { genBtn.disabled = false; genBtn.textContent = "即梦生成片段"; }
      } }, "即梦生成片段");
      const importInput = h("input", { type: "file", accept: ".mp4,.mov,.webm,.mkv,.m4v,video/*", hidden: true,
        onchange: async () => {
          const f = importInput.files && importInput.files[0]; if (!f) return;
          try {
            const d = await f.arrayBuffer();
            const r = await api.video.shots.importVideo(s.id, { name: f.name, data: d });
            if (!r.ok) window.Shell.toast(r.error || "导入片段失败", "error");
            else window.Shell.toast("片段已导入", "success");
            await load(root);
          } catch (e) { window.Shell.toast(e.message, "error"); }
          importInput.value = "";
        } });
      const importBtn = h("button", { class: "btn small", onclick: () => importInput.click() }, "导入片段");
      const clearBtn = h("button", { class: "btn small danger-ghost", disabled: !s.videoAssetId, onclick: async () => {
        const r = await api.video.shots.clearVideo(s.id);
        if (r.ok) { window.Shell.toast("已清除该镜头片段"); await load(root); }
        else window.Shell.toast(r.error || "清除失败", "error");
      } }, "清除片段");
      shotsBox.append(h("section", { class: "card module shot-row" },
        h("header", { class: "card-head" }, h("h2", {}, `第 ${i + 1} 镜`), h("span", { class: "card-tag" }, `${fmt(s.start)} – ${fmt(s.end)}`)),
        h("p", { class: "muted" }, "", (s.narration || "").slice(0, 120)),
        h("p", { class: "muted" }, "", audioText + "；" + videoText),
        h("div", { class: "actions" }, genBtn, importBtn, clearBtn, importInput)));
    });

    const startBtn = h("button", { class: "btn primary", disabled: running || !ff.ok, onclick: async () => {
      startBtn.disabled = true;
      try {
        const r = await api.video.renders.start(currentId, { burnSubtitles: burnInput.checked });
        if (!r.ok) window.Shell.toast(r.error || "开始合成失败", "error");
        else window.Shell.toast("合成任务已开始，页面会轮询进度", "success");
        await load(root);
      } catch (e) { window.Shell.toast(e.message, "error"); startBtn.disabled = false; }
    } }, running ? "合成进行中…" : "开始合成");
    const retryBtn = h("button", { class: "btn", disabled: !latest || running, onclick: async () => {
      if (!latest) return;
      const r = await api.video.renders.retry(latest.id);
      if (!r.ok) window.Shell.toast(r.error || "重跑失败", "error");
      else { window.Shell.toast("已重新开始合成"); await load(root); }
    } }, "失败重跑");
    const folderBtn = h("button", { class: "btn", disabled: !latest || !latest.outputPath, onclick: async () => {
      const r = await api.video.renders.openFolder(latest.id);
      if (!r.ok) window.Shell.toast(r.error || "打开失败", "error");
    } }, "打开输出文件夹");
    const playBtn = h("button", { class: "btn", disabled: !latest || !latest.outputPath, onclick: async () => {
      const r = await api.video.renders.openOutput(latest.id);
      if (!r.ok) window.Shell.toast(r.error || "打开失败", "error");
    } }, "用系统播放器打开成片");
    const jimengBtn = h("button", { class: "btn", onclick: async () => {
      const r = await api.video.jimeng.open();
      if (!r.ok) window.Shell.toast(r.error || "打开即梦失败", "error");
      else window.Shell.toast("即梦窗口已打开（登录一次后保持登录）", "success");
    } }, "打开即梦");

    body.textContent = "";
    body.append(
      h("header", { class: "page-head" },
        h("div", {}, h("h1", {}, "合成导出"),
          h("p", { class: "sub" }, "合成前请确认每镜都有配音；无画面的镜头会用黑场兜底，配音不会丢。"))),
      modules(card({ title: "项目", icon: "folder" },
        h("p", {}, data.project.title),
        h("p", { class: "muted" }, "", `共 ${data.shots.length} 个镜头 · 总时长 ${fmt(data.project.totalSeconds)} · 比例 ${data.project.aspect}`),
        h("p", { class: "muted" }, "", ff.ok ? "系统 ffmpeg/ffprobe：可用" : "系统 ffmpeg/ffprobe：" + (ff.warning || "不可用，合成前请先安装")),
        h("div", { class: "actions" }, startBtn, retryBtn, folderBtn, playBtn, jimengBtn),
        h("label", { class: "muted" }, "烧入字幕（默认开；烧入失败时自动改为仅输出 SRT，页面会如实提示）", burnInput))),
      latest ? modules(card({ title: "最近一次合成", icon: "film" },
        h("p", {}, `状态：${latest.status} · ${latest.message || ""}`),
        h("p", { class: "muted" }, "", latest.outputPath ? `成片：${latest.outputPath}` : "暂无成片"),
        h("p", { class: "muted" }, "", latest.srtPath ? `字幕：${latest.srtPath}` : ""),
        ...(latest.warnings || []).map((w) => h("p", { class: "muted" }, "", "注意：" + w)),
        h("p", { class: "muted" }, "", `进度：${latest.pct}%`))) : h("p", { class: "muted" }, "暂无合成记录"),
      h("h2", {}, "镜头与片段"),
      shotsBox);

    if (running) {
      stopPoll();
      pollTimer = setInterval(async () => {
        const r = await api.video.renders.list(currentId).catch(() => ({ renders: [] }));
        const still = (r.renders || []).some((x) => x.status === "queued" || x.status === "running");
        if (!still) await load(root);
      }, 2000);
    }
  }
})();
