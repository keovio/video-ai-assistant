"use strict";
// 发布小工具：tag/版本解析、增量包校验、安装包齐全检查、防降级
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { loadConfig, installerNames, installerUrls } = require("../lib/config");
const { tmp } = require("./helpers");

const TOOL = path.join(__dirname, "..", "scripts", "release-tools.js");
const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
const cfg = loadConfig();

test("config / tag / version-from-tag", () => {
  assert.equal(run("config", "repo").stdout.trim(), cfg.repo);
  assert.equal(run("tag", "1.2.3").stdout.trim(), cfg.tagPrefix + "1.2.3");
  assert.equal(run("version-from-tag", cfg.tagPrefix + "1.2.3").stdout.trim(), "1.2.3");
  assert.notEqual(run("version-from-tag", "nope-1.2.3").status, 0);
  assert.notEqual(run("version-from-tag", cfg.tagPrefix + "1.2").status, 0);
});

test("verify-layer 检查版本、sha、大小、地址", () => {
  const d = tmp();
  const buf = Buffer.from("layer-bytes");
  const m = {
    version: "1.2.3", electron: "33.4.11", bootstrap: 1, size: buf.length,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    asarUrl: `https://github.com/${cfg.repo}/releases/download/${cfg.tagPrefix}1.2.3/app-update.asar`,
    installers: installerUrls(cfg, "1.2.0"),
  };
  fs.writeFileSync(path.join(d, "app-update.asar"), buf);
  fs.writeFileSync(path.join(d, "app-update.json"), JSON.stringify(m));
  assert.equal(run("verify-layer", d, "1.2.3").status, 0);
  assert.notEqual(run("verify-layer", d, "1.2.4").status, 0);
  fs.writeFileSync(path.join(d, "app-update.asar"), "layer-bytez");
  assert.match(run("verify-layer", d, "1.2.3").stderr, /sha256/);
});

test("expect-installers / channel-ok", () => {
  const d = tmp();
  const n = installerNames(cfg, "2.0.0");
  for (const f of [n.mac.arm64, n.mac.x64, n.win]) fs.writeFileSync(path.join(d, f), "x");
  assert.match(run("expect-installers", d, "2.0.0").stderr, /linux-x64\.AppImage/);
  fs.writeFileSync(path.join(d, n.linux), "x");
  assert.equal(run("expect-installers", d, "2.0.0").status, 0);
  const ch = path.join(d, "latest.json");
  assert.equal(run("channel-ok", ch, "1.0.0").status, 0); // 通道不存在
  fs.writeFileSync(ch, JSON.stringify({ version: "1.5.0" }));
  assert.equal(run("channel-ok", ch, "1.5.1").status, 0);
  assert.notEqual(run("channel-ok", ch, "1.4.9").status, 0);
});
