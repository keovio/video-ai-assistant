"use strict";
// 启动器：package.json 的 main。永远来自安装包内置的 app.asar（安装后从不修改）。
// 启动时到 <userData>/updates/ 找已下载的新应用层，校验通过就加载它的 main.js，否则加载内置应用层。
// 新应用层启动失败（抛异常 / 窗口加载完成后 10 秒内崩溃 / 连续 2 次没启动成功）会被标记为坏版本，并自动退回内置版本。
//
// 注意：这个文件和 lib/update-core.js、lib/fs-utils.js、lib/config.js 属于“启动器协议”。
// 改动它们的行为时要把 lib/update-core.js 的 BOOT_PROTOCOL 加 1 —— 旧安装包就会提示下载完整安装包，而不是加载新应用层。
const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const ofs = require("original-fs"); // 把 .asar 当普通文件读写（Electron 的 fs 会把它当目录）
const core = require("../lib/update-core");
const { loadConfig } = require("../lib/config");

const BUNDLED_ROOT = path.join(__dirname, "..");
const config = loadConfig(BUNDLED_ROOT);

// 数据目录固定为 <系统应用数据目录>/<appName>，开发运行和安装后一致：
//   macOS ~/Library/Application Support/<appName>    Windows %APPDATA%\<appName>    Linux ~/.config/<appName>
// app ready 之前就可以 getPath/setPath。
try { app.setPath("userData", path.join(app.getPath("appData"), config.appName)); } catch { /* 用 Electron 默认值 */ }
const UPDATES_DIR = process.env.APP_UPDATES_DIR || path.join(app.getPath("userData"), "updates");

function readPkgVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "0.0.0"; }
  catch { return app.getVersion(); }
}

const bundledVersion = readPkgVersion(BUNDLED_ROOT);
const electron = process.versions.electron;
const noUpdates = process.argv.includes("--no-updates") || process.env.APP_NO_UPDATES === "1";

let state = core.readState(ofs, UPDATES_DIR);
let picked = { layer: null, rejected: [], changed: false };
if (!noUpdates) {
  try {
    picked = core.selectLayer({ fsImpl: ofs, updatesDir: UPDATES_DIR, bundledVersion, electron, state });
    state = picked.state;
  } catch (err) {
    picked = { layer: null, rejected: [{ version: "?", reason: "选择应用层出错：" + (err && err.message) }], changed: false };
  }
}

const layer = picked.layer;
const info = {
  protocol: core.BOOT_PROTOCOL,
  bundledVersion,
  electron,
  updatesDir: UPDATES_DIR,
  noUpdates,
  source: layer ? "update" : "bundled",
  version: layer ? layer.version : bundledVersion,
  root: layer ? layer.asarPath : BUNDLED_ROOT,
  rejected: picked.rejected,
};

let settled = false; // 已确认“能正常启动”或已放弃
let detach = null;
function save() { core.writeState(ofs, UPDATES_DIR, state); }

function fallBack(reason) {
  if (settled || !layer) return;
  settled = true;
  core.markBad(state, layer.version, reason);
  save();
  try { console.error(`[boot] 应用层 ${layer.version} 启动失败，退回内置版本：${reason}`); } catch { /* ignore */ }
  // 主进程可能已经注册了一半的通道/窗口：最干净的做法是带原参数重启一次，下次会直接用内置层
  app.relaunch();
  app.exit(1);
}

if (layer) {
  core.beginBoot(state, layer.version);
  save();
  const onErr = (err) => fallBack(String((err && (err.stack || err.message)) || err));
  process.on("uncaughtException", onErr);
  process.on("unhandledRejection", onErr);
  detach = () => { process.removeListener("uncaughtException", onErr); process.removeListener("unhandledRejection", onErr); detach = null; };
} else if (picked.changed) {
  save();
}

let readyTimer = null;
const boot = {
  ...info,
  // 窗口加载完成：再观察 10 秒没崩就记为“可正常启动”
  markReady() {
    if (!layer || settled || readyTimer) return;
    readyTimer = setTimeout(() => boot.markGood(), 10000);
    if (readyTimer.unref) readyTimer.unref();
  },
  markGood() {
    if (!layer || settled) return;
    settled = true;
    if (detach) detach();
    core.markGood(state, layer.version);
    save();
  },
  // 第二个实例（拿不到单实例锁）马上退出：不算启动失败
  cancelLaunch() {
    if (!layer || settled) return;
    settled = true;
    if (detach) detach();
    state = core.readState(ofs, UPDATES_DIR);
    core.cancelBoot(state, layer.version);
    save();
  },
  fail(reason) { fallBack(reason); },
};
global.__appBoot = boot;

// 正常退出也算一次成功启动
app.on("will-quit", () => { if (layer && !settled && app.isReady()) boot.markGood(); });

const entry = path.join(info.root, "main.js");
if (layer) {
  try {
    require(entry);
  } catch (err) {
    fallBack("加载 main.js 出错：" + String((err && (err.stack || err.message)) || err));
  }
} else {
  require(entry);
}
