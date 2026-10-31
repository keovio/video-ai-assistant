"use strict";
// 内嵌视图（即梦 / 抖音）与页面占位元素的位置同步（0.5.0）。
//
// 内嵌视图是原生层，永远压在网页 DOM 上面，所以：
// - 位置要跟着占位元素走：窗口缩放、日志面板开合/拖宽、侧栏变化、页面滚动都要重报（ResizeObserver + scroll）；
// - 只报占位元素在 #main 可视区里的那一部分，滚出去的部分不盖到页头/别的内容上；整块滚出可视区就隐藏；
// - 弹出确认框（.modal-overlay）时临时隐藏，否则对话框被视图盖住点不到。
// 用法：EmbedSync.attach({ pageId, placeholderId, api: { setBounds, show, hide }, isOpen: () => bool })
(function () {
  const debounce = (window.Shell && window.Shell.debounce) || ((fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; });
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
    const root = document.getElementById("page-" + e.pageId);
    const el = document.getElementById(e.placeholderId);
    if (!root || root.hidden || !el) return;
    if (!e.isOpen()) return;
    const r = visibleRect(el);
    const shouldShow = r.width >= 50 && r.height >= 50 && !modalOpen();
    if (shouldShow) {
      e.api.setBounds({ x: r.x, y: r.y, width: r.width, height: r.height }).catch(() => {});
      if (!e.shown) { e.shown = true; e.api.show().catch(() => {}); }
    } else if (e.shown) {
      e.shown = false;
      e.api.hide().catch(() => {});
    }
  }

  function attach(opts) {
    const e = { ...opts, shown: false, observed: null };
    e.sync = debounce(() => sync(e), 60);
    entries.push(e);
    return {
      // 页面显示 / 视图刚打开时调用：重新观察占位元素并立即同步
      refresh() {
        const el = document.getElementById(e.placeholderId);
        if (el && e.observed !== el && ro) { if (e.observed) ro.unobserve(e.observed); ro.observe(el); e.observed = el; }
        e.shown = false;
        sync(e);
      },
      // 页面隐藏时调用：标记未显示（主进程那边由页面的 hide 调用负责）
      hidden() { e.shown = false; },
    };
  }

  const all = () => entries.forEach((e) => e.sync());
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(all) : null;
  window.addEventListener("resize", all);
  document.addEventListener("scroll", all, true);
  const mainEl = () => document.getElementById("main");
  const watchMain = () => { const m = mainEl(); if (m && ro) ro.observe(m); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchMain); else watchMain();
  // 对话框出现/消失时立即同步（隐藏或恢复视图）
  const mo = new MutationObserver(() => entries.forEach((e) => sync(e)));
  const startMo = () => mo.observe(document.body, { childList: true, subtree: false });
  if (document.body) startMo(); else document.addEventListener("DOMContentLoaded", startMo);

  window.EmbedSync = { attach };
})();
