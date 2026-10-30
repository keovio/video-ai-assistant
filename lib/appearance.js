"use strict";
// 外观：自定义背景图（存到 <数据目录>/appearance/background.<ext>），纯 Node，可单测。
// 页面 CSP 只允许 'self' 和 data: 图片，所以背景图以 data URL 交给页面。
const fs = require("fs");
const path = require("path");

const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif" };
const MAX_BYTES = 15 * 1024 * 1024;

// 检查一个准备当背景的文件：返回 { ok, ext, mime } 或 { ok: false, error }
function checkImageFile(file, fsImpl = fs) {
  const ext = path.extname(String(file || "")).toLowerCase();
  if (!IMAGE_TYPES[ext]) return { ok: false, error: "只支持 PNG、JPG、WebP、GIF、AVIF 图片" };
  let st;
  try { st = fsImpl.statSync(file); } catch { return { ok: false, error: "找不到这个文件" }; }
  if (!st.isFile()) return { ok: false, error: "不是文件" };
  if (st.size > MAX_BYTES) return { ok: false, error: `图片太大（${(st.size / 1048576).toFixed(1)} MB），请选 15 MB 以内的` };
  if (st.size === 0) return { ok: false, error: "文件是空的" };
  return { ok: true, ext, mime: IMAGE_TYPES[ext] };
}

function createBackgroundStore({ dir, fsImpl = fs }) {
  const findCurrent = () => {
    for (const ext of Object.keys(IMAGE_TYPES)) {
      const p = path.join(dir, "background" + ext);
      if (fsImpl.existsSync(p)) return { file: p, ext };
    }
    return null;
  };
  function clear() {
    for (const ext of Object.keys(IMAGE_TYPES)) { try { fsImpl.rmSync(path.join(dir, "background" + ext), { force: true }); } catch { /* ignore */ } }
  }
  // 复制一张图片进来，替换旧的
  function save(src) {
    const c = checkImageFile(src, fsImpl);
    if (!c.ok) return c;
    fsImpl.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.background-${process.pid}-${Date.now()}${c.ext}`);
    fsImpl.copyFileSync(src, tmp);
    clear();
    fsImpl.renameSync(tmp, path.join(dir, "background" + c.ext));
    return { ok: true };
  }
  // 当前背景的 data URL；没有返回 ""
  function dataUrl() {
    const cur = findCurrent();
    if (!cur) return "";
    try { return `data:${IMAGE_TYPES[cur.ext]};base64,${fsImpl.readFileSync(cur.file).toString("base64")}`; } catch { return ""; }
  }
  return { save, clear, dataUrl, has: () => !!findCurrent() };
}

module.exports = { checkImageFile, createBackgroundStore, IMAGE_TYPES, MAX_BYTES };
