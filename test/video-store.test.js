"use strict";
// 视频存储：建项目/增删改镜头/排序/删除连带/非法字段 strip/持久化重开
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmp } = require("./helpers");
const { createVideoStore } = require("../lib/video-store");

const storeAt = () => createVideoStore(path.join(tmp(), "video"));

test("建项目：默认镜头数、order 连续、时间按估算排", () => {
  const store = storeAt();
  const { project, shots } = store.createProject({ title: "测试" }, 3);
  assert.equal(project.title, "测试");
  assert.equal(project.status, "draft");
  assert.equal(project.aspect, "9:16");
  assert.equal(shots.length, 3);
  assert.deepEqual(shots.map((s) => s.order), [0, 1, 2]);
  assert.ok(shots.every((s) => s.projectId === project.id));
  assert.ok(shots.every((s) => s.status === "pending"));
  assert.equal(store.projects.get(project.id).totalSeconds, 0);
});

test("镜头增删改：改口播后时间重算，删后 order 重新连续", () => {
  const store = storeAt();
  const { project } = store.createProject({ title: "T" }, 2);
  const s1 = store.updateShot(store.shotsOf(project.id)[0].id, { narration: "一二三四五六七八九" });
  assert.deepEqual([s1.start, s1.end], [0, 2]);
  assert.equal(store.projects.get(project.id).totalSeconds, 2);

  const added = store.addShot(project.id, { narration: "你好世界" });
  assert.equal(added.order, 2);
  let list = store.shotsOf(project.id);
  assert.deepEqual(list.map((s) => s.order), [0, 1, 2]);
  assert.equal(store.projects.get(project.id).totalSeconds, 2.9);

  assert.equal(store.removeShot(list[0].id), true);
  list = store.shotsOf(project.id);
  assert.deepEqual(list.map((s) => s.order), [0, 1]);
  assert.deepEqual([list[0].start, list[0].end], [0, 0]); // 剩下第一镜是空口播
  assert.equal(store.projects.get(project.id).totalSeconds, 0.9);
});

test("排序：reorder 按给定 id 顺序排，未列出的排后面", () => {
  const store = storeAt();
  const { project, shots } = store.createProject({ title: "T" }, 3);
  const [a, b, c] = shots;
  const reordered = store.reorderShots(project.id, [c.id, a.id]);
  assert.deepEqual(reordered.map((s) => s.id), [c.id, a.id, b.id]);
  assert.deepEqual(reordered.map((s) => s.order), [0, 1, 2]);
});

test("非法字段 strip：未知字段不进文件，相对路径校验", () => {
  const store = storeAt();
  const p = store.projects.upsert({ title: "T", hacked: true, totalSeconds: "bad" });
  assert.equal(p.hacked, undefined);
  assert.equal(p.totalSeconds, 0);
  const a1 = store.assets.upsert({ kind: "audio", path: "projects/p1/assets/a.mp3", hash: "ABCDEF", bytes: 12.9 });
  assert.equal(a1.hash, "abcdef");
  assert.equal(a1.bytes, 12);
  const a2 = store.assets.upsert({ kind: "audio", path: "../secret.mp3", hash: "zz" });
  assert.equal(a2.path, "");
  assert.equal(a2.hash, "");
  const r = store.renders.upsert({ projectId: p.id, status: "weird", pct: 150, outputPath: "/abs/out.mp4" });
  assert.equal(r.status, "queued");
  assert.equal(r.pct, 100);
  assert.equal(r.outputPath, "");
});

test("删除项目连带：镜头和渲染记录删，资产记录删、文件不删", () => {
  const store = storeAt();
  const dir = tmp();
  const store2 = createVideoStore(path.join(dir, "video"));
  const { project } = store2.createProject({ title: "T" }, 2);
  store2.renders.upsert({ projectId: project.id, status: "done" });
  const assetPath = path.join(dir, "video", "projects", project.id, "assets", "a.mp3");
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, "fake-audio");
  store2.assets.upsert({ kind: "audio", path: `projects/${project.id}/assets/a.mp3`, hash: "aa", bytes: 10 });
  const other = store2.createProject({ title: "Other" }, 1);

  assert.equal(store2.removeProject(project.id), true);
  assert.equal(store2.projects.get(project.id), null);
  assert.deepEqual(store2.shotsOf(project.id), []);
  assert.deepEqual(store2.renders.list({ projectId: project.id }), []);
  assert.equal(store2.assets.count(), 0);
  assert.equal(fs.existsSync(assetPath), true); // 文件保留
  assert.equal(store2.projects.count(), 1);
  assert.equal(store2.shotsOf(other.project.id).length, 1);
});

test("复制项目：新 id、标题加副本、镜头一起复制、状态回草稿", () => {
  const store = storeAt();
  const { project } = store.createProject({ title: "原片" }, 2);
  store.updateShot(store.shotsOf(project.id)[0].id, { narration: "你好世界", visual: "海边" });
  store.projects.upsert({ ...store.projects.get(project.id), status: "done" });
  const { project: copy, shots } = store.duplicateProject(project.id);
  assert.notEqual(copy.id, project.id);
  assert.equal(copy.title, "原片 副本");
  assert.equal(copy.status, "draft");
  assert.equal(shots.length, 2);
  assert.equal(shots[0].narration, "你好世界");
  assert.equal(shots[0].visual, "海边");
  assert.notEqual(shots[0].id, store.shotsOf(project.id)[0].id);
  assert.deepEqual(shots.map((s) => s.order), [0, 1]);
});

test("持久化重开：新实例读到同一批数据，order 与时间不变", () => {
  const dir = path.join(tmp(), "video");
  const s1 = createVideoStore(dir);
  const { project } = s1.createProject({ title: "持久" }, 2);
  s1.updateShot(s1.shotsOf(project.id)[0].id, { narration: "一二三四五六七八九" });
  const s2 = createVideoStore(dir);
  assert.equal(s2.projects.get(project.id).title, "持久");
  assert.equal(s2.projects.get(project.id).totalSeconds, 2);
  const shots = s2.shotsOf(project.id);
  assert.deepEqual(shots.map((s) => s.order), [0, 1]);
  assert.deepEqual([shots[0].start, shots[0].end], [0, 2]);
});
