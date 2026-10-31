"use strict";
// 日志视图（日志页和右侧「运行日志」面板共用）+ 右侧运行日志面板。
//   Shell.createLogView({ compact }) → { el, toolbar, clear, copy, setFontSize }
//   Shell.toggleLogDock([true|false])   打开 / 收起右侧面板（Ctrl/⌘ + L）
//   Shell.registerLogScopes({ export: ["导出", "green"] })   模块名显示成中文彩色标签
//   Shell.setLogFocus((e, defaultRule) => …)                   自定义「重点」视图显示哪些
// 面板：顶部显示正在跑的后台任务（进度、停止）；日志一行「时间 · 模块 · 消息」，警告 / 错误整行染色，隔 2 分钟插时间分隔；
// 默认「重点」视图，可切「全部 / 警告 / 错误」；有后台任务开始时自动展开（设置 logAutoOpen 可关）。
// 面板可拖动左边缘调宽度（双击收起），A− / A+ 或 Ctrl/⌘ + 滚轮缩放字号；宽度、字号、开关都记在设置里。
(function () {
  const { h, icon } = window.Shell;
  const api = window.app;
  const MAX_ROWS = 2000;
  const LEVEL_TEXT = { debug: "调试", info: "信息", warn: "警告", error: "错误" };
  const RANK = { debug: 0, info: 1, warn: 2, error: 3 };
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const ts = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
  const LEVEL_ICON = { debug: "·", info: "i", warn: "!", error: "×" };
  const dayTime = (t) => { const d = new Date(t); const today = new Date(); const same = d.toDateString() === today.toDateString(); return (same ? "" : `${d.getMonth() + 1}月${d.getDate()}日 `) + `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  // 模块名 → 中文标签和颜色（任务的日志用任务标题做模块名）。业务模块用 Shell.registerLogScopes({ export: ["导出", "green"] }) 加；
  // 颜色可选 blue / violet / green / orange / teal / pink / gray，没登记的模块按名字自动配色
  const SCOPES = { main: ["应用", "gray"], shell: ["界面", "gray"], renderer: ["页面", "gray"], task: ["任务", "blue"], update: ["更新", "teal"], updater: ["更新", "teal"] };
  const PALETTE = ["blue", "violet", "green", "orange", "teal", "pink"];
  function scopeInfo(scope) {
    if (!scope) return { label: "", color: "gray" };
    if (SCOPES[scope]) return { label: SCOPES[scope][0], color: SCOPES[scope][1] };
    let n = 0; for (const ch of scope) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
    return { label: scope.length > 10 ? scope.slice(0, 10) + "…" : scope, color: PALETTE[n % PALETTE.length] };
  }
  // 「重点」视图：只看做成了什么和警告错误；调试、任务「开始：」、过程性的模块收起来，点「全部」才显示。
  // 业务里可以换规则：Shell.setLogFocus((e, defaultRule) => …) 返回 true 显示
  const MINOR_SCOPES = new Set(["shell", "renderer"]);
  function defaultImportant(e) {
    if (e.level === "error" || e.level === "warn") return true;
    if (e.level === "debug") return false;
    const m = e.message || "";
    if (e.scope === "task") return !/^开始：/.test(m);
    if (e.scope === "update" || e.scope === "updater") return /已下载|新版本|回滚|失败/.test(m);
    if (e.scope === "main") return /启动/.test(m);
    return !MINOR_SCOPES.has(e.scope);
  }
  let focusRule = null;
  const important = (e) => { try { return focusRule ? !!focusRule(e, defaultImportant) : defaultImportant(e); } catch { return defaultImportant(e); } };
  const line = (e) => `${ts(e.time)} [${e.level.toUpperCase()}]${e.scope ? ` [${e.scope}]` : ""} ${e.message}`;

  // 所有日志视图共用一份条目，只向主进程取一次
  const store = { entries: [], loaded: null, views: new Set() };
  function ensureLoaded() {
    if (!store.loaded) {
      store.loaded = api.logs.list({ limit: MAX_ROWS }).then((l) => { store.entries = l; for (const v of store.views) v.redraw(); });
      api.logs.onEntries((batch) => {
        store.entries.push(...batch);
        if (store.entries.length > MAX_ROWS) store.entries = store.entries.slice(-MAX_ROWS);
        for (const v of store.views) v.append(batch);
        for (const cb of entryHooks) { try { cb(batch); } catch { /* ignore */ } }
      });
    }
    return store.loaded;
  }
  const entryHooks = new Set();

  function iconBtn(name, title, onclick, cls = "") {
    return h("button", { class: "icon-btn " + cls, title, "aria-label": title, onclick }, icon(name));
  }

  function createLogView({ compact = false } = {}) {
    let level = compact ? "focus" : "";
    let query = "";
    let follow = true;

    const levelSel = compact
      ? h("div", { class: "log-chips", role: "radiogroup" }, ...[["focus", "重点"], ["", "全部"], ["warn", "警告"], ["error", "错误"]].map(([v, l]) =>
        h("button", { class: "log-chip" + (v === "focus" ? " active" : ""), title: v === "focus" ? "只看做成了什么和出错的地方" : "", dataset: { value: v }, onclick: (e) => {
          level = v; for (const b of levelSel.children) b.classList.toggle("active", b === e.currentTarget); redraw();
        } }, l)))
      : h("select", { class: "input input-sm", title: "最低级别", onchange: () => { level = levelSel.value; redraw(); } },
        h("option", { value: "" }, "全部"),
        ...["debug", "info", "warn", "error"].map((l) => h("option", { value: l }, `${LEVEL_TEXT[l]}+`)));
    const search = h("input", { class: "input input-sm grow", type: "search", placeholder: "搜索…", oninput: window.Shell.debounce(() => { query = search.value.trim().toLowerCase(); redraw(); }, 150) });
    const list = h("div", { class: "log-list" + (compact ? " compact" : ""), tabindex: "0" });
    const count = h("span", { class: "muted small log-count" });
    const followBtn = iconBtn("arrowDown", "自动滚动到最新", () => { follow = !follow; followBtn.classList.toggle("on", follow); if (follow) scrollEnd(); }, "on");

    const match = (e) => (!level || (level === "focus" ? important(e) : RANK[e.level] >= RANK[level])) && (!query || e.message.toLowerCase().includes(query) || e.scope.toLowerCase().includes(query));
    // 面板里的一条：紧凑的一行「时间 · 模块 · 消息」，警告 / 错误整行染色；隔了 2 分钟以上插一条时间分隔
    let lastTime = 0;
    const compactRow = (e) => {
      const nodes = [];
      if (e.time - lastTime > 120000) nodes.push(h("div", { class: "log-sep" }, h("span", {}, dayTime(e.time))));
      lastTime = e.time;
      const sc = scopeInfo(e.scope);
      const done = e.scope === "task" && / 完成（/.test(e.message);
      nodes.push(h("div", { class: `log-line ${e.level}${done ? " done" : ""}`, title: `${ts(e.time)} ${LEVEL_TEXT[e.level] || ""}` },
        h("span", { class: "log-time" }, ts(e.time).slice(0, 8)),
        h("span", { class: `log-tag tag-${sc.color}` }, sc.label || "·"),
        h("span", { class: "log-msg" }, e.level === "error" ? "✗ " : e.level === "warn" ? "⚠ " : done ? "✓ " : "", e.message)));
      return nodes;
    };
    const row = compact
      ? compactRow
      : (e) => h("div", { class: `log-row ${e.level}` },
        h("span", { class: "log-time" }, ts(e.time)),
        h("span", { class: "log-level" }, LEVEL_TEXT[e.level] || e.level),
        e.scope ? h("span", { class: "log-scope" }, e.scope) : null,
        h("span", { class: "log-msg" }, e.message));
    const scrollEnd = () => { list.scrollTop = list.scrollHeight; };
    const shown = () => store.entries.filter(match);
    function redraw() {
      const s = shown();
      lastTime = 0;
      list.replaceChildren(...s.slice(-MAX_ROWS).flatMap(row));
      count.textContent = `${s.length} 条`;
      if (follow) scrollEnd();
    }
    function append(batch) {
      const add = batch.filter(match);
      if (!add.length) return;
      const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
      list.append(...add.flatMap(row));
      while (list.childElementCount > MAX_ROWS) list.firstElementChild.remove();
      count.textContent = `${shown().length} 条`;
      if (follow && atEnd) scrollEnd();
    }
    async function copy() {
      await navigator.clipboard.writeText(shown().map(line).join("\n"));
      window.Shell.toast("已复制到剪贴板", "success");
    }
    async function clear() { await api.logs.clear(); store.entries = []; for (const v of store.views) v.redraw(); }
    function setFontSize(px) { list.style.fontSize = px + "px"; }

    // Ctrl/⌘ + 滚轮：缩放日志字号
    list.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      bumpFont(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });

    const toolbar = h("div", { class: "toolbar" }, levelSel, search, count, followBtn);
    const view = { list, toolbar, redraw, append, copy, clear, setFontSize, scrollEnd };
    store.views.add(view);
    setFontSize(window.Shell.getSettings().logFontSize || 12);
    ensureLoaded().then(redraw);
    return view;
  }

  function bumpFont(d) {
    const cur = window.Shell.getSettings().logFontSize || 12;
    const next = Math.min(18, Math.max(10, cur + d));
    if (next !== cur) window.Shell.saveSettings({ logFontSize: next });
  }

  // ---------- 右侧运行日志面板 ----------
  const MIN_W = 280, MAX_W = 900, MIN_MAIN = 360;
  let dockView = null;
  let unseen = 0;

  function maxWidth() {
    const side = document.getElementById("sidebar").getBoundingClientRect().width;
    return Math.max(MIN_W, Math.min(MAX_W, window.innerWidth - side - MIN_MAIN));
  }
  function applyDock() {
    const s = window.Shell.getSettings();
    const open = !!s.logDockOpen;
    const dock = document.getElementById("logdock");
    const rz = document.getElementById("dock-resizer");
    const btn = document.getElementById("btn-logdock");
    dock.hidden = !open; rz.hidden = !open;
    btn.setAttribute("aria-pressed", String(open));
    btn.classList.toggle("active", open);
    document.getElementById("app").style.setProperty("--dock-w", Math.min(maxWidth(), s.logDockWidth || 420) + "px");
    if (open) {
      if (!dockView) buildDock(dock);
      unseen = 0; drawDot();
      requestAnimationFrame(() => dockView.scrollEnd());
    }
    if (dockView) {
      dockView.setFontSize(s.logFontSize || 12);
      const sz = document.getElementById("logdock-size");
      if (sz) sz.textContent = String(s.logFontSize || 12);
    }
  }
  // 面板顶部：正在跑的后台任务（标题、当前步骤、进度条、停止）
  function taskPanel() {
    const box = h("div", { class: "dock-tasks", hidden: true });
    const live = new Map();
    // 进度条宽度用 style 属性赋值（CSP 不允许 style="" 字符串）
    const bar = (t) => { const b = h("div", { class: "bar" + (t.pct == null ? " indeterminate" : "") }); if (t.pct != null) b.style.width = Math.max(2, Math.min(100, t.pct)) + "%"; return h("div", { class: "progress" }, b); };
    const draw = () => {
      const list = [...live.values()].filter((t) => t.status === "running" || t.status === "queued");
      box.hidden = !list.length;
      box.replaceChildren(...list.map((t) => h("div", { class: "dock-task" },
        h("div", { class: "dock-task-head" },
          h("span", { class: "dock-task-dot" + (t.status === "queued" ? " queued" : "") }),
          h("span", { class: "dock-task-title" }, t.title),
          t.cancellable ? h("button", { class: "btn small ghost", onclick: () => api.tasks.cancel(t.id) }, "停止") : null),
        h("div", { class: "dock-task-msg" }, t.status === "queued" ? "排队中…" : (t.message || "进行中…")),
        bar(t))));
    };
    api.tasks.list().then((l) => { for (const t of l) live.set(t.id, t); draw(); }).catch(() => {});
    api.tasks.onChange((t) => { live.set(t.id, t); if (!(t.status === "running" || t.status === "queued")) setTimeout(() => { live.delete(t.id); draw(); }, 1500); draw(); });
    return box;
  }

  function buildDock(dock) {
    dockView = createLogView({ compact: true });
    dock.append(
      h("header", { class: "dock-head" },
        h("h2", {}, "运行日志"),
        h("span", { class: "spacer" }),
        h("div", { class: "zoom-ctl", title: "日志字号（Ctrl/⌘ + 滚轮）" },
          iconBtn("minus", "缩小字号", () => bumpFont(-1)),
          h("span", { id: "logdock-size", class: "small muted" }, String(window.Shell.getSettings().logFontSize || 12)),
          iconBtn("plus", "放大字号", () => bumpFont(1))),
        iconBtn("copy", "复制", () => dockView.copy()),
        iconBtn("trash", "清空", () => dockView.clear()),
        iconBtn("close", "收起（Ctrl/⌘ + L）", () => toggleLogDock(false))),
      taskPanel(),
      dockView.toolbar,
      dockView.list);
  }
  function toggleLogDock(force) {
    const v = typeof force === "boolean" ? force : !window.Shell.getSettings().logDockOpen;
    window.Shell.saveSettings({ logDockOpen: v });
  }
  function drawDot() {
    const dot = document.querySelector("#btn-logdock .tool-dot");
    if (dot) dot.hidden = !unseen;
  }
  function setupDockResizer() {
    const rz = document.getElementById("dock-resizer");
    const app = document.getElementById("app");
    let dragging = false;
    let width = 0;
    rz.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true; rz.setPointerCapture(e.pointerId); app.classList.add("resizing");
    });
    rz.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      width = Math.round(Math.min(maxWidth(), Math.max(MIN_W, window.innerWidth - e.clientX)));
      app.style.setProperty("--dock-w", width + "px");
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { rz.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      app.classList.remove("resizing");
      if (width) window.Shell.saveSettings({ logDockWidth: width });
    };
    rz.addEventListener("pointerup", end);
    rz.addEventListener("pointercancel", end);
    rz.addEventListener("dblclick", () => toggleLogDock(false));
  }

  window.Shell.createLogView = createLogView;
  window.Shell.toggleLogDock = toggleLogDock;
  window.Shell.logLine = line;
  window.Shell.registerLogScopes = (map) => { for (const [k, v] of Object.entries(map || {})) SCOPES[k] = Array.isArray(v) ? v : [String(v), "gray"]; for (const v of store.views) v.redraw(); };
  window.Shell.setLogFocus = (fn) => { focusRule = typeof fn === "function" ? fn : null; for (const v of store.views) v.redraw(); };

  window.Shell.onStart(() => {
    const btn = document.getElementById("btn-logdock");
    btn.prepend(icon("terminal"));
    btn.addEventListener("click", () => toggleLogDock());
    setupDockResizer();
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") { e.preventDefault(); toggleLogDock(); }
    });
    window.addEventListener("resize", window.Shell.debounce(applyDock, 100));
    window.Shell.onSettings((c) => { if ("logDockOpen" in c || "logDockWidth" in c || "logFontSize" in c) applyDock(); });
    ensureLoaded();
    // 面板收起时有新的错误：按钮上亮个红点
    entryHooks.add((batch) => {
      if (window.Shell.getSettings().logDockOpen) return;
      const n = batch.filter((e) => e.level === "error").length;
      if (n) { unseen += n; drawDot(); }
    });
    // 有后台任务开始时自动展开面板（设置里可关）
    const seen = new Set();
    api.tasks.onChange((t) => {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      if ((t.status === "running" || t.status === "queued") && window.Shell.getSettings().logAutoOpen !== false && !window.Shell.getSettings().logDockOpen) toggleLogDock(true);
    });
    applyDock();
  });
})();
