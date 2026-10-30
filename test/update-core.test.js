"use strict";
// 增量更新纯逻辑：版本比较、清单校验、启动选层、崩溃回滚、发布挑选、镜像、清理、错误翻译
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const core = require("../lib/update-core");
const { tmp, sha } = require("./helpers");

function putLayer(dir, version, { body = "layer " + version, electron = "33.2.1", bootstrap, corrupt = false, size } = {}) {
  const buf = Buffer.from(body);
  fs.writeFileSync(path.join(dir, `app-${version}.asar`), corrupt ? Buffer.from(body.slice(0, -1) + "#") : buf); // 大小不变、内容被改
  const m = { version, electron, sha256: sha(buf), size: size == null ? buf.length : size, file: `app-${version}.asar` };
  if (bootstrap != null) m.bootstrap = bootstrap;
  fs.writeFileSync(path.join(dir, `app-${version}.json`), JSON.stringify(m));
  return m;
}
const select = (dir, extra = {}) => core.selectLayer({ fsImpl: fs, updatesDir: dir, bundledVersion: "0.2.0", electron: "33.4.11", ...extra });

test("compareVersions 按语义化版本排序（含预发布）", () => {
  assert.equal(core.compareVersions("0.2.1", "0.2.0"), 1);
  assert.equal(core.compareVersions("0.2.0", "0.2.0"), 0);
  assert.equal(core.compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(core.compareVersions("1.0.0", "1.0.0-beta.1"), 1);
  assert.equal(core.compareVersions("1.0.0-beta.2", "1.0.0-beta.1"), 1);
  assert.equal(core.compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(core.compareVersions("garbage", "0.0.1"), -1);
  assert.equal(core.electronMajor("33.2.1"), 33);
  assert.equal(core.electronMajor(34), 34);
});

test("validateManifest / needsFullInstall", () => {
  const ok = { version: "0.2.1", electron: "33", sha256: "a".repeat(64), size: 10, asarUrl: "https://x/y" };
  assert.equal(core.validateManifest(ok, { requireUrl: true }), "");
  assert.match(core.validateManifest({ ...ok, version: "x" }), /版本/);
  assert.match(core.validateManifest({ ...ok, sha256: "zz" }), /sha256/);
  assert.match(core.validateManifest({ ...ok, size: 0 }), /size/);
  assert.match(core.validateManifest({ ...ok, asarUrl: "http://x" }, { requireUrl: true }), /下载地址/);
  assert.equal(core.validateManifest({ ...ok, installers: { mac: { arm64: "https://a", x64: "https://b" }, win: "https://c", linux: "https://d" } }), "");
  assert.match(core.validateManifest({ ...ok, installers: { win: "http://c" } }), /installers\.win/);
  assert.equal(core.needsFullInstall(ok, { electron: "33.4.0" }), "");
  assert.match(core.needsFullInstall({ ...ok, electron: "34.0.0" }, { electron: "33.4.0" }), /内核/);
  assert.match(core.needsFullInstall({ ...ok, bootstrap: 2 }, { electron: "33.4.0", bootProtocol: 1 }), /启动器/);
});

test("pickInstaller 按系统和架构挑完整安装包", () => {
  const inst = { mac: { arm64: "https://x/mac-arm64.dmg", x64: "https://x/mac-x64.dmg" }, win: "https://x/win.exe", linux: "https://x/linux.AppImage" };
  assert.equal(core.pickInstaller(inst, "darwin", "arm64"), "https://x/mac-arm64.dmg");
  assert.equal(core.pickInstaller(inst, "darwin", "x64"), "https://x/mac-x64.dmg");
  assert.equal(core.pickInstaller(inst, "win32", "x64"), "https://x/win.exe");
  assert.equal(core.pickInstaller(inst, "win32", "arm64"), "https://x/win.exe");
  assert.equal(core.pickInstaller(inst, "linux", "x64"), "https://x/linux.AppImage");
  assert.equal(core.pickInstaller({ mac: "https://x/universal.dmg" }, "darwin", "arm64"), "https://x/universal.dmg");
  assert.equal(core.pickInstaller(inst, "freebsd", "x64"), "");
  assert.equal(core.pickInstaller(null, "darwin", "arm64"), "");
});

test("selectLayer 选最新的合法应用层", () => {
  const d = tmp();
  putLayer(d, "0.2.1");
  putLayer(d, "0.2.2");
  const r = select(d);
  assert.equal(r.layer.version, "0.2.2");
  assert.equal(r.layer.asarPath, path.join(d, "app-0.2.2.asar"));
});

test("selectLayer：没有目录 / 版本不新 → 用内置", () => {
  assert.equal(select(path.join(tmp(), "nope")).layer, null);
  const d = tmp();
  putLayer(d, "0.1.9");
  putLayer(d, "0.2.0");
  const r = select(d);
  assert.equal(r.layer, null);
  assert.equal(r.rejected.length, 2);
});

test("selectLayer 拒绝 sha 不符 / 大小不符 / 内核大版本不同，并退到下一个", () => {
  const d = tmp();
  putLayer(d, "0.2.1");
  putLayer(d, "0.2.4", { corrupt: true });
  putLayer(d, "0.2.3", { electron: "34.0.0" });
  putLayer(d, "0.2.2", { size: 999 });
  const r = select(d);
  assert.equal(r.layer.version, "0.2.1");
  const why = Object.fromEntries(r.rejected.map((x) => [x.version, x.reason]));
  assert.match(why["0.2.4"], /sha256/);
  assert.match(why["0.2.3"], /内核/);
  assert.match(why["0.2.2"], /大小/);
  assert.ok(r.changed);
  assert.ok(r.state.bad["0.2.4"]);
});

test("selectLayer 跳过需要新启动器的层和损坏的清单", () => {
  const d = tmp();
  putLayer(d, "0.3.0", { bootstrap: 2 });
  fs.writeFileSync(path.join(d, "app-0.4.0.json"), "{not json");
  const r = select(d);
  assert.equal(r.layer, null);
  assert.equal(r.rejected.length, 2);
});

test("崩溃保护：连续 2 次没启动成功 → 标记坏版本，第 3 次用内置", () => {
  const d = tmp();
  putLayer(d, "0.2.1");
  let st = core.readState(fs, d);
  for (let i = 0; i < 2; i++) {
    const r = select(d, { state: st });
    assert.equal(r.layer.version, "0.2.1", "attempt " + i);
    core.beginBoot(r.state, "0.2.1");
    core.writeState(fs, d, r.state); // 然后崩溃：没有 markGood
    st = core.readState(fs, d);
  }
  const r3 = select(d, { state: st });
  assert.equal(r3.layer, null);
  assert.match(r3.state.bad["0.2.1"], /连续 2 次/);
});

test("成功启动后不再累计失败；第二个实例退出不算失败", () => {
  const d = tmp();
  putLayer(d, "0.2.1");
  const st = core.emptyState();
  core.beginBoot(st, "0.2.1");
  core.cancelBoot(st, "0.2.1");
  assert.equal(st.boots["0.2.1"].attempts, 0);
  core.beginBoot(st, "0.2.1"); core.beginBoot(st, "0.2.1");
  core.markGood(st, "0.2.1");
  core.beginBoot(st, "0.2.1"); core.beginBoot(st, "0.2.1");
  assert.equal(select(d, { state: st }).layer.version, "0.2.1");
  core.markBad(st, "0.2.1", "boom");
  assert.equal(select(d, { state: st }).layer, null);
});

test("state.json 读写与容错", () => {
  const d = tmp();
  assert.deepEqual(core.readState(fs, d), { bad: {}, boots: {} });
  fs.writeFileSync(path.join(d, "state.json"), "]]");
  assert.deepEqual(core.readState(fs, d), { bad: {}, boots: {} });
  core.writeState(fs, d, { bad: { "1.0.0": "x" }, boots: {} });
  assert.equal(core.readState(fs, d).bad["1.0.0"], "x");
  assert.deepEqual(fs.readdirSync(d), ["state.json"]); // 没有残留临时文件
  core.writeState(fs, path.join(d, "state.json", "x"), core.emptyState()); // 写不了也不抛错
});

test("pickRelease 只认 <前缀><版本号> 且带 app-update.json 的发布", () => {
  const rel = (tag, assets = ["app-update.json"], extra = {}) => ({ tag_name: tag, html_url: "h/" + tag, assets: assets.map((n) => ({ name: n, browser_download_url: `https://github.com/r/releases/download/${tag}/${n}` })), ...extra });
  const list = [rel("v0.2.0"), rel("v0.3.0", ["x.dmg"]), rel("v0.2.10"), rel("v0.4.0", undefined, { draft: true }), rel("latest-layer"), rel("vnext"), rel("app-v9.0.0")];
  const best = core.pickRelease(list, { tagPrefix: "v" });
  assert.equal(best.version, "0.2.10");
  assert.match(best.manifestUrl, /v0\.2\.10\/app-update\.json$/);
  assert.equal(core.pickRelease(list, { tagPrefix: "app-v" }).version, "9.0.0");
  assert.equal(core.pickRelease([rel("1.0.0"), rel("latest-layer")], { tagPrefix: "" }).version, "1.0.0");
  assert.equal(core.pickRelease([]), null);
});

test("mirrorUrls 只给 GitHub 地址加镜像并去重", () => {
  const u = "https://github.com/a/b/releases/download/t/f";
  assert.deepEqual(core.mirrorUrls(u, ["", "https://ghfast.top/"]), [u, "https://ghfast.top/" + u]);
  assert.deepEqual(core.mirrorUrls(u, ["https://ghfast.top"]), ["https://ghfast.top/" + u]);
  assert.deepEqual(core.mirrorUrls("https://cdn.example.com/x", ["https://ghfast.top/", ""]), ["https://cdn.example.com/x"]);
  assert.deepEqual(core.mirrorUrls(u, []), [u]);
});

test("filesToPrune 只保留当前版本和新版本", () => {
  const names = ["app-0.2.1.asar", "app-0.2.1.json", "app-0.2.2.asar", "app-0.2.2.json", "app-0.2.3.asar.download", "state.json"];
  assert.deepEqual(core.filesToPrune(names, ["0.2.2", ""]).sort(), ["app-0.2.1.asar", "app-0.2.1.json", "app-0.2.3.asar.download"]);
});

test("friendlyError 把技术错误翻译成中文", () => {
  assert.match(core.friendlyError("api.github.com：ENOTFOUND api.github.com").message, /网络连接失败/);
  assert.match(core.friendlyError("ghfast.top：连接超时").message, /超时/);
  assert.match(core.friendlyError("GitHub API api.github.com：HTTP 403").message, /限制/);
  assert.match(core.friendlyError("sha256 校验失败").message, /不完整/);
  assert.match(core.friendlyError("OWNER/REPO").message, /app\.config\.json/);
  assert.equal(core.friendlyError("x").detail, "x");
  assert.match(core.friendlyError("").message, /更新失败/);
});
