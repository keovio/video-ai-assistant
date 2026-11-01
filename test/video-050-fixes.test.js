"use strict";
// 0.5.0 问题修复的回归测试：PATH 补全、合成规格统一、资产跨项目安全、崩溃恢复、
// 全局语速、批量写盘、AI 兼容回退与看画面、渲染重跑沿用选项、真实 ffmpeg 混合规格拼接。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { tmp } = require("./helpers");
const { augmentedPath, extraBinDirs } = require("../lib/video/bin-path");
const { buildSegmentCommand, buildFinalCommand, renderProject } = require("../lib/video/render");
const { voiceOf, normalizeProject } = require("../lib/video-model");
const { createVideoStore, createCollection } = require("../lib/video-store");
const { setupVideoIpc } = require("../lib/video-ipc");
const { createSecretsStore } = require("../lib/video/secrets");
const { analyzeVideo, chatComplete } = require("../lib/video/ai");
const { probeDuration } = require("../lib/video/tts");

function wav1s() {
  const samples = 8000, header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + samples * 2, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(samples * 2, 40);
  return Buffer.concat([header, Buffer.alloc(samples * 2)]);
}

function harness({ fetchImpl = null, ttsRate = 1, defaults = null } = {}) {
  const dir = path.join(tmp(), "video");
  const store = createVideoStore(dir);
  const ipcMain = { handlers: {}, handle(ch, fn) { this.handlers[ch] = fn; } };
  const secrets = createSecretsStore({ file: path.join(tmp(), "secrets.json"), safeStorage: null });
  secrets.set("ttsApiKey", "sk-test");
  setupVideoIpc({
    ipcMain, store, videoDir: dir,
    videoDefaults: defaults || {},
    getTtsSettings: () => ({ ttsProvider: "openai", ttsVoice: "alloy", ttsRate, ttsBaseUrl: "https://example.invalid/v1", ttsModel: "tts-1" }),
    getTtsKey: () => secrets.get("ttsApiKey"),
    fetchImpl, secrets,
  });
  return { dir, store, h: ipcMain.handlers };
}

test("PATH 补全：mac 追加 Homebrew 目录，不重复；Windows 用分号并识别 Path 键", () => {
  const mac = augmentedPath({ platform: "darwin", env: { PATH: "/usr/bin:/bin:/usr/local/bin" }, exists: () => true });
  assert.equal(mac.key, "PATH");
  const parts = mac.value.split(":");
  assert.ok(parts.includes("/opt/homebrew/bin"));
  assert.equal(parts.filter((p) => p === "/usr/local/bin").length, 1);
  assert.equal(parts[0], "/usr/bin", "原有顺序保持在前");
  const none = augmentedPath({ platform: "darwin", env: { PATH: "/usr/bin" }, exists: () => false });
  assert.equal(none.value, "/usr/bin");
  const win = augmentedPath({ platform: "win32", env: { Path: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, exists: () => true });
  assert.equal(win.key, "Path");
  assert.ok(win.value.split(";").some((p) => /WinGet\\Links$/.test(p)));
  assert.ok(extraBinDirs("linux").includes("/snap/bin"));
});

test("合成命令：片段/黑场统一缩放补边、SAR、帧率；音频统一 44.1k 立体声；BGM 循环且不压人声；字幕带中文字体", () => {
  const clip = buildSegmentCommand({ kind: "clip", videoFile: "v.mp4", audioFile: "a.mp3", duration: 3, width: 720, height: 1280 }, "o.mp4").join(" ");
  assert.match(clip, /scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280/);
  assert.match(clip, /setsar=1/);
  assert.match(clip, /aresample=44100/);
  assert.match(clip, /-ar 44100 -ac 2/);
  const black = buildSegmentCommand({ kind: "audio-only", videoFile: "", audioFile: "", duration: 1, width: 720, height: 720 }, "o.mp4").join(" ");
  assert.match(black, /anullsrc=r=44100:cl=stereo/);
  assert.match(black, /pad=720:720/);
  const fin = buildFinalCommand({ segmentFiles: { listFile: "l.txt" }, srtPath: "v.srt", bgmFile: "b.mp3", output: "o.mp4", burnSubtitles: true, fontName: "PingFang SC" });
  const j = fin.join(" ");
  assert.match(j, /normalize=0/);
  assert.ok(fin.indexOf("-stream_loop") >= 0 && fin.indexOf("-stream_loop") < fin.indexOf("b.mp3"));
  assert.match(j, /force_style='FontName=PingFang SC/);
});

const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); execFileSync("ffprobe", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("真实 ffmpeg：横屏 24fps 片段 + 黑场段混拼成竖屏成片，规格一致、临时文件清理干净", { skip: !hasFfmpeg && "无系统 ffmpeg" }, async () => {
  const videoDir = path.join(tmp(), "video");
  const assets = path.join(videoDir, "projects/p1/assets");
  fs.mkdirSync(assets, { recursive: true });
  // 生成一个 640x360、24fps、1 秒、带 22.05k 单声道音轨的横屏片段（模拟规格不一致的即梦片段）
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=640x360:r=24:d=1", "-f", "lavfi", "-i", "sine=f=440:r=22050:d=1",
    "-ac", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(assets, "clip.mp4")]);
  fs.writeFileSync(path.join(assets, "a.wav"), wav1s());
  const assetsById = {
    v1: { id: "v1", kind: "video", path: "projects/p1/assets/clip.mp4", seconds: 1 },
    a1: { id: "a1", kind: "audio", path: "projects/p1/assets/a.wav", seconds: 1 },
  };
  const shots = [
    { id: "s1", order: 0, narration: "第一镜。", audioAssetId: "a1", audioSeconds: 1, videoAssetId: "v1", start: 0, end: 1 },
    { id: "s2", order: 1, narration: "第二镜。", audioAssetId: "a1", audioSeconds: 1, start: 1, end: 2 },
  ];
  const outDir = path.join(videoDir, "projects/p1/output");
  const r = await renderProject({ project: { id: "p1", aspect: "9:16" }, shots, assetsById, videoDir, outDir, burnSubtitles: false });
  const out = path.join(videoDir, r.outputPath);
  const info = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", out], { encoding: "utf8" }).trim();
  assert.equal(info, "720,1280");
  const dur = probeDuration(out);
  assert.ok(dur != null && Math.abs(dur - 2) < 0.3, `成片约 2 秒，实测 ${dur}`);
  const tmpDir = path.join(outDir, ".tmp");
  assert.ok(!fs.existsSync(tmpDir) || fs.readdirSync(tmpDir).length === 0, "临时分段文件应清理");
});

test("复制项目后删除原项目：副本的配音仍可试听；删除项目会清掉项目目录", async () => {
  const { dir, store, h } = harness();
  const { project } = store.createProject({ title: "原" }, 1);
  const shot = store.shotsOf(project.id)[0];
  store.updateShot(shot.id, { narration: "你好" });
  const imp = await h["video:shots.importAudio"](null, shot.id, { name: "v.wav", data: wav1s() });
  assert.equal(imp.ok, true);
  const dup = await h["video:projects.duplicate"](null, project.id);
  assert.equal(dup.ok, true);
  const copyShot = dup.shots[0];
  assert.notEqual(copyShot.audioAssetId, shot.audioAssetId || imp.asset.id, "副本应有自己的资产");
  const rm = await h["video:projects.remove"](null, project.id);
  assert.equal(rm.removed, true);
  assert.ok(!fs.existsSync(path.join(dir, "projects", project.id)), "原项目目录应删除");
  const audio = await h["video:shots.audioData"](null, copyShot.id);
  assert.equal(audio.ok, true, audio.error);
});

test("旧数据兼容：别的项目引用了本项目目录下的资产，删除本项目时资产搬家而不是丢失", async () => {
  const { dir, store, h } = harness();
  const a = store.createProject({ title: "A" }, 1);
  const b = store.createProject({ title: "B" }, 1);
  const sa = store.shotsOf(a.project.id)[0];
  const sb = store.shotsOf(b.project.id)[0];
  const imp = await h["video:shots.importAudio"](null, sa.id, { name: "v.wav", data: wav1s() });
  // 模拟 0.4.0 的跨项目去重：B 直接引用 A 目录下的资产
  store.updateShot(sb.id, { audioAssetId: imp.asset.id, audioSeconds: 1 });
  await h["video:projects.remove"](null, a.project.id);
  const asset = store.assets.get(imp.asset.id);
  assert.ok(asset, "资产记录应保留");
  assert.ok(asset.path.startsWith(`projects/${b.project.id}/`), "资产应搬到 B 的目录");
  assert.ok(fs.existsSync(path.join(dir, asset.path)));
  const audio = await h["video:shots.audioData"](null, sb.id);
  assert.equal(audio.ok, true);
});

test("崩溃恢复：残留的 running 合成与 voicing 镜头在启动时标为失败，之后可再次合成", () => {
  const dir = path.join(tmp(), "video");
  const store = createVideoStore(dir);
  const { project } = store.createProject({ title: "T" }, 1);
  const shot = store.shotsOf(project.id)[0];
  store.renders.upsert({ projectId: project.id, status: "running", stage: "segments" });
  store.projects.upsert({ ...store.projects.get(project.id), status: "rendering" });
  store.updateShot(shot.id, { status: "voicing" });
  const fresh = createVideoStore(dir); // 模拟重启
  const n = fresh.recoverInterrupted();
  assert.ok(n >= 3);
  assert.equal(fresh.renders.list({ projectId: project.id })[0].status, "failed");
  assert.equal(fresh.projects.get(project.id).status, "failed");
  assert.equal(fresh.shots.get(shot.id).status, "failed");
});

test("语速：项目没单独设置时用全局语速；项目设置了才覆盖", async () => {
  assert.equal(voiceOf({}).rate, 0);
  assert.equal(normalizeProject({}).voice.rate, 0);
  const bodies = [];
  const fetchImpl = async (_url, opts) => { bodies.push(JSON.parse(opts.body)); return { ok: true, status: 200, arrayBuffer: async () => wav1s(), text: async () => "" }; };
  const { store, h } = harness({ fetchImpl, ttsRate: 1.3 });
  const { project } = store.createProject({ title: "T" }, 1);
  const shot = store.shotsOf(project.id)[0];
  store.updateShot(shot.id, { narration: "你好" });
  await h["video:shots.generateAudio"](null, shot.id, {});
  assert.equal(bodies[0].speed, 1.3);
  store.projects.upsert({ ...store.projects.get(project.id), voice: { rate: 0.8 } });
  await h["video:shots.generateAudio"](null, shot.id, {});
  assert.equal(bodies[1].speed, 0.8);
});

test("新建项目默认值每次现读（改设置后立即生效）", async () => {
  let n = 2;
  const { h } = harness({ defaults: () => ({ defaultShotCount: n, aspect: "16:9" }) });
  const a = await h["video:projects.create"](null, { title: "a" });
  assert.equal(a.shots.length, 2);
  n = 4;
  const b = await h["video:projects.create"](null, { title: "b" });
  assert.equal(b.shots.length, 4);
  assert.equal(b.project.aspect, "16:9");
});

test("重跑合成沿用原来的“不烧字幕”选项", async () => {
  const calls = [];
  const dir = path.join(tmp(), "video");
  const store = createVideoStore(dir);
  const ipcMain = { handlers: {}, handle(ch, fn) { this.handlers[ch] = fn; } };
  setupVideoIpc({ ipcMain, store, videoDir: dir, renderRun: async (args) => { calls.push(args.join(" ")); const out = args[args.length - 1]; fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, "x"); }, renderCheck: async () => true });
  const h = ipcMain.handlers;
  const { project } = store.createProject({ title: "T" }, 1);
  store.updateShot(store.shotsOf(project.id)[0].id, { narration: "你好世界" });
  const r1 = await h["video:renders.start"](null, project.id, { burnSubtitles: false });
  for (let i = 0; i < 50 && store.renders.get(r1.render.id).status !== "done"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.renders.get(r1.render.id).burnSubtitles, false);
  calls.length = 0;
  const r2 = await h["video:renders.retry"](null, r1.render.id);
  for (let i = 0; i < 50 && store.renders.get(r2.render.id).status !== "done"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(!calls.some((c) => c.includes("subtitles=")), "重跑不应烧字幕");
});

test("批量写盘：batch 内多次 upsert 只落盘一次；改一镜不刷新其他镜头的 updatedAt", () => {
  const file = path.join(tmp(), "c.json");
  let t = 1;
  const c = createCollection({ file, now: () => t++ });
  c.batch(() => { c.upsert({ a: 1 }); c.upsert({ a: 2 }); assert.ok(!fs.existsSync(file), "batch 期间不落盘"); });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).items.length, 2);
  const store = createVideoStore(path.join(tmp(), "video"));
  const { project } = store.createProject({ title: "T" }, 3);
  const [a, b, c2] = store.shotsOf(project.id);
  store.updateShot(c2.id, { visual: "只改画面" });
  assert.equal(store.shots.get(a.id).updatedAt, a.updatedAt);
  assert.equal(store.shots.get(b.id).updatedAt, b.updatedAt);
});

const VALID = {
  style: { visual: "电影感", camera: "慢推", pacing: "慢", mood: "忧郁", colorLight: "暖", sound: "钢琴", hooks: "悬念" },
  skill: { name: "x", description: "d", body: "b" },
  script: { title: "t", narration: "n", shots: [{ narration: "一句", visual: "v", seconds: 3 }] },
};
const okRes = (content) => { const body = JSON.stringify({ choices: [{ message: { content } }] }); return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body), text: async () => body }; };
const errRes = (status, text) => ({ ok: false, status, arrayBuffer: async () => Buffer.from(text), text: async () => text });

test("AI：服务不支持 response_format 时自动去掉重试", async () => {
  const sent = [];
  const fetchImpl = async (_u, opts) => {
    const b = JSON.parse(opts.body); sent.push(b);
    return b.response_format ? errRes(400, "unknown parameter: response_format") : okRes('{"a":1}');
  };
  const r = await chatComplete({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetchImpl, messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.content, '{"a":1}');
  assert.equal(sent.length, 2);
  assert.ok(!sent[1].response_format);
});

test("AI 看画面：带截图调用；模型不支持图片时退回纯文本", async () => {
  const img = "data:image/jpeg;base64,AAAA";
  const sent = [];
  const vision = async (_u, opts) => { const b = JSON.parse(opts.body); sent.push(b); return okRes(JSON.stringify(VALID)); };
  const r1 = await analyzeVideo({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetchImpl: vision, images: [img], videoInfo: { caption: "c" } });
  assert.equal(r1.usedImages, true);
  assert.ok(Array.isArray(sent[0].messages[1].content));
  assert.equal(sent[0].messages[1].content[1].type, "image_url");
  const textOnly = async (_u, opts) => {
    const b = JSON.parse(opts.body);
    return Array.isArray(b.messages[1].content) ? errRes(400, "image input not supported") : okRes(JSON.stringify(VALID));
  };
  const r2 = await analyzeVideo({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetchImpl: textOnly, images: [img], videoInfo: { caption: "c" } });
  assert.equal(r2.usedImages, false);
  assert.equal(r2.script.shots.length, 1);
});

test("0.6.26：生成配音可取消，取消后不算失败", async () => {
  const fetchImpl = (_url, opts) => new Promise((_res, rej) => {
    opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const { store, h } = harness({ fetchImpl });
  const { project } = store.createProject({ title: "T" }, 1);
  const shot = store.shotsOf(project.id)[0];
  store.updateShot(shot.id, { narration: "你好" });
  const p = h["video:shots.generateAudio"](null, shot.id, {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.shots.get(shot.id).status, "voicing");
  const c = await h["video:shots.cancelAudio"](null, shot.id);
  assert.equal(c.cancelled, 1);
  const r = await p;
  assert.equal(r.cancelled, true);
  assert.notEqual(store.shots.get(shot.id).status, "failed");
  assert.notEqual(store.shots.get(shot.id).status, "voicing");
});
