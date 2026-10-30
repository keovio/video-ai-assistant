"use strict";
// 后台任务
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTaskManager } = require("../lib/tasks");
const { createLogger } = require("../lib/logger");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("运行、进度、结果；事件顺序", async () => {
  const tm = createTaskManager({ throttleMs: 0 });
  tm.register("count", { title: "计数", async handler({ n }, ctx) {
    for (let i = 1; i <= n; i++) { await sleep(1); ctx.progress((i / n) * 100, `${i}/${n}`); }
    return n * 2;
  } });
  const events = [];
  tm.onChange((t) => events.push(`${t.status}:${t.pct}`));
  const t = tm.run("count", { n: 4 });
  assert.equal(t.status, "running");
  assert.equal(t.title, "计数");
  const done = await tm.wait(t.id);
  assert.equal(done.status, "done");
  assert.equal(done.result, 8);
  assert.equal(done.pct, 100);
  assert.equal(done.message, "4/4");
  assert.deepEqual(events, ["queued:null", "running:null", "running:25", "running:50", "running:75", "running:100", "done:100"]);
});

test("失败与取消（运行中 / 排队中）", async () => {
  const tm = createTaskManager({ concurrency: 1, throttleMs: 0 });
  tm.register("boom", async () => { throw new Error("炸了"); });
  tm.register("slow", async (_p, ctx) => {
    for (let i = 0; i < 100; i++) { await sleep(5); ctx.throwIfCancelled(); }
  });
  const f = await tm.wait(tm.run("boom").id);
  assert.equal(f.status, "failed");
  assert.equal(f.error, "炸了");

  const a = tm.run("slow");
  const b = tm.run("slow");
  assert.equal(tm.get(b.id).status, "queued"); // 并发 1：第二个排队
  assert.equal(tm.cancel(b.id), true);
  assert.equal(tm.get(b.id).status, "cancelled");
  await sleep(12);
  tm.cancel(a.id);
  const ra = await tm.wait(a.id);
  assert.equal(ra.status, "cancelled");
  assert.equal(tm.cancel(a.id), false); // 已结束不能再取消
  assert.equal(tm.activeCount(), 0);
});

test("并发上限与排队顺序；single 任务只跑一个", async () => {
  const tm = createTaskManager({ concurrency: 2, throttleMs: 0 });
  let peak = 0, now = 0;
  tm.register("w", async () => { now++; peak = Math.max(peak, now); await sleep(10); now--; });
  const ids = [1, 2, 3, 4, 5].map(() => tm.run("w").id);
  await Promise.all(ids.map((id) => tm.wait(id)));
  assert.equal(peak, 2);
  assert.ok(tm.list().every((t) => t.status === "done"));

  tm.register("sync", { single: true, handler: () => sleep(10) });
  const s1 = tm.run("sync");
  const s2 = tm.run("sync");
  assert.equal(s1.id, s2.id);
  await tm.wait(s1.id);
});

test("忽略 signal 的任务被取消后结果也算取消；未注册的类型抛错", async () => {
  const tm = createTaskManager({ throttleMs: 0 });
  tm.register("stubborn", async () => { await sleep(10); return "x"; });
  const t = tm.run("stubborn");
  tm.cancel(t.id);
  assert.equal((await tm.wait(t.id)).status, "cancelled");
  assert.throws(() => tm.run("nope"), /没有这种任务/);
  assert.throws(() => tm.register("bad", {}), /handler/);
});

test("进度节流：快速更新合并，最后一次一定发出", async () => {
  const tm = createTaskManager({ throttleMs: 30 });
  tm.register("fast", async (_p, ctx) => { for (let i = 1; i <= 100; i++) ctx.progress(i); await sleep(50); });
  const pcts = [];
  tm.onChange((t) => { if (t.status === "running") pcts.push(t.pct); });
  await tm.wait(tm.run("fast").id);
  assert.ok(pcts.length < 10, `发了 ${pcts.length} 次`);
  assert.equal(pcts[pcts.length - 1], 100);
});

test("保留最近 N 个已结束任务；clearFinished；写日志", async () => {
  const logger = createLogger();
  const tm = createTaskManager({ keepFinished: 2, throttleMs: 0, logger });
  tm.register("q", { title: "快任务", handler: async () => {} });
  for (let i = 0; i < 4; i++) await tm.wait(tm.run("q").id);
  assert.equal(tm.list().length, 2);
  tm.clearFinished();
  assert.equal(tm.list().length, 0);
  assert.ok(logger.entries().some((e) => e.scope === "task" && /快任务 完成/.test(e.message)));
});
