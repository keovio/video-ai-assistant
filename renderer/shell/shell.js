"use strict";
// 通用外壳（页面侧）：页面注册与导航、侧边栏折叠/拖动宽度、深浅色、提示条、小工具。
// 页面只通过 window.app（preload 暴露）和主进程通信。
//
// 加一个页面（renderer/pages/xxx.js，并在 index.html 里加 <script>）：
//   Shell.registerPage({
//     id: "notes", title: "笔记", icon: "note",       // icon：内置图标名，或一个字符
//     order: 20,                                       // 越小越靠上；section: "system" 放到底部
//     render(root, ctx) { root.append(Shell.h("h1", {}, "笔记")); },  // 首次打开时调用一次
//     onShow(root, ctx) {}, onHide(root, ctx) {},      // 每次切入 / 切出（可选）
//   });
(function () {
  const api = window.app;

  // ---------- 小工具 ----------
  // h("div", { class: "x", onclick: fn, hidden: true }, "文字", childNode, [更多子节点])
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "html") el.innerHTML = v;
      else if (v === true) el.setAttribute(k, "");
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, String(v));
    }
    const add = (c) => {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    };
    children.forEach(add);
    return el;
  }
  const $ = (sel, root = document) => root.querySelector(sel);
  const fmtTime = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  const fmtDuration = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${Math.floor(s / 3600)} 时 ${Math.floor((s % 3600) / 60)} 分`; };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // 内置图标（24×24 线条）。页面也可以传一个字符当图标
  const ICONS = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    tasks: '<path d="M4 6h10M4 12h16M4 18h7"/><circle cx="19" cy="6" r="2"/><circle cx="15" cy="18" r="2"/>',
    logs: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    star: '<path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4 6.5 20.3l1-6.2L3 9.7l6.2-.9z"/>',
    chevron: '<path d="M15 6l-6 6 6 6"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.4-4-7.8-9-7.8z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>',
  };
  function icon(name) {
    if (ICONS[name]) return h("span", { class: "ico", html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>` });
    return h("span", { class: "ico ico-text" }, String(name || "•").slice(0, 2));
  }

  // ---------- 模块卡片 ----------
  // 页面用模块拼：Shell.modules(Shell.card({ title: "标题", tag: "已开启", actions: [按钮] }, 内容…), …)
  // modules() 是瀑布流容器（宽窗口自动多列），card() 是一个模块
  // 设置里切到「经典」布局时，同样的 modules/card 会排成单列列表，页面代码不用改
  function card(opts, ...children) {
    const o = typeof opts === "string" ? { title: opts } : (opts || {});
    const head = o.title || o.actions ? h("header", { class: "card-head" },
      h("h2", {}, o.icon ? icon(o.icon) : null, o.title || ""),
      o.tag ? h("span", { class: "card-tag" }, o.tag) : null,
      h("span", { class: "spacer" }),
      o.actions || null) : null;
    return h("section", { class: "card module" + (o.class ? " " + o.class : ""), id: o.id }, head,
      o.desc ? h("p", { class: "card-desc" }, o.desc) : null, ...children);
  }
  // 瀑布流：CSS grid + 每张卡按实际高度占 N 行（保持 DOM 顺序），列数按容器宽度算，
  // 卡片少于可放列数时卡片会变宽铺满，不会右边空一大块。窗口/日志面板/侧边栏变宽变窄都会实时重排。
  const MODULE_MIN_W = 320, MODULE_GAP = 18;
  const moduleObserver = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => {
    const boxes = new Set();
    for (const e of entries) boxes.add(e.target.classList.contains("modules") ? e.target : e.target.parentElement);
    for (const b of boxes) if (b) layoutModules(b);
  }) : null;
  function layoutModules(box) {
    if (!box.isConnected) return;
    const items = [...box.children].filter((c) => !c.hidden);
    if (document.documentElement.dataset.layout === "classic") {
      box.style.gridTemplateColumns = "";
      for (const c of items) c.style.gridRowEnd = "";
      return;
    }
    const w = box.clientWidth;
    if (!w) return;
    const fit = Math.max(1, Math.floor((w + MODULE_GAP) / (MODULE_MIN_W + MODULE_GAP)));
    const cols = Math.max(1, Math.min(fit, items.length || 1));
    box.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    for (const c of items) {
      c.style.gridRowEnd = "auto";
      const hgt = c.getBoundingClientRect().height;
      c.style.gridRowEnd = `span ${Math.max(1, Math.ceil(hgt + MODULE_GAP))}`;
    }
  }
  function modules(...children) {
    const box = h("div", { class: "modules" }, ...children);
    if (moduleObserver) {
      moduleObserver.observe(box);
      for (const c of box.children) moduleObserver.observe(c);
      // 后加进来的卡片也要观察
      new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) moduleObserver.observe(n);
        layoutModules(box);
      }).observe(box, { childList: true });
    }
    return box;
  }
  function relayoutModules() { for (const b of document.querySelectorAll(".modules")) layoutModules(b); }

  // ---------- 状态 ----------
  const pages = new Map(); // id → { def, section, root, rendered }
  let current = "";
  let settings = {};
  let started = false;
  const ctx = { api, h, $, icon, fmtTime, fmtDuration, debounce, get settings() { return settings; } };

  // ---------- 页面注册与导航 ----------
  function registerPage(def) {
    if (!def || !def.id || typeof def.render !== "function") throw new Error("registerPage 需要 id 和 render");
    if (pages.has(def.id)) throw new Error(`页面 ${def.id} 重复注册`);
    pages.set(def.id, { def, root: null, rendered: false });
    if (started) buildNav();
  }

  function sortedPages() {
    const list = [...pages.values()].map((p) => p.def);
    const key = (d) => [d.section === "system" ? 1 : 0, d.order ?? 100];
    return list.sort((a, b) => { const ka = key(a), kb = key(b); return ka[0] - kb[0] || ka[1] - kb[1]; });
  }

  function buildNav() {
    const nav = $("#nav");
    nav.textContent = "";
    let lastSection = null;
    for (const d of sortedPages()) {
      if (d.hidden) continue;
      const section = d.section === "system" ? "system" : "main";
      if (lastSection && section !== lastSection) nav.append(h("div", { class: "nav-sep" }));
      lastSection = section;
      nav.append(h("button", {
        class: "nav-item" + (d.id === current ? " active" : ""), dataset: { page: d.id }, title: d.title,
        onclick: () => navigate(d.id),
      }, icon(d.icon), h("span", { class: "nav-label" }, d.title), h("span", { class: "nav-badge", hidden: true })));
    }
  }

  // 导航角标：Shell.setBadge("tasks", 3)；传空 / 0 隐藏
  function setBadge(id, value) {
    const b = $(`#nav .nav-item[data-page="${CSS.escape(id)}"] .nav-badge`);
    if (!b) return;
    b.textContent = value ? String(value) : "";
    b.hidden = !value;
  }

  function navigate(id) {
    if (!pages.has(id)) id = sortedPages().find((d) => !d.hidden)?.id;
    if (!id) return;
    const prev = pages.get(current);
    const next = pages.get(id);
    if (prev && prev !== next && prev.root) {
      prev.root.hidden = true;
      try { prev.def.onHide && prev.def.onHide(prev.root, ctx); } catch (err) { reportError(err); }
    }
    if (!next.root) {
      next.root = h("section", { class: "page", id: `page-${id}` });
      $("#main").append(next.root);
    }
    if (!next.rendered) {
      next.rendered = true;
      try { next.def.render(next.root, ctx); } catch (err) { reportError(err); next.root.append(h("p", { class: "error" }, "页面出错：" + err.message)); }
    }
    next.root.hidden = false;
    current = id;
    for (const b of document.querySelectorAll("#nav .nav-item")) b.classList.toggle("active", b.dataset.page === id);
    document.title = `${next.def.title} - ${ctx.productName || ""}`.replace(/ - $/, "");
    if (location.hash !== "#" + id) history.replaceState(null, "", "#" + id);
    try { next.def.onShow && next.def.onShow(next.root, ctx); } catch (err) { reportError(err); }
    if (started && settings.lastPage !== id) saveSettings({ lastPage: id });
  }

  // 预先渲染某个页面（不切换过去），供需要页面元素常驻的场景
  function prerender(id) {
    const p = pages.get(id);
    if (!p || p.rendered) return;
    p.root = h("section", { class: "page", id: `page-${id}`, hidden: true });
    $("#main").append(p.root);
    p.rendered = true;
    try { p.def.render(p.root, ctx); } catch (err) { reportError(err); }
  }

  // ---------- 设置 ----------
  const pendingPatch = {};
  const flushSettings = debounce(() => {
    const patch = { ...pendingPatch };
    for (const k of Object.keys(pendingPatch)) delete pendingPatch[k];
    api.settings.set(patch).then((r) => { if (r && r.settings) settings = r.settings; });
  }, 250);
  // 先在本地生效（主题、侧边栏立刻变），再合并提交到主进程
  function saveSettings(patch) {
    Object.assign(settings, patch); Object.assign(pendingPatch, patch); flushSettings();
    if (!started) return;
    if ("theme" in patch) applyTheme();
    if ("sidebarCollapsed" in patch || "sidebarWidth" in patch) applySidebar();
    if (APPEARANCE_KEYS.some((k) => k in patch)) applyAppearance();
    for (const cb of settingListeners) { try { cb(patch, settings); } catch (err) { reportError(err); } }
  }

  const settingListeners = new Set();
  function onSettings(cb) { settingListeners.add(cb); return () => settingListeners.delete(cb); }

  // ---------- 主题 ----------
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  function applyTheme() {
    // 主进程把 nativeTheme.themeSource 设成了 theme，所以 prefers-color-scheme 已经跟着变
    const pref = settings.theme || "system";
    const dark = pref === "dark" || (pref === "system" && mq.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }
  mq.addEventListener("change", applyTheme);

  // ---------- 外观：主题色、背景、毛玻璃、性能模式、字体 ----------
  const APPEARANCE_KEYS = ["layout", "accent", "background", "backgroundDim", "glass", "performanceMode", "fontFamily", "fontCustom", "fontSize"];
  const FONT_STACKS = {
    system: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
    sans: '"Inter", "HarmonyOS Sans SC", "MiSans", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", system-ui, sans-serif',
    serif: '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "STSong", "SimSun", Georgia, serif',
    rounded: 'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", "Yuanti SC", "YouYuan", "Varela Round", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, "Sarasa Mono SC", "Noto Sans Mono CJK SC", monospace',
  };
  // 自定义字体名只留安全字符，防止写坏样式
  const cleanFontName = (v) => String(v || "").replace(/[^\p{L}\p{N} _\-,'"]/gu, "").trim().slice(0, 200);
  let bgImageLoaded = false;
  async function loadBackgroundImage(force) {
    if (bgImageLoaded && !force) return;
    bgImageLoaded = true;
    let url = "";
    try { url = await api.appearance.background(); } catch { /* ignore */ }
    const el = $("#bg");
    el.style.backgroundImage = url ? `url("${url}")` : "";
    el.classList.toggle("has-image", !!url);
  }
  function applyAppearance() {
    const root = document.documentElement;
    const s = settings;
    root.dataset.layout = s.layout === "classic" ? "classic" : "cards";
    root.dataset.accent = s.accent || "blue";
    const bg = s.background || "none";
    root.dataset.bg = bg;
    const perf = !!s.performanceMode;
    root.classList.toggle("perf", perf);
    root.classList.toggle("glass", bg !== "none" && !!s.glass && !perf);
    root.classList.toggle("has-bg", bg !== "none");
    $("#bg-dim").style.opacity = String(s.backgroundDim || 0);
    if (bg === "custom") loadBackgroundImage(false);
    const fam = s.fontFamily === "custom" ? (cleanFontName(s.fontCustom) ? cleanFontName(s.fontCustom) + ", " + FONT_STACKS.system : FONT_STACKS.system) : (FONT_STACKS[s.fontFamily] || FONT_STACKS.system);
    root.style.setProperty("--font", fam);
    root.style.setProperty("--font-size", (s.fontSize || 14) + "px");
    requestAnimationFrame(relayoutModules);
  }

  // ---------- 侧边栏：折叠 + 拖动宽度 ----------
  const MIN_W = 180, MAX_W = 360, SNAP_W = 120;
  function applySidebar() {
    const app = $("#app");
    app.classList.toggle("collapsed", !!settings.sidebarCollapsed);
    app.style.setProperty("--sidebar-w", (settings.sidebarWidth || 220) + "px");
    const btn = $("#btn-collapse");
    btn.textContent = "";
    btn.append(icon("chevron"));
    btn.title = settings.sidebarCollapsed ? "展开侧边栏（Ctrl/⌘ + B）" : "折叠侧边栏（Ctrl/⌘ + B）";
  }
  function toggleSidebar(force) {
    const v = typeof force === "boolean" ? force : !settings.sidebarCollapsed;
    saveSettings({ sidebarCollapsed: v });
    applySidebar();
  }
  function setupResizer() {
    const rz = $("#resizer");
    const app = $("#app");
    let dragging = false;
    rz.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      rz.setPointerCapture(e.pointerId);
      app.classList.add("resizing");
    });
    rz.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const x = e.clientX;
      if (x < SNAP_W) { if (!settings.sidebarCollapsed) { settings.sidebarCollapsed = true; applySidebar(); } return; }
      const w = Math.round(Math.min(MAX_W, Math.max(MIN_W, x)));
      settings.sidebarCollapsed = false;
      settings.sidebarWidth = w;
      applySidebar();
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { rz.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      app.classList.remove("resizing");
      saveSettings({ sidebarCollapsed: settings.sidebarCollapsed, sidebarWidth: settings.sidebarWidth });
    };
    rz.addEventListener("pointerup", end);
    rz.addEventListener("pointercancel", end);
    rz.addEventListener("dblclick", () => toggleSidebar());
    $("#btn-collapse").addEventListener("click", () => toggleSidebar());
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") { e.preventDefault(); toggleSidebar(); }
    });
  }

  // ---------- 提示条 ----------
  // Shell.toast("已保存") / Shell.toast("出错了", "error", 5000)；type: info | success | warn | error
  function toast(message, type = "info", ms = 3000) {
    const el = h("div", { class: `toast ${type}`, role: "status" }, message);
    $("#toasts").append(el);
    requestAnimationFrame(() => el.classList.add("show"));
    const close = () => { el.classList.remove("show"); setTimeout(() => el.remove(), 250); };
    el.addEventListener("click", close);
    if (ms > 0) setTimeout(close, ms);
    return close;
  }

  // 确认框（简单版）：await Shell.confirm("确定？")
  function confirmDialog(message, { okText = "确定", cancelText = "取消", danger = false } = {}) {
    return new Promise((resolve) => {
      const done = (v) => { overlay.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
      const onKey = (e) => { if (e.key === "Escape") done(false); if (e.key === "Enter") done(true); };
      const overlay = h("div", { class: "modal-overlay", onclick: (e) => { if (e.target === overlay) done(false); } },
        h("div", { class: "modal", role: "dialog", "aria-modal": "true" },
          h("p", { class: "modal-text" }, message),
          h("div", { class: "actions end" },
            h("button", { class: "btn", onclick: () => done(false) }, cancelText),
            h("button", { class: "btn " + (danger ? "danger" : "primary"), onclick: () => done(true) }, okText))));
      document.body.append(overlay);
      document.addEventListener("keydown", onKey);
      overlay.querySelector(".btn:last-child").focus();
    });
  }

  // ---------- 页面错误写进日志 ----------
  function reportError(err) {
    const msg = (err && (err.stack || err.message)) || String(err);
    try { api.logs.write("error", msg, "renderer"); } catch { /* ignore */ }
  }
  window.addEventListener("error", (e) => reportError(e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => reportError(e.reason));

  // 外壳启动完成后执行（页面脚本里用来订阅事件、初始化全局状态）
  const startHooks = [];
  function onStart(cb) { if (started) cb(ctx); else startHooks.push(cb); }

  // ---------- 启动（由 shell/boot.js 调用） ----------
  async function start() {
    const [info, s] = await Promise.all([api.info(), api.settings.get()]);
    settings = s;
    ctx.info = info;
    ctx.productName = info.productName;
    applyTheme();
    applyAppearance();
    applySidebar();
    setupResizer();
    api.appearance.onBackground(() => loadBackgroundImage(true));
    $("#app-name").textContent = info.productName;
    $("#brand-mark").textContent = (info.productName || "A").trim().slice(0, 1).toUpperCase();
    $("#app-version").textContent = "v" + info.version;
    const src = $("#app-source");
    src.textContent = info.source === "update" ? "已更新" : "内置";
    src.classList.toggle("update", info.source === "update");
    src.title = info.source === "update" ? `已更新的应用层（安装包版本 ${info.bundledVersion}）` : "安装包内置版本";
    src.hidden = false;

    api.settings.onChange(({ changed, settings: all }) => {
      // 本地还没提交的修改优先（拖动侧边栏时不被旧值覆盖）
      settings = { ...all, ...pendingPatch };
      if ("theme" in changed) applyTheme();
      if ("sidebarCollapsed" in changed || "sidebarWidth" in changed) applySidebar();
      if (APPEARANCE_KEYS.some((k) => k in changed)) applyAppearance();
      for (const cb of settingListeners) { try { cb(changed, settings); } catch (err) { reportError(err); } }
    });

    started = true;
    buildNav();
    for (const cb of startHooks) { try { await cb(ctx); } catch (err) { reportError(err); } }
    const fromHash = decodeURIComponent(location.hash.slice(1));
    navigate(pages.has(fromHash) ? fromHash : (pages.has(settings.lastPage) ? settings.lastPage : ""));
    window.addEventListener("hashchange", () => { const id = decodeURIComponent(location.hash.slice(1)); if (id && id !== current && pages.has(id)) navigate(id); });
  }

  window.Shell = {
    registerPage, navigate, prerender, onStart, setBadge, toast, confirm: confirmDialog,
    saveSettings, onSettings, getSettings: () => ({ ...settings }), toggleSidebar,
    h, $, icon, card, modules, fmtTime, fmtDuration, debounce, reportError, start,
    get current() { return current; }, ctx,
  };
})();
