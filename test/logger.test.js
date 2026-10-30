"use strict";
// 日志
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createLogger } = require("../lib/logger");
const { tmp } = require("./helpers");

test("级别过滤、作用域、写文件", () => {
  const dir = path.join(tmp(), "logs");
  const log = createLogger({ dir, level: "info" });
  log.debug("看不到");
  log.info("你好", { a: 1 });
  log.scope("net").warn("慢");
  log.error(new Error("坏了"));
  const all = log.entries();
  assert.deepEqual(all.map((e) => e.level), ["info", "warn", "error"]);
  assert.equal(all[0].message, "你好 { a: 1 }");
  assert.equal(all[1].scope, "net");
  assert.match(all[2].message, /Error: 坏了/);
  const text = fs.readFileSync(log.currentFile(), "utf8");
  assert.match(text, /\[INFO\] 你好/);
  assert.match(text, /\[WARN\] \[net\] 慢/);
  log.setLevel("debug");
  log.debug("现在能看到");
  assert.equal(log.entries().length, 4);
});

test("筛选：最低级别、关键字、afterId；内存条数上限；清空", () => {
  const log = createLogger({ maxEntries: 5 });
  for (let i = 0; i < 8; i++) log.info("msg " + i);
  log.warn("警告 abc");
  const e = log.entries();
  assert.equal(e.length, 5);
  assert.equal(e[e.length - 1].message, "警告 abc");
  assert.equal(log.entries({ level: "warn" }).length, 1);
  assert.equal(log.entries({ q: "ABC" }).length, 1);
  assert.equal(log.entries({ afterId: e[3].id }).length, 1);
  assert.equal(log.entries({ limit: 2 }).length, 2);
  log.clear();
  assert.equal(log.entries().length, 0);
});

test("onEntry 订阅；prune 删除过期文件", () => {
  const dir = tmp();
  let t = new Date(2026, 0, 20, 12).getTime();
  const log = createLogger({ dir, keepDays: 7, now: () => t });
  const got = [];
  const off = log.onEntry((e) => got.push(e.message));
  log.info("a");
  off();
  log.info("b");
  assert.deepEqual(got, ["a"]);
  fs.writeFileSync(path.join(dir, "app-2026-01-01.log"), "old");
  fs.writeFileSync(path.join(dir, "app-2026-01-15.log"), "recent");
  fs.writeFileSync(path.join(dir, "other.txt"), "keep");
  assert.equal(log.prune(), 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["app-2026-01-15.log", "app-2026-01-20.log", "other.txt"]);
});

test("写文件失败不影响内存日志", () => {
  const f = path.join(tmp(), "file");
  fs.writeFileSync(f, "x"); // 拿一个文件当目录 → mkdir 失败
  const log = createLogger({ dir: path.join(f, "logs") });
  log.info("仍然记录");
  assert.equal(log.entries().length, 1);
});
