"use strict";
// 视频数据模型（纯函数，可单测，不依赖 Electron / 文件系统）。
//
// 项目 > 镜头：Project 挂一串 Shot；Asset 只存相对路径，文件在
// <数据目录>/projects/<projectId>/assets/ 下。时间先按字数估算
// （约 4.5 字/秒），最终以 TTS 实际音频时长重排（M2 用）。
const CHARS_PER_SECOND = 4.5;

const str = (v, max = 200) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);
const num01 = (v, lo = 0, hi = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(n * 10) / 10));
};
const tagsOf = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,，、\s#]+/) : [])
  .map((t) => str(t, 30).trim()).filter(Boolean).filter((t, i, a) => a.indexOf(t) === i).slice(0, 20);

const PROJECT_STATUSES = ["draft", "script_ready", "rendering", "done", "failed"];
const SHOT_STATUSES = ["pending", "voicing", "imaging", "ready", "failed"];
const ASPECTS = ["9:16", "16:9", "1:1"];

// voice 快照：{ voice, rate, bgm }，bgm 是 BGM 文件名/路径（相对路径或空）
function voiceOf(v) {
  const o = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  const rate = Number(o.rate);
  return {
    voice: str(o.voice, 64),
    rate: Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1,
    bgm: str(o.bgm, 200),
  };
}

function normalizeProject(x) {
  const o = x && typeof x === "object" ? x : {};
  return {
    accountId: str(o.accountId, 64),
    title: str(o.title, 200).trim() || "未命名项目",
    tags: tagsOf(o.tags),
    status: PROJECT_STATUSES.includes(o.status) ? o.status : "draft",
    aspect: ASPECTS.includes(o.aspect) ? o.aspect : "9:16",
    voice: voiceOf(o.voice),
    totalSeconds: num01(o.totalSeconds),
  };
}

function normalizeShot(x) {
  const o = x && typeof x === "object" ? x : {};
  const order = Number(o.order);
  const retry = Number(o.retryCount);
  return {
    projectId: str(o.projectId, 64),
    order: Number.isFinite(order) && order >= 0 ? Math.floor(order) : 0,
    start: num01(o.start),
    end: num01(o.end),
    narration: str(o.narration, 5000),
    visual: str(o.visual, 2000),
    imagePrompt: str(o.imagePrompt, 2000),
    imageAssetId: str(o.imageAssetId, 64),
    audioAssetId: str(o.audioAssetId, 64),
    audioSeconds: num01(o.audioSeconds),
    status: SHOT_STATUSES.includes(o.status) ? o.status : "pending",
    error: str(o.error, 500),
    retryCount: Number.isFinite(retry) ? Math.min(99, Math.max(0, Math.floor(retry))) : 0,
  };
}

// 口播字数：去掉空白后按字符数算（中文按字，英文按字母计入同一口径，仅作估算）
function countChars(text) {
  return [...String(text || "")].filter((c) => !/\s/.test(c)).length;
}

// 估算时长（秒）：字数 / 4.5，向上取整到 0.1 秒；空口播为 0
function estimateSeconds(narration) {
  const n = countChars(narration);
  if (!n) return 0;
  return Math.ceil((n / CHARS_PER_SECOND) * 10) / 10;
}

function byOrder(shots) {
  return [...(shots || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
}

// 按估算时长顺序排 start/end，返回新数组 + 总时长（不改输入）
function computeTimings(shots) {
  let t = 0;
  const out = byOrder(shots).map((s) => {
    const d = estimateSeconds(s.narration);
    const start = Math.round(t * 10) / 10;
    t = Math.round((t + d) * 10) / 10;
    return { ...s, start, end: t };
  });
  return { shots: out, totalSeconds: t };
}

// 按实际音频时长重排：durations 可以是按 order 顺序的秒数数组，
// 或 { shotId: 秒数 }；某镜头没有实际时长时退回估算时长
function retimeFromAudio(shots, durations) {
  const ordered = byOrder(shots);
  const secs = (s, i) => {
    let v;
    if (Array.isArray(durations)) v = durations[i];
    else if (durations && typeof durations === "object") v = durations[s.id];
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : estimateSeconds(s.narration);
  };
  let t = 0;
  const out = ordered.map((s, i) => {
    const d = secs(s, i);
    const start = Math.round(t * 10) / 10;
    t = Math.round((t + d) * 10) / 10;
    return { ...s, start, end: t, audioSeconds: d };
  });
  return { shots: out, totalSeconds: t };
}

module.exports = {
  CHARS_PER_SECOND, PROJECT_STATUSES, SHOT_STATUSES, ASPECTS,
  normalizeProject, normalizeShot, voiceOf, countChars, estimateSeconds, computeTimings, retimeFromAudio,
};
