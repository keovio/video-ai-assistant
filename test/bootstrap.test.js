"use strict";
// 启动器（boot/bootstrap.js）在模拟的 Electron 里：选层、抛错回滚、连续失败回滚、--no-updates
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { tmp, sha } = require("./helpers");

const HARNESS = path.join(__dirname, "bootstrap-harness.js");
const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
const [ma, mi, pa] = bundled.split(".").map(Number);
const NEWER = `${ma}.${mi}.${pa + 1}`;

function boot(dir, behavior = "ok", ...flags) {
  const r = spawnSync(process.execPath, [HARNESS, dir, behavior, ...flags], { encoding: "utf8" });
  const line = r.stdout.trim().split("\n").pop();
  assert.ok(line, r.stderr);
  return JSON.parse(line);
}
function putLayer(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.from("fake asar " + version);
  fs.writeFileSync(path.join(dir, `app-${version}.asar`), buf);
  // harness 里 process.versions.electron 打桩为 33.4.11，清单写同一大版本
  fs.writeFileSync(path.join(dir, `app-${version}.json`), JSON.stringify({ version, electron: "33.0.0", sha256: sha(buf), size: buf.length, file: `app-${version}.asar` }));
}

test("没有新层 → 加载内置 main.js", () => {
  const r = boot(path.join(tmp(), "updates"));
  assert.equal(r.loaded, "bundled");
  assert.equal(r.boot.source, "bundled");
  assert.equal(r.boot.version, bundled);
});

test("有合法新层 → 加载新层；markGood 记为成功", () => {
  const d = path.join(tmp(), "updates");
  putLayer(d, NEWER);
  const r = boot(d, "ok", "--good");
  assert.equal(r.loaded, "layer");
  assert.equal(r.boot.source, "update");
  assert.equal(r.boot.version, NEWER);
  assert.equal(r.state.boots[NEWER].good, true);
});

test("新层 main.js 抛错 → 标记坏版本并重启；下次加载内置", () => {
  const d = path.join(tmp(), "updates");
  putLayer(d, NEWER);
  const r1 = boot(d, "throw");
  assert.equal(r1.loaded, "layer");
  assert.equal(r1.relaunched, true);
  assert.equal(r1.exitCode, 1);
  assert.match(r1.state.bad[NEWER], /boom from layer/);
  const r2 = boot(d);
  assert.equal(r2.loaded, "bundled");
  assert.ok(r2.boot.rejected.some((x) => /坏版本/.test(x.reason)));
});

test("新层连续 2 次没走到“启动成功” → 第 3 次加载内置", () => {
  const d = path.join(tmp(), "updates");
  putLayer(d, NEWER);
  assert.equal(boot(d).loaded, "layer"); // 没有 markGood = 崩溃
  assert.equal(boot(d).loaded, "layer");
  const r3 = boot(d);
  assert.equal(r3.loaded, "bundled");
  assert.match(r3.state.bad[NEWER], /连续 2 次/);
});

test("--no-updates → 忽略已下载的层", () => {
  const d = path.join(tmp(), "updates");
  putLayer(d, NEWER);
  assert.equal(boot(d, "ok", "--no-updates").loaded, "bundled");
});
