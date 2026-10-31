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

test("0.6.12：分析记录保存原地址、平台和标题", () => {
  const os = require("os"), path = require("path"), fs = require("fs");
  const { createVideoStore } = require("../lib/video-store");
  const store = createVideoStore(fs.mkdtempSync(path.join(os.tmpdir(), "va-")));
  const r = store.analyses.upsert({ sourceUrl: "https://www.bilibili.com/video/BV1xx", site: "bilibili", sourceTitle: "标题", scriptTitle: "T" });
  const got = store.analyses.get(r.id);
  assert.equal(got.sourceUrl, "https://www.bilibili.com/video/BV1xx");
  assert.equal(got.site, "bilibili");
  assert.equal(got.sourceTitle, "标题");
  assert.equal(store.analyses.upsert({ site: "evil" }).site, "");
});
