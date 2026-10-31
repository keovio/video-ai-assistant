"use strict";
// 补全 PATH，让系统 ffmpeg/ffprobe 在“从 Finder / Dock / 开始菜单启动”时也能找到。
//
// macOS 从 Finder/Dock 启动的 GUI 应用只继承 launchd 的最小 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
// 不含 Homebrew（/opt/homebrew/bin、/usr/local/bin）和 MacPorts（/opt/local/bin），
// 结果是用户明明 brew install ffmpeg 了，应用里仍提示“未检测到 ffmpeg”。
// Windows 上 winget 装的 ffmpeg 在 %LOCALAPPDATA%\Microsoft\WinGet\Links，
// 装完不重新登录时当前进程的 PATH 里也没有。这里把常见安装目录追加到 PATH 末尾（已存在的不重复加）。
// 纯 Node，可单测：env / platform / exists 都可注入。
const fs = require("fs");
const path = require("path");

function extraBinDirs(platform = process.platform, env = process.env) {
  if (platform === "darwin") {
    return ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/opt/homebrew/sbin", "/usr/local/sbin"];
  }
  if (platform === "win32") {
    const dirs = [];
    const local = env.LOCALAPPDATA || (env.USERPROFILE ? path.win32.join(env.USERPROFILE, "AppData", "Local") : "");
    if (local) dirs.push(path.win32.join(local, "Microsoft", "WinGet", "Links"));
    if (env.ProgramData) dirs.push(path.win32.join(env.ProgramData, "chocolatey", "bin"));
    if (env.USERPROFILE) dirs.push(path.win32.join(env.USERPROFILE, "scoop", "shims"));
    dirs.push("C:\\ffmpeg\\bin", "C:\\Program Files\\ffmpeg\\bin");
    return dirs;
  }
  return ["/usr/local/bin", "/usr/bin", "/snap/bin", "/var/lib/flatpak/exports/bin", "/home/linuxbrew/.linuxbrew/bin"];
}

// 返回补全后的 PATH 字符串（不改 env）；exists(dir) 决定是否追加（默认检查目录存在）。
function augmentedPath({ platform = process.platform, env = process.env, exists = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } } } = {}) {
  const sep = platform === "win32" ? ";" : ":";
  const key = platform === "win32" ? (Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "Path") : "PATH";
  const current = String(env[key] || "").split(sep).filter(Boolean);
  const norm = (d) => (platform === "win32" ? d.toLowerCase().replace(/[\\/]+$/, "") : d.replace(/\/+$/, ""));
  const seen = new Set(current.map(norm));
  const out = [...current];
  for (const d of extraBinDirs(platform, env)) {
    if (seen.has(norm(d)) || !exists(d)) continue;
    seen.add(norm(d));
    out.push(d);
  }
  return { key, value: out.join(sep) };
}

// 就地补全 process.env 的 PATH（主进程启动时调用一次）。
function ensureBinPath(opts = {}) {
  const env = opts.env || process.env;
  const { key, value } = augmentedPath({ ...opts, env });
  env[key] = value;
  return value;
}

module.exports = { extraBinDirs, augmentedPath, ensureBinPath };
