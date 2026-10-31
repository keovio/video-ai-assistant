"use strict";
// 0.6.20 作品库：所有项目的成片 + 所有保存的分析，集中查看、搜索、打开、删除。
(function () {
  const { h } = window.Shell;
  const api = window.app;
  const STATUS = { queued: ["排队中", ""], running: ["合成中", "warn"], done: ["已完成", "ok"], failed: ["失败", "err"] };
  const SITE = { douyin: "抖音", bilibili: "B 站", youtube: "YouTube", web: "网页" };
  const PREVIEW = 8; // “全部”视图每类先显示几条
  const PAGE = 24;

  const state = { tab: "all", q: "", renders: [], analyses: [], limit: { renders: PAGE, analyses: PAGE }, loading: false, error: "" };
  const thumbs = new Map(); // renderId -> { thumb, seconds }
  let observer = null;

  const fmtSize = (n) => (!n ? "" : n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
  const fmtDur = (s) => { s = Math.round(Number(s) || 0); if (!s) return ""; const m = Math.floor(s / 60); return m ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s} 秒`; };
  function fmtWhen(ts) {
    if (!ts) return "";
    const d = new Date(ts); if (isNaN(d)) return "";
    const now = new Date(); const hm = d.toTimeString().slice(0, 5);
    if (d.toDateString() === now.toDateString()) return "今天 " + hm;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "昨天 " + hm;
    return (d.getFullYear() === now.getFullYear() ? "" : d.getFullYear() + "/") + (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
  }
  const has = (q, ...fields) => !q || fields.some((f) => String(f || "").toLowerCase().includes(q));

  window.Shell.registerPage({
    id: "library",
    title: "作品库",
    icon: "layers",
    order: 28,
    render(root) {
      root.classList.add("page-wide");
      root._body = h("div", { class: "library" });
      root.append(root._body);
      load(root);
    },
    onShow(root) { load(root); },
  });

  async function load(root) {
    state.loading = true;
    try {
      const [r, a] = await Promise.all([api.video.library.renders(), api.video.analyses.list()]);
      if (!r.ok) throw new Error(r.error || "读取成片失败");
      if (!a.ok) throw new Error(a.error || "读取分析失败");
      state.renders = r.renders || [];
      state.analyses = a.analyses || [];
      state.error = "";
    } catch (e) { state.error = e.message; }
    state.loading = false;
    draw(root);
  }

  function draw(root) {
    const body = root._body;
    if (!body) return;
    if (observer) observer.disconnect();
    observer = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { observer.unobserve(en.target); loadThumb(en.target); }
    }, { rootMargin: "200px" });

    const tabBtn = (id, label, n) => h("button", { class: state.tab === id ? "active" : "", onclick: () => { state.tab = id; draw(root); } },
      label + (n != null ? ` ${n}` : ""));
    const search = h("input", { class: "input lib-search", type: "search", placeholder: "搜索项目名、分析标题、作者、链接", value: state.q,
      oninput: (e) => { state.q = e.target.value; state.limit = { renders: PAGE, analyses: PAGE }; drawResults(root); } });

    body.textContent = "";
    body.append(
      h("header", { class: "page-head" },
        h("div", {}, h("h1", {}, "作品库"), h("p", { class: "sub" }, "所有项目合成出的成片和保存过的视频分析，都在这里。")),
        h("button", { class: "btn", onclick: () => load(root) }, "刷新")),
      h("div", { class: "lib-toolbar" },
        h("div", { class: "segmented" },
          tabBtn("all", "全部"), tabBtn("renders", "成片", state.renders.length), tabBtn("analyses", "分析", state.analyses.length)),
        search),
      root._results = h("div", { class: "lib-results" }));
    drawResults(root);
  }

  function drawResults(root) {
    const body = root._results;
    if (!body) return;
    body.textContent = "";
    if (observer) observer.disconnect();
    const q = state.q.trim().toLowerCase();
    const renders = state.renders.filter((r) => has(q, r.projectTitle, r.outputPath, r.error));
    const analyses = state.analyses.filter((a) => has(q, a.scriptTitle, a.sourceTitle, a.author, a.sourceUrl, a.caption));
    if (state.error) { body.append(h("p", { class: "error" }, state.error)); return; }

    if (state.tab !== "analyses") body.append(section(root, "renders", "成片", renders, renderCard,
      state.renders.length ? "没有匹配的成片。" : "还没有成片。在“合成导出”里合成一次，就会出现在这里。"));
    if (state.tab !== "renders") body.append(section(root, "analyses", "视频分析", analyses, analysisCard,
      state.analyses.length ? "没有匹配的分析。" : "还没有保存的分析。在“视频分析”里分析一条视频并保存。"));
  }

  function section(root, kind, title, items, cardFn, emptyText) {
    const all = state.tab === "all";
    const max = all ? PREVIEW : state.limit[kind];
    const grid = h("div", { class: "lib-grid lib-grid-" + kind });
    for (const it of items.slice(0, max)) grid.append(cardFn(root, it));
    const more = items.length > max
      ? (all
        ? h("button", { class: "btn small ghost", onclick: () => { state.tab = kind; draw(root); } }, `查看全部 ${items.length} 条 →`)
        : h("button", { class: "btn block", onclick: () => { state.limit[kind] += PAGE; draw(root); } }, `显示更多（还有 ${items.length - max} 条）`))
      : null;
    return h("section", { class: "lib-section" },
      h("div", { class: "lib-section-head" }, h("h2", {}, title, " ", h("span", { class: "chip" }, String(items.length))), all ? more : null),
      items.length ? grid : h("p", { class: "muted small-text" }, emptyText),
      all ? null : more);
  }

  function renderCard(root, r) {
    const [label, cls] = STATUS[r.status] || [r.status, ""];
    const playable = r.status === "done" && r.exists;
    const t = thumbs.get(r.id);
    const thumb = h("div", { class: "lib-thumb" + (playable ? " playable" : ""), "data-id": r.id, title: playable ? "播放成片" : "",
      onclick: playable ? () => openOutput(r.id) : null });
    paintThumb(thumb, r, t);
    if (playable && !t) observer.observe(thumb);
    const meta = [fmtWhen(r.createdAt), t && t.seconds ? fmtDur(t.seconds) : "", r.exists ? fmtSize(r.sizeBytes) : ""].filter(Boolean).join(" · ");
    return h("div", { class: "lib-card" },
      thumb,
      h("div", { class: "lib-card-body" },
        h("div", { class: "lib-card-title", title: r.projectTitle || "" }, r.projectTitle || (r.projectExists ? "未命名项目" : "（项目已删除）")),
        h("div", { class: "lib-card-meta" }, h("span", { class: "chip " + cls }, label), " ", meta),
        r.status === "failed" ? h("div", { class: "error small-text lib-err", title: r.error || "" }, r.error || r.message || "合成失败") : null,
        r.status === "done" && !r.exists ? h("div", { class: "muted small-text" }, "成片文件已不在磁盘上") : null,
        h("div", { class: "lib-actions" },
          playable ? h("button", { class: "btn small primary", onclick: () => openOutput(r.id) }, "播放") : null,
          playable ? h("button", { class: "btn small", title: "放进 TikTok / 抖音的草稿箱", onclick: () => draftDialog(r) }, "存草稿") : null,
          r.exists ? h("button", { class: "btn small", onclick: () => call(api.video.renders.openFolder(r.id)) }, "文件夹") : null,
          r.projectExists ? h("button", { class: "btn small", onclick: () => { window.VideoApp.openProject(r.projectId); window.Shell.navigate("render"); } }, "去合成") : null,
          r.status === "failed" && r.projectExists ? h("button", { class: "btn small", onclick: async () => { if (await call(api.video.renders.retry(r.id))) { window.Shell.toast("已重新开始合成"); load(root); } } }, "重跑") : null,
          r.status === "running" || r.status === "queued" ? null : h("button", { class: "btn small danger-ghost", onclick: async () => {
            if (!await window.Shell.confirm(`删除这条成片记录${r.exists ? "和视频文件" : ""}吗？`)) return;
            if (await call(api.video.renders.remove(r.id))) { window.Shell.toast("已删除"); thumbs.delete(r.id); load(root); }
          } }, "删除"))));
  }

  function paintThumb(el, r, t) {
    el.textContent = "";
    if (t && t.thumb) el.append(h("img", { src: t.thumb, alt: "" }));
    else el.append(h("span", { class: "lib-thumb-ph" }, r.status === "done" ? (r.exists ? "🎬" : "文件不在") : (STATUS[r.status] || [r.status])[0]));
    if (t && t.seconds) el.append(h("span", { class: "lib-dur" }, fmtDur(t.seconds)));
    if (r.status === "done" && r.exists) el.append(h("span", { class: "lib-play" }, "▶"));
  }

  async function loadThumb(el) {
    const id = el.getAttribute("data-id");
    const r = state.renders.find((x) => x.id === id);
    if (!r) return;
    try {
      const res = await api.video.library.thumb(id);
      thumbs.set(id, res.ok ? { thumb: res.thumb || "", seconds: res.seconds || 0 } : { thumb: "", seconds: 0 });
    } catch { thumbs.set(id, { thumb: "", seconds: 0 }); }
    if (!el.isConnected) return;
    const t = thumbs.get(id);
    paintThumb(el, r, t);
    const meta = el.parentElement && el.parentElement.querySelector(".lib-card-meta");
    if (meta && t.seconds) {
      const chip = meta.firstChild;
      meta.replaceChildren(chip, " " + [fmtWhen(r.createdAt), fmtDur(t.seconds), fmtSize(r.sizeBytes)].filter(Boolean).join(" · "));
    }
  }

  function analysisCard(root, a) {
    const title = a.scriptTitle || a.sourceTitle || "未命名分析";
    const shots = Array.isArray(a.shots) ? a.shots.length : 0;
    const speech = Array.isArray(a.shots) && a.shots.some((s) => s && s.narration);
    return h("div", { class: "lib-card lib-analysis", onclick: () => window.VideoAnalysis && window.VideoAnalysis.open(a.id) },
      h("div", { class: "lib-card-body" },
        h("div", { class: "lib-card-meta" },
          h("span", { class: "chip" }, SITE[a.site] || "网页"),
          shots ? h("span", { class: "chip" }, `${shots} 镜`) : null,
          Array.isArray(a.shots) ? h("span", { class: "chip" }, speech ? "有口播" : "无口播") : null),
        h("div", { class: "lib-card-title two-line", title }, title),
        h("div", { class: "lib-card-meta" }, [a.author || "未知作者", fmtWhen(a.createdAt)].filter(Boolean).join(" · ")),
        a.sourceUrl ? h("div", { class: "muted small-text source-url", title: a.sourceUrl }, a.sourceUrl) : null,
        h("div", { class: "lib-actions" },
          h("button", { class: "btn small primary", onclick: (e) => { e.stopPropagation(); window.VideoAnalysis && window.VideoAnalysis.open(a.id); } }, "打开"),
          a.sourceUrl ? h("button", { class: "btn small", onclick: (e) => {
            e.stopPropagation();
            if (!/^https?:\/\//i.test(a.sourceUrl)) { window.Shell.toast("原地址无效", "error"); return; }
            window.Shell.navigate("douyin");
            api.video.embed.nav("douyin", "newTab", a.sourceUrl).catch((err) => window.Shell.toast("打开失败：" + err.message, "error"));
          } }, "原视频") : null,
          h("button", { class: "btn small danger-ghost", onclick: async (e) => {
            e.stopPropagation();
            if (!await window.Shell.confirm(`确定删除这条分析“${title}”吗？`)) return;
            if (await call(api.video.analyses.remove(a.id))) { window.Shell.toast("已删除"); load(root); }
          } }, "删除"))));
  }

  // 0.6.21 存草稿：选平台 + 文案 → 在“视频分析”的内嵌浏览器里打开创作者上传页，自动放好成片和文案
  const PLATFORMS = [["tiktok", "TikTok"], ["douyin", "抖音"]];
  function draftDialog(r) {
    let platform = localStorage.getItem("publish.platform") || "tiktok";
    const caption = h("textarea", { class: "input", rows: 4, maxlength: 2200, placeholder: "标题 / 文案 / #话题（可空）", value: r.projectTitle && r.projectTitle !== "未命名项目" ? r.projectTitle : "" });
    const seg = h("div", { class: "segmented" });
    const drawSeg = () => seg.replaceChildren(...PLATFORMS.map(([id, label]) => h("button", { class: platform === id ? "active" : "", onclick: () => { platform = id; drawSeg(); } }, label)));
    drawSeg();
    const finish = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") finish(); };
    const go = async () => {
      localStorage.setItem("publish.platform", platform);
      const text = caption.value.trim();
      if (text) { try { await navigator.clipboard.writeText(text); } catch { /* ignore */ } }
      finish();
      window.Shell.navigate("douyin");
      await new Promise((res) => setTimeout(res, 400));
      const res = await api.video.publish.draft(r.id, { platform, caption: text });
      if (!res || !res.ok) window.Shell.toast((res && res.error) || "打开上传页失败", "error");
    };
    const field = (label, el, hint) => h("label", { class: "form-field" }, h("span", { class: "form-label" }, label), el, hint ? h("span", { class: "form-hint" }, hint) : "");
    const overlay = h("div", { class: "modal-overlay", onclick: (e) => { if (e.target === overlay) finish(); } },
      h("div", { class: "modal modal-form", role: "dialog", "aria-modal": "true" },
        h("h3", { class: "modal-title" }, "存到草稿箱"),
        h("div", { class: "form-field" }, h("span", { class: "form-label" }, "平台"), seg),
        field("文案", caption, "会自动填进上传页（也会复制到剪贴板备用）"),
        h("p", { class: "muted small-text" }, "会在“视频分析”左边的浏览器里打开创作者上传页。第一次需要登录（建议扫码或手机号/邮箱登录），登录后自动放入成片和文案，最后你检查一下点“保存草稿”。"),
        h("div", { class: "actions end" }, h("button", { class: "btn", onclick: finish }, "取消"), h("button", { class: "btn primary", onclick: go }, "打开上传页"))));
    document.body.append(overlay);
    document.addEventListener("keydown", onKey);
    caption.focus();
  }
  // 存草稿进度：在任何页面都弹提示
  try {
    api.video.publish.onStatus((p) => {
      if (!p || !p.message) return;
      const type = p.stage === "failed" ? "error" : p.stage === "ready" ? "success" : "";
      window.Shell.toast(p.message, type);
    });
  } catch { /* ignore */ }

  async function openOutput(id) { await call(api.video.renders.openOutput(id)); }
  async function call(p) {
    try { const r = await p; if (!r || !r.ok) { window.Shell.toast((r && r.error) || "操作失败", "error"); return false; } return true; }
    catch (e) { window.Shell.toast(e.message, "error"); return false; }
  }
})();
