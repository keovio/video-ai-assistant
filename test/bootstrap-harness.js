"use strict";
// 在纯 Node 里运行 boot/bootstrap.js：模拟 electron / original-fs，拦截 main.js 的加载。
// 用法：node test/bootstrap-harness.js <updatesDir> <layerBehavior: ok|throw> [--no-updates]
// 结果以一行 JSON 打印：{ loaded, boot, exitCode, relaunched, state }
const Module = require("module");
const path = require("path");
const fs = require("fs");

const [updatesDir, behavior] = process.argv.slice(2);
// 纯 Node 里没有 process.versions.electron：打桩成与测试清单相同的大版本
if (!process.versions.electron) Object.defineProperty(process.versions, "electron", { value: "33.4.11", enumerable: true });
process.env.APP_UPDATES_DIR = updatesDir;
const result = { loaded: null, exitCode: null, relaunched: false };
const handlers = {};
const fakeApp = {
  getPath: (k) => path.join(updatesDir, "..", "_" + k),
  setPath: () => {},
  getVersion: () => "0.0.0",
  relaunch: () => { result.relaunched = true; },
  exit: (code) => { result.exitCode = code; },
  on: (ev, fn) => { handlers[ev] = fn; },
  isReady: () => true,
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return { app: fakeApp };
  if (request === "original-fs") return fs;
  if (/main\.js$/.test(request) && path.isAbsolute(request)) {
    result.loaded = /\.asar[\\/]main\.js$/.test(request) ? "layer" : "bundled";
    if (result.loaded === "layer" && behavior === "throw") throw new Error("boom from layer");
    return {};
  }
  return origLoad.apply(this, arguments);
};
require("../boot/bootstrap.js");
const boot = global.__appBoot;
if (process.argv.includes("--good")) boot.markGood();
const state = (() => { try { return JSON.parse(fs.readFileSync(path.join(updatesDir, "state.json"), "utf8")); } catch { return null; } })();
console.log(JSON.stringify({ ...result, boot: { source: boot.source, version: boot.version, bundledVersion: boot.bundledVersion, rejected: boot.rejected }, state }));
