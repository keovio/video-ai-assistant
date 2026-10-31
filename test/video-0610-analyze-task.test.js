"use strict";
// 0.6.10：视频分析走后台任务，可取消
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTaskManager } = require("../lib/tasks");
const { setupVideoIpc } = require("../lib/video-ipc");

function harness(fetchImpl) {
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const store = { analyses: { upsert: (x) => ({ id: "a1", ...x }) }, assets: { list: () => [] } };
  const tasks = createTaskManager({ throttleMs: 0 });
  setupVideoIpc({ ipcMain, store, videoDir: require("os").tmpdir(), tasks, fetchImpl,
    getAiSettings: () => ({ aiBaseUrl: "https://x.test/v1", aiModel: "m" }), getAiKey: () => "k" });
  const call = (ch, ...a) => handlers[ch]({}, ...a);
  return { call, tasks };
}

test("分析出现在后台任务里，取消后返回 cancelled", async () => {
  const fetchImpl = (_u, o) => new Promise((_res, rej) => {
    o.signal.addEventListener("abort", () => { const e = new Error("已取消"); e.code = "TASK_CANCELLED"; rej(e); });
  });
  const { call, tasks } = harness(fetchImpl);
  const p = call("video:douyin.analyze", { videoInfo: { caption: "测试" }, useFrames: false });
  await new Promise((r) => setTimeout(r, 20));
  const list = tasks.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].type, "video-analyze");
  assert.equal(list[0].status, "running");
  const c = await call("video:douyin.cancelAnalyze");
  assert.equal(c.cancelled, 1);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.cancelled, true);
  assert.equal(tasks.list()[0].status, "cancelled");
});
