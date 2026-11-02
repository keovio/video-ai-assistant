"use strict";
// 0.6.41：从原视频里分析背景音乐（纯 Node + 系统 ffmpeg），给 AI 判断风格、节奏、卡点用。
// 能算的只是“听得出的物理特征”：节奏 BPM、节拍清晰度、响度和强弱变化、高潮时间点、换镜是否卡点。
// 曲风、乐器、情绪仍由 AI 结合这些数据和画面推断。
const { execFile } = require("child_process");

const SR = 11025;
const HOP = 256; // 约 23ms 一帧

function defaultRun(file) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(SR), "-t", "300", "-f", "s16le", "-"],
      { timeout: 120000, maxBuffer: 256 * 1024 * 1024, encoding: "buffer", windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function toSamples(buf) {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

// 每帧 RMS
function frameRms(x, hop = HOP) {
  const n = Math.floor(x.length / hop);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * hop, e = i + hop; i < e; i++) s += x[i] * x[i];
    out[f] = Math.sqrt(s / hop);
  }
  return out;
}

// 起音包络：对数能量的正向差分，减去局部均值
function onsetEnvelope(rms) {
  const n = rms.length;
  const le = rms.map((v) => Math.log(1e-4 + v));
  const d = new Float32Array(n);
  for (let i = 1; i < n; i++) d[i] = Math.max(0, le[i] - le[i - 1]);
  const w = 16, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) { s += d[k]; c++; }
    out[i] = Math.max(0, d[i] - s / c);
  }
  return out;
}

// 自相关找节拍周期（60–180 BPM，轻微偏向 120），再找相位，返回 BPM、清晰度和节拍时间点
function estimateTempo(onset, fps) {
  const n = onset.length;
  if (n < fps * 4) return null;
  let mean = 0; for (const v of onset) mean += v; mean /= n;
  const c = onset.map((v) => v - mean);
  let e0 = 0; for (const v of c) e0 += v * v;
  if (e0 <= 1e-9) return null;
  const minLag = Math.round((fps * 60) / 180), maxLag = Math.round((fps * 60) / 60);
  let best = -Infinity, bestLag = 0;
  const ac = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0; for (let i = 0; i + lag < n; i++) s += c[i] * c[i + lag];
    s /= e0;
    ac[lag] = s;
    const bpm = (fps * 60) / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 1.0, 2));
    if (s * w > best) { best = s * w; bestLag = lag; }
  }
  if (!bestLag) return null;
  // 抛物线插值求更细的周期
  let lag = bestLag;
  const a = ac[bestLag - 1], b = ac[bestLag], d = ac[bestLag + 1];
  if (a != null && d != null && a - 2 * b + d !== 0) lag = bestLag + (0.5 * (a - d)) / (a - 2 * b + d);
  const bpm = (fps * 60) / lag;
  const clarity = Math.max(0, Math.min(1, ac[bestLag]));
  // 相位：让节拍点上的起音强度和最大
  let bestPh = 0, bestSum = -1;
  for (let ph = 0; ph < bestLag; ph++) {
    let s = 0; for (let t = ph; t < n; t += lag) s += onset[Math.round(t)] || 0;
    if (s > bestSum) { bestSum = s; bestPh = ph; }
  }
  const beats = [];
  for (let t = bestPh; t < n; t += lag) beats.push(Math.round((t / fps) * 100) / 100);
  return { bpm: Math.round(bpm), clarity: Math.round(clarity * 100) / 100, beats };
}

const db = (v) => (v > 0 ? 20 * Math.log10(v) : -120);

// 每秒响度（dB）+ 高潮点
function energyProfile(rms, fps) {
  const secs = Math.floor(rms.length / fps);
  const per = [];
  for (let s = 0; s < secs; s++) {
    let sum = 0; for (let i = s * fps; i < (s + 1) * fps; i++) sum += rms[i] * rms[i];
    per.push(Math.round(db(Math.sqrt(sum / fps)) * 10) / 10);
  }
  return per;
}

function analyzeSamples(x, sr = SR) {
  const fps = sr / HOP;
  const rms = frameRms(x);
  if (!rms.length) return null;
  let total = 0; for (const v of x) total += v * v;
  const overallDb = Math.round(db(Math.sqrt(total / Math.max(1, x.length))) * 10) / 10;
  const duration = Math.round((x.length / sr) * 10) / 10;
  if (overallDb < -50) return { duration, silent: true, overallDb };
  const perSec = energyProfile(rms, Math.round(fps));
  const tempo = estimateTempo(onsetEnvelope(rms), fps);
  // 平滑后的高潮：最大响度那一秒；起伏幅度：最响 - 最弱（去掉开头结尾各 1 秒）
  const core = perSec.slice(1, Math.max(2, perSec.length - 1)).filter((v) => v > -90);
  const maxDb = core.length ? Math.max(...core) : overallDb;
  const minDb = core.length ? Math.min(...core) : overallDb;
  const peakSec = perSec.indexOf(maxDb);
  // 明显变强的时间点：比前 3 秒均值高 6dB 以上
  const rises = [];
  for (let s = 3; s < perSec.length; s++) {
    const prev = (perSec[s - 1] + perSec[s - 2] + perSec[s - 3]) / 3;
    if (perSec[s] - prev >= 6 && (!rises.length || s - rises[rises.length - 1] >= 3)) rises.push(s);
  }
  return { duration, silent: false, overallDb, maxDb, minDb, dynamic: Math.round((maxDb - minDb) * 10) / 10, peakSec, rises, perSec, tempo };
}

// 换镜点有多少落在节拍附近（±0.12 秒）
function beatCutAlign(scenes = [], beats = []) {
  const cuts = scenes.map(Number).filter(Number.isFinite);
  if (!cuts.length || !beats.length) return null;
  const hit = cuts.filter((c) => beats.some((b) => Math.abs(b - c) <= 0.12)).length;
  return { cuts: cuts.length, onBeat: hit };
}

function describeMusic(m, { scenes = [], musicName = "" } = {}) {
  if (!m) return "";
  const lines = [];
  if (m.silent) return "音乐分析（从原视频音轨测得）：几乎没有声音（整体响度很低），没有可分析的背景音乐。";
  if (musicName) lines.push(`背景音乐名：${musicName}`);
  if (m.tempo) {
    const speed = m.tempo.bpm < 80 ? "慢" : m.tempo.bpm < 110 ? "中速" : m.tempo.bpm < 140 ? "偏快" : "快";
    const clear = m.tempo.clarity >= 0.35 ? "节拍清晰（鼓点/律动明显）" : m.tempo.clarity >= 0.15 ? "节拍一般" : "节拍不明显（可能是氛围音乐、人声或环境音为主）";
    lines.push(`节奏：约 ${m.tempo.bpm} BPM（${speed}），${clear}`);
  } else lines.push("节奏：测不出稳定节拍（可能没有鼓点，或以人声/环境音为主）");
  lines.push(`响度：整体 ${m.overallDb} dB，起伏 ${m.dynamic} dB（${m.dynamic >= 15 ? "强弱对比大，有明显推进/爆发" : m.dynamic >= 8 ? "有一定起伏" : "比较平稳"}）`);
  if (m.duration > 6) {
    const parts = [];
    if (m.rises.length) parts.push(`在 ${m.rises.map((s) => s + " 秒").join("、")} 明显变强`);
    if (m.peakSec >= 0) parts.push(`最响约在第 ${m.peakSec} 秒`);
    if (parts.length) lines.push(`强弱变化：${parts.join("，")}`);
  }
  const al = m.tempo ? beatCutAlign(scenes, m.tempo.beats) : null;
  if (al) lines.push(`卡点：${al.cuts} 处换镜中有 ${al.onBeat} 处落在节拍上${al.onBeat / al.cuts >= 0.6 && al.cuts >= 2 ? "（明显的卡点剪辑）" : al.onBeat / al.cuts < 0.3 ? "（不是卡点剪辑）" : ""}`);
  return "音乐分析（从原视频音轨测得，数值可信；曲风/乐器/情绪需你结合判断）：\n" + lines.join("\n");
}

async function analyzeMusic(file, { run = defaultRun } = {}) {
  const buf = await run(file);
  if (!buf || buf.length < SR * 2) return null; // 不到 1 秒或没有音轨
  return analyzeSamples(toSamples(buf));
}

module.exports = { analyzeMusic, analyzeSamples, estimateTempo, onsetEnvelope, frameRms, beatCutAlign, describeMusic, toSamples, SR, HOP };
