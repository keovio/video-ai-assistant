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

// voice 快照：{ ttsProvider, voice, rate, bgm }，bgm 是 BGM 文件名/路径（相对路径或空）。
// 空字符串 / rate=0 表示“跟随设置页的全局值”（0.5.0 起；之前缺省 rate 被写成 1，导致全局语速永远不生效）。
function voiceOf(v) {
  const o = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  const rate = Number(o.rate);
  return {
    ttsProvider: str(o.ttsProvider, 32),
    voice: str(o.voice, 64),
    rate: Number.isFinite(rate) && rate > 0 ? Math.min(2, Math.max(0.5, rate)) : 0,
    bgm: str(o.bgm, 200),
    // 背景音乐音量 0–1；0 = 自动（有口播时约 18% 垫底，全片无口播时 80%）
    bgmVolume: Number.isFinite(Number(o.bgmVolume)) ? Math.min(1, Math.max(0, Number(o.bgmVolume))) : 0,
    bgmName: str(o.bgmName, 200),
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
    videoAssetId: str(o.videoAssetId, 64),
    clipSeconds: num01(o.clipSeconds),
    // 手动时长（秒，0 = 自动）：没有配音时用它，适合纯画面 / 只放背景音乐的镜头
    seconds: num01(o.seconds, 0, 600),
    audioAssetId: str(o.audioAssetId, 64),
    audioSeconds: num01(o.audioSeconds),
    // audioSource：""=无配音，"generated"=TTS 生成，"import"=用户导入的音频
    audioSource: ["generated", "import"].includes(o.audioSource) ? o.audioSource : "",
    // audioMeasured：true 表示 audioSeconds 是 ffprobe 实测值，false 表示字数估算值
    audioMeasured: o.audioMeasured === true,
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

// 某镜头的计时用时长：已挂配音且有实测秒数时用实测值，否则用字数估算。
// 注意：audioSeconds 只有在 audioAssetId 非空时才算实测值，避免旧估算值被误当成实测。
// 0.6.6 起没有配音时的顺序：手动时长 > 口播字数估算 > 视频片段时长 > 有画面素材默认 3 秒 > 0（空镜跳过）。
const DEFAULT_SILENT_SECONDS = 3;
function measuredDuration(s) {
  if (!s) return 0;
  if (s.audioAssetId && Number(s.audioSeconds) > 0) return Math.round(Number(s.audioSeconds) * 10) / 10;
  if (Number(s.seconds) > 0) return Math.round(Number(s.seconds) * 10) / 10;
  const est = estimateSeconds(s.narration);
  if (est > 0) return est;
  if (s.videoAssetId && Number(s.clipSeconds) > 0) return Math.round(Number(s.clipSeconds) * 10) / 10;
  if (s.videoAssetId || s.imageAssetId) return DEFAULT_SILENT_SECONDS;
  return 0;
}

// 按实测时长（有配音的镜头）+ 估算时长（无配音的镜头）排 start/end，返回新数组 + 总时长（不改输入）。
// 这是 M2 之后刷新时间的默认口径：有配音的镜头绝不被估算值覆盖回估算时间。
function computeMeasuredTimings(shots) {
  let t = 0;
  const out = byOrder(shots).map((s) => {
    const d = measuredDuration(s);
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
  normalizeProject, normalizeShot, voiceOf, countChars, estimateSeconds, computeTimings, computeMeasuredTimings, measuredDuration, retimeFromAudio,
};
