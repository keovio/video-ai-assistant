"use strict";
// 0.6.20 作品库：所有项目成片列表、缩略图、删除成片
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createVideoStore } = require("../lib/video-store");
const { setupVideoIpc } = require("../lib/video-ipc");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-"));
  const store = createVideoStore(dir);
  const ipcMain = { handlers: {}, handle(ch, fn) { this.handlers[ch] = fn; } };
  const runs = [];
  setupVideoIpc({ ipcMain, store, videoDir: dir, probe: () => 12.4,
    renderRun: async (args) => { runs.push(args); const out = args[args.length - 1]; fs.writeFileSync(out, "jpg"); } });
  return { dir, store, h: ipcMain.handlers, runs };
}

test("library.renders 跨项目列出成片，带项目名、是否存在、大小，最新在前", async () => {
  const { dir, store, h } = setup();
  const p1 = store.createProject({ title: "甲" }); const p2 = store.createProject({ title: "乙" });
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out/a.mp4"), "12345");
  store.renders.upsert({ projectId: p1.project ? p1.project.id : p1.id, status: "done", outputPath: "out/a.mp4", createdAt: 1 });
  store.renders.upsert({ projectId: p2.project ? p2.project.id : p2.id, status: "failed", error: "x" });
  const r = await h["video:library.renders"]({});
  assert.equal(r.ok, true);
  assert.equal(r.renders.length, 2);
  const done = r.renders.find((x) => x.status === "done");
  assert.equal(done.projectTitle, "甲");
  assert.equal(done.exists, true);
  assert.equal(done.sizeBytes, 5);
});

test("library.thumb 生成并缓存缩略图，返回 data URL 和时长；renders.remove 删记录和文件", async () => {
  const { dir, store, h, runs } = setup();
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  const mp4 = path.join(dir, "out/b.mp4");
  fs.writeFileSync(mp4, "x");
  const rec = store.renders.upsert({ projectId: "p", status: "done", outputPath: "out/b.mp4" });
  const t = await h["video:library.thumb"]({}, rec.id);
  assert.equal(t.ok, true);
  assert.match(t.thumb, /^data:image\/jpeg;base64,/);
  assert.equal(t.seconds, 12.4);
  await h["video:library.thumb"]({}, rec.id);
  assert.equal(runs.length, 1, "第二次用缓存");
  const del = await h["video:renders.remove"]({}, rec.id);
  assert.equal(del.ok, true);
  assert.equal(fs.existsSync(mp4), false);
  assert.equal(fs.existsSync(mp4 + ".thumb.jpg"), false);
  assert.equal(store.renders.get(rec.id), null);
});

test("合成中的成片不能删", async () => {
  const { store, h } = setup();
  const rec = store.renders.upsert({ projectId: "p", status: "running" });
  const r = await h["video:renders.remove"]({}, rec.id);
  assert.equal(r.ok, false);
});
