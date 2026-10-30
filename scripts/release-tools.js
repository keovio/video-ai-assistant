#!/usr/bin/env node
"use strict";
// 发布流程（.github/workflows/*.yml）用的小工具，所有名字都从 app.config.json 读取。
//   node scripts/release-tools.js config <字段>                 打印配置字段（repo / tagPrefix / channelTag / appName …）
//   node scripts/release-tools.js version-from-tag <tag>        从 tag 取版本号（校验前缀和格式），打印版本号
//   node scripts/release-tools.js tag <version>                 打印 tag（tagPrefix + version）
//   node scripts/release-tools.js verify-layer <目录> <version> 校验 <目录>/app-update.asar + app-update.json
//   node scripts/release-tools.js expect-installers <目录> <version>  检查三个系统的安装包都在
//   node scripts/release-tools.js channel-ok <channel.json|-> <version>  通道里已有更新的版本时失败（防止降级）
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadConfig, installerNames, releaseTag, releaseDownloadBase } = require("../lib/config");
const core = require("../lib/update-core");

const cfg = loadConfig(path.join(__dirname, ".."));
const [cmd, a, b] = process.argv.slice(2);
const fail = (msg) => { console.error("✗ " + msg); process.exit(1); };
const isVersion = (v) => !!core.parseVersion(v) && /^\d/.test(String(v));

switch (cmd) {
  case "config": {
    if (!(a in cfg)) fail("没有这个配置字段：" + a);
    console.log(Array.isArray(cfg[a]) ? JSON.stringify(cfg[a]) : String(cfg[a]));
    break;
  }
  case "version-from-tag": {
    const tag = String(a || "");
    if (!tag.startsWith(cfg.tagPrefix)) fail(`tag ${tag} 不是以 "${cfg.tagPrefix}" 开头（app.config.json 的 tagPrefix）`);
    const v = tag.slice(cfg.tagPrefix.length);
    if (!isVersion(v)) fail(`tag ${tag} 里的版本号格式不对`);
    console.log(v);
    break;
  }
  case "tag": {
    if (!isVersion(a)) fail("版本号格式不对：" + a);
    console.log(releaseTag(cfg, a));
    break;
  }
  case "verify-layer": {
    const dir = a, v = b;
    const m = JSON.parse(fs.readFileSync(path.join(dir, "app-update.json"), "utf8"));
    const buf = fs.readFileSync(path.join(dir, "app-update.asar"));
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const err = core.validateManifest(m, { requireUrl: true });
    if (err) fail("清单无效：" + err);
    if (m.version !== v) fail(`版本不符：清单是 ${m.version}，要发布的是 ${v}`);
    if (sha !== m.sha256 || buf.length !== m.size) fail(`sha256/大小不符：实际 ${sha} ${buf.length}，清单 ${m.sha256} ${m.size}`);
    const want = `${releaseDownloadBase(cfg, releaseTag(cfg, v))}/app-update.asar`;
    if (m.asarUrl !== want) fail(`asarUrl 不对：${m.asarUrl}，应为 ${want}`);
    if (m.bootstrap !== core.BOOT_PROTOCOL) console.log(`::warning::清单的 bootstrap=${m.bootstrap}，当前代码是 ${core.BOOT_PROTOCOL}`);
    console.log(`✓ 增量包校验通过：${v} ${sha} ${buf.length} 字节，Electron ${m.electron}`);
    break;
  }
  case "expect-installers": {
    const dir = a, v = b;
    const n = installerNames(cfg, v);
    const want = [n.mac.arm64, n.mac.x64, n.win, n.linux];
    const have = new Set(fs.readdirSync(dir));
    const missing = want.filter((f) => !have.has(f));
    if (missing.length) fail("缺少安装包：" + missing.join(", ") + "\n现有：" + [...have].join(", "));
    console.log("✓ 安装包齐全：\n  " + want.join("\n  "));
    break;
  }
  case "channel-ok": {
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(a === "-" ? 0 : a, "utf8")); } catch { /* 通道还不存在 */ }
    if (cur && core.compareVersions(cur.version, b) > 0) fail(`通道 ${cfg.channelTag} 里已经是更新的 ${cur.version}，不能用 ${b} 覆盖`);
    console.log(`✓ 可以更新通道 ${cfg.channelTag}（当前 ${cur ? cur.version : "无"} → ${b}）`);
    break;
  }
  default:
    fail("未知命令：" + cmd);
}
