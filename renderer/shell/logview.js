"use strict";
// 日志视图（日志页和右侧「运行日志」面板共用）+ 右侧运行日志面板。
//   Shell.createLogView({ compact }) → { el, toolbar, clear, copy, setFontSize }
//   Shell.toggleLogDock([true|false])   打开 / 收起右侧面板（Ctrl/⌘ + L）
// 面板可拖动左边缘调宽度（双击收起），A− / A+ 或 Ctrl/⌘ + 滚轮缩放字号；宽度、字号、开关都记在设置里。
(function () {
  const { h, icon } = window.Shell;
  const api = window.app;
  const MAX_ROWS = 2000;
  const LEVEL_TEXT = { debug: "调试", info: "信息", warn: "警告", error: "错误" };
  const RANK = { debug: 0, info: 1, warn: 2, error: 3 };
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const ts = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
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
    let level = "";
    let query = "";
    let follow = true;

    const levelSel = h("select", { class: "input input-sm", title: "最低级别", onchange: () => { level = levelSel.value; redraw(); } },
      h("option", { value: "" }, "全部"),
      ...["debug", "info", "warn", "error"].map((l) => h("option", { value: l }, `${LEVEL_TEXT[l]}+`)));
    const search = h("input", { class: "input input-sm grow", type: "search", placeholder: "搜索…", oninput: window.Shell.debounce(() => { query = search.value.trim().toLowerCase(); redraw(); }, 150) });
    const list = h("div", { class: "log-list" + (compact ? " compact" : ""), tabindex: "0" });
    const count = h("span", { class: "muted small log-count" });
    const followBtn = iconBtn("arrowDown", "自动滚动到最新", () => { follow = !follow; followBtn.classList.toggle("on", follow); if (follow) scrollEnd(); }, "on");

    const match = (e) => (!level || RANK[e.level] >= RANK[level]) && (!query || e.message.toLowerCase().includes(query) || e.scope.toLowerCase().includes(query));
    const row = compact
      ? (e) => h("div", { class: `log-row ${e.level}` },
        h("span", { class: "log-time" }, ts(e.time).slice(0, 8)),
        h("span", { class: "log-msg" }, e.scope ? h("span", { class: "log-scope" }, e.scope + " ") : null, e.message))
      : (e) => h("div", { class: `log-row ${e.level}` },
        h("span", { class: "log-time" }, ts(e.time)),
        h("span", { class: "log-level" }, LEVEL_TEXT[e.level] || e.level),
        e.scope ? h("span", { class: "log-scope" }, e.scope) : null,
        h("span", { class: "log-msg" }, e.message));
    const scrollEnd = () => { list.scrollTop = list.scrollHeight; };
    const shown = () => store.entries.filter(match);
    function redraw() {
      const s = shown();
      list.replaceChildren(...s.slice(-MAX_ROWS).map(row));
      count.textContent = `${s.length} 条`;
      if (follow) scrollEnd();
    }
    function append(batch) {
      const add = batch.filter(match);
      if (!add.length) return;
      const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
      list.append(...add.map(row));
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
    applyDock();
  });
})();
