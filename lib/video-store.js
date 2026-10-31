"use strict";
// 视频本地数据：每个集合一个 JSON 文件（<数据目录>/video/<名字>.json），原子写，纯 Node，可单测。
// 沿用 content-ai-assistant/lib/store.js 的 createCollection + SCHEMAS 白名单模式：
// 未知字段在写入时 strip；id / createdAt / updatedAt 由集合管理。
const path = require("path");
const crypto = require("crypto");
const { readJson, writeJsonAtomic } = require("./fs-utils");
const { normalizeProject, normalizeShot } = require("./video-model");
const { computeMeasuredTimings } = require("./video-model");

const str = (v, max = 200) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);
const num01 = (v, lo = 0, hi = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(n * 10) / 10));
};

// 只存相对路径：拒绝绝对路径、反斜杠和 ".." 段
function relPath(v, max = 200) {
  const s = str(v, max).replace(/\\/g, "/");
  if (!s || s.startsWith("/") || s.split("/").includes("..")) return "";
  return s;
}

const ASSET_KINDS = ["audio", "image", "video"];
const RENDER_STATUSES = ["queued", "running", "done", "failed", "cancelled"];

function normalizeAsset(x) {
  const o = x && typeof x === "object" ? x : {};
  const bytes = Number(o.bytes);
  return {
    kind: ASSET_KINDS.includes(o.kind) ? o.kind : "image",
    path: relPath(o.path),
    hash: /^[0-9a-f]{1,128}$/i.test(str(o.hash, 128)) ? str(o.hash, 128).toLowerCase() : "",
    bytes: Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : 0,
    // seconds：ffprobe 实测的媒体时长（视频片段/音频用；未知时 0，渲染时按音频时长兜底）
    seconds: num01(o.seconds),
    // source：""=未知，"generated"=TTS/生成，"import"=用户导入
    source: ["generated", "import"].includes(o.source) ? o.source : "",
  };
}

const ANALYSIS_STYLE_KEYS = ["visual", "camera", "pacing", "mood", "colorLight", "sound", "hooks"];

// 抖音分析记录（M4）：来源信息 + 风格拆解 + skill 文本 + 脚本分镜。
// shots 只存白名单字段（narration/visual/imagePrompt/seconds），不存多余字段；
// skillPath 只存相对路径（skill.md 写在 <数据目录>/video/analyses/<id>/ 下）。
function normalizeAnalysisShot(x) {
  const o = x && typeof x === "object" ? x : {};
  const seconds = Number(o.seconds);
  return {
    narration: str(o.narration, 5000),
    visual: str(o.visual, 2000),
    imagePrompt: str(o.imagePrompt, 2000),
    seconds: Number.isFinite(seconds) && seconds > 0 ? Math.min(30, Math.max(0.1, Math.round(seconds * 10) / 10)) : 0,
  };
}

function normalizeAnalysis(x) {
  const o = x && typeof x === "object" ? x : {};
  const style = o.style && typeof o.style === "object" ? o.style : {};
  const styleOut = {};
  for (const k of ANALYSIS_STYLE_KEYS) styleOut[k] = str(style[k], 1000);
  const skill = o.skill && typeof o.skill === "object" ? o.skill : {};
  const script = o.script && typeof o.script === "object" ? o.script : {};
  return {
    sourceUrl: str(o.sourceUrl, 500),
    videoId: str(o.videoId, 64),
    author: str(o.author, 200),
    caption: str(o.caption, 2000),
    likeCountText: str(o.likeCountText, 64),
    commentCountText: str(o.commentCountText, 64),
    shareCountText: str(o.shareCountText, 64),
    style: styleOut,
    skill: {
      name: str(skill.name, 64),
      description: str(skill.description, 500),
      body: str(skill.body, 8000),
    },
    skillText: str(o.skillText, 12000),
    skillPath: relPath(o.skillPath),
    scriptTitle: str(o.scriptTitle || script.title, 200),
    scriptNarration: str(o.scriptNarration || script.narration, 5000),
    shots: Array.isArray(o.shots) ? o.shots.map(normalizeAnalysisShot).filter((s) => s.narration).slice(0, 12)
      : (Array.isArray(script.shots) ? script.shots.map(normalizeAnalysisShot).filter((s) => s.narration).slice(0, 12) : []),
    manualText: str(o.manualText, 2000),
  };
}

function normalizeRender(x) {
  const o = x && typeof x === "object" ? x : {};
  const pct = Number(o.pct);
  return {
    projectId: str(o.projectId, 64),
    status: RENDER_STATUSES.includes(o.status) ? o.status : "queued",
    stage: str(o.stage, 64),
    pct: Number.isFinite(pct) ? Math.min(100, Math.max(0, Math.round(pct))) : 0,
    message: str(o.message, 500),
    outputPath: relPath(o.outputPath),
    srtPath: relPath(o.srtPath),
    // warnings：渲染过程中的非致命提示（如某镜无画面用黑场兜底、字幕烧入失败改出 SRT）
    warnings: Array.isArray(o.warnings) ? o.warnings.map((w) => str(w, 500)).filter(Boolean).slice(0, 20) : [],
    error: str(o.error, 500),
    startedAt: Number(o.startedAt) || 0,
    endedAt: Number(o.endedAt) || 0,
  };
}

function createCollection({ file, normalize = (x) => x, now = Date.now, max = 5000 } = {}) {
  let items = null;
  const load = () => {
    if (items) return items;
    const raw = readJson(file, { items: [] });
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : [];
    items = arr
      .filter((x) => x && typeof x.id === "string")
      .map((x) => ({ ...normalize(x), id: x.id, createdAt: Number(x.createdAt) || 0, updatedAt: Number(x.updatedAt) || 0 }));
    return items;
  };
  const save = () => writeJsonAtomic(file, { version: 1, items });

  function list({ q = "", status = "", projectId = "", kind = "" } = {}) {
    const kw = str(q, 100).trim().toLowerCase();
    return load()
      .filter((x) => !projectId || x.projectId === projectId)
      .filter((x) => !status || x.status === status)
      .filter((x) => !kind || x.kind === kind)
      .filter((x) => !kw || [x.title, x.narration, x.visual, x.imagePrompt, (x.tags || []).join(" ")]
        .some((f) => typeof f === "string" && f.toLowerCase().includes(kw)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((x) => ({ ...x }));
  }
  function get(id) { const x = load().find((i) => i.id === id); return x ? { ...x } : null; }
  function upsert(input) {
    if (!input || typeof input !== "object") throw new Error("数据格式不对");
    const all = load();
    const t = now();
    const idx = input.id ? all.findIndex((i) => i.id === input.id) : -1;
    let item;
    if (idx >= 0) {
      item = { ...all[idx], ...normalize({ ...all[idx], ...input }), id: all[idx].id, createdAt: all[idx].createdAt, updatedAt: t };
      all[idx] = item;
    } else {
      if (all.length >= max) throw new Error(`最多保存 ${max} 条，请先删除一些`);
      item = { ...normalize(input), id: crypto.randomUUID(), createdAt: t, updatedAt: t };
      all.push(item);
    }
    save();
    return { ...item };
  }
  function remove(id) {
    const all = load();
    const idx = all.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    all.splice(idx, 1);
    save();
    return true;
  }
  return { list, get, upsert, remove, count: () => load().length, _load: load, _save: save };
}

function createVideoStore(dir) {
  const projects = createCollection({ file: path.join(dir, "projects.json"), normalize: normalizeProject });
  const shots = createCollection({ file: path.join(dir, "shots.json"), normalize: normalizeShot });
  const assets = createCollection({ file: path.join(dir, "assets.json"), normalize: normalizeAsset });
  const renders = createCollection({ file: path.join(dir, "renders.json"), normalize: normalizeRender });
  const analyses = createCollection({ file: path.join(dir, "analyses.json"), normalize: normalizeAnalysis });

  const shotsOf = (projectId) => shots.list({ projectId }).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);

  // order 从 0 连续：按 (order, createdAt) 排后重编号
  function renumber(projectId) {
    const list = shotsOf(projectId);
    let changed = false;
    list.forEach((s, i) => { if (s.order !== i) { shots.upsert({ ...s, order: i }); changed = true; } });
    return changed;
  }

  // 按实测时长重算 start/end，并写回项目 totalSeconds（M2 起默认口径：
  // 已挂配音的镜头用实测秒数，未挂配音的镜头仍用字数估算；绝不把实测时间覆盖回估算）
  function refreshTimings(projectId) {
    const list = shotsOf(projectId);
    const { shots: timed, totalSeconds } = computeMeasuredTimings(list);
    for (const s of timed) shots.upsert({ ...s });
    const p = projects.get(projectId);
    if (p && p.totalSeconds !== totalSeconds) projects.upsert({ ...p, totalSeconds });
    return { shots: timed, totalSeconds };
  }

  // 明确按实测时长重排：把一组 { shotId: 秒数 } 写进镜头 audioSeconds 后再刷新时间。
  // durations 里没有的镜头保持原 audioSeconds（有配音则继续用实测，无配音则估算）。
  function retimeMeasured(projectId, durations = {}) {
    const list = shotsOf(projectId);
    for (const s of list) {
      const n = Number(durations[s.id]);
      if (Number.isFinite(n) && n > 0 && s.audioAssetId) shots.upsert({ ...s, audioSeconds: Math.round(n * 10) / 10 });
    }
    return refreshTimings(projectId);
  }

  function addShot(projectId, input = {}) {
    const order = shotsOf(projectId).length;
    const s = shots.upsert({ ...input, projectId, order });
    renumber(projectId);
    refreshTimings(projectId);
    return shots.get(s.id);
  }

  function updateShot(id, patch = {}) {
    const old = shots.get(id);
    if (!old) throw new Error("镜头不存在");
    const s = shots.upsert({ ...old, ...patch, id, projectId: old.projectId });
    renumber(old.projectId);
    refreshTimings(old.projectId);
    return shots.get(s.id);
  }

  function removeShot(id) {
    const old = shots.get(id);
    if (!old) return false;
    const ok = shots.remove(id);
    renumber(old.projectId);
    refreshTimings(old.projectId);
    return ok;
  }

  // ids 为新顺序（按 order 排列的 shot id）；未列出的镜头排在后面
  function reorderShots(projectId, ids) {
    const list = shotsOf(projectId);
    const wanted = (Array.isArray(ids) ? ids : []).filter((id) => list.some((s) => s.id === id));
    const rest = list.filter((s) => !wanted.includes(s.id));
    const ordered = [...wanted.map((id) => list.find((s) => s.id === id)), ...rest];
    ordered.forEach((s, i) => shots.upsert({ ...s, order: i }));
    renumber(projectId);
    refreshTimings(projectId);
    return shotsOf(projectId);
  }

  function createProject(input = {}, shotCount = 6) {
    const p = projects.upsert(input);
    const n = Math.max(0, Math.min(20, Math.floor(Number(shotCount) || 0)));
    const created = [];
    for (let i = 0; i < n; i++) created.push(shots.upsert({ projectId: p.id, order: i }));
    renumber(p.id);
    refreshTimings(p.id);
    return { project: projects.get(p.id), shots: shotsOf(p.id) };
  }

  function duplicateProject(id) {
    const old = projects.get(id);
    if (!old) throw new Error("项目不存在");
    const { id: _pid, createdAt: _pc, updatedAt: _pu, ...rest } = old;
    const p = projects.upsert({ ...rest, title: `${old.title} 副本`, status: "draft" });
    const oldShots = shotsOf(id);
    for (const s of oldShots) {
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = s;
      shots.upsert({ ...rest, projectId: p.id });
    }
    renumber(p.id);
    refreshTimings(p.id);
    return { project: projects.get(p.id), shots: shotsOf(p.id) };
  }

  // 删除项目：连带删除镜头与渲染记录；资产记录中属于该项目的也删记录，
  // 但资产文件本身不删（只删记录，文件留在磁盘上，M1 不做清理）。
  function removeProject(id) {
    const ok = projects.remove(id);
    if (!ok) return false;
    for (const s of shotsOf(id)) shots.remove(s.id);
    for (const r of renders.list({ projectId: id })) renders.remove(r.id);
    for (const a of assets.list()) {
      if (a.path.startsWith(`projects/${id}/`)) assets.remove(a.id);
    }
    return true;
  }

  return {
    projects, shots, assets, renders, analyses,
    shotsOf, renumber, refreshTimings, retimeMeasured,
    addShot, updateShot, removeShot, reorderShots,
    createProject, duplicateProject, removeProject,
  };
}

module.exports = { createCollection, createVideoStore, normalizeAsset, normalizeRender, normalizeAnalysis, normalizeAnalysisShot, relPath };
