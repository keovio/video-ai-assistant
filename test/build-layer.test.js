"use strict";
// build-layer.js：真实打一个增量包到临时目录，校验 asar 内容和清单
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const core = require("../lib/update-core");
const { loadConfig } = require("../lib/config");
const { tmp } = require("./helpers");

const ROOT = path.join(__dirname, "..");
let asar = null;
try { asar = require("@electron/asar"); } catch { /* 没装依赖时跳过 */ }

test("build-layer 产出合法的 app-update.asar + app-update.json", { skip: !asar && "未安装 @electron/asar（先 npm install）", timeout: 60000 }, () => {
  const out = tmp();
  execFileSync(process.execPath, [path.join(ROOT, "build", "build-layer.js"), "--version", "9.8.7", "--installer-version", "9.8.0", "--out", out, "--notes", "测试说明"], { cwd: ROOT, stdio: "pipe" });
  const m = JSON.parse(fs.readFileSync(path.join(out, "app-update.json"), "utf8"));
  const buf = fs.readFileSync(path.join(out, "app-update.asar"));
  const cfg = loadConfig(ROOT);
  assert.equal(core.validateManifest(m, { requireUrl: true }), "");
  assert.equal(m.version, "9.8.7");
  assert.equal(m.size, buf.length);
  assert.equal(m.sha256, crypto.createHash("sha256").update(buf).digest("hex"));
  assert.equal(m.bootstrap, core.BOOT_PROTOCOL);
  assert.equal(m.notes, "测试说明");
  assert.equal(m.asarUrl, `https://github.com/${cfg.repo}/releases/download/${cfg.tagPrefix}9.8.7/app-update.asar`);
  assert.match(m.installers.win, new RegExp(`/${cfg.tagPrefix}9\\.8\\.0/${cfg.appName}-9\\.8\\.0-win-x64\\.exe$`));
  assert.ok(m.installers.mac.arm64 && m.installers.mac.x64 && m.installers.linux);
  const files = asar.listPackage(path.join(out, "app-update.asar")).map((p) => p.split(path.sep).join("/"));
  for (const f of ["/boot/bootstrap.js", "/main.js", "/preload.js", "/app.config.json", "/lib/update-core.js", "/renderer/index.html", "/package.json"]) assert.ok(files.includes(f), f);
  assert.ok(!files.some((f) => f.startsWith("/test") || f.startsWith("/node_modules") || f.startsWith("/.github")), "不应包含测试/依赖");
  const pkg = JSON.parse(asar.extractFile(path.join(out, "app-update.asar"), "package.json").toString());
  assert.equal(pkg.version, "9.8.7");
  assert.equal(pkg.main, "boot/bootstrap.js");
  assert.equal(pkg.devDependencies, undefined);
  // 本地安装这个层后，启动器能选中它
  const upd = tmp();
  fs.copyFileSync(path.join(out, "app-update.asar"), path.join(upd, "app-9.8.7.asar"));
  fs.writeFileSync(path.join(upd, "app-9.8.7.json"), JSON.stringify({ ...m, file: "app-9.8.7.asar" }));
  const sel = core.selectLayer({ fsImpl: fs, updatesDir: upd, bundledVersion: "0.1.0", electron: m.electron });
  assert.equal(sel.layer && sel.layer.version, "9.8.7");
});
