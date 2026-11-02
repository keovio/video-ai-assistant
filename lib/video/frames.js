"use strict";
// 0.6.38：用已下载的原视频做分析素材（纯 Node + 系统 ffmpeg/ffprobe，可注入 run 做单测）。
// - probeDuration：ffprobe 读时长
// - detectScenes：ffmpeg scene 滤镜找换镜点
// - planFrameTimes：换镜点 + 全片均匀点，合并去重成约 16 个截图时间（纯函数）
// - extractFrames：按时间点各截一张 jpg（data URL），并按换镜点给出相邻差异
// - compressForAi：压到 480p 左右、目标体积以内，给能直接看视频的模型
const { execFile } = require("child_process");
const fs = require("fs");

function defaultRun(cmd, args, { timeout = 120000, encoding = "utf8" } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || "").slice(-800); return reject(err); }
      resolve({ stdout, stderr: String(stderr || "") });
    });
  });
}

async function probeDuration(file, run = defaultRun) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { timeout: 30000 });
  const d = Number(String(stdout).trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error("读不到视频时长");
  return d;
}

function parseSceneTimes(stderr) {
  const out = [];
  const re = /pts_time:\s*([0-9.]+)/g;
  let m;
  while ((m = re.exec(String(stderr || "")))) { const t = Number(m[1]); if (Number.isFinite(t)) out.push(t); }
  return out;
}

async function detectScenes(file, { threshold = 0.3, run = defaultRun } = {}) {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-an", "-vf", `scale=160:-2,select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"], { timeout: 180000 });
  return parseSceneTimes(stderr);
}

const r1 = (t) => Math.round(t * 10) / 10;

// 换镜点优先（每个镜头开头稍后一点截，避开转场模糊），再用全片均匀点补齐；相邻点至少隔 minGap 秒。
function planFrameTimes(duration, scenes = [], { count = 16, minGap = 0.6 } = {}) {
  const dur = Number(duration);
  if (!Number.isFinite(dur) || dur <= 0) return [];
  // 短视频不用截满：约每 0.5 秒一张，至少 4 张
  const n = Math.max(1, Math.min(32, count, Math.max(4, Math.round(dur / 0.5))));
  const end = Math.max(0, dur - 0.15);
  const clamp = (t) => Math.min(end, Math.max(0, t));
  const gap = Math.min(minGap, dur / (n * 2));
  const picked = [];
  const tryAdd = (t) => { t = r1(clamp(t)); if (picked.every((p) => Math.abs(p - t) >= gap)) { picked.push(t); return true; } return false; };
  tryAdd(Math.min(0.3, end));
  let cuts = scenes.map(Number).filter((t) => Number.isFinite(t) && t > 0.2 && t < dur - 0.2).sort((a, b) => a - b);
  // 换镜太多时均匀抽一部分，给均匀点留至少 1/4
  const room = n - 1 - Math.floor(n / 4);
  if (cuts.length > room) cuts = Array.from({ length: room }, (_, i) => cuts[Math.floor((i * cuts.length) / room)]);
  for (const c of cuts) { if (picked.length >= n) break; tryAdd(c + 0.25); }
  const slots = n - picked.length;
  if (slots > 0) {
    // 均匀点由密到疏地加，直到填满或加不进去
    for (let k = slots + 1; picked.length < n && k <= slots * 4 + 2; k++) {
      for (let i = 1; i < k && picked.length < n; i++) tryAdd((dur * i) / k);
    }
  }
  return picked.sort((a, b) => a - b);
}

// 相邻截图之间有没有换镜点：有给 0.6（明显不同），没有给 0.1（几乎相同/略有变化），供 AI 判断镜头数。
function diffsFromScenes(times, scenes = []) {
  const cuts = scenes.map(Number).filter(Number.isFinite);
  const out = [];
  for (let i = 1; i < times.length; i++) out.push(cuts.some((c) => c > times[i - 1] && c <= times[i] + 0.05) ? 0.6 : 0.1);
  return out;
}

async function extractFrames(file, { count = 16, run = defaultRun, log = null } = {}) {
  const duration = await probeDuration(file, run);
  let scenes = [];
  try { scenes = await detectScenes(file, { run }); }
  catch (err) { if (log) log.warn(`换镜检测失败，只按时长均匀截图：${(err && err.message) || err}`); }
  const times = planFrameTimes(duration, scenes, { count });
  const images = [];
  const okTimes = [];
  for (const t of times) {
    try {
      const { stdout } = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale='if(gt(iw,ih),min(720,iw),min(540,iw))':-2", "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "-"], { timeout: 30000, encoding: "buffer" });
      if (stdout && stdout.length > 500) { images.push("data:image/jpeg;base64," + Buffer.from(stdout).toString("base64")); okTimes.push(t); }
    } catch (err) { if (log) log.warn(`截取 ${t} 秒画面失败：${(err && err.message) || err}`); }
  }
  images.times = okTimes;
  images.diffs = diffsFromScenes(okTimes, scenes);
  images.duration = duration;
  images.scenes = scenes;
  return images;
}

// 目标码率：体积 × 0.85 留余量，减去 48k 音频；最低 120k。太长（码率不够）返回 0，调用方放弃压缩。
function targetVideoKbps(duration, maxBytes) {
  const total = (maxBytes * 8 * 0.85) / Math.max(1, duration) / 1000;
  const v = Math.floor(total - 48);
  return v >= 120 ? Math.min(v, 1200) : 0;
}

async function compressForAi(file, outFile, { maxBytes, run = defaultRun, duration = null } = {}) {
  const dur = duration || await probeDuration(file, run);
  let kbps = targetVideoKbps(dur, maxBytes);
  if (!kbps) throw new Error(`视频太长（${Math.round(dur)} 秒），压到 ${Math.round(maxBytes / 1048576)} MB 以内画质太差`);
  for (let attempt = 0; attempt < 2; attempt++) {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", file,
      "-vf", "scale='if(gt(iw,ih),min(854,iw),min(480,iw))':-2",
      "-c:v", "libx264", "-preset", "veryfast", "-b:v", `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`, "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "48k", "-ac", "1", "-movflags", "+faststart", outFile], { timeout: 600000 });
    const bytes = fs.statSync(outFile).size;
    if (bytes <= maxBytes) return { path: outFile, bytes, kbps };
    kbps = Math.floor(kbps * 0.7);
    if (kbps < 100) break;
  }
  throw new Error("压缩后仍超过体积上限");
}

module.exports = { probeDuration, detectScenes, parseSceneTimes, planFrameTimes, diffsFromScenes, extractFrames, targetVideoKbps, compressForAi };
