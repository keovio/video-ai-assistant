"use strict";
// 配置：app.config.json 有效；默认值；安装包文件名与 electron-builder 配置一致
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const cfgLib = require("../lib/config");
const { tmp } = require("./helpers");

test("仓库里的 app.config.json 有效", () => {
  const c = cfgLib.loadConfig();
  assert.deepEqual(cfgLib.validateConfig(c), []);
  for (const k of ["appName", "productName", "appId", "repo", "tagPrefix", "channelTag", "mirrors"]) assert.ok(k in c, k);
});

test("缺文件时用默认值；占位仓库视为未配置", () => {
  const c = cfgLib.loadConfig(tmp());
  assert.equal(c.repo, "OWNER/REPO");
  assert.equal(c.tagPrefix, "v");
  assert.equal(c.channelTag, "latest-layer");
  assert.deepEqual(c.mirrors, ["", "https://ghfast.top/"]);
  assert.equal(cfgLib.isRepoConfigured(c), false);
  assert.equal(cfgLib.isRepoConfigured({ repo: "me/app" }), true);
});

test("validateConfig 报出错误字段", () => {
  const errs = cfgLib.validateConfig({ appName: "有 空格", productName: "", appId: "x", repo: "nope", tagPrefix: "v", channelTag: "", mirrors: "x" });
  assert.equal(errs.length, 6);
});

test("配置可以覆盖部分字段", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "app.config.json"), JSON.stringify({ repo: "me/app", tagPrefix: "app-v" }));
  const c = cfgLib.loadConfig(d);
  assert.equal(c.repo, "me/app");
  assert.equal(cfgLib.releaseTag(c, "1.0.0"), "app-v1.0.0");
  assert.equal(c.appName, "my-electron-app");
});

test("安装包地址与 electron-builder 的 artifactName 对得上", () => {
  const c = cfgLib.loadConfig();
  const eb = require("../electron-builder.config.js");
  assert.equal(eb.appId, c.appId);
  assert.equal(eb.productName, c.productName);
  const fill = (tpl, arch, ext) => tpl.replace("${version}", "1.2.3").replace("${arch}", arch).replace("${ext}", ext);
  const n = cfgLib.installerNames(c, "1.2.3");
  assert.equal(fill(eb.mac.artifactName, "arm64", "dmg"), n.mac.arm64);
  assert.equal(fill(eb.mac.artifactName, "x64", "dmg"), n.mac.x64);
  assert.equal(fill(eb.win.artifactName, "x64", "exe"), n.win);
  assert.equal(fill(eb.linux.artifactName, "x64", "AppImage"), n.linux);
  const u = cfgLib.installerUrls(c, "1.2.3");
  assert.equal(u.win, `https://github.com/${c.repo}/releases/download/${c.tagPrefix}1.2.3/${n.win}`);
  // 打包清单与 build/files.js 一致
  const files = require("../build/files");
  for (const d of files.DIRS) assert.ok(eb.files.includes(`${d}/**/*`), d);
  for (const f of files.FILES) assert.ok(eb.files.includes(f), f);
});
