"use strict";
// 读取 app.config.json —— 整个模板唯一的配置来源（启动器、更新器、打包、发布流程都从这里取名字）。
// 纯 Node，不依赖 Electron。
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DEFAULTS = {
  appName: "my-electron-app",
  productName: "示例应用",
  appId: "com.example.myelectronapp",
  repo: "OWNER/REPO",
  tagPrefix: "v",
  channelTag: "latest-layer",
  mirrors: ["", "https://ghfast.top/"],
};

// 校验配置，返回错误说明数组（空数组 = 合法）
function validateConfig(c) {
  const errs = [];
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(String(c.appName || ""))) errs.push("appName 只能用字母、数字、点、横线、下划线（用作数据目录和文件名）");
  if (!String(c.productName || "").trim()) errs.push("productName 不能为空");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(c.appId || ""))) errs.push("appId 格式应类似 com.example.app");
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(c.repo || ""))) errs.push("repo 格式应为 owner/name");
  if (!/^[\w.-]*$/.test(String(c.tagPrefix))) errs.push("tagPrefix 只能用字母、数字、点、横线");
  if (!/^[\w.-]+$/.test(String(c.channelTag || ""))) errs.push("channelTag 不能为空");
  if (!Array.isArray(c.mirrors)) errs.push("mirrors 必须是数组（\"\" 表示直连）");
  return errs;
}

// repo 还是占位符时，更新功能不可用（界面里会提示去改配置）
function isRepoConfigured(c) {
  return !!c && /^[\w.-]+\/[\w.-]+$/.test(String(c.repo || "")) && c.repo !== "OWNER/REPO";
}

function loadConfig(root = ROOT) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(root, "app.config.json"), "utf8")); } catch { /* 用默认值 */ }
  const c = { ...DEFAULTS, ...raw };
  if (c.tagPrefix == null) c.tagPrefix = "v";
  if (!Array.isArray(c.mirrors) || !c.mirrors.length) c.mirrors = [""];
  return c;
}

// 发布资产的文件名（electron-builder 配置和 build-layer 共用，保证安装包地址能算出来）
function installerNames(c, version) {
  return {
    mac: {
      arm64: `${c.appName}-${version}-mac-arm64.dmg`,
      x64: `${c.appName}-${version}-mac-x64.dmg`,
    },
    win: `${c.appName}-${version}-win-x64.exe`,
    linux: `${c.appName}-${version}-linux-x64.AppImage`,
  };
}

function releaseTag(c, version) { return `${c.tagPrefix || ""}${version}`; }
function releaseDownloadBase(c, tag) { return `https://github.com/${c.repo}/releases/download/${tag}`; }

// 某个版本的全部安装包下载地址（清单里的 installers 字段）
function installerUrls(c, version) {
  const base = releaseDownloadBase(c, releaseTag(c, version));
  const n = installerNames(c, version);
  return {
    mac: { arm64: `${base}/${n.mac.arm64}`, x64: `${base}/${n.mac.x64}` },
    win: `${base}/${n.win}`,
    linux: `${base}/${n.linux}`,
  };
}

module.exports = { ROOT, DEFAULTS, loadConfig, validateConfig, isRepoConfigured, installerNames, installerUrls, releaseTag, releaseDownloadBase };
