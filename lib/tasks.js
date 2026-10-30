"use strict";
// 后台任务：注册任务类型 → run 启动 → 报告进度 → 可取消；限制同时运行的个数，多出来的排队（纯 Node，可单测）。
//
//   tasks.register("export", {
//     title: "导出数据",
//     async handler(params, ctx) {
//       for (let i = 0; i < n; i++) {
//         ctx.throwIfCancelled();            // 或者把 ctx.signal 传给 fetch 等
//         ctx.progress((i + 1) / n * 100, `第 ${i + 1}/${n} 项`);
//       }
//       return { file };                     // 结果放进 task.result
//     },
//   });
//   tasks.run("export", { ... })            // 立即返回任务快照；await tasks.wait(id) 等结束
//
// 状态：queued → running → done | failed | cancelled。pct 为 null 表示进度未知（界面显示滚动条）。

const FINAL = new Set(["done", "failed", "cancelled"]);

function cancelError() { const e = new Error("任务已取消"); e.name = "AbortError"; e.code = "TASK_CANCELLED"; return e; }

function createTaskManager({ concurrency = 2, keepFinished = 50, throttleMs = 100, logger = null, now = Date.now } = {}) {
  const types = new Map();
  const tasks = new Map(); // id → 内部记录（按插入顺序）
  const listeners = new Set();
  let seq = 0;

  const snap = (t) => ({
    id: t.id, type: t.type, title: t.title, status: t.status, pct: t.pct, message: t.message,
    createdAt: t.createdAt, startedAt: t.startedAt, endedAt: t.endedAt,
    error: t.error, result: t.result, cancellable: !FINAL.has(t.status),
  });

  function emitNow(t) {
    t.lastEmit = now();
    if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    const s = snap(t);
    for (const cb of listeners) { try { cb(s); } catch { /* ignore */ } }
  }
  // 进度更新做节流；状态变化立即发
  function emitProgress(t) {
    if (!throttleMs) return emitNow(t);
    const wait = throttleMs - (now() - (t.lastEmit || 0));
    if (wait <= 0) return emitNow(t);
    if (!t.timer) t.timer = setTimeout(() => { t.timer = null; emitNow(t); }, wait);
  }

  function register(type, def) {
    const d = typeof def === "function" ? { handler: def } : def;
    if (!d || typeof d.handler !== "function") throw new Error(`任务 ${type} 缺少 handler`);
    types.set(type, { title: d.title || type, handler: d.handler, single: !!d.single });
  }

  const running = () => [...tasks.values()].filter((t) => t.status === "running").length;

  function prune() {
    const done = [...tasks.values()].filter((t) => FINAL.has(t.status));
    for (const t of done.slice(0, Math.max(0, done.length - keepFinished))) tasks.delete(t.id);
  }

  function pump() {
    for (const t of tasks.values()) {
      if (running() >= concurrency) break;
      if (t.status === "queued") start(t);
    }
  }

  function finish(t, status, extra = {}) {
    if (FINAL.has(t.status)) return;
    Object.assign(t, { status, endedAt: now() }, extra);
    if (status === "done") { t.pct = 100; }
    const log = logger && logger.scope ? logger.scope("task") : null;
    if (log) {
      const secs = t.startedAt ? ((t.endedAt - t.startedAt) / 1000).toFixed(1) : "0";
      if (status === "failed") log.error(`${t.title} 失败（${secs} 秒）：${t.error}`);
      else log.info(`${t.title} ${status === "done" ? "完成" : "已取消"}（${secs} 秒）`);
    }
    emitNow(t);
    t.resolve(snap(t));
    prune();
    pump();
  }

  function start(t) {
    t.status = "running";
    t.startedAt = now();
    if (logger && logger.scope) logger.scope("task").info(`开始：${t.title}`);
    emitNow(t);
    const ctx = {
      id: t.id,
      signal: t.ctl.signal,
      get cancelled() { return t.ctl.signal.aborted; },
      throwIfCancelled() { if (t.ctl.signal.aborted) throw cancelError(); },
      progress(pct, message) {
        if (FINAL.has(t.status)) return;
        if (pct === null || pct === undefined) t.pct = pct === null ? null : t.pct;
        else if (Number.isFinite(Number(pct))) t.pct = Math.max(0, Math.min(100, Math.round(Number(pct) * 10) / 10));
        if (message !== undefined) t.message = String(message);
        emitProgress(t);
      },
      log(...a) { if (logger && logger.scope) logger.scope(t.title).info(...a); },
    };
    Promise.resolve()
      .then(() => t.handler(t.params, ctx))
      .then(
        (result) => (t.ctl.signal.aborted ? finish(t, "cancelled") : finish(t, "done", { result: result === undefined ? null : result })),
        (err) => (t.ctl.signal.aborted || (err && err.code === "TASK_CANCELLED")
          ? finish(t, "cancelled")
          : finish(t, "failed", { error: (err && err.message) || String(err) })),
      );
  }

  function run(type, params = {}, { title } = {}) {
    const def = types.get(type);
    if (!def) throw new Error(`没有这种任务：${type}`);
    if (def.single) {
      const active = [...tasks.values()].find((t) => t.type === type && !FINAL.has(t.status));
      if (active) return snap(active); // 同类任务只允许一个：直接返回正在跑的那个
    }
    const t = {
      id: `t${now().toString(36)}-${++seq}`, type, title: title || def.title, handler: def.handler, params,
      status: "queued", pct: null, message: "", createdAt: now(), startedAt: 0, endedAt: 0,
      error: "", result: null, ctl: new AbortController(), lastEmit: 0, timer: null,
    };
    t.promise = new Promise((r) => { t.resolve = r; });
    tasks.set(t.id, t);
    emitNow(t);
    pump();
    return snap(t);
  }

  function cancel(id) {
    const t = tasks.get(id);
    if (!t || FINAL.has(t.status)) return false;
    t.message = "正在取消…";
    t.ctl.abort();
    if (t.status === "queued") finish(t, "cancelled");
    else emitNow(t);
    return true;
  }

  return {
    register,
    run,
    cancel,
    get: (id) => (tasks.has(id) ? snap(tasks.get(id)) : null),
    wait: (id) => (tasks.has(id) ? tasks.get(id).promise : Promise.resolve(null)),
    list: () => [...tasks.values()].map(snap),
    types: () => [...types.entries()].map(([type, d]) => ({ type, title: d.title })),
    clearFinished() { for (const t of [...tasks.values()]) if (FINAL.has(t.status)) tasks.delete(t.id); },
    cancelAll() { for (const t of [...tasks.values()]) cancel(t.id); },
    activeCount: () => [...tasks.values()].filter((t) => !FINAL.has(t.status)).length,
    onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
}

module.exports = { createTaskManager, cancelError };
