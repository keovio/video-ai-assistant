"use strict";
// 分镜编辑器（M1 存储与编辑；M2 增加配音：生成、导入、试听、清除；M3 增加画面状态，片段生成与合成在“合成导出”页；M4 改左右结构）。
// 左栏：紧凑的镜头列表（可滚动，点一行选中）；右栏：选中镜头的详情表单 + 项目保存栏。
// 镜头顺序、增删、配音操作的语义与之前一致：未保存的新镜头要先点“保存”才能操作配音。
(function () {
  const { h, card, modules } = window.Shell;
  const api = window.app;

  let currentId = null;
  let draft = null; // { project: {...}, shots: [...] }，shots 里 _new 表示未保存的新镜头
  let deletedIds = [];
  let newSeq = 0;
  let currentAudio = null;
  let currentListenBtn = null;

  const estimate = (text) => {
    const n = [...String(text || "")].filter((c) => !/\s/.test(c)).length;
    return n ? Math.ceil((n / 4.5) * 10) / 10 : 0;
  };
  const fmt = (s) => (Math.round(Number(s || 0) * 10) / 10) + " 秒";
  const fmtRange = (start, end) => `${fmt(start)} – ${fmt(end)}`;
  // 某镜的计时用时长：已挂配音且有秒数时用该秒数（实测或估算见 audioMeasured），否则字数估算
  const shotSeconds = (s) => (s.audioAssetId && Number(s.audioSeconds) > 0
    ? Math.round(Number(s.audioSeconds) * 10) / 10 : estimate(s.narration));
  const audioText = (s) => {
    if (!s.audioAssetId) return s.error ? `配音：失败（${s.error}）` : "配音：暂无，请生成或导入音频";
    const src = s.audioSource === "import" ? "导入" : "TTS 生成";
    const how = s.audioMeasured ? "实测" : "估算（未检测到 ffprobe）";
    return `配音：${src} · ${how} ${fmt(s.audioSeconds)}`;
  };
  const videoText = (s) => (s.videoAssetId
    ? `画面：片段已挂（${s.clipSeconds ? fmt(s.clipSeconds) : "时长未知"}），合成时按配音时长对齐（短了循环、长了截断）`
    : "画面：暂无片段，合成时该镜用黑场兜底，配音保留；去“合成导出”页生成或导入片段");
  const stopListen = () => {
    if (currentAudio) { try { currentAudio.pause(); } catch { /* ignore */ } currentAudio = null; }
    if (currentListenBtn) { currentListenBtn.textContent = "试听"; currentListenBtn = null; }
  };

  async function unwrap(r) {
    if (!r || !r.ok) throw new Error((r && r.error) || "操作失败");
    return r;
  }

  function timings(shots) {
    let t = 0;
    return shots.map((s) => {
      const d = shotSeconds(s);
      const start = Math.round(t * 10) / 10;
      t = Math.round((t + d) * 10) / 10;
      return { start, end: t, seconds: d };
    });
  }

  window.VideoApp = {
    openProject(id) { currentId = id; draft = null; deletedIds = []; },
    currentProjectId() { return currentId; },
  };

  window.Shell.registerPage({
    id: "editor",
    title: "分镜编辑",
    icon: "note",
    order: 20,
    async onShow(root) {
      if (!currentId) { renderEmpty(root); return; }
      if (!draft || draft.project.id !== currentId) await load(root, currentId);
    },
    render(root) {
      root.classList.add("page-wide");
      root._body = h("div", { id: "editor-body" });
      root.append(root._body);
      if (!currentId) renderEmpty(root);
      else load(root, currentId).catch((e) => window.Shell.toast(e.message, "error"));
    },
  });

  function renderEmpty(root) {
    const body = root._body || root;
    body.textContent = "";
    body.append(h("header", { class: "page-head" },
      h("div", {}, h("h1", {}, "分镜编辑"), h("p", { class: "sub" }, "先在“项目”页打开一个项目，再回来编辑它的脚本和分镜。"))),
      h("button", { class: "btn primary", onclick: () => window.Shell.navigate("projects") }, "去项目列表"));
  }

  async function load(root, id) {
    stopListen();
    const r = await unwrap(await api.video.projects.get(id));
    draft = { project: { ...r.project }, shots: r.shots.map((s) => ({ ...s })) };
    deletedIds = [];
    renderForm(root);
  }

  function renderForm(root) {
    const body = root._body;
    body.textContent = "";
    const p = draft.project;
    let selectedIdx = 0;

    const titleInput = h("input", { class: "input grow", value: p.title });
    const tagsInput = h("input", { class: "input grow", value: (p.tags || []).join("、"), placeholder: "标签，用、或逗号分隔" });
    const aspectSelect = h("select", { class: "input" },
      ...[["9:16", "9:16 竖屏"], ["16:9", "16:9 横屏"], ["1:1", "1:1 方形"]].map(([v, l]) => h("option", { value: v }, l)));
    aspectSelect.value = p.aspect || "9:16";
    const totalEl = h("span", { class: "muted" });
    const listBox = h("div", { id: "shot-list", class: "shot-list" });
    const detailBox = h("div", { id: "shot-detail" });

    const updateTotals = () => {
      const ts = timings(draft.shots);
      totalEl.textContent = `共 ${draft.shots.length} 个镜头 · 总时长 ${fmt(ts.length ? ts[ts.length - 1].end : 0)}（有配音的镜头按配音时长，无配音的按约 4.5 字/秒估算）`;
      return ts;
    };

    const redrawList = () => {
      const ts = updateTotals();
      listBox.textContent = "";
      draft.shots.forEach((s, i) => {
        const t = ts[i];
        const preview = (s.narration || "").trim().slice(0, 40) || "（空口播）";
        const status = s.error ? "失败" : s.audioAssetId ? "有配音" : "待配音";
        const row = h("div", {
          class: "shot-row" + (i === selectedIdx ? " selected" : ""),
          onclick: () => { selectedIdx = i; redrawList(); renderDetail(); },
        },
          h("div", { class: "shot-row-head" },
            h("b", {}, `第 ${i + 1} 镜`),
            h("span", { class: "card-tag" }, fmtRange(t.start, t.end)),
            h("span", { class: "muted small" }, status)),
          h("div", { class: "muted shot-row-preview" }, preview));
        listBox.append(row);
      });
      if (!draft.shots.length) listBox.append(h("p", { class: "muted" }, "还没有镜头，点下面“添加镜头”。"));
    };

    const renderDetail = () => {
      detailBox.textContent = "";
      const s = draft.shots[selectedIdx];
      if (!s) {
        detailBox.append(h("p", { class: "muted" }, "左侧选一个镜头，这里显示它的详情。"));
        return;
      }
      const i = selectedIdx;
      const ts = timings(draft.shots);
      const t = ts[i];
      const narration = h("textarea", { class: "input field-full", rows: 4, placeholder: "这镜的口播文案" }, s.narration || "");
      narration.addEventListener("input", () => { s.narration = narration.value; updateTotals(); redrawListLight(); });
      const visual = h("textarea", { class: "input field-full", rows: 3, placeholder: "画面描述：主体、场景、构图、光线" }, s.visual || "");
      visual.addEventListener("input", () => { s.visual = visual.value; });
      const imagePrompt = h("textarea", { class: "input field-full", rows: 3, placeholder: "生图提示词（M3 用，可空，默认用画面描述）" }, s.imagePrompt || "");
      imagePrompt.addEventListener("input", () => { s.imagePrompt = imagePrompt.value; });

      const listenBtn = h("button", { class: "btn small", disabled: !s.audioAssetId, onclick: () => listenShot(s, listenBtn) }, "试听");
      const genBtn = h("button", { class: "btn small", onclick: () => generateShot(s, genBtn) }, "生成配音");
      const importInput = h("input", { type: "file", accept: ".mp3,.wav,.m4a,.ogg,.flac,.aac,.opus,audio/*", hidden: true,
        onchange: async () => { const f = importInput.files && importInput.files[0]; if (!f) return; await importShot(s, f); importInput.value = ""; } });
      const importBtn = h("button", { class: "btn small", onclick: () => importInput.click() }, "导入音频");
      const clearBtn = h("button", { class: "btn small danger-ghost", disabled: !s.audioAssetId,
        onclick: async () => {
          if (!needSaved(s)) return;
          const r = await api.video.shots.clearAudio(s.id);
          if (r.ok) { window.Shell.toast("已清除该镜头配音"); await load(root, currentId); }
          else window.Shell.toast(r.error || "清除失败", "error");
        } }, "清除配音");

      detailBox.append(
        h("section", { class: "card module shot-detail" },
          h("header", { class: "card-head" },
            h("h2", {}, `第 ${i + 1} 镜`),
            h("span", { class: "card-tag" }, fmtRange(t.start, t.end)),
            h("span", { class: "spacer" }),
            h("button", { class: "btn small", disabled: i === 0, onclick: () => move(i, -1) }, "上移"),
            h("button", { class: "btn small", disabled: i === draft.shots.length - 1, onclick: () => move(i, 1) }, "下移"),
            h("button", { class: "btn small danger-ghost", onclick: () => removeShot(i) }, "删除")),
          h("p", { class: "card-desc" }, "口播（" + fmt(t.seconds) + "）"),
          narration,
          h("p", { class: "card-desc" }, "画面描述"),
          visual,
          h("p", { class: "card-desc" }, "生图提示词"),
          imagePrompt,
          h("p", { class: "card-desc" }, "配音"),
          h("p", { class: "muted" }, "", audioText(s)),
          h("div", { class: "actions" }, genBtn, importBtn, listenBtn, clearBtn, importInput),
          h("p", { class: "card-desc" }, "画面"),
          h("p", { class: "muted" }, "", videoText(s))));
    };

    // 只更新列表里的时间标签和预览，不重建输入框，避免打字时丢焦点
    const redrawListLight = () => {
      const ts = timings(draft.shots);
      [...listBox.querySelectorAll(".shot-row")].forEach((rowEl, idx) => {
        const tag = rowEl.querySelector(".card-tag");
        if (tag && ts[idx]) tag.textContent = fmtRange(ts[idx].start, ts[idx].end);
        const prev = rowEl.querySelector(".shot-row-preview");
        const s = draft.shots[idx];
        if (prev && s) prev.textContent = (s.narration || "").trim().slice(0, 40) || "（空口播）";
      });
    };

    const move = (i, d) => {
      const j = i + d;
      if (j < 0 || j >= draft.shots.length) return;
      const [s] = draft.shots.splice(i, 1);
      draft.shots.splice(j, 0, s);
      selectedIdx = j;
      redrawList();
      renderDetail();
    };
    const removeShot = (i) => {
      const [s] = draft.shots.splice(i, 1);
      if (s && !s._new && s.id) deletedIds.push(s.id);
      selectedIdx = Math.max(0, Math.min(selectedIdx, draft.shots.length - 1));
      redrawList();
      renderDetail();
    };
    // ---- M2 配音操作：都需要已保存的镜头（未保存的新镜头没有服务端 id） ----
    const needSaved = (s) => {
      if (s._new || !s.id) { window.Shell.toast("请先点“保存”，再操作配音", "error"); return false; }
      return true;
    };
    const generateShot = async (s, btn) => {
      if (!needSaved(s)) return;
      if (!String(s.narration || "").trim()) { window.Shell.toast("这镜没有口播文案，无法生成配音", "error"); return; }
      const old = btn.textContent; btn.disabled = true; btn.textContent = "生成中…";
      try {
        const r = await api.video.shots.generateAudio(s.id);
        if (!r.ok) window.Shell.toast(r.error || "生成配音失败", "error");
        else if (r.warning) window.Shell.toast("配音已生成，但时长是估算值：" + r.warning, "error");
        else window.Shell.toast("配音已生成（实测 " + fmt(r.seconds) + "）", "success");
        await load(root, currentId);
      } catch (e) { window.Shell.toast(e.message, "error"); }
      finally { btn.disabled = false; btn.textContent = old; }
    };
    const importShot = async (s, file) => {
      if (!needSaved(s)) return;
      try {
        const data = await file.arrayBuffer();
        const r = await api.video.shots.importAudio(s.id, { name: file.name, data });
        if (!r.ok) window.Shell.toast(r.error || "导入音频失败", "error");
        else if (r.warning) window.Shell.toast("音频已导入，但时长是估算值：" + r.warning, "error");
        else window.Shell.toast("音频已导入（实测 " + fmt(r.seconds) + (r.deduped ? "，与已有音频内容相同，已复用" : "") + "）", "success");
        await load(root, currentId);
      } catch (e) { window.Shell.toast(e.message, "error"); }
    };
    const listenShot = async (s, btn) => {
      if (currentListenBtn === btn) { stopListen(); return; }
      stopListen();
      const r = await api.video.shots.audioData(s.id);
      if (!r.ok) { window.Shell.toast(r.error || "试听失败", "error"); return; }
      const audio = new Audio(r.dataUrl);
      currentAudio = audio; currentListenBtn = btn; btn.textContent = "停止";
      audio.onended = () => stopListen();
      audio.onerror = () => { stopListen(); window.Shell.toast("音频播放失败", "error"); };
      try { await audio.play(); }
      catch (e) { stopListen(); window.Shell.toast("音频播放失败：" + e.message, "error"); }
    };
    const generateAll = async (btn) => {
      if (draft.shots.some((s) => s._new)) { window.Shell.toast("有未保存的新镜头，请先点“保存”", "error"); return; }
      const ids = draft.shots.filter((s) => String(s.narration || "").trim()).map((s) => s.id);
      if (!ids.length) { window.Shell.toast("没有可生成配音的口播文案", "error"); return; }
      const old = btn.textContent; btn.disabled = true; btn.textContent = "生成中…";
      let done = 0, failed = 0;
      try {
        for (const id of ids) {
          const r = await api.video.shots.generateAudio(id);
          if (r.ok) done++; else failed++;
        }
        window.Shell.toast(failed ? `配音生成完成：成功 ${done} 镜，失败 ${failed} 镜（失败原因写在对应镜头下）` : `配音已生成 ${done} 镜`, failed ? "error" : "success");
        await load(root, currentId);
      } finally { btn.disabled = false; btn.textContent = old; }
    };

    async function save() {
      const btn = body.querySelector("#btn-save");
      if (btn) btn.disabled = true;
      try {
        const tags = tagsInput.value.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean);
        await unwrap(await api.video.projects.update(currentId, { title: titleInput.value, tags, aspect: aspectSelect.value }));
        for (const id of deletedIds) await unwrap(await api.video.shots.remove(id));
        deletedIds = [];
        const finalIds = [];
        for (const s of draft.shots) {
          if (s._new) {
            const r = await unwrap(await api.video.shots.add(currentId, { narration: s.narration, visual: s.visual, imagePrompt: s.imagePrompt }));
            finalIds.push(r.shot.id);
          } else {
            await unwrap(await api.video.shots.update(s.id, { narration: s.narration, visual: s.visual, imagePrompt: s.imagePrompt }));
            finalIds.push(s.id);
          }
        }
        await unwrap(await api.video.shots.reorder(currentId, finalIds));
        await load(root, currentId);
        window.Shell.toast("已保存", "success");
      } catch (e) { window.Shell.toast(e.message, "error"); }
      finally { const b = body.querySelector("#btn-save"); if (b) b.disabled = false; }
    }

    body.append(
      h("header", { class: "page-head" },
        h("div", {}, h("h1", {}, "分镜编辑"),
          h("p", { class: "sub" }, "改完点“保存”，离开页面前没保存的改动会丢。"))),
      modules(card({ title: "项目", icon: "folder" },
        h("div", { class: "actions" }, titleInput, tagsInput, aspectSelect),
        h("p", { class: "muted" }, "", totalEl),
        h("div", { class: "actions" },
          h("button", { class: "btn primary", id: "btn-save", onclick: save }, "保存"),
          h("button", { class: "btn", onclick: async () => { await load(root, currentId); window.Shell.toast("已放弃未保存的改动"); } }, "放弃改动"),
          h("button", { class: "btn", id: "btn-voice-all", onclick: (e) => generateAll(e.currentTarget) }, "生成配音"),
          h("button", { class: "btn", onclick: () => window.Shell.navigate("render") }, "去合成导出"),
          h("button", { class: "btn", onclick: () => window.Shell.navigate("render") }, "即梦片段与合成")))),
      h("div", { class: "split-layout editor-layout" },
        h("div", { class: "split-left" },
          listBox,
          h("div", { class: "actions" },
            h("button", { class: "btn", onclick: () => {
              draft.shots.push({ _new: true, _tmp: "new-" + (++newSeq), narration: "", visual: "", imagePrompt: "", status: "pending" });
              selectedIdx = draft.shots.length - 1;
              redrawList(); renderDetail();
            } }, "＋ 添加镜头"))),
        h("div", { class: "split-right" }, detailBox)));

    redrawList();
    renderDetail();
  }
})();
