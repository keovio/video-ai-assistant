"use strict";
// 抖音分析页（M4）：左侧是内嵌抖音视图（持久会话，登录一次后保持），
// 右侧是分析面板：提取当前视频信息 -> AI 分析（风格拆解 + skill + 脚本分镜）
// -> 编辑 -> 保存分析记录 -> 导入到项目。选择器未验证、提取不到时走手动粘贴兜底，
// 没有 AI Key 时分析按钮禁用并提示去设置，绝不编造分析结果。
(function () {
  const { h } = window.Shell;
  const api = window.app;
  // 运行日志里 video 模块显示成中文标签（分析、配音、合成的过程都记在这个模块下）
  try { if (window.Shell && window.Shell.registerLogScopes) window.Shell.registerLogScopes({ video: ["视频", "violet"] }); } catch { /* ignore */ }

  const STYLE_LABELS = {
    visual: "画面风格", camera: "镜头与运镜", pacing: "节奏",
    mood: "情绪氛围", colorLight: "色彩与光线", sound: "声音与音乐", hooks: "文案与钩子",
  };
  const STYLE_KEYS = Object.keys(STYLE_LABELS);

  // 左侧内嵌浏览器（进页面自动打开抖音，登录一次后保持），见 embed-browser.js
  let browser = null;
  const viewOpened = () => !!(browser && browser.isOpen());
  let aiReady = false;
  let currentInfo = null; // 提取到的视频信息（或 null）
  let draft = null; // 当前分析草稿（与存储记录同形），未分析时为 null
  let busy = false;

  function emptyDraft() {
    return {
      sourceUrl: "", videoId: "", author: "", caption: "",
      likeCountText: "", commentCountText: "", shareCountText: "",
      style: Object.fromEntries(STYLE_KEYS.map((k) => [k, ""])),
      skill: { name: "", description: "", body: "" },
      skillText: "", scriptTitle: "", scriptNarration: "",
      shots: [], manualText: "",
    };
  }

  async function unwrap(r) {
    if (!r || !r.ok) throw new Error((r && r.error) || "操作失败");
    return r;
  }

  window.Shell.registerPage({
    id: "douyin",
    title: "视频分析",
    icon: "search",
    order: 26,
    render(root) {
      root.classList.add("page-wide");
      root._body = h("div", { id: "douyin-body" });
      root.append(root._body);
      buildSkeleton(root);
      refreshAiStatus(root).catch(() => {});
      refreshSavedList(root).catch(() => {});
    },
    async onShow(root) {
      if (browser) browser.show();
      refreshAiStatus(root).catch(() => {});
      refreshSavedList(root).catch(() => {});
    },
    async onHide() {
      if (browser) browser.hide();
    },
  });

  function buildSkeleton(root) {
    const body = root._body;
    body.textContent = "";

    browser = window.EmbedBrowser.create({
      kind: "douyin", pageId: "douyin", title: "视频网站", api: api.video.douyin,
      emptyText: "支持抖音、B 站、YouTube（YouTube 需要你的网络能打开），也可以打开其他视频网站。登录一次后会保持。",
    });
    // 右侧面板：当前视频 + 分析结果 + 已保存的分析，全部由 renderPanel 重绘
    const panel = h("div", { id: "douyin-panel", class: "workbench-side" });

    body.append(
      h("header", { class: "page-head compact" },
        h("div", {}, h("h1", {}, "视频分析"),
          h("p", { class: "sub" }, "在左边打开抖音、B 站或 YouTube 的一个视频，然后点右边的“分析当前视频”。B 站和 YouTube 有字幕时会一起读。"))),
      h("div", { class: "workbench" }, browser.el, panel));
    root._panel = panel;
    renderPanel(root);
  }

  async function refreshAiStatus(root) {
    const hint = root.querySelector("#douyin-ai-hint");
    const btns = [...root.querySelectorAll(".douyin-analyze-btn")];
    try {
      const r = await api.video.ai.status();
      aiReady = !!(r && r.set);
      if (hint) {
        hint.className = "hint-bar " + (aiReady ? "ok" : "warn");
        hint.replaceChildren(
          h("span", { class: "grow" }, aiReady
            ? `AI 已就绪（Key …${r.last4 || ""}）${r.insecureFallback ? "，Key 未加密保存" : ""}`
            : "还没配置 AI Key，配好后才能分析"),
          aiReady ? "" : h("button", { class: "btn small", onclick: () => (window.Shell.openSettings ? window.Shell.openSettings("video-ai") : window.Shell.navigate("settings")) }, "去设置"));
      }
    } catch {
      aiReady = false;
      if (hint) { hint.className = "hint-bar warn"; hint.textContent = "AI 设置读取失败，请到设置页检查。"; }
    }
    for (const b of btns) b.disabled = busy;
  }

  let savedSeq = 0;
  async function refreshSavedList(root) {
    const box = root.querySelector("#douyin-saved-list");
    if (!box) return;
    const seq = ++savedSeq; // 并发刷新时只让最后一次落地，避免列表重复
    let r;
    try { r = await unwrap(await api.video.analyses.list()); }
    catch (e) { if (seq === savedSeq) box.replaceChildren(h("p", { class: "error" }, e.message)); return; }
    if (seq !== savedSeq || !box.isConnected) return;
    box.textContent = "";
    if (!r.analyses.length) {
      box.append(h("p", { class: "muted small-text" }, "还没有保存的分析。分析后点“保存分析”，会留在这里。"));
      return;
    }
    for (const a of r.analyses) {
      const when = a.createdAt ? new Date(a.createdAt).toLocaleString() : "";
      box.append(h("div", { class: "clip-row saved-row" },
        h("div", { class: "clip-row-head" },
          h("b", { class: "grow" }, a.scriptTitle || "未命名分析"),
        h("button", { class: "btn small", onclick: () => loadSaved(root, a.id) }, "打开"),
        h("button", { class: "btn small danger-ghost", onclick: async () => {
          if (!await window.Shell.confirm(`确定删除这条分析“${a.scriptTitle || "未命名分析"}”吗？`)) return;
          const res = await api.video.analyses.remove(a.id);
          if (res.ok) { window.Shell.toast("已删除"); await refreshSavedList(root); }
          else window.Shell.toast(res.error || "删除失败", "error");
        } }, "删除")),
        h("div", { class: "clip-row-text" }, `${a.author || "未知作者"}${when ? " · " + when : ""}`)));
    }
  }

  async function loadSaved(root, id) {
    try {
      const r = await unwrap(await api.video.analyses.get(id));
      const a = r.analysis;
      draft = {
        id: a.id, sourceUrl: a.sourceUrl, videoId: a.videoId, author: a.author, caption: a.caption,
        likeCountText: a.likeCountText, commentCountText: a.commentCountText, shareCountText: a.shareCountText,
        style: { ...a.style }, skill: { ...a.skill }, skillText: a.skillText,
        scriptTitle: a.scriptTitle, scriptNarration: a.scriptNarration,
        shots: (a.shots || []).map((s) => ({ ...s })), manualText: a.manualText || "",
      };
      currentInfo = { url: a.sourceUrl, videoId: a.videoId, author: a.author, caption: a.caption,
        likeCountText: a.likeCountText, commentCountText: a.commentCountText, shareCountText: a.shareCountText };
      renderPanel(root);
      window.Shell.toast("已载入这条分析，可编辑后重新保存或导入到项目");
    } catch (e) { window.Shell.toast(e.message, "error"); }
  }

  function renderPanel(root) {
    const panel = root._panel;
    if (!panel) return;
    panel.textContent = "";
    const d = draft || emptyDraft();

    const info = h("div", { id: "douyin-current-info" });
    if (currentInfo) {
      const chips = [];
      const SITE = { douyin: "抖音", bilibili: "B 站", youtube: "YouTube", web: "网页" };
      if (currentInfo.site) chips.push(h("span", { class: "chip" }, SITE[currentInfo.site] || "网页"));
      if (currentInfo.durationSec) chips.push(h("span", { class: "chip" }, Math.round(currentInfo.durationSec) + " 秒"));
      if (currentInfo.viewCountText) chips.push(h("span", { class: "chip" }, "播放 " + currentInfo.viewCountText));
      chips.push(currentInfo.transcript ? h("span", { class: "chip ok", title: currentInfo.transcript.slice(0, 300) }, `字幕 ${currentInfo.transcript.length} 字`) : h("span", { class: "chip" }, "无字幕"));
      if (currentInfo.likeCountText) chips.push(h("span", { class: "chip" }, "赞 " + currentInfo.likeCountText));
      if (currentInfo.commentCountText) chips.push(h("span", { class: "chip" }, "评 " + currentInfo.commentCountText));
      if (currentInfo.shareCountText) chips.push(h("span", { class: "chip" }, "转 " + currentInfo.shareCountText));
      info.append(
        currentInfo.title ? h("p", {}, h("b", {}, currentInfo.title.slice(0, 80))) : "",
        h("p", {}, currentInfo.title ? h("span", { class: "muted" }, currentInfo.author || "（未读到作者）") : h("b", {}, currentInfo.author || "（未读到作者）")),
        h("p", { class: "muted small-text" }, (currentInfo.caption || "（未读到文案）").slice(0, 160)),
        chips.length ? h("div", { class: "stat-line" }, ...chips) : "");
    } else {
      info.append(h("p", { class: "muted small-text" }, "在左边点开一个视频（进入视频详情页），再点下面的按钮。"));
    }

    const linkInput = h("input", { class: "input field-full", placeholder: "视频链接（可选，抖音 / B 站 / YouTube）", value: d.sourceUrl || (currentInfo && currentInfo.url) || "" });
    const captionInput = h("textarea", { class: "input field-full", rows: 3, placeholder: "视频文案 / 补充说明（可选，会一起发给 AI）", value: d.manualText || "" });

    const analyzeBtn = h("button", { class: "btn primary block lg douyin-analyze-btn", id: "douyin-analyze-btn", onclick: () => runAnalyze(root, "extract") }, "分析当前视频");
    const manualBtn = h("button", { class: "btn douyin-analyze-btn", id: "douyin-analyze-manual-btn", onclick: () => runAnalyze(root, "manual") }, "用手动信息分析");
    const aiHint = h("div", { class: "hint-bar", id: "douyin-ai-hint" }, "正在读取 AI 设置…");

    panel.append(
      h("section", { class: "side-card" },
        h("h3", {}, "当前视频"),
        info,
        analyzeBtn,
        h("div", { class: "gap-8" }),
        h("div", { class: "hint-bar", id: "douyin-progress", hidden: true }),
        h("div", { class: "gap-8" }),
        aiHint,
        h("details", { class: "fold" },
          h("summary", {}, "读不到视频信息？手动粘贴链接和文案"),
          linkInput, h("div", { class: "gap-6" }), captionInput,
          h("div", { class: "actions" }, manualBtn))));

    if (!draft) {
      panel.append(h("section", { class: "side-card" },
        h("h3", {}, "分析结果"),
        h("p", { class: "muted small-text" }, "分析后这里会出现风格拆解、风格 skill、脚本与分镜，都可以改，确认后点“导入到项目”。")));
    } else {
      panel.append(buildResultCard(root, d));
    }

    panel.append(
      h("section", { class: "side-card" },
        h("h3", {}, "已保存的分析"),
        h("div", { id: "douyin-saved-list", class: "clip-list" })));
    refreshAiStatus(root).catch(() => {});
    refreshSavedList(root).catch(() => {});
  }

  function buildResultCard(root, d) {
    const styleInputs = {};
    const styleBox = h("div", {});
    for (const k of STYLE_KEYS) {
      const ta = h("textarea", { class: "input field-full", rows: 2, value: d.style[k] || "" });
      ta.addEventListener("input", () => { d.style[k] = ta.value; });
      styleInputs[k] = ta;
      styleBox.append(h("p", { class: "card-desc" }, STYLE_LABELS[k]), ta);
    }
    const skillNameInput = h("input", { class: "input field-full", placeholder: "skill 名（英文短横线小写）", value: d.skill.name || "" });
    skillNameInput.addEventListener("input", () => { d.skill.name = skillNameInput.value; });
    const skillDescInput = h("input", { class: "input field-full", placeholder: "skill 一句话说明", value: d.skill.description || "" });
    skillDescInput.addEventListener("input", () => { d.skill.description = skillDescInput.value; });
    const skillBodyInput = h("textarea", { class: "input field-full", rows: 6, placeholder: "skill 正文：风格定义、镜头语言、要做/不要做", value: d.skill.body || "" });
    skillBodyInput.addEventListener("input", () => { d.skill.body = skillBodyInput.value; });
    const skillTextArea = h("textarea", { class: "input field-full mono", rows: 10, placeholder: "生成的 SKILL.md 文本（可直接编辑）", value: d.skillText || "" });
    skillTextArea.addEventListener("input", () => { d.skillText = skillTextArea.value; });

    const titleInput = h("input", { class: "input field-full", placeholder: "脚本标题", value: d.scriptTitle || "" });
    titleInput.addEventListener("input", () => { d.scriptTitle = titleInput.value; });
    const narrationInput = h("textarea", { class: "input field-full", rows: 4, placeholder: "口播全文", value: d.scriptNarration || "" });
    narrationInput.addEventListener("input", () => { d.scriptNarration = narrationInput.value; });

    const shotsBox = h("div", {});
    const renderShots = () => {
      shotsBox.textContent = "";
      d.shots.forEach((s, i) => {
        const narr = h("textarea", { class: "input field-full", rows: 2, value: s.narration || "" });
        narr.addEventListener("input", () => { s.narration = narr.value; });
        const vis = h("textarea", { class: "input field-full", rows: 2, value: s.visual || "" });
        vis.addEventListener("input", () => { s.visual = vis.value; });
        const prompt = h("textarea", { class: "input field-full", rows: 2, value: s.imagePrompt || "" });
        prompt.addEventListener("input", () => { s.imagePrompt = prompt.value; });
        const secs = h("input", { class: "input", type: "number", min: 1, max: 30, step: 0.1, value: String(s.seconds || "") });
        secs.addEventListener("input", () => { s.seconds = Number(secs.value) || 0; });
        shotsBox.append(h("section", { class: "subcard" },
          h("header", { class: "card-head" }, h("h2", {}, `第 ${i + 1} 镜`),
            h("span", { class: "spacer" }),
            h("button", { class: "btn small danger-ghost", onclick: () => { d.shots.splice(i, 1); renderShots(); } }, "删除")),
          h("p", { class: "card-desc" }, "口播"), narr,
          h("p", { class: "card-desc" }, "画面描述"), vis,
          h("p", { class: "card-desc" }, "生视频提示词"), prompt,
          h("p", { class: "card-desc" }, "预估时长（秒）"), secs));
      });
      if (!d.shots.length) shotsBox.append(h("p", { class: "muted" }, "还没有分镜镜头，点“添加镜头”手动加，或重新分析。"));
    };
    renderShots();

    const saveBtn = h("button", { class: "btn", onclick: () => saveDraft(root, d) }, "保存分析");
    const copyBtn = h("button", { class: "btn", onclick: async () => {
      const text = d.skillText || "";
      if (!text.trim()) { window.Shell.toast("skill 文本是空的", "error"); return; }
      try { await navigator.clipboard.writeText(text); window.Shell.toast("skill 已复制", "success"); }
      catch (e) { window.Shell.toast("复制失败：" + e.message, "error"); }
    } }, "复制 skill");
    const saveSkillBtn = h("button", { class: "btn", onclick: async () => {
      try {
        const saved = await saveDraft(root, d, { silent: true });
        const r = await api.video.analyses.saveSkill(saved.id);
        if (!r.ok) window.Shell.toast(r.error || "保存 skill 文件失败", "error");
        else window.Shell.toast("skill 已保存到数据目录：" + r.path, "success");
      } catch (e) { window.Shell.toast(e.message, "error"); }
    } }, "保存 skill 文件");
    const importBtn = h("button", { class: "btn primary", onclick: async () => {
      try {
        const saved = await saveDraft(root, d, { silent: true });
        const r = await api.video.analyses.import(saved.id);
        if (!r.ok) { window.Shell.toast(r.error || "导入失败", "error"); return; }
        window.VideoApp.openProject(r.project.id);
        window.Shell.navigate("editor");
        window.Shell.toast("已按分镜新建项目，去分镜编辑里确认", "success");
      } catch (e) { window.Shell.toast(e.message, "error"); }
    } }, "导入到项目");

    return h("section", { class: "side-card" },
      h("h3", {}, h("span", { class: "grow" }, "分析结果"), h("span", { class: "chip" }, `${d.shots.length} 镜`)),
      h("div", { class: "actions" }, importBtn, saveBtn),
      h("details", { class: "fold", open: true },
        h("summary", {}, "脚本与分镜"),
        titleInput, h("div", { class: "gap-6" }), narrationInput,
        shotsBox,
        h("div", { class: "actions" },
          h("button", { class: "btn small", onclick: () => { d.shots.push({ narration: "", visual: "", imagePrompt: "", seconds: 0 }); renderShots(); } }, "＋ 添加镜头"))),
      h("details", { class: "fold" }, h("summary", {}, "风格拆解"), styleBox),
      h("details", { class: "fold" },
        h("summary", {}, "风格 skill"),
        skillNameInput, skillDescInput, skillBodyInput,
        h("p", { class: "card-desc" }, "SKILL.md 文本（保存 skill 文件时写这个内容）"), skillTextArea,
        h("div", { class: "actions" }, copyBtn, saveSkillBtn)));
  }

  async function saveDraft(root, d, { silent = false } = {}) {
    const payload = {
      ...(d.id ? { id: d.id } : {}),
      sourceUrl: d.sourceUrl || (currentInfo && currentInfo.url) || "",
      videoId: d.videoId || (currentInfo && currentInfo.videoId) || "",
      author: d.author || (currentInfo && currentInfo.author) || "",
      caption: d.caption || (currentInfo && currentInfo.caption) || "",
      likeCountText: d.likeCountText || (currentInfo && currentInfo.likeCountText) || "",
      commentCountText: d.commentCountText || (currentInfo && currentInfo.commentCountText) || "",
      shareCountText: d.shareCountText || (currentInfo && currentInfo.shareCountText) || "",
      style: d.style, skill: d.skill, skillText: d.skillText,
      scriptTitle: d.scriptTitle, scriptNarration: d.scriptNarration,
      shots: d.shots.filter((s) => String(s.narration || "").trim()),
      manualText: d.manualText || "",
    };
    const r = await unwrap(await api.video.analyses.upsert(payload));
    draft = {
      ...d, id: r.analysis.id,
      shots: (r.analysis.shots || []).map((s) => ({ ...s })),
      skillText: r.analysis.skillText, skill: { ...r.analysis.skill }, style: { ...r.analysis.style },
    };
    if (!silent) window.Shell.toast("分析已保存", "success");
    refreshSavedList(root).catch(() => {});
    return r.analysis;
  }

  // 分析进度：按钮显示阶段和已用秒数，结果/错误留在面板里（不只是一闪而过的提示）
  let tick = null;
  function setProgress(root, stage, kind = "") {
    const box = root.querySelector("#douyin-progress");
    const btn = root.querySelector("#douyin-analyze-btn");
    if (tick) { clearInterval(tick); tick = null; }
    if (!box) return;
    if (!stage) { box.hidden = true; if (btn) btn.textContent = "分析当前视频"; return; }
    box.hidden = false;
    box.className = "hint-bar " + (kind || "");
    if (kind) { box.textContent = stage; if (btn) btn.textContent = "分析当前视频"; return; }
    const t0 = Date.now();
    const draw = () => {
      const sec = Math.floor((Date.now() - t0) / 1000);
      box.textContent = `${stage}（已用 ${sec} 秒，详细过程看右侧运行日志）`;
      if (btn) btn.textContent = `分析中… ${sec}s`;
    };
    draw();
    tick = setInterval(() => { if (!box.isConnected) { clearInterval(tick); tick = null; return; } draw(); }, 1000);
  }

  async function runAnalyze(root, mode) {
    if (busy) return;
    if (!aiReady) {
      window.Shell.toast("还没配置 AI Key：先到设置里填接口地址、模型和 Key", "error");
      if (window.Shell.openSettings) window.Shell.openSettings("video-ai");
      return;
    }
    const panel = root._panel;
    const linkInput = panel.querySelector("input.field-full");
    const captionInput = panel.querySelector("textarea.field-full");
    const manualText = [captionInput ? captionInput.value : "", linkInput ? linkInput.value : ""].filter(Boolean).join("\n");
    let videoInfo = currentInfo;
    if (mode === "extract") {
      setProgress(root, "正在读取左侧视频信息…");
      try {
        const r = await api.video.douyin.extract();
        if (!r.ok) throw new Error(r.error || "提取失败");
        currentInfo = r.info;
        videoInfo = r.info;
        window.Shell.toast("已读到当前视频信息，开始分析…", "success");
      } catch (e) {
        const msg = (e && e.message) || "提取失败：请确认已在左侧打开视频详情页，或用下面手动粘贴";
        setProgress(root, "没读到视频信息：" + msg, "warn");
        window.Shell.toast(msg, "error");
        return;
      }
    } else {
      const link = linkInput ? linkInput.value.trim() : "";
      const caption = captionInput ? captionInput.value.trim() : "";
      if (!link && !caption) {
        window.Shell.toast("手动分析需要先粘贴视频链接或文案", "error");
        return;
      }
      videoInfo = { url: link, author: "", caption, likeCountText: "", commentCountText: "", shareCountText: "" };
      currentInfo = videoInfo;
    }
    busy = true;
    refreshAiStatus(root).catch(() => {});
    if (window.Shell.toggleLogDock) { try { window.Shell.toggleLogDock(true); } catch { /* ignore */ } }
    setProgress(root, mode === "extract" && viewOpened() ? "正在截取画面并请求 AI 分析，通常要 20–90 秒" : "正在请求 AI 分析，通常要 20–60 秒");
    try {
      // “分析当前视频”时顺带截几帧画面给 AI 看（视图开着时）；手动分析不截图
      const r = await api.video.douyin.analyze({ videoInfo, manualText: captionInput ? captionInput.value : "", useFrames: mode === "extract" && viewOpened() });
      if (!r.ok) throw new Error(r.error || "分析失败");
      const a = r.record;
      draft = {
        id: a.id, sourceUrl: a.sourceUrl, videoId: a.videoId, author: a.author, caption: a.caption,
        likeCountText: a.likeCountText, commentCountText: a.commentCountText, shareCountText: a.shareCountText,
        style: { ...a.style }, skill: { ...a.skill }, skillText: a.skillText,
        scriptTitle: a.scriptTitle, scriptNarration: a.scriptNarration,
        shots: (a.shots || []).map((s) => ({ ...s })), manualText: a.manualText || "",
      };
      setProgress(root, "");
      renderPanel(root);
      window.Shell.toast(r.usedImages
        ? "分析完成（已结合画面截图），结果已保存，可编辑后导入到项目"
        : "分析完成（仅依据文案，未看画面），结果已保存，可编辑后导入到项目", "success");
    } catch (e) {
      const msg = (e && e.message) || "分析失败";
      setProgress(root, "分析失败：" + msg, "warn");
      window.Shell.toast(msg, "error");
    } finally {
      busy = false;
      refreshAiStatus(root).catch(() => {});
    }
  }
})();
