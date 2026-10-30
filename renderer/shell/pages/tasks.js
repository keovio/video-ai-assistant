"use strict";
// 内置页面：后台任务。也负责侧边栏底部的任务指示器和全局任务状态 Shell.tasks。
//   Shell.tasks.run("demo", { steps: 10 })   → 启动主进程注册的任务，返回任务快照（失败抛错）
//   Shell.tasks.subscribe((list, changed) => …)  → 任务变化时回调，返回取消订阅函数
(function () {
  const { h, icon, fmtDuration } = window.Shell;
  const api = window.app;
  const map = new Map();
  const subs = new Set();
  const STATUS = { queued: "排队中", running: "进行中", done: "已完成", failed: "失败", cancelled: "已取消" };
  const FINAL = new Set(["done", "failed", "cancelled"]);

  const list = () => [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
  function emit(changed) { const l = list(); for (const cb of subs) { try { cb(l, changed); } catch (err) { window.Shell.reportError(err); } } }

  const store = {
    list,
    get: (id) => map.get(id) || null,
    subscribe(cb) { subs.add(cb); cb(list(), null); return () => subs.delete(cb); },
    async run(type, params, opts) {
      const r = await api.tasks.run(type, params, opts);
      if (!r.ok) throw new Error(r.error);
      map.set(r.task.id, { ...(map.get(r.task.id) || {}), ...r.task });
      emit(r.task);
      return r.task;
    },
    cancel: (id) => api.tasks.cancel(id),
    async clearFinished() { await api.tasks.clearFinished(); for (const [id, t] of map) if (FINAL.has(t.status)) map.delete(id); emit(null); },
  };
  window.Shell.tasks = store;

  // ---- 侧边栏指示器 + 导航角标 + 完成提示 ----
  function updateIndicator(l, changed) {
    const active = l.filter((t) => !FINAL.has(t.status));
    const btn = document.getElementById("task-indicator");
    btn.hidden = active.length === 0;
    window.Shell.setBadge("tasks", active.length || "");
    if (active.length) {
      const known = active.filter((t) => typeof t.pct === "number");
      const pct = known.length ? known.reduce((s, t) => s + t.pct, 0) / known.length : null;
      document.getElementById("task-indicator-label").textContent = active.length === 1 ? `${active[0].title} ${pct === null ? "" : Math.round(pct) + "%"}` : `${active.length} 个任务进行中`;
      const bar = document.getElementById("task-indicator-bar");
      bar.classList.toggle("indeterminate", pct === null);
      bar.style.width = pct === null ? "" : pct + "%";
      btn.title = active.map((t) => `${t.title}：${t.message || STATUS[t.status]}`).join("\n");
    }
    if (changed && FINAL.has(changed.status) && window.Shell.current !== "tasks") {
      if (changed.status === "done") window.Shell.toast(`${changed.title} 已完成`, "success");
      else if (changed.status === "failed") window.Shell.toast(`${changed.title} 失败：${changed.error}`, "error", 6000);
    }
  }

  window.Shell.onStart(async () => {
    for (const t of await api.tasks.list()) map.set(t.id, t);
    api.tasks.onChange((t) => { const prev = map.get(t.id); const wasFinal = prev && FINAL.has(prev.status); map.set(t.id, t); emit(wasFinal ? null : t); });
    store.subscribe(updateIndicator);
    document.getElementById("task-indicator").addEventListener("click", () => window.Shell.navigate("tasks"));
  });

  // ---- 页面 ----
  // 每个任务一张卡片，按 id 复用：进度变化只改进度条和文字，避免「取消」按钮被频繁重建点不到
  function createCard(t) {
    const r = {};
    r.title = h("span", { class: "task-title" });
    r.badge = h("span", { class: "badge" });
    r.meta = h("span", { class: "muted small" });
    r.cancel = h("button", { class: "btn small", onclick: () => store.cancel(r.id) }, "取消");
    r.bar = h("div", { class: "bar" });
    r.progress = h("div", { class: "progress" }, r.bar);
    r.msg = h("p", { class: "muted small task-msg" });
    r.err = h("p", { class: "error small" });
    r.el = h("div", { class: "task-card" },
      h("div", { class: "task-head" }, r.title, r.badge, h("span", { class: "spacer" }), r.meta, r.cancel),
      r.progress, r.msg, r.err);
    updateCard(r, t);
    return r;
  }
  function updateCard(r, t) {
    r.id = t.id;
    const final = FINAL.has(t.status);
    const indeterminate = t.status === "running" && typeof t.pct !== "number";
    r.el.className = `task-card status-${t.status}`;
    r.title.textContent = t.title;
    r.badge.className = `badge ${t.status}`;
    r.badge.textContent = STATUS[t.status] || t.status;
    const elapsed = t.startedAt ? fmtDuration((t.endedAt || Date.now()) - t.startedAt) : "";
    r.meta.textContent = [typeof t.pct === "number" && !final ? `${Math.round(t.pct)}%` : "", elapsed].filter(Boolean).join(" · ");
    r.cancel.hidden = !t.cancellable;
    r.progress.hidden = FINAL.has(t.status);
    r.bar.classList.toggle("indeterminate", indeterminate);
    r.bar.classList.toggle("failed", t.status === "failed");
    r.bar.style.width = indeterminate ? "" : (t.status === "done" ? 100 : t.pct || 0) + "%";
    r.msg.textContent = t.message || "";
    r.msg.hidden = !t.message || t.status === "failed";
    r.err.textContent = t.error || "";
    r.err.hidden = t.status !== "failed";
  }

  window.Shell.registerPage({
    id: "tasks", title: "后台任务", icon: "tasks", section: "system", order: 10,
    render(root) {
      const activeBox = h("div", { class: "task-list" });
      const doneBox = h("div", { class: "task-list" });
      const empty = h("div", { class: "empty" }, "没有正在运行的任务");
      const doneHead = h("div", { class: "section-head" }, h("h2", {}, "最近完成"), h("span", { class: "spacer" }), h("button", { class: "btn small ghost", onclick: () => store.clearFinished() }, "清除"));
      root.append(
        h("header", { class: "page-head" },
          h("div", {}, h("h1", {}, "后台任务"), h("p", { class: "sub" }, "耗时的操作在后台运行，可以随时切到别的页面")),
          h("button", { class: "btn", onclick: () => store.run("demo").catch((e) => window.Shell.toast(e.message, "error")) }, "运行示例任务")),
        h("div", { class: "section-head" }, h("h2", {}, "进行中")), activeBox, empty, doneHead, doneBox);
      const cards = new Map();
      let timer = null;
      const place = (box, items) => {
        items.forEach((t, i) => {
          let r = cards.get(t.id);
          if (!r) { r = createCard(t); cards.set(t.id, r); } else updateCard(r, t);
          if (box.children[i] !== r.el) box.insertBefore(r.el, box.children[i] || null);
        });
      };
      const draw = (l) => {
        const active = l.filter((t) => !FINAL.has(t.status));
        const done = l.filter((t) => FINAL.has(t.status));
        for (const [id, r] of cards) if (!l.some((t) => t.id === id)) { r.el.remove(); cards.delete(id); }
        place(activeBox, active);
        place(doneBox, done);
        empty.hidden = active.length > 0;
        doneHead.hidden = doneBox.hidden = done.length === 0;
        // 有任务在跑时每秒刷新一次耗时
        if (active.length && !timer) timer = setInterval(() => draw(store.list()), 1000);
        if (!active.length && timer) { clearInterval(timer); timer = null; }
      };
      store.subscribe(draw);
    },
  });

  void icon;
})();
