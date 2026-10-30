"use strict";
// 音频资产工具（纯 Node，可单测）：哈希、按哈希去重落盘、系统 ffmpeg/ffprobe 可用性。
// 资产文件命名一律 <sha256><扩展名>，同一内容只存一份；记录里只存相对路径。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const AUDIO_EXTS = {
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".ogg": "audio/ogg", ".flac": "audio/flac", ".aac": "audio/aac", ".opus": "audio/opus",
};

function mimeFor(file) {
  return AUDIO_EXTS[path.extname(String(file)).toLowerCase()] || "audio/mpeg";
}

function isAudioFile(file) {
  return !!AUDIO_EXTS[path.extname(String(file)).toLowerCase()];
}

function hashBuffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function hashFile(file) {
  return hashBuffer(fs.readFileSync(file));
}

// 把 bytes 落到 assetsDir 下，文件名取 <hash><ext>；已存在同哈希文件时直接复用，不重复写。
// 返回 { rel, abs, hash, bytes, deduped }，rel 为 assetsDir 内的相对路径（调用方再拼项目前缀）。
function storeAudioBytes(bytes, assetsDir, ext) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!buf.length) throw new Error("音频文件为空");
  const safeExt = AUDIO_EXTS[ext] ? ext : ".mp3";
  const hash = hashBuffer(buf);
  fs.mkdirSync(assetsDir, { recursive: true });
  const name = `${hash}${safeExt}`;
  const abs = path.join(assetsDir, name);
  let deduped = false;
  if (fs.existsSync(abs)) deduped = true;
  else fs.writeFileSync(abs, buf);
  return { rel: name, abs, hash, bytes: buf.length, deduped };
}

function commandAvailable(cmd, runFn) {
  if (typeof runFn === "function") { try { return !!runFn(cmd); } catch { return false; } }
  try { execFileSync(cmd, ["-version"], { stdio: "ignore", timeout: 10000 }); return true; }
  catch { return false; }
}

function ffmpegStatus(checkFn) {
  const ffmpeg = commandAvailable("ffmpeg", checkFn);
  const ffprobe = commandAvailable("ffprobe", checkFn);
  return {
    ffmpeg, ffprobe,
    ok: ffmpeg && ffprobe,
    warning: !ffmpeg || !ffprobe
      ? "未检测到系统 ffmpeg/ffprobe：配音时长只能用字数估算（约 4.5 字/秒），合成导出也不可用。请先安装系统 ffmpeg（macOS：brew install ffmpeg；Ubuntu/Debian：sudo apt install ffmpeg；Windows：winget install ffmpeg），装好后重启应用。"
      : "",
  };
}

module.exports = { AUDIO_EXTS, mimeFor, isAudioFile, hashBuffer, hashFile, storeAudioBytes, commandAvailable, ffmpegStatus };
