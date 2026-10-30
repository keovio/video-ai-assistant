#!/usr/bin/env node
"use strict";
// 构建应用内增量更新包：<out>/app-update.asar + <out>/app-update.json（默认 out = release/）。
// 内容与 electron-builder 打进 app.asar 的一致（build/files.js 的清单 + 精简后的 package.json）。
// 应用层只有 JS/HTML/CSS，没有原生模块，所以在任何系统上构建都一样，一个包同时服务 macOS / Windows / Linux。
//
// 用法：npm run build:layer -- [--version 1.2.3] [--installer-version 1.2.0] [--out layer] [--notes "修复了…"]
//   --version            应用层版本号，默认 package.json 的 version
//   --installer-version  需要完整安装时指向哪个版本的安装包，默认与 --version 相同
//                        （只发增量、不发安装包时，填最近一次完整发布的版本号）
//   --out                输出目录，默认 release
//   --notes              更新说明（显示在应用里），默认 update-notes.txt 第一行
//
// 打包在系统临时目录里进行，写出后再校验一遍 sha256：某些同步盘 / 网络文件系统会让刚写的文件读回来不一致。
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { loadConfig, validateConfig, installerUrls, releaseTag, releaseDownloadBase } = require("../lib/config");
const { BOOT_PROTOCOL, parseVersion } = require("../lib/update-core");
const files = require("./files");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
const die = (msg) => { console.error("✗ " + msg); process.exit(1); };
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const cfg = loadConfig(ROOT);
const cfgErrs = validateConfig(cfg);
if (cfgErrs.length) die("app.config.json 有误：\n  " + cfgErrs.join("\n  "));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = opt("version", pkg.version);
const installerVersion = opt("installer-version", version);
if (!parseVersion(version) || /^v/.test(version)) die(`版本号格式不对：${version}（应类似 1.2.3）`);
if (!parseVersion(installerVersion) || /^v/.test(installerVersion)) die(`--installer-version 格式不对：${installerVersion}`);
const outDir = path.resolve(ROOT, opt("out", "release"));
if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
  die("package.json 有运行时依赖（dependencies）：增量包不含 node_modules，请改用完整安装包发布，或把依赖打包进 lib/");
}

function electronVersion() {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
    const v = lock.packages && lock.packages["node_modules/electron"] && lock.packages["node_modules/electron"].version;
    if (/^\d+\./.test(v || "")) return v;
  } catch { /* 再试 node_modules */ }
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", "electron", "package.json"), "utf8")).version; } catch { return ""; }
}
const electron = electronVersion();
if (!/^\d+\./.test(electron)) die("找不到 electron 版本：先运行 npm install");

let asar;
try { asar = require("@electron/asar"); }
catch { die("缺少 @electron/asar：运行 npm install（devDependencies 里有 @electron/asar@3.4.1）"); }

// ---- 1. 在临时目录里准备文件 ----
const work = fs.mkdtempSync(path.join(os.tmpdir(), "app-layer-"));
const stage = path.join(work, "app");
fs.mkdirSync(stage, { recursive: true });
const copied = [];
function copy(rel) {
  const relPosix = rel.split(path.sep).join("/");
  if (files.EXCLUDE.some((re) => re.test(relPosix))) return;
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) die(`build/files.js 里列出的 ${relPosix} 不存在`);
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) { for (const n of fs.readdirSync(src).sort()) copy(path.join(rel, n)); return; }
  fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
  fs.copyFileSync(src, path.join(stage, rel));
  copied.push(relPosix);
}
for (const d of files.DIRS) copy(d);
for (const f of files.FILES) copy(f);
// 与 electron-builder 写进 app.asar 的 package.json 一致：去掉 scripts / devDependencies 等
const slim = {};
for (const k of ["name", "productName", "version", "description", "main", "private", "license", "author"]) if (pkg[k] !== undefined) slim[k] = pkg[k];
slim.version = version;
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(slim, null, 2));

(async () => {
  // ---- 2. 打包并校验 ----
  const tmpAsar = path.join(work, "app-update.asar");
  await asar.createPackage(stage, tmpAsar);
  const buf = fs.readFileSync(tmpAsar);
  const hash = sha256(buf);
  const listed = asar.listPackage(tmpAsar).map((p) => p.split(path.sep).join("/"));
  for (const must of ["/boot/bootstrap.js", "/main.js", "/preload.js", "/package.json", "/app.config.json", "/renderer/index.html"]) {
    if (!listed.includes(must)) die(`增量包里缺少 ${must}`);
  }
  const packedPkg = JSON.parse(asar.extractFile(tmpAsar, "package.json").toString("utf8"));
  if (packedPkg.version !== version) die("增量包里的 package.json 版本不对");

  // ---- 3. 写到输出目录，读回来再校验一遍 ----
  fs.mkdirSync(outDir, { recursive: true });
  const outAsar = path.join(outDir, "app-update.asar");
  const outJson = path.join(outDir, "app-update.json");
  fs.rmSync(outAsar, { force: true });
  fs.copyFileSync(tmpAsar, outAsar);
  const back = fs.readFileSync(outAsar);
  if (back.length !== buf.length || sha256(back) !== hash) {
    die(`写出的 app-update.asar 校验不一致（文件系统问题）。请把项目复制到 ${os.tmpdir()} 下再运行，例如：\n  cp -r . /tmp/app && cd /tmp/app && npm run build:layer`);
  }

  let notes = opt("notes", "");
  if (!notes) { try { notes = fs.readFileSync(path.join(ROOT, "update-notes.txt"), "utf8").split(/\r?\n/)[0].trim(); } catch { /* 没有说明文件 */ } }
  const tag = releaseTag(cfg, version);
  const manifest = {
    version,
    electron,
    bootstrap: BOOT_PROTOCOL,
    sha256: hash,
    size: buf.length,
    asarUrl: `${releaseDownloadBase(cfg, tag)}/app-update.asar`,
    installers: installerUrls(cfg, installerVersion),
    releaseUrl: `https://github.com/${cfg.repo}/releases/tag/${tag}`,
    notes: notes || `${cfg.productName} ${version}`,
    publishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(outJson, JSON.stringify(manifest, null, 2) + "\n");
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`✓ 增量包：${path.relative(ROOT, outAsar)}（${copied.length + 1} 个文件，${(buf.length / 1024).toFixed(1)} KB）`);
  console.log(JSON.stringify(manifest, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
