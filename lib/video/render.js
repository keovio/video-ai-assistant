"use strict";
// ffmpeg 合成（纯 Node，可单测，不依赖 Electron）。
//
// 设计要点（M3，系统 ffmpeg，绝不内置二进制）：
// - 每镜一段：有视频片段用片段；无片段有图片用图片 + 轻微 zoompan；
//   既无片段又无图片时用黑场兜底，配音绝不静默丢掉，该镜记一条 warning。
// - 每段时长 = 该镜计时时长（有配音用实测秒数，无配音用字数估算，见 video-model.measuredDuration）。
//   片段比音频短：循环补齐；比音频长：截断；无音频的镜头用静音轨补齐，保证拼接后音轨连续。
// - 先逐段渲染成临时 MP4，再用 concat 拼接，最后一步做字幕烧入 + 可选 BGM + faststart。
//   烧入失败时自动重试一次“只出 SRT、不烧入”，并明确报告 burned=false，绝不谎称已烧入。
// - ffmpeg/ffprobe 缺失时在开工前就报错（FFMPEG_MISSING），不在渲染中途才发现。
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { measuredDuration } = require("../video-model");

class RenderError extends Error {
  constructor(message, { code = "", retryable = false } = {}) {
    super(message);
    this.name = "RenderError";
    this.code = code;
    this.retryable = retryable;
  }
}

const ASPECT_SIZE = { "9:16": [720, 1280], "16:9": [1280, 720], "1:1": [720, 720] };
function aspectSize(aspect) { return ASPECT_SIZE[aspect] || ASPECT_SIZE["9:16"]; }
const round1 = (n) => Math.round(Number(n) * 10) / 10;
const safeDur = (n, fallback = 1) => (Number.isFinite(Number(n)) && Number(n) > 0 ? round1(n) : fallback);

// ---- SRT ----
// 时间格式 HH:MM:SS,mmm
function formatSrtTime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const ms = Math.round(total * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  const rest = String(ms % 1000).padStart(3, "0");
  return `${h}:${m}:${s},${rest}`;
}

// 按句号/问号/感叹号/分号切分，保留标点；切不出句子时整段当一句。
// 每句时长按字数等比分配（字多的句子占更久），总和等于镜头时长。
function splitNarration(narration, duration) {
  const text = String(narration || "").trim();
  const dur = safeDur(duration, 0);
  if (!text || dur <= 0) return [];
  const parts = text.match(/[^。！？；.!?;]+[。！？；.!?;]?/g) || [text];
  const cleaned = parts.map((p) => p.trim()).filter(Boolean);
  if (!cleaned.length) return [];
  const totalChars = cleaned.reduce((a, p) => a + [...p].length, 0) || 1;
  let t = 0;
  return cleaned.map((p, i) => {
    const isLast = i === cleaned.length - 1;
    const d = isLast ? round1(dur - t) : Math.max(0.1, round1((dur * [...p].length) / totalChars));
    const start = round1(t);
    t = round1(t + d);
    return { text: p, start: start, end: isLast ? round1(dur) : t, seconds: round1((isLast ? dur - start : d)) };
  });
}

// shots：已排好 start/end 的镜头数组（按 order）。返回 SRT 文本。
function buildSrt(shots) {
  const cues = [];
  for (const s of shots || []) {
    const start = Number(s.start) || 0;
    const dur = Math.max(0, round1((Number(s.end) || 0) - start));
    if (dur <= 0 || !String(s.narration || "").trim()) continue;
    for (const part of splitNarration(s.narration, dur)) {
      cues.push({ start: start + part.start, end: start + part.end, text: part.text });
    }
  }
  return cues.map((c, i) => `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${c.text}\n`).join("\n");
}

// subtitles 滤镜用的路径转义：反斜杠、冒号、单引号都要转义，否则滤镜会把路径切碎。
function escapeSubtitlePath(p) {
  return String(p).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

// ---- 分段规划（纯函数，可单测） ----
// assetsById: { assetId: asset }，asset.path 为 videoDir 下相对路径；asset.seconds 为 ffprobe 实测秒数（未知时 0）。
// 返回 { segments, warnings }；segments 顺序 = shots 顺序，绝不丢镜头（无画面时黑场兜底）。
function planSegments(shots, assetsById, { aspect = "9:16" } = {}) {
  const [w, h] = aspectSize(aspect);
  const segments = [];
  const warnings = [];
  for (const s of shots || []) {
    const duration = round1(measuredDuration(s));
    const audio = s.audioAssetId ? assetsById[s.audioAssetId] : null;
    const clip = s.videoAssetId ? assetsById[s.videoAssetId] : null;
    const image = s.imageAssetId ? assetsById[s.imageAssetId] : null;
    const seg = { shotId: s.id, order: s.order || 0, duration, width: w, height: h, audioFile: audio ? audio.path : "", warnings: [] };
    if (clip) {
      const clipSeconds = Number(clip.seconds) || 0;
      seg.kind = "clip";
      seg.videoFile = clip.path;
      seg.clipSeconds = clipSeconds;
      // 片段短于音频：循环补齐；长于音频：截断；未知时长：仍按音频时长输出（-t 兜底）。
      seg.loop = clipSeconds > 0 && clipSeconds < duration;
      seg.trim = clipSeconds > duration;
    } else if (image) {
      seg.kind = "image";
      seg.videoFile = image.path;
    } else {
      seg.kind = "audio-only";
      seg.videoFile = "";
      const msg = `第 ${seg.order + 1} 镜无画面素材（无视频片段、无图片），已用黑场兜底，配音保留。`;
      seg.warnings.push(msg);
      warnings.push(msg);
    }
    if (!audio) {
      const msg = `第 ${seg.order + 1} 镜无配音，已用静音轨补齐，保证拼接后音轨连续。`;
      seg.warnings.push(msg);
      warnings.push(msg);
    }
    segments.push(seg);
  }
  return { segments, warnings };
}

// ---- 单段 ffmpeg 命令（返回 args 数组，可单测；不执行） ----
// 所有段统一输出规格：目标分辨率（等比缩放 + 补黑边居中）、SAR 1:1、25fps、yuv420p，
// 音频 44.1kHz 立体声 AAC。concat 拼接要求各段参数完全一致，否则会花屏、报错或音画错位
// （即梦片段常是 1080x1920 / 24fps，TTS 常是 24kHz 单声道，静音轨是 44.1kHz 立体声）。
const SEG_FPS = 25;
const SEG_AUDIO_RATE = 44100;
function buildSegmentCommand(seg, outFile) {
  const dur = seg.duration;
  const fps = SEG_FPS;
  const W = seg.width, H = seg.height;
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  if (seg.kind === "clip") {
    if (seg.loop) args.push("-stream_loop", "-1");
    args.push("-i", seg.videoFile);
  } else if (seg.kind === "image") {
    args.push("-loop", "1", "-i", seg.videoFile);
  } else {
    // audio-only：黑场视频源
    args.push("-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${fps}:d=${dur}`);
  }
  if (seg.audioFile) args.push("-i", seg.audioFile);
  else args.push("-f", "lavfi", "-i", `anullsrc=r=${SEG_AUDIO_RATE}:cl=stereo`);
  const vIndex = 0;
  const aIndex = 1;
  let vf;
  if (seg.kind === "image") {
    // 轻微推镜：缩放裁切到目标尺寸后 zoompan 缓慢放大（d=总帧数），避免眩晕。
    const frames = Math.max(1, Math.round(dur * fps));
    vf = `[${vIndex}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='min(zoom+0.0008,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${fps},setsar=1,format=yuv420p[v]`;
  } else {
    // 片段 / 黑场：等比缩放进目标画幅，不足处补黑边，统一帧率与像素格式
    vf = `[${vIndex}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p[v]`;
  }
  const af = `[${aIndex}:a]aresample=${SEG_AUDIO_RATE},aformat=sample_rates=${SEG_AUDIO_RATE}:channel_layouts=stereo,apad[a]`;
  args.push("-filter_complex", `${vf};${af}`, "-map", "[v]", "-map", "[a]");
  args.push("-t", String(dur), "-r", String(fps), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", String(SEG_AUDIO_RATE), "-ac", "2", outFile);
  return args;
}

// 字幕字体：libass 默认字体常常没有中文字形，烧出来是方框；按平台指定系统自带的中文字体。
function subtitleFontFor(platform = process.platform) {
  if (platform === "darwin") return "PingFang SC";
  if (platform === "win32") return "Microsoft YaHei";
  return "Noto Sans CJK SC";
}

// ---- 最终合成命令（concat 结果 + 字幕 + BGM + faststart） ----
// srtPath 建议传文件名并让 ffmpeg 在字幕所在目录运行（cwd），避开 Windows 盘符/反斜杠在
// subtitles 滤镜里的转义问题；传绝对路径也能用（会做转义）。
function buildFinalCommand({ segmentFiles, srtPath, bgmFile = "", output, burnSubtitles = true, fontName = subtitleFontFor() }) {
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", segmentFiles.listFile];
  const hasBgm = !!bgmFile;
  // BGM 循环播放，避免比成片短时后半段没有音乐；混音时长以主音轨为准。
  if (hasBgm) args.push("-stream_loop", "-1", "-i", bgmFile);
  const filters = [];
  let vMap = "0:v";
  if (burnSubtitles && srtPath) {
    const style = fontName ? `:force_style='FontName=${String(fontName).replace(/'/g, "")},FontSize=16,Outline=1'` : "";
    filters.push(`[0:v]subtitles='${escapeSubtitlePath(srtPath)}'${style}[vout]`);
    vMap = "[vout]";
  }
  let aMap = "0:a";
  if (hasBgm) {
    // BGM 压到约 18% 再混音；normalize=0 关掉 amix 的自动归一化，否则人声会被压低一半。
    filters.push("[1:a]volume=0.18[bgm]");
    filters.push("[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]");
    aMap = "[aout]";
  }
  if (filters.length) args.push("-filter_complex", filters.join(";"));
  args.push("-map", vMap, "-map", aMap);
  if (burnSubtitles && srtPath) args.push("-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p");
  else args.push("-c:v", "copy");
  args.push("-c:a", "aac", "-ar", String(SEG_AUDIO_RATE), "-ac", "2", "-movflags", "+faststart", output);
  return args;
}

function writeConcatList(files, listFile) {
  const body = files.map((f) => `file '${String(f).replace(/'/g, "'\\''")}'`).join("\n") + "\n";
  fs.mkdirSync(path.dirname(listFile), { recursive: true });
  fs.writeFileSync(listFile, body);
  return listFile;
}

// 默认执行器：execFile 的 Promise 包装（runFn 可注入，单测用假实现）。
function defaultRun(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: 1800000, maxBuffer: 16 * 1024 * 1024, cwd: cwd || undefined, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg 失败：${stderr ? String(stderr).slice(-500) : err.message}`));
      else resolve({ stdout, stderr });
    });
  });
}

function defaultCheck(cmd) {
  return new Promise((resolve) => {
    execFile(cmd, ["-version"], { timeout: 10000, windowsHide: true }, (err) => resolve(!err));
  });
}

// 完整渲染（编排器，I/O 与命令执行可注入，便于单测与 IPC 共用）。
// 入参：{ project, shots（已排 start/end）, assetsById, videoDir, outDir, tmpDir, burnSubtitles, bgmFile（绝对路径或空）,
//         run（默认 defaultRun）, check（默认 defaultCheck）, probe（默认不测，调用方已把秒数写进 asset.seconds）, onProgress({stage,pct,message}) }
// 返回：{ outputPath（videoDir 下相对路径）, srtPath（相对路径）, segments, warnings, burned, totalSeconds }
async function renderProject(opts = {}) {
  const { project, shots = [], assetsById = {}, videoDir = "", outDir = "", tmpDir = "", burnSubtitles = true } = opts;
  const run = opts.run || defaultRun;
  const check = opts.check || defaultCheck;
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  if (!project || !project.id) throw new RenderError("缺少项目，无法渲染", { code: "NO_PROJECT" });
  if (!shots.length) throw new RenderError("该项目没有镜头，无法渲染", { code: "NO_SHOTS" });
  const ffmpegOk = await check("ffmpeg");
  const ffprobeOk = await check("ffprobe");
  if (!ffmpegOk || !ffprobeOk) {
    throw new RenderError(
      "未检测到系统 ffmpeg/ffprobe，无法合成导出。请先安装系统 ffmpeg（macOS：brew install ffmpeg；Ubuntu/Debian：sudo apt install ffmpeg；Windows：winget install ffmpeg），装好后重启应用再试。",
      { code: "FFMPEG_MISSING" },
    );
  }
  const timedShots = [...shots].sort((a, b) => (a.order || 0) - (b.order || 0));
  const totalSeconds = round1(timedShots.reduce((a, s) => a + (Number(s.end) || 0) - (Number(s.start) || 0), 0)) ||
    round1(timedShots.reduce((a, s) => a + measuredDuration(s), 0));
  const { segments, warnings } = planSegments(timedShots, assetsById, { aspect: project.aspect });
  const allWarnings = [...warnings];
  // 时长为 0 的镜头（无口播、无配音的空白占位镜头）没有可渲染的内容：
  // 跳过该段并记一条 warning，而不是给 ffmpeg 一个 -t 0 的空段（会直接失败）。
  // 有口播或配音的镜头时长恒 > 0，不会被这条规则误跳。
  const renderSegments = segments.filter((s) => s.duration > 0);
  for (const s of segments.filter((s) => s.duration <= 0)) {
    allWarnings.push(`第 ${s.order + 1} 镜无内容（无口播、无配音），已跳过该镜。`);
  }
  if (!renderSegments.length) {
    throw new RenderError("该项目所有镜头都没有内容（无口播、无配音），无法渲染", { code: "NO_CONTENT" });
  }
  const base = path.join(outDir || path.join(videoDir, `projects/${project.id}/output`));
  const tmp = tmpDir || path.join(base, ".tmp");
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  const stamp = Date.now();
  const outputName = `video-${stamp}.mp4`;
  const outputAbs = path.join(base, outputName);
  const srtAbs = path.join(base, `video-${stamp}.srt`);
  const listFile = path.join(tmp, `concat-${stamp}.txt`);

  // SRT sidecar：无论烧入成败都写，烧入失败时它就是唯一字幕。
  const srtText = buildSrt(timedShots);
  fs.writeFileSync(srtAbs, srtText);

  // 逐段渲染（只渲染时长 > 0 的段）；临时文件带时间戳，结束后（无论成败）一律清理。
  const segmentFiles = [];
  const cleanup = () => {
    for (const f of [...segmentFiles, listFile]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
    try { if (!tmpDir && fs.readdirSync(tmp).length === 0) fs.rmdirSync(tmp); } catch { /* ignore */ }
  };
  let burned = false;
  try {
    for (let i = 0; i < renderSegments.length; i++) {
      const seg = renderSegments[i];
      onProgress({ stage: "segments", pct: Math.round((i / Math.max(1, renderSegments.length)) * 60), message: `正在渲染第 ${i + 1}/${renderSegments.length} 镜` });
      const segFile = path.join(tmp, `seg-${stamp}-${i}.mp4`);
      const args = buildSegmentCommand({
        ...seg,
        videoFile: seg.videoFile ? path.join(videoDir, seg.videoFile) : "",
        audioFile: seg.audioFile ? path.join(videoDir, seg.audioFile) : "",
      }, segFile);
      segmentFiles.push(segFile);
      await run(args, { cwd: base });
    }
    writeConcatList(segmentFiles, listFile);

    // 最终合成：先试烧入，失败则退回不烧入（只出 SRT），绝不谎称已烧入。
    // 字幕用文件名 + cwd=成片目录，避开 Windows 路径在 subtitles 滤镜里的转义问题。
    const bgmAbs = opts.bgmFile || "";
    const srtArg = path.basename(srtAbs);
    onProgress({ stage: "final", pct: 85, message: burnSubtitles ? "正在烧入字幕并合成成片" : "正在合成成片（不烧字幕）" });
    if (burnSubtitles) {
      try {
        await run(buildFinalCommand({ segmentFiles: { listFile }, srtPath: srtArg, bgmFile: bgmAbs, output: outputAbs, burnSubtitles: true, fontName: opts.fontName }), { cwd: base });
        burned = true;
      } catch (err) {
        const msg = `字幕烧入失败（${(err && err.message) || err}），已改为仅输出 SRT 字幕文件，成片本身不受影响。`;
        allWarnings.push(msg);
        await run(buildFinalCommand({ segmentFiles: { listFile }, srtPath: srtArg, bgmFile: bgmAbs, output: outputAbs, burnSubtitles: false }), { cwd: base });
        burned = false;
      }
    } else {
      await run(buildFinalCommand({ segmentFiles: { listFile }, srtPath: srtArg, bgmFile: bgmAbs, output: outputAbs, burnSubtitles: false }), { cwd: base });
    }
  } finally {
    cleanup();
  }
  onProgress({ stage: "done", pct: 100, message: "合成完成" });
  const rel = (abs) => path.relative(videoDir, abs).replace(/\\/g, "/");
  return {
    outputPath: rel(outputAbs), srtPath: rel(srtAbs),
    segments: renderSegments, warnings: allWarnings, burned, totalSeconds,
  };
}

module.exports = {
  RenderError, aspectSize, formatSrtTime, splitNarration, buildSrt, escapeSubtitlePath,
  planSegments, buildSegmentCommand, buildFinalCommand, writeConcatList, renderProject, subtitleFontFor,
};
