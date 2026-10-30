"use strict";
// 原子写 JSON 与锁文件
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const fu = require("../lib/fs-utils");
const { tmp } = require("./helpers");

test("writeJsonAtomic 自动建目录、不留临时文件；readJson 容错", () => {
  const d = tmp();
  const f = path.join(d, "a", "b", "data.json");
  fu.writeJsonAtomic(f, { x: 1 });
  assert.deepEqual(fu.readJson(f), { x: 1 });
  fu.writeJsonAtomic(f, { x: 2 });
  assert.deepEqual(fu.readJson(f), { x: 2 });
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ["data.json"]);
  fs.writeFileSync(f, "{oops");
  assert.equal(fu.readJson(f, "fallback"), "fallback");
  assert.equal(fu.readJson(path.join(d, "none.json"), null), null);
});

test("pidAlive", () => {
  assert.equal(fu.pidAlive(process.pid), true);
  assert.equal(fu.pidAlive(0), false);
  assert.equal(fu.pidAlive(-1), false);
});

test("锁：持有者活着 → 忙；持有者不在 / 超时 → 清掉残留锁", () => {
  const d = tmp();
  const f = path.join(d, "var", "task.lock");
  assert.equal(fu.acquireLock(f, 111111), "");
  // 当前进程持有锁 → 另一个 pid 取锁应失败
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
  assert.throws(() => fu.acquireLock(f, 222222), (e) => e.code === "LOCK_BUSY" && /已有任务在运行/.test(e.message));
  // 持有者活着但锁已超时 → 当作残留
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 10000 }));
  assert.match(fu.acquireLock(f, 222222, { staleMs: 5000 }), /已清理残留锁/);
  // 进程不存在 → 清掉残留锁
  fs.writeFileSync(f, JSON.stringify({ pid: 2 ** 22 + 12345, createdAt: Date.now() - 60000 }));
  assert.match(fu.acquireLock(f, 333333), /已清理残留锁/);
  // 只释放自己的锁
  fu.releaseLock(f, 444444);
  assert.equal(fs.existsSync(f), true);
  fu.releaseLock(f, 333333);
  assert.equal(fs.existsSync(f), false);
  // 锁文件损坏 → 视为残留
  fs.writeFileSync(f, "garbage");
  assert.match(fu.acquireLock(f, 555555), /已清理残留锁/);
});
