"use strict";
// 通用媒体资产落盘（纯 Node，可单测）：视频/图片文件按内容哈希去重，
// 文件名一律 <sha256><扩展名>，与音频资产（lib/video/audio.js）同一规则。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const VIDEO_EXTS = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mkv": "video/x-matroska", ".m4v": "video/mp4",
};
const IMAGE_EXTS = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif",
};

function mimeForMedia(file) {
  const ext = path.extname(String(file)).toLowerCase();
  return VIDEO_EXTS[ext] || IMAGE_EXTS[ext] || "application/octet-stream";
}
function isVideoFile(file) { return !!VIDEO_EXTS[path.extname(String(file)).toLowerCase()]; }
function isImageFile(file) { return !!IMAGE_EXTS[path.extname(String(file)).toLowerCase()]; }

// bytes 落盘去重，返回 { rel, abs, hash, bytes, deduped }，rel 为 assetsDir 内相对路径。
function storeMediaBytes(bytes, assetsDir, ext) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!buf.length) throw new Error("媒体文件为空");
  const safeExt = (VIDEO_EXTS[ext] || IMAGE_EXTS[ext]) ? ext : ".mp4";
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  fs.mkdirSync(assetsDir, { recursive: true });
  const name = `${hash}${safeExt}`;
  const abs = path.join(assetsDir, name);
  let deduped = false;
  if (fs.existsSync(abs)) deduped = true;
  else fs.writeFileSync(abs, buf);
  return { rel: name, abs, hash, bytes: buf.length, deduped };
}

// 磁盘文件复制去重（即梦下载、用户本地文件走这条路，不经过渲染器内存）。
function storeMediaFile(srcPath, assetsDir) {
  const ext = path.extname(String(srcPath)).toLowerCase();
  return storeMediaBytes(fs.readFileSync(srcPath), assetsDir, ext);
}

module.exports = { VIDEO_EXTS, IMAGE_EXTS, mimeForMedia, isVideoFile, isImageFile, storeMediaBytes, storeMediaFile };
