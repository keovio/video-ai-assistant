"use strict";
// 设置存储
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createSettings, BASE_SCHEMA, normalize } = require("../lib/settings");
const { tmp } = require("./helpers");

test("默认值、写入、持久化", () => {
  const f = path.join(tmp(), "settings.json");
  const s = createSettings({ file: f });
  assert.equal(s.get("theme"), "system");
  assert.equal(fs.existsSync(f), false); // 没改过不写文件
  const r = s.set({ theme: "dark", sidebarWidth: 250 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changed, { theme: "dark", sidebarWidth: 250 });
  const again = createSettings({ file: f });
  assert.equal(again.get("theme"), "dark");
  assert.equal(again.get("sidebarWidth"), 250);
});

test("校验：非法值拒绝，数字夹到范围内，未知键报错，其余照常写入", () => {
  const s = createSettings({ file: path.join(tmp(), "s.json") });
  const r = s.set({ theme: "purple", zoom: 9, nope: 1, autoCheckUpdate: false });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
  assert.equal(s.get("theme"), "system");
  assert.equal(s.get("zoom"), 1.5);
  assert.equal(s.get("autoCheckUpdate"), false);
  assert.equal(normalize({ type: "number", min: 0, max: 10, step: 1 }, "3.6"), 4);
  assert.equal(normalize({ type: "bool" }, "true"), undefined);
});

test("文件里手改坏的值退回默认；坏 JSON 不崩", () => {
  const d = tmp();
  const f = path.join(d, "s.json");
  fs.writeFileSync(f, JSON.stringify({ theme: "x", sidebarWidth: 9999, logLevel: "debug", extra: 1 }));
  const s = createSettings({ file: f });
  assert.equal(s.get("theme"), "system");
  assert.equal(s.get("sidebarWidth"), 360);
  assert.equal(s.get("logLevel"), "debug");
  assert.equal(s.get("extra"), undefined);
  fs.writeFileSync(f, "{oops");
  assert.equal(createSettings({ file: f }).get("theme"), "system");
});

test("onChange 只在真正变化时触发；reset 恢复默认；扩展 schema", () => {
  const s = createSettings({ file: path.join(tmp(), "s.json"), schema: { ...BASE_SCHEMA, exportDir: { type: "string", default: "" } } });
  const seen = [];
  const off = s.onChange((c) => seen.push(c));
  s.set({ theme: "light" });
  s.set({ theme: "light" });
  s.set({ exportDir: "/tmp/x" });
  assert.deepEqual(seen, [{ theme: "light" }, { exportDir: "/tmp/x" }]);
  s.reset(["theme"]);
  assert.equal(s.get("theme"), "system");
  assert.equal(s.get("exportDir"), "/tmp/x");
  s.reset();
  assert.equal(s.get("exportDir"), "");
  off();
  s.set({ theme: "dark" });
  assert.equal(seen.length, 4);
});

test("外观设置：背景、遮罩步进、字体、日志面板宽度", () => {
  const s = createSettings({ file: path.join(tmp(), "a.json") });
  assert.equal(s.get("background"), "aurora");
  assert.equal(s.get("glass"), true);
  const r = s.set({ background: "night", backgroundDim: 0.3, fontFamily: "custom", fontCustom: "LXGW WenKai", fontSize: 30, logDockWidth: 100, logFontSize: 13.4 });
  assert.equal(r.ok, true);
  assert.equal(s.get("backgroundDim"), 0.3); // 没有浮点误差
  assert.equal(s.get("fontSize"), 18);
  assert.equal(s.get("logDockWidth"), 280);
  assert.equal(s.get("logFontSize"), 13);
  assert.equal(s.set({ background: "rainbow" }).ok, false);
  assert.equal(s.set({ accent: "violet" }).ok, true);
});
