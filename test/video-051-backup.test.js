"use strict";
// 0.5.1：删除项目前自动快照、可恢复；数据文件读坏时先另存原文件
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createVideoStore } = require("../lib/video-store");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vbak-"));

test("删除一个项目只删它；删前快照可恢复全部项目", () => {
  const dir = tmp();
  const store = createVideoStore(dir);
  const a = store.createProject({ title: "A", shotCount: 2 }).project;
  const b = store.createProject({ title: "B", shotCount: 2 }).project;
  store.createProject({ title: "C", shotCount: 2 });
  const aShots = store.shotsOf(a.id).length;
  const bShots = store.shotsOf(b.id).length;
  assert.ok(aShots > 0 && bShots > 0);
  store.snapshot("删除项目“B”前");
  assert.strictEqual(store.removeProject(b.id), true);
  assert.deepStrictEqual(store.projects.list().map((p) => p.title).sort(), ["A", "C"]);
  assert.strictEqual(store.shotsOf(a.id).length, aShots);
  const backups = store.listBackups();
  assert.strictEqual(backups.length, 1);
  assert.strictEqual(backups[0].projectCount, 3);
  const r = store.restoreBackup(backups[0].id);
  assert.strictEqual(r.projectCount, 3);
  assert.strictEqual(store.shotsOf(b.id).length, bShots);
  // 恢复前自动备份了一份
  assert.strictEqual(store.listBackups().length, 2);
  // 重新打开仍是恢复后的数据
  assert.strictEqual(createVideoStore(dir).projects.count(), 3);
});

test("空 id / 不存在的 id 不会删任何东西", () => {
  const store = createVideoStore(tmp());
  store.createProject({ title: "A" });
  assert.strictEqual(store.removeProject(""), false);
  assert.strictEqual(store.removeProject(undefined), false);
  assert.strictEqual(store.removeProject("nope"), false);
  assert.strictEqual(store.projects.count(), 1);
});

test("恢复拒绝非法备份 id", () => {
  const store = createVideoStore(tmp());
  assert.throws(() => store.restoreBackup("../x"), /备份不存在/);
});

test("数据文件读坏时先另存 .corrupt，写盘前留 .bak", () => {
  const dir = tmp();
  const file = path.join(dir, "projects.json");
  fs.writeFileSync(file, "{ broken");
  const store = createVideoStore(dir);
  assert.strictEqual(store.projects.count(), 0);
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith("projects.json.corrupt-")));
  store.createProject({ title: "A" });
  store.createProject({ title: "B" });
  assert.ok(fs.existsSync(file + ".bak"));
});
