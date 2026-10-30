#!/usr/bin/env node
"use strict";
// 冒烟测试：找到 electron-builder 打出的未打包应用（release/ 下），带 --smoke-test 运行，输出里要有 "SMOKE OK"。
// 用法：npm run smoke [-- <可执行文件路径>]       Linux 无桌面环境时：xvfb-run -a npm run smoke
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { loadConfig } = require("../lib/config");

const ROOT = path.resolve(__dirname, "..");
const cfg = loadConfig(ROOT);
const rel = path.join(ROOT, "release");

function findExecutable() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const dirs = fs.existsSync(rel) ? fs.readdirSync(rel).map((n) => path.join(rel, n)).filter((p) => fs.statSync(p).isDirectory()) : [];
  for (const d of dirs) {
    if (process.platform === "darwin") {
      const app = fs.readdirSync(d).find((n) => n.endsWith(".app"));
      if (app) return path.join(d, app, "Contents", "MacOS", app.slice(0, -4));
    } else if (process.platform === "win32") {
      const exe = path.join(d, `${cfg.productName}.exe`);
      if (fs.existsSync(exe)) return exe;
    } else {
      const bin = path.join(d, cfg.appName);
      if (fs.existsSync(bin)) return bin;
    }
  }
  return "";
}

const exe = findExecutable();
if (!exe || !fs.existsSync(exe)) { console.error("✗ 找不到打包好的应用：先运行 npm run pack"); process.exit(1); }
const args = ["--smoke-test", "--no-updates"];
// CI 的 Linux 上 chrome-sandbox 没有 setuid 权限，且 Ubuntu 24.04 限制非特权用户命名空间：关掉沙箱只用于测试
if (process.platform === "linux") args.push("--no-sandbox");
console.log(`运行：${exe} ${args.join(" ")}`);
// 测试用独立的更新目录，避免碰到本机真实数据
// 设置、日志也写到临时目录
const env = {
  ...process.env, ELECTRON_ENABLE_LOGGING: "1",
  APP_UPDATES_DIR: path.join(require("os").tmpdir(), `${cfg.appName}-smoke-updates`),
  APP_DATA_DIR: path.join(require("os").tmpdir(), `${cfg.appName}-smoke-data`),
};
const child = spawn(exe, args, { env, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
const timer = setTimeout(() => { console.error("✗ 冒烟测试超时（90 秒）"); child.kill("SIGKILL"); process.exit(1); }, 90000);
child.on("exit", (code) => {
  clearTimeout(timer);
  const ok = code === 0 && /SMOKE OK/.test(out);
  console.log(ok ? "✓ 冒烟测试通过" : `✗ 冒烟测试失败（退出码 ${code}）`);
  process.exit(ok ? 0 : 1);
});
