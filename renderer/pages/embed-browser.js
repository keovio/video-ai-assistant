"use strict";
// 内嵌浏览器（0.5.1）：给即梦 / 抖音的内嵌视图套一个浏览器外壳——
// 工具栏（后退、前进、刷新/停止、主页、地址栏、在系统浏览器打开）+ 占满剩余高度的视口。
//
// 内嵌视图是原生层，永远压在网页 DOM 上面，所以这里还负责位置同步：
// - 视口位置变化（窗口缩放、日志面板开合/拖宽、侧栏变化、页面滚动）都重报（ResizeObserver + scroll）；
// - 只报视口在 #main 可视区里的那一部分，滚出去的部分不盖到页头；整块滚出可视区就隐藏；
// - 弹出确认框（.modal-overlay）时临时隐藏，否则对话框被视图盖住点不到。
//
// 用法：
//   const b = EmbedBrowser.create({ kind: "douyin", pageId: "douyin", title: "抖音",
//     api: api.video.douyin, autoOpen: true, emptyText: "…" });
//   容器.append(b.el);  页面 onShow 里 b.show()，onHide 里 b.hide()。
//   b.isOpen() 视图是否已打开。视口元素 id 为 `${kind}-view-placeholder`。
(function () {
  const { h, icon } = window.Shell;
  const app = window.app;
  const entries = [];

  function modalOpen() { return !!document.querySelector(".modal-overlay"); }

  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    const main = document.getElementById("main");
    const m = main ? main.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const left = Math.max(r.left, m.left), top = Math.max(r.top, m.top);
    const right = Math.min(r.right, m.right), bottom = Math.min(r.bottom, m.bottom);
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  function sync(e) {
    if (!e.active || !e.opened) return;
    const r = visibleRect(e.viewport);
    const shouldShow = document.body.contains(e.viewport) && r.width >= 50 && r.height >= 50 && !modalOpen();
    if (shouldShow) {
      e.api.setBounds({ x: r.x, y: r.y, width: r.width, height: r.height }).catch(() => {});
      if (!e.shown) { e.shown = true; e.api.show().catch(() => {}); }
    } else if (e.shown) {
      e.shown = false;
      e.api.hide().catch(() => {});
    }
  }

  const schedule = (() => {
    let raf = 0;
    return () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; entries.forEach(sync); }); };
  })();
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  window.addEventListener("resize", schedule);
  document.addEventListener("scroll", schedule, true);
  const start = () => {
    const m = document.getElementById("main");
    if (m && ro) ro.observe(m);
    new MutationObserver(() => entries.forEach(sync)).observe(document.body, { childList: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();

  function create({ kind, pageId, title, api, autoOpen = true, emptyText = "" }) {
    const btn = (name, label, onclick) => h("button", { class: "browser-btn", title: label, "aria-label": label, onclick }, icon(name));
    const nav = (action, arg) => app.video.embed.nav(kind, action, arg).catch(() => {});
    const back = btn("chevron", "后退", () => nav("back"));
    const fwd = btn("chevronRight", "前进", () => nav("forward"));
    const reload = btn("refresh", "刷新", () => nav(e.loading ? "stop" : "reload"));
    const home = btn("home", "主页", () => (e.opened ? nav("home") : open()));
    const ext = btn("external", "在系统浏览器打开", () => nav("external"));
    // 缩放：- 百分比 +，点百分比回到 100%；按站点记在本机（localStorage），下次打开自动套用
    const zoomKey = `embed.zoom.${kind}`;
    const savedZoom = () => { const z = Number(localStorage.getItem(zoomKey)); return z >= 0.5 && z <= 2 ? z : 1; };
    const zoomOut = btn("minus", "缩小（Ctrl/⌘ -）", () => nav("zoomOut"));
    const zoomIn = btn("plus", "放大（Ctrl/⌘ +）", () => nav("zoomIn"));
    const zoomLabel = h("button", { class: "browser-zoom", title: "恢复 100%（Ctrl/⌘ 0）", onclick: () => nav("zoom", 1) }, "100%");
    const lock = h("span", { class: "browser-lock" }, icon("lock"));
    const addr = h("input", { class: "browser-addr", spellcheck: "false", placeholder: kind === "douyin" ? "输入网址，或搜索抖音" : "输入网址" });
    addr.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && addr.value.trim()) { addr.blur(); if (e.opened) nav("go", addr.value.trim()); else open().then(() => nav("go", addr.value.trim())); }
      if (ev.key === "Escape") { addr.value = e.url || ""; addr.blur(); }
    });
    addr.addEventListener("focus", () => addr.select());
    const progress = h("div", { class: "browser-progress" });
    const status = h("div", { class: "browser-empty" },
      h("div", { class: "browser-empty-title" }, `正在打开${title}…`),
      emptyText ? h("p", { class: "muted small-text" }, emptyText) : null);
    const viewport = h("div", { class: "browser-viewport", id: `${kind}-view-placeholder` }, status);
    const el = h("div", { class: "browser", "data-kind": kind },
      h("div", { class: "browser-bar" }, back, fwd, reload, home,
        h("div", { class: "browser-addr-wrap" }, lock, addr),
        h("div", { class: "browser-zoom-group" }, zoomOut, zoomLabel, zoomIn), ext),
      progress, viewport);

    const e = { kind, pageId, api, viewport, active: false, opened: false, shown: false, loading: false, url: "", opening: null };
    entries.push(e);
    if (ro) ro.observe(viewport);

    function draw(st) {
      if (!st) return;
      e.loading = !!st.loading;
      e.url = st.url || e.url;
      back.disabled = !st.canGoBack;
      fwd.disabled = !st.canGoForward;
      ext.disabled = !e.opened;
      reload.replaceChildren(icon(e.loading ? "close" : "refresh"));
      reload.title = e.loading ? "停止" : "刷新";
      progress.classList.toggle("on", e.loading);
      lock.hidden = !/^https:/.test(e.url);
      if (st.zoom) {
        const z = Number(st.zoom) || 1;
        zoomLabel.textContent = Math.round(z * 100) + "%";
        zoomLabel.classList.toggle("changed", Math.abs(z - 1) > 0.001);
        zoomOut.disabled = !e.opened || z <= 0.5;
        zoomIn.disabled = !e.opened || z >= 2;
        if (e.opened) localStorage.setItem(zoomKey, String(z));
      }
      if (document.activeElement !== addr) addr.value = e.url || "";
    }
    draw({ canGoBack: false, canGoForward: false, zoom: savedZoom() });
    app.video.embed.onState((st) => { if (st && st.kind === kind) draw(st); });

    async function open() {
      if (e.opened) { schedule(); return true; }
      if (e.opening) return e.opening;
      status.replaceChildren(h("div", { class: "browser-empty-title" }, `正在打开${title}…`), emptyText ? h("p", { class: "muted small-text" }, emptyText) : "");
      e.opening = (async () => {
        try {
          const r = await api.open();
          if (!r || !r.ok) throw new Error((r && r.error) || `打开${title}失败`);
          e.opened = true;
          e.shown = true; // open() 已把视图挂上
          if (savedZoom() !== 1) await nav("zoom", savedZoom());
          // 页面已切走时立即收起
          if (!e.active) { e.shown = false; api.hide().catch(() => {}); }
          const s = await app.video.embed.nav(kind, "state").catch(() => null);
          if (s && s.state) draw(s.state);
          schedule();
          return true;
        } catch (err) {
          const raw = String((err && err.message) || err);
          const msg = /\(-1\d\d\)|ERR_(NAME|CONNECTION|INTERNET|NETWORK|TIMED_OUT|ADDRESS)/.test(raw) ? "网络连不上，请检查网络或代理后重试" : raw;
          api.hide().catch(() => {});
          e.shown = false;
          status.replaceChildren(
            h("div", { class: "browser-empty-title" }, `${title}没有打开`),
            h("p", { class: "muted small-text", title: raw }, msg),
            h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => open() }, "重试")));
          return false;
        } finally { e.opening = null; }
      })();
      return e.opening;
    }

    return {
      el,
      isOpen: () => e.opened,
      open,
      show() {
        e.active = true;
        e.shown = false;
        if (!e.opened && autoOpen) open();
        else schedule();
      },
      hide() {
        e.active = false;
        if (e.shown || e.opened) { e.shown = false; api.hide().catch(() => {}); }
      },
      refresh: schedule,
    };
  }

  window.EmbedBrowser = { create };
})();
