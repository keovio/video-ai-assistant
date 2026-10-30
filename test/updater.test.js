"use strict";
// 更新器端到端（假 GitHub）：检查 → 下载 → 启动器选中新层；需要完整安装；通道后备；未配置仓库
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const core = require("../lib/update-core");
const { createUpdater } = require("../lib/updater");
const { installerUrls } = require("../lib/config");
const { tmp, sha, fakeFetch } = require("./helpers");

const CONFIG = { appName: "demo", productName: "演示", appId: "com.demo.app", repo: "me/demo", tagPrefix: "v", channelTag: "latest-layer", mirrors: [""] };

function fakeGithub({ version = "0.2.1", electron = "33.2.1", asar = Buffer.from("NEW LAYER"), config = CONFIG } = {}) {
  const tag = config.tagPrefix + version;
  const base = `https://github.com/${config.repo}/releases/download/${tag}`;
  const manifest = { version, electron, bootstrap: 1, sha256: sha(asar), size: asar.length, asarUrl: `${base}/app-update.asar`, installers: installerUrls(config, version), notes: "改进" };
  return {
    manifest, asar,
    routes: {
      [`https://api.github.com/repos/${config.repo}/releases?per_page=30`]: { body: [{ tag_name: tag, html_url: `https://github.com/${config.repo}/releases/tag/${tag}`, assets: [{ name: "app-update.json", browser_download_url: `${base}/app-update.json` }] }, { tag_name: "latest-layer", assets: [{ name: "app-update.json" }] }] },
      [`${base}/app-update.json`]: { body: manifest },
      [`${base}/app-update.asar`]: { body: asar },
    },
  };
}
const bootOf = (d, extra = {}) => ({ version: "0.2.0", bundledVersion: "0.2.0", source: "bundled", electron: "33.2.1", protocol: 1, updatesDir: d, ...extra });

test("检查 → 下载 → 启动器选中新应用层", async () => {
  const d = tmp();
  const gh = fakeGithub();
  const u = createUpdater({ fetchImpl: fakeFetch(gh.routes), fsImpl: fs, boot: bootOf(d), config: CONFIG, platform: "linux", arch: "x64" });
  assert.equal(u.info().repoConfigured, true);
  const c = await u.check();
  assert.equal(c.ok, true, c.error);
  assert.equal(c.available, true);
  assert.equal(c.needsFull, false);
  assert.match(c.installerUrl, /demo-0\.2\.1-linux-x64\.AppImage$/);
  const progress = [];
  const r = await u.download(c.manifest, (p) => progress.push(p.pct));
  assert.equal(r.ok, true, r.error);
  assert.equal(progress.at(-1), 100);
  assert.equal(u.info().downloaded, "0.2.1");
  assert.equal((await u.check()).alreadyDownloaded, true);
  const sel = core.selectLayer({ fsImpl: fs, updatesDir: d, bundledVersion: "0.2.0", electron: "33.9.0" });
  assert.equal(sel.layer.version, "0.2.1");
  assert.equal(fs.readFileSync(sel.layer.asarPath, "utf8"), "NEW LAYER");
});

test("重新下载会清掉旧版本文件和该版本的失败记录", async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "app-0.1.5.asar"), "old");
  fs.writeFileSync(path.join(d, "app-0.1.5.json"), "{}");
  core.writeState(fs, d, { bad: { "0.2.1": "boom" }, boots: {} });
  const gh = fakeGithub();
  const u = createUpdater({ fetchImpl: fakeFetch(gh.routes), fsImpl: fs, boot: bootOf(d), config: CONFIG });
  const c = await u.check();
  assert.equal(c.badBefore, "boom");
  assert.equal((await u.download(c.manifest)).ok, true);
  assert.deepEqual(fs.readdirSync(d).sort(), ["app-0.2.1.asar", "app-0.2.1.json", "state.json"]);
  assert.equal(core.readState(fs, d).bad["0.2.1"], undefined);
});

test("Electron 大版本变化 → 需要完整安装包，按系统给出下载地址，不下载", async () => {
  const d = tmp();
  const gh = fakeGithub({ electron: "34.0.0" });
  for (const [platform, arch, re] of [["darwin", "arm64", /mac-arm64\.dmg$/], ["darwin", "x64", /mac-x64\.dmg$/], ["win32", "x64", /win-x64\.exe$/]]) {
    const u = createUpdater({ fetchImpl: fakeFetch(gh.routes), fsImpl: fs, boot: bootOf(d), config: CONFIG, platform, arch });
    const c = await u.check();
    assert.equal(c.available, true);
    assert.equal(c.needsFull, true);
    assert.match(c.installerUrl, re);
    const r = await u.download(c.manifest);
    assert.equal(r.ok, false);
    assert.equal(r.needsFull, true);
  }
  assert.deepEqual(fs.readdirSync(d), []);
});

test("GitHub API 不可用时走固定通道；已是最新则 available=false", async () => {
  const d = tmp();
  const gh = fakeGithub();
  const calls = [];
  const routes = { "https://github.com/me/demo/releases/download/latest-layer/app-update.json": { body: gh.manifest } };
  const c = await createUpdater({ fetchImpl: fakeFetch(routes, calls), fsImpl: fs, boot: bootOf(d, { version: "0.2.1", source: "update" }), config: CONFIG }).check();
  assert.equal(c.ok, true, c.error);
  assert.equal(c.available, false);
  assert.ok(calls[0].startsWith("https://api.github.com/"));
});

test("镜像：直连失败自动换镜像下载", async () => {
  const d = tmp();
  const cfg = { ...CONFIG, mirrors: ["", "https://mirror.example/"] };
  const gh = fakeGithub({ config: cfg });
  const routes = {};
  for (const [url, r] of Object.entries(gh.routes)) routes[url.startsWith("https://github.com/") ? "https://mirror.example/" + url : url] = r;
  const u = createUpdater({ fetchImpl: fakeFetch(routes), fsImpl: fs, boot: bootOf(d), config: cfg });
  const c = await u.check();
  assert.equal(c.ok, true, c.error);
  const r = await u.download(c.manifest);
  assert.equal(r.ok, true, r.error);
  assert.match(r.source, /^https:\/\/mirror\.example\//);
});

test("仓库还是占位符 / 网络失败时返回中文提示", async () => {
  const d = tmp();
  const c1 = await createUpdater({ fetchImpl: fakeFetch({}), fsImpl: fs, boot: bootOf(d), config: { ...CONFIG, repo: "OWNER/REPO" } }).check();
  assert.equal(c1.ok, false);
  assert.match(c1.message, /app\.config\.json/);
  const c2 = await createUpdater({ fetchImpl: fakeFetch({}), fsImpl: fs, boot: bootOf(d), config: CONFIG }).check();
  assert.equal(c2.ok, false);
  assert.match(c2.message, /网络连接失败/);
  assert.match(c2.detail, /ENOTFOUND/);
});

test("清单被篡改（sha 不符）→ 下载失败，不留文件", async () => {
  const d = tmp();
  const gh = fakeGithub();
  gh.routes[gh.manifest.asarUrl] = { body: Buffer.from("EVIL LAYR") }; // 同样长度
  const u = createUpdater({ fetchImpl: fakeFetch(gh.routes), fsImpl: fs, boot: bootOf(d), config: CONFIG });
  const r = await u.download((await u.check()).manifest);
  assert.equal(r.ok, false);
  assert.match(r.message, /不完整/);
  assert.equal(core.selectLayer({ fsImpl: fs, updatesDir: d, bundledVersion: "0.2.0", electron: "33.2.1" }).layer, null);
});
