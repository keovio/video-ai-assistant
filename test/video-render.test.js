"use strict";
// M3 合成：分段规划（循环/截断/黑场兜底/静音补齐）、SRT 生成、
// ffmpeg 命令拼接、烧入失败退回 SRT、真实系统 ffmpeg 端到端渲染、IPC 渲染与片段导入。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmp } = require("./helpers");
const {
  RenderError, formatSrtTime, splitNarration, buildSrt, escapeSubtitlePath,
  planSegments, buildSegmentCommand, buildFinalCommand, writeConcatList, renderProject,
} = require("../lib/video/render");
const { probeDuration } = require("../lib/video/tts");
const { createVideoStore } = require("../lib/video-store");
const { setupVideoIpc } = require("../lib/video-ipc");
const { createSecretsStore } = require("../lib/video/secrets");

function wav1s() {
  const samples = 8000, header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + samples * 2, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(samples * 2, 40);
  return Buffer.concat([header, Buffer.alloc(samples * 2)]);
}

const assets = {
  a1: { id: "a1", kind: "audio", path: "projects/p/assets/a.mp3", seconds: 0 },
  v1: { id: "v1", kind: "video", path: "projects/p/assets/v.mp4", seconds: 3 },
  vLong: { id: "vLong", kind: "video", path: "projects/p/assets/vl.mp4", seconds: 20 },
  img1: { id: "img1", kind: "image", path: "projects/p/assets/i.png", seconds: 0 },
};

test("SRT：时间格式、分句等比分配、镜头起止偏移", () => {
  assert.equal(formatSrtTime(0), "00:00:00,000");
  assert.equal(formatSrtTime(61.5), "00:01:01,500");
  assert.equal(formatSrtTime(3661.234), "01:01:01,234");
  const parts = splitNarration("你好世界。再见朋友。", 4);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].text, "你好世界。");
  assert.equal(parts[1].end, 4);
  assert.ok(Math.abs(parts[0].seconds - 2) < 0.2);
  const srt = buildSrt([
    { start: 0, end: 1, narration: "你好" },
    { start: 1, end: 3, narration: "世界你好" },
    { start: 3, end: 3, narration: "空时长不输出" },
  ]);
  assert.match(srt, /00:00:00,000 --> 00:00:01,000\n你好/);
  assert.match(srt, /00:00:01,000 --> 00:00:03,000\n世界你好/);
  assert.doesNotMatch(srt, /空时长不输出/);
  assert.equal(escapeSubtitlePath("/a:b/c'd.srt"), "/a\\:b/c\\'d.srt");
});

test("分段规划：片段短了循环、长了截断、无画面黑场兜底、无配音静音补齐、顺序不丢镜头", () => {
  const shots = [
    { id: "s1", order: 0, narration: "一二三四五", audioAssetId: "a1", audioSeconds: 5, videoAssetId: "v1" }, // 片段 3 秒 < 音频 5 秒：循环
    { id: "s2", order: 1, narration: "一二三四五", audioAssetId: "a1", audioSeconds: 5, videoAssetId: "vLong" }, // 片段 20 秒 > 音频：截断
    { id: "s3", order: 2, narration: "一二三四五", audioAssetId: "a1", audioSeconds: 5, imageAssetId: "img1" }, // 图片 + zoompan
    { id: "s4", order: 3, narration: "一二三四五", audioAssetId: "a1", audioSeconds: 5 }, // 无画面：黑场，配音保留
    { id: "s5", order: 4, narration: "一二三四五", videoAssetId: "v1" }, // 无配音：估算时长 + 静音警告
  ];
  const { segments, warnings } = planSegments(shots, assets);
  assert.deepEqual(segments.map((s) => s.shotId), ["s1", "s2", "s3", "s4", "s5"]);
  assert.equal(segments[0].kind, "clip");
  assert.equal(segments[0].loop, true);
  assert.equal(segments[1].trim, true);
  assert.equal(segments[2].kind, "image");
  assert.equal(segments[3].kind, "audio-only");
  assert.ok(segments[3].audioFile, "黑场段仍保留配音文件");
  assert.ok(warnings.some((w) => /黑场/.test(w)));
  assert.ok(warnings.some((w) => /静音/.test(w)));
  assert.equal(segments[4].duration, 1.2); // 5 字 / 4.5 = 1.2（估算）
  assert.equal(segments[4].audioFile, "");
});

test("单段命令：图片段含 zoompan、片段循环含 stream_loop、输出含时长与编码", () => {
  const imgArgs = buildSegmentCommand({ kind: "image", videoFile: "i.png", audioFile: "a.mp3", duration: 2, width: 720, height: 1280 }, "seg.mp4");
  assert.ok(imgArgs.join(" ").includes("zoompan"));
  assert.ok(imgArgs.includes("libx264") && imgArgs.includes("aac"));
  const loopArgs = buildSegmentCommand({ kind: "clip", videoFile: "v.mp4", audioFile: "a.mp3", duration: 5, loop: true, width: 720, height: 1280 }, "seg.mp4");
  assert.ok(loopArgs.includes("-stream_loop"));
  const silentArgs = buildSegmentCommand({ kind: "audio-only", videoFile: "", audioFile: "", duration: 1, width: 720, height: 1280 }, "seg.mp4");
  assert.ok(silentArgs.join(" ").includes("anullsrc"));
  assert.ok(silentArgs.join(" ").includes("color=c=black"));
});

test("最终命令：烧入用 subtitles+重编码、不烧入用 copy、faststart 恒有、BGM 混音压低", () => {
  const burn = buildFinalCommand({ segmentFiles: { listFile: "list.txt" }, srtPath: "a.srt", output: "out.mp4", burnSubtitles: true });
  assert.ok(burn.join(" ").includes("subtitles="));
  assert.ok(burn.includes("libx264") && burn.includes("+faststart"));
  const copy = buildFinalCommand({ segmentFiles: { listFile: "list.txt" }, srtPath: "a.srt", output: "out.mp4", burnSubtitles: false });
  assert.ok(copy.includes("copy"));
  assert.ok(!copy.join(" ").includes("subtitles="));
  const bgm = buildFinalCommand({ segmentFiles: { listFile: "list.txt" }, srtPath: "a.srt", bgmFile: "bgm.mp3", output: "out.mp4", burnSubtitles: false });
  assert.ok(bgm.join(" ").includes("volume=0.18") && bgm.join(" ").includes("amix"));
  const listFile = path.join(tmp(), "concat.txt");
  writeConcatList(["/tmp/a b.mp4", "/tmp/c.mp4"], listFile);
  assert.match(fs.readFileSync(listFile, "utf8"), /file '\/tmp\/a b\.mp4'/);
});

test("renderProject 假执行：烧入失败退回 SRT、不谎称已烧入；ffmpeg 缺失开工前报错", async () => {
  const dir = tmp();
  const calls = [];
  const fakeRun = async (args) => {
    calls.push(args);
    const out = args[args.length - 1];
    if (args.join(" ").includes("subtitles=")) throw new Error("libass 不可用（模拟）");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, "fake-mp4");
  };
  const result = await renderProject({
    project: { id: "p", aspect: "9:16" },
    shots: [
      { id: "s1", order: 0, narration: "你好世界", start: 0, end: 1, audioAssetId: "a1", audioSeconds: 1 },
      { id: "s2", order: 1, narration: "测试", start: 1, end: 1.5 },
    ],
    assetsById: assets, videoDir: dir, outDir: path.join(dir, "out"),
    burnSubtitles: true, run: fakeRun, check: async () => true,
  });
  assert.equal(result.burned, false);
  assert.ok(result.warnings.some((w) => /字幕烧入失败/.test(w)));
  assert.ok(fs.existsSync(path.join(dir, result.srtPath)));
  assert.ok(fs.existsSync(path.join(dir, result.outputPath)));
  assert.match(fs.readFileSync(path.join(dir, result.srtPath), "utf8"), /你好世界/);
  await assert.rejects(
    renderProject({ project: { id: "p" }, shots: [{ id: "s1", order: 0, narration: "你好" }], assetsById: {}, videoDir: dir, run: fakeRun, check: async () => false }),
    (e) => e instanceof RenderError && e.code === "FFMPEG_MISSING" && /brew install ffmpeg/.test(e.message),
  );
  await assert.rejects(
    renderProject({ project: { id: "p" }, shots: [], assetsById: {}, videoDir: dir, run: fakeRun, check: async () => true }),
    /没有镜头/,
  );
});

test("renderProject：空白占位镜头（时长 0）被跳过并记 warning，不导致 ffmpeg 空段失败", async () => {
  const dir = tmp();
  const calls = [];
  const fakeRun = async (args) => {
    calls.push(args);
    const out = args[args.length - 1];
    if (out.endsWith(".mp4")) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, "fake-mp4"); }
  };
  const result = await renderProject({
    project: { id: "p", aspect: "9:16" },
    shots: [
      { id: "s1", order: 0, narration: "你好世界", start: 0, end: 1, audioAssetId: "a1", audioSeconds: 1 },
      { id: "s2", order: 1, narration: "", start: 1, end: 1 }, // 空白占位：时长 0
    ],
    assetsById: assets, videoDir: dir, outDir: path.join(dir, "out"),
    burnSubtitles: false, run: fakeRun, check: async () => true,
  });
  assert.equal(result.segments.length, 1);
  assert.ok(result.warnings.some((w) => /无内容/.test(w)));
  await assert.rejects(
    renderProject({
      project: { id: "p" },
      shots: [{ id: "s1", order: 0, narration: "", start: 0, end: 0 }],
      assetsById: {}, videoDir: dir, run: fakeRun, check: async () => true,
    }),
    /所有镜头都没有内容/,
  );
});

test("renderProject 真实 ffmpeg：1 秒配音 + 无画面黑场兜底，成片与 SRT 齐全、时长约 1 秒", async () => {
  const videoDir = path.join(tmp(), "video");
  const projectId = "p-real";
  const assetsDir = path.join(videoDir, `projects/${projectId}/assets`);
  fs.mkdirSync(assetsDir, { recursive: true });
  const wavPath = path.join(assetsDir, "voice.wav");
  fs.writeFileSync(wavPath, wav1s());
  const result = await renderProject({
    project: { id: projectId, aspect: "9:16" },
    shots: [{ id: "s1", order: 0, narration: "你好世界", start: 0, end: 1, audioAssetId: "a1", audioSeconds: 1 }],
    assetsById: { a1: { id: "a1", kind: "audio", path: `projects/${projectId}/assets/voice.wav`, seconds: 1 } },
    videoDir,
    outDir: path.join(videoDir, `projects/${projectId}/output`),
    burnSubtitles: false,
  });
  const outAbs = path.join(videoDir, result.outputPath);
  assert.ok(fs.existsSync(outAbs), "成片文件应存在");
  assert.ok(fs.statSync(outAbs).size > 0);
  assert.ok(fs.existsSync(path.join(videoDir, result.srtPath)));
  const dur = probeDuration(outAbs);
  assert.ok(dur != null && Math.abs(dur - 1) < 0.5, `成片时长应约 1 秒，实测 ${dur}`);
  assert.ok(result.warnings.some((w) => /黑场/.test(w)), "无画面镜头应记黑场 warning");
});

function setupIpcHarness() {
  const dir = path.join(tmp(), "video");
  const store = createVideoStore(dir);
  const ipcMain = { handlers: {}, handle(ch, fn) { this.handlers[ch] = fn; } };
  const secrets = createSecretsStore({ file: path.join(tmp(), "secrets.json"), safeStorage: null });
  const calls = [];
  const fakeRun = async (args) => {
    calls.push(args);
    const out = args[args.length - 1];
    if (out.endsWith(".mp4")) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, "fake-mp4"); }
  };
  setupVideoIpc({
    ipcMain, store, videoDir: dir, secrets,
    getTtsSettings: () => ({}), getTtsKey: () => "",
    renderRun: fakeRun, renderCheck: async () => true,
  });
  return { dir, store, h: ipcMain.handlers, calls };
}

async function waitForRender(h, projectId, timeoutMs = 10000) {
  const started = Date.now();
  for (;;) {
    const rs = await h["video:renders.list"](null, projectId);
    const rec = (rs.renders || [])[0];
    if (rec && (rec.status === "done" || rec.status === "failed")) return rec;
    if (Date.now() - started > timeoutMs) throw new Error("渲染轮询超时");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("IPC 渲染：假 ffmpeg 下开始合成 -> done，成片/SRT 路径与黑场 warning 齐全；片段导入挂视频资产", async () => {
  const { store, h } = setupIpcHarness();
  const { project } = store.createProject({ title: "T" }, 1);
  const shot = store.shotsOf(project.id)[0];
  store.updateShot(shot.id, { narration: "你好世界" });
  const impA = await h["video:shots.importAudio"](null, shot.id, { name: "voice.wav", data: wav1s() });
  assert.equal(impA.ok, true);
  const started = await h["video:renders.start"](null, project.id, { burnSubtitles: true });
  assert.equal(started.ok, true);
  const rec = await waitForRender(h, project.id);
  assert.equal(rec.status, "done");
  assert.ok(rec.outputPath.endsWith(".mp4"));
  assert.ok(rec.srtPath.endsWith(".srt"));
  assert.ok((rec.warnings || []).some((w) => /黑场/.test(w)));
  assert.equal(store.projects.get(project.id).status, "done");
  // 同项目再开一个应被“已有进行中”拒绝的反例：done 后可再开，这里只验证 done 后能重跑
  const again = await h["video:renders.start"](null, project.id, {});
  assert.equal(again.ok, true);
  const rec2 = await waitForRender(h, project.id);
  assert.equal(rec2.status, "done");

  // 片段导入：假 mp4 bytes 也能挂资产（时长未测到时 clipSeconds 为 0，渲染按音频时长兜底）
  const impV = await h["video:shots.importVideo"](null, shot.id, { name: "clip.mp4", data: Buffer.from("fake-video") });
  assert.equal(impV.ok, true);
  assert.ok(impV.shot.videoAssetId);
  assert.equal(impV.asset.kind, "video");
  const bad = await h["video:shots.importVideo"](null, shot.id, { name: "x.txt", data: Buffer.from("hi") });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /仅支持视频文件/);
  const cleared = await h["video:shots.clearVideo"](null, shot.id);
  assert.equal(cleared.shot.videoAssetId, "");
  // 无窗口时即梦生成明确转手动，不伪造
  const jimeng = await h["video:shots.generateClip"](null, shot.id);
  assert.equal(jimeng.ok, false);
  assert.equal(jimeng.manual, true);
});
