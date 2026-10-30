"use strict";
// electron-builder 配置：名字、appId、产物文件名全部来自 app.config.json，不在这里写死。
const { loadConfig } = require("./lib/config");
const files = require("./build/files");

const c = loadConfig(__dirname);

module.exports = {
  appId: c.appId,
  productName: c.productName,
  copyright: "Copyright © 2026 keovio",
  directories: { output: "release", buildResources: "build" },
  files: [...files.DIRS.map((d) => `${d}/**/*`), ...files.FILES, "package.json", "!**/.DS_Store", "!**/*.map"],
  asar: true,
  // 不在 CI 里自动发布（发布由 .github/workflows/release.yml 用 gh 完成）
  publish: null,
  mac: {
    target: [{ target: "dmg", arch: ["arm64", "x64"] }],
    category: "public.app-category.productivity",
    identity: null, // 没有 Apple 证书：afterPack 里做 ad-hoc 签名
    hardenedRuntime: false,
    gatekeeperAssess: false,
    artifactName: `${c.appName}-\${version}-mac-\${arch}.\${ext}`,
  },
  dmg: {
    title: `${c.productName} \${version}`,
    contents: [{ x: 150, y: 190 }, { x: 410, y: 190, type: "link", path: "/Applications" }],
    window: { width: 560, height: 380 },
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    artifactName: `${c.appName}-\${version}-win-x64.\${ext}`,
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
  },
  linux: {
    target: [{ target: "AppImage", arch: ["x64"] }],
    category: "Utility",
    executableName: c.appName,
    artifactName: `${c.appName}-\${version}-linux-x64.\${ext}`,
  },
  afterPack: "build/adhoc-sign.js",
  electronLanguages: ["zh_CN", "zh-CN", "en", "en-US"],
};
