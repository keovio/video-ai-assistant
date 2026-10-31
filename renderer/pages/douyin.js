"use strict";
// 抖音分析页（M4）：左侧是内嵌抖音视图（持久会话，登录一次后保持），
// 右侧是分析面板：提取当前视频信息 -> AI 分析（风格拆解 + skill + 脚本分镜）
// -> 编辑 -> 保存分析记录 -> 导入到项目。选择器未验证、提取不到时走手动粘贴兜底，
// 没有 AI Key 时分析按钮禁用并提示去设置，绝不编造分析结果。
(function () {
  const { h } = window.Shell;
  const api = window.app;
  const debounce = window.Shell.debounce || ((fn) => fn);

  const STYLE_LABELS = {
    visual: "画面风格", camera: "镜头与运镜", pacing: "节奏",
    mood: "情绪氛围", colorLight: "色彩与光线", sound: "声音与音乐", hooks: "文案与钩子",
  };
  const STYLE_KEYS = Object.keys(STYLE_LABELS);

  let viewOpened = false;
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
    title: "抖音分析",
    icon: "search",
    order: 15,
    render(root) {
      root.classList.add("page-wide");
      root._body = h("div", { id: "douyin-body" });
      root.append(root._body);
      buildSkeleton(root);
      refreshAiStatus(root).catch(() => {});
      refreshSavedList(root).catch(() => {});
    },
    async onShow(root) {
      reportBounds(root);
      if (viewOpened) { try { await api.video.douyin.show(); } catch { /* ignore */ } }
      refreshAiStatus(root).catch(() => {});
      refreshSavedList(root).catch(() => {});
    },
    async onHide() {
      try { await api.video.douyin.hide(); } catch { /* ignore */ }
    },
  });

  // 上报占位元素位置给主进程（内嵌视图按这个 rect 定位），防抖；滚动/缩放时也上报。
  function reportBounds(root) {
    const el = root.querySelector("#douyin-view-placeholder");
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    api.video.douyin.setBounds({ x: r.x, y: r.y, width: r.width, height: r.height }).catch(() => {});
  }
  const reportBoundsDebounced = debounce((root) => reportBounds(root), 120);
  window.addEventListener("resize", () => {
    const root = document.getElementById("page-douyin");
    if (root && !root.hidden) reportBoundsDebounced(root);
  });
  document.addEventListener("scroll", (e) => {
    const root = document.getElementById("page-douyin");
    if (root && !root.hidden && e.target && e.target.id === "main") reportBoundsDebounced(root);
  }, true);

  function buildSkeleton(root) {
    const body = root._body;
    body.textContent = "";

    const placeholder = h("div", { id: "douyin-view-placeholder", class: "embed-placeholder" },
      h("p", { class: "muted" }, "点“打开抖音”后，抖音页面会嵌在这里显示（登录一次后保持登录）。"),
      h("p", { class: "muted small" }, "选择器未经真机验证：如果打开视频后读不到信息，请用右侧手动粘贴链接和文案。"));
    const openBtn = h("button", { class: "btn primary", onclick: async () => {
      openBtn.disabled = true;
      try {
        const r = await api.video.douyin.open();
        if (!r.ok) window.Shell.toast(r.error || "打开抖音失败", "error");
        else { viewOpened = true; window.Shell.toast("抖音已在左侧打开", "success"); }
        reportBounds(root);
      } catch (e) { window.Shell.toast(e.message, "error"); }
      finally { openBtn.disabled = false; }
    } }, "打开抖音");
    const hideBtn = h("button", { class: "btn", onclick: async () => {
      await api.video.douyin.hide().catch(() => {});
      window.Shell.toast("已隐藏抖音视图（登录态保留，再打开时不用重新登录）");
    } }, "隐藏视图");

    // 右侧面板：手动信息 + 当前视频 + 分析结果，全部由 renderPanel 重绘
    const panel = h("div", { id: "douyin-panel" });

    body.append(
      h("header", { class: "page-head" },
        h("div", {}, h("h1", {}, "抖音分析"),
          h("p", { class: "sub" }, "在左侧刷抖音、点开一个视频，右侧点“分析当前视频”；也可以手动粘贴链接和文案分析。"))),
      h("div", { class: "split-layout douyin-layout" },
        h("div", { class: "split-left" },
          h("div", { class: "actions" }, openBtn, hideBtn),
          placeholder),
        h("div", { class: "split-right" }, panel)));
    root._panel = panel;
    root._placeholder = placeholder;
    renderPanel(root);
    requestAnimationFrame(() => reportBounds(root));
  }

  async function refreshAiStatus(root) {
    const hint = root.querySelector("#douyin-ai-hint");
    const btns = [...root.querySelectorAll(".douyin-analyze-btn")];
    try {
      const r = await api.video.ai.status();
      aiReady = !!(r && r.set);
      if (hint) {
        hint.textContent = aiReady
          ? `AI 已配置（Key 末 4 位 …${r.last4 || ""}）${r.insecureFallback ? "，注意：本机无可用钥匙串，Key 以文件形式保存，未加密" : ""}`
          : "未配置 AI Key：请先到“设置 → 视频 → AI 分析”里保存 Key，才能分析；未配置时只能看提取到的视频信息和手动粘贴。";
      }
    } catch {
      aiReady = false;
      if (hint) hint.textContent = "AI 设置读取失败，请到设置页检查。";
    }
    for (const b of btns) b.disabled = busy || !aiReady;
  }

  async function refreshSavedList(root) {
    const box = root.querySelector("#douyin-saved-list");
    if (!box) return;
    box.textContent = "";
    let r;
    try { r = await unwrap(await api.video.analyses.list()); }
    catch (e) { box.append(h("p", { class: "error" }, e.message)); return; }
    if (!r.analyses.length) {
      box.append(h("p", { class: "muted" }, "还没有保存的分析。分析后点“保存分析”，会留在这里。"));
      return;
    }
    for (const a of r.analyses) {
      const when = a.createdAt ? new Date(a.createdAt).toLocaleString() : "";
      box.append(h("div", { class: "actions saved-row" },
        h("div", { class: "saved-row-main" },
          h("b", {}, a.scriptTitle || "未命名分析"),
          h("div", { class: "muted" }, `${a.author || "未知作者"}${when ? " · " + when : ""}${a.sourceUrl ? " · " + a.sourceUrl.slice(0, 60) : ""}`)),
        h("button", { class: "btn small", onclick: () => loadSaved(root, a.id) }, "打开"),
        h("button", { class: "btn small danger-ghost", onclick: async () => {
          if (!await window.Shell.confirm(`确定删除这条分析“${a.scriptTitle || "未命名分析"}”吗？`)) return;
          const res = await api.video.analyses.remove(a.id);
          if (res.ok) { window.Shell.toast("已删除"); await refreshSavedList(root); }
          else window.Shell.toast(res.error || "删除失败", "error");
        } }, "删除")));
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

    const infoText = currentInfo
      ? `作者：${currentInfo.author || "（未读到）"}\n文案：${currentInfo.caption || "（未读到）"}\n链接：${currentInfo.url || ""}${currentInfo.likeCountText ? `\n点赞 ${currentInfo.likeCountText}` : ""}${currentInfo.commentCountText ? ` · 评论 ${currentInfo.commentCountText}` : ""}${currentInfo.shareCountText ? ` · 分享 ${currentInfo.shareCountText}` : ""}`
      : "还没提取到视频信息：先在左侧打开抖音并点开一个视频，再点“分析当前视频”；或在下面手动粘贴。";
    const infoBox = h("p", { class: "muted", id: "douyin-current-info" }, infoText);

    const linkInput = h("input", { class: "input field-full", placeholder: "手动粘贴抖音视频链接（可选）", value: d.sourceUrl || (currentInfo && currentInfo.url) || "" });
    const captionInput = h("textarea", { class: "input field-full", rows: 3, placeholder: "手动粘贴视频文案/补充说明（可选，分析时会一起发给 AI）", value: d.manualText || "" });

    const analyzeBtn = h("button", { class: "btn primary douyin-analyze-btn", id: "douyin-analyze-btn", disabled: true, onclick: () => runAnalyze(root, "extract") }, "分析当前视频");
    const manualBtn = h("button", { class: "btn douyin-analyze-btn", id: "douyin-analyze-manual-btn", disabled: true, onclick: () => runAnalyze(root, "manual") }, "用手动信息分析");
    const aiHint = h("p", { class: "muted", id: "douyin-ai-hint" }, "正在读取 AI 设置…");

    panel.append(
      h("section", { class: "card module" },
        h("header", { class: "card-head" }, h("h2", {}, "当前视频")),
        infoBox,
        h("p", { class: "card-desc" }, "手动粘贴（提取失败时的兜底）"),
        linkInput,
        captionInput,
        h("div", { class: "actions" }, analyzeBtn, manualBtn),
        aiHint));

    if (!draft) {
      panel.append(h("p", { class: "muted" }, "分析结果会显示在这里：风格拆解、风格 skill、脚本与分镜，全部可编辑，确认后点“导入到项目”。"));
    } else {
      panel.append(buildResultCard(root, d));
    }

    panel.append(
      h("section", { class: "card module" },
        h("header", { class: "card-head" }, h("h2", {}, "已保存的分析")),
        h("div", { id: "douyin-saved-list" })));
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

    return h("section", { class: "card module" },
      h("header", { class: "card-head" }, h("h2", {}, "分析结果（可编辑）")),
      h("p", { class: "card-desc" }, "风格拆解"), styleBox,
      h("p", { class: "card-desc" }, "风格 skill"),
      skillNameInput, skillDescInput, skillBodyInput,
      h("p", { class: "card-desc" }, "SKILL.md 文本（保存 skill 文件时写这个内容）"), skillTextArea,
      h("p", { class: "card-desc" }, "脚本"),
      titleInput, narrationInput,
      h("p", { class: "card-desc" }, "分镜"),
      shotsBox,
      h("div", { class: "actions" },
        h("button", { class: "btn", onclick: () => { d.shots.push({ narration: "", visual: "", imagePrompt: "", seconds: 0 }); renderShots(); } }, "＋ 添加镜头")),
      h("div", { class: "actions" }, saveBtn, copyBtn, saveSkillBtn, importBtn));
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

  async function runAnalyze(root, mode) {
    if (busy) return;
    const panel = root._panel;
    const linkInput = panel.querySelector("input.field-full");
    const captionInput = panel.querySelector("textarea.field-full");
    const manualText = [captionInput ? captionInput.value : "", linkInput ? linkInput.value : ""].filter(Boolean).join("\n");
    let videoInfo = currentInfo;
    if (mode === "extract") {
      try {
        const r = await api.video.douyin.extract();
        if (!r.ok) throw new Error(r.error || "提取失败");
        currentInfo = r.info;
        videoInfo = r.info;
        window.Shell.toast("已读到当前视频信息，开始分析…", "success");
      } catch (e) {
        window.Shell.toast((e && e.message) || "提取失败：请确认已在左侧打开视频详情页，或用下面手动粘贴", "error");
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
    try {
      const r = await api.video.douyin.analyze({ videoInfo, manualText: captionInput ? captionInput.value : "" });
      if (!r.ok) throw new Error(r.error || "分析失败");
      const a = r.record;
      draft = {
        id: a.id, sourceUrl: a.sourceUrl, videoId: a.videoId, author: a.author, caption: a.caption,
        likeCountText: a.likeCountText, commentCountText: a.commentCountText, shareCountText: a.shareCountText,
        style: { ...a.style }, skill: { ...a.skill }, skillText: a.skillText,
        scriptTitle: a.scriptTitle, scriptNarration: a.scriptNarration,
        shots: (a.shots || []).map((s) => ({ ...s })), manualText: a.manualText || "",
      };
      renderPanel(root);
      window.Shell.toast("分析完成，结果已保存，可编辑后导入到项目", "success");
    } catch (e) {
      window.Shell.toast((e && e.message) || "分析失败", "error");
    } finally {
      busy = false;
      refreshAiStatus(root).catch(() => {});
    }
  }
})();
