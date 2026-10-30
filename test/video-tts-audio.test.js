"use strict";
// M2 配音：TTS 适配器注册表、OpenAI 兼容调用与失败分类、即梦占位、
// 音频哈希去重、实测时长重排、IPC 导入/生成路径（用假 fetch 与真实 ffprobe 读 WAV 时长）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmp } = require("./helpers");
const {
  TtsError, clampRate, probeDuration, synthesize, synthesizeJimeng, synthesizeOpenAI,
  listProviders, getProvider, registerProvider, resetProviders,
} = require("../lib/video/tts");
const { mimeFor, isAudioFile, storeAudioBytes, hashFile, ffmpegStatus } = require("../lib/video/audio");
const { createSecretsStore } = require("../lib/video/secrets");
const { computeMeasuredTimings, normalizeShot, voiceOf } = require("../lib/video-model");
const { createVideoStore } = require("../lib/video-store");
const { setupVideoIpc } = require("../lib/video-ipc");

// 1 秒、8000Hz、单声道、16bit 的静音 WAV：ffprobe 能读出时长 1.0 秒
function wav1s() {
  const samples = 8000, header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + samples * 2, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(samples * 2, 40);
  return Buffer.concat([header, Buffer.alloc(samples * 2)]);
}

function fakeFetch({ status = 200, body = Buffer.alloc(0), capture = null } = {}) {
  return async (url, opts) => {
    if (capture) capture.push({ url, opts });
    return {
      ok: status >= 200 && status < 300, status,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      text: async () => body.toString(),
    };
  };
}

test("TTS 注册表：openai 可自动、jimeng 明确不可自动、未知 provider 报错", () => {
  resetProviders();
  const providers = listProviders();
  assert.equal(providers.find((p) => p.id === "openai").automated, true);
  assert.equal(providers.find((p) => p.id === "jimeng").automated, false);
  assert.equal(getProvider("nope"), null);
  assert.rejects(() => synthesize({ provider: "nope", text: "你好" }), /未知的 TTS 服务商/);
  registerProvider("fake", async () => ({ file: "x.mp3", seconds: 1 }));
  assert.equal(getProvider("fake").id, "fake");
  resetProviders();
  assert.equal(getProvider("fake"), null);
});

test("OpenAI 兼容 TTS：请求格式、Bearer、写文件、注入的实测时长", async () => {
  const dir = tmp();
  const capture = [];
  const outFile = path.join(dir, "a.mp3");
  const r = await synthesizeOpenAI({
    text: "你好世界", voice: "alloy", rate: 1.25, format: "mp3", outFile,
    baseUrl: "https://example.invalid/v1/", apiKey: "sk-test",
    fetchImpl: fakeFetch({ body: Buffer.from("fake-audio"), capture }),
    probeFn: () => 3.2,
  });
  assert.equal(r.file, outFile);
  assert.equal(r.seconds, 3.2);
  assert.equal(fs.readFileSync(outFile).toString(), "fake-audio");
  assert.equal(capture[0].url, "https://example.invalid/v1/audio/speech"); // 末尾斜杠已去掉
  assert.equal(capture[0].opts.headers.Authorization, "Bearer sk-test");
  const body = JSON.parse(capture[0].opts.body);
  assert.equal(body.input, "你好世界");
  assert.equal(body.voice, "alloy");
  assert.equal(body.speed, 1.25);
  assert.equal(body.response_format, "mp3");
});

test("OpenAI 兼容 TTS：401 不可重试、429 可重试、缺 Key/缺地址直接报错", async () => {
  const outFile = path.join(tmp(), "a.mp3");
  const base = { text: "你好", outFile, baseUrl: "https://example.invalid/v1", apiKey: "k" };
  await assert.rejects(
    synthesizeOpenAI({ ...base, fetchImpl: fakeFetch({ status: 401, body: Buffer.from("bad key") }) }),
    (e) => e instanceof TtsError && e.retryable === false && e.code === "AUTH_FAILED",
  );
  await assert.rejects(
    synthesizeOpenAI({ ...base, fetchImpl: fakeFetch({ status: 429 }) }),
    (e) => e instanceof TtsError && e.retryable === true,
  );
  await assert.rejects(synthesizeOpenAI({ ...base, apiKey: "" }), /请先在设置里保存 TTS Key/);
  await assert.rejects(synthesizeOpenAI({ ...base, baseUrl: "" }), /请先在设置里填写 TTS 服务地址/);
  await assert.rejects(synthesizeOpenAI({ ...base, text: "   " }), /口播文案为空/);
  assert.equal(clampRate(9), 2);
  assert.equal(clampRate(0.1), 0.5);
  assert.equal(clampRate("x"), 1);
});

test("即梦 provider：不伪造成功，明确报错并指引导入音频", async () => {
  await assert.rejects(
    synthesizeJimeng({ text: "你好" }),
    (e) => e instanceof TtsError && e.code === "JIMENG_NOT_AUTOMATED" && /导入音频/.test(e.message),
  );
  await assert.rejects(synthesize({ provider: "jimeng", text: "你好" }), /尚未自动接通/);
});

test("probeDuration：注入失败返回 null，不抛错", () => {
  assert.equal(probeDuration("nope.mp3", () => null), null);
  assert.equal(probeDuration("nope.mp3", () => { throw new Error("boom"); }), null);
});

test("音频资产：同内容去重、哈希一致、扩展名与 mime", () => {
  const dir = path.join(tmp(), "assets");
  const bytes = wav1s();
  const a = storeAudioBytes(bytes, dir, ".wav");
  const b = storeAudioBytes(bytes, dir, ".wav");
  assert.equal(a.hash, b.hash);
  assert.equal(a.rel, b.rel);
  assert.equal(b.deduped, true);
  assert.equal(a.deduped, false);
  assert.equal(hashFile(a.abs), a.hash);
  assert.equal(mimeFor("x.mp3"), "audio/mpeg");
  assert.equal(mimeFor("x.wav"), "audio/wav");
  assert.equal(isAudioFile("x.txt"), false);
  assert.equal(isAudioFile("x.MP3"), true);
  assert.throws(() => storeAudioBytes(Buffer.alloc(0), dir, ".mp3"), /音频文件为空/);
});

test("ffmpeg 状态：注入检测函数可控，缺失时警告非空", () => {
  const all = ffmpegStatus((cmd) => true);
  assert.equal(all.ok, true);
  assert.equal(all.warning, "");
  const missing = ffmpegStatus((cmd) => cmd === "ffmpeg");
  assert.equal(missing.ok, false);
  assert.match(missing.warning, /ffmpeg/);
});

test("密钥存储：加密路径只暴露末 4 位，无钥匙串时明确标未加密", () => {
  const fakeSafe = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from("enc:" + s),
    decryptString: (b) => b.toString().replace(/^enc:/, ""),
  };
  const s1 = createSecretsStore({ file: path.join(tmp(), "secrets.json"), safeStorage: fakeSafe });
  assert.equal(s1.get("ttsApiKey"), "");
  const st = s1.set("ttsApiKey", "sk-abcdef1234");
  assert.equal(st.set, true);
  assert.equal(st.last4, "1234");
  assert.equal(st.insecureFallback, false);
  assert.equal(s1.get("ttsApiKey"), "sk-abcdef1234");
  assert.equal(s1.set("ttsApiKey", "").set, false);

  const s2 = createSecretsStore({ file: path.join(tmp(), "secrets.json"), safeStorage: null });
  const st2 = s2.set("ttsApiKey", "sk-xyz9876");
  assert.equal(st2.insecureFallback, true);
  assert.equal(st2.last4, "9876");
  assert.equal(s2.get("ttsApiKey"), "sk-xyz9876");
});

test("实测时长重排：有配音用实测、无配音用估算；normalize 白名单含新字段", () => {
  const { shots, totalSeconds } = computeMeasuredTimings([
    { id: "a", order: 0, narration: "你好世界", audioAssetId: "asset1", audioSeconds: 1.5 },
    { id: "b", order: 1, narration: "一二三四五六七八九" },
    { id: "c", order: 2, narration: "你好世界", audioAssetId: "", audioSeconds: 9 }, // 无资产：9 秒不算实测
  ]);
  assert.deepEqual([shots[0].start, shots[0].end], [0, 1.5]);
  assert.deepEqual([shots[1].start, shots[1].end], [1.5, 3.5]);
  assert.deepEqual([shots[2].start, shots[2].end], [3.5, 4.4]); // c 退回估算 0.9
  assert.equal(totalSeconds, 4.4);

  const s = normalizeShot({ audioSource: "import", audioMeasured: true, hacked: 1 });
  assert.equal(s.audioSource, "import");
  assert.equal(s.audioMeasured, true);
  assert.equal(s.hacked, undefined);
  assert.equal(normalizeShot({ audioSource: "weird" }).audioSource, "");
  assert.deepEqual(voiceOf({ ttsProvider: "jimeng", voice: "v", rate: 1 }).ttsProvider, "jimeng");
});

test("存储刷新时间：改另一镜口播后，已测时长不被估算覆盖", () => {
  const store = createVideoStore(path.join(tmp(), "video"));
  const { project } = store.createProject({ title: "T" }, 2);
  const [a, b] = store.shotsOf(project.id);
  store.updateShot(a.id, { narration: "你好世界", audioAssetId: "asset1", audioSeconds: 1.5, audioSource: "import", audioMeasured: true });
  // 改第二镜口播：刷新后第一镜仍按 1.5 秒实测排
  store.updateShot(b.id, { narration: "一二三四五六七八九" });
  const list = store.shotsOf(project.id);
  assert.deepEqual([list[0].start, list[0].end], [0, 1.5]);
  assert.deepEqual([list[1].start, list[1].end], [1.5, 3.5]);
  assert.equal(store.projects.get(project.id).totalSeconds, 3.5);
});

// ---- IPC 层：导入 / 生成 / 试听数据 / 即梦占位 ----
function setupIpcHarness({ fetchImpl = null } = {}) {
  const dir = path.join(tmp(), "video");
  const store = createVideoStore(dir);
  const ipcMain = { handlers: {}, handle(ch, fn) { this.handlers[ch] = fn; } };
  const secrets = createSecretsStore({ file: path.join(tmp(), "secrets.json"), safeStorage: null });
  secrets.set("ttsApiKey", "sk-test-key");
  setupVideoIpc({
    ipcMain, store, videoDir: dir,
    getTtsSettings: () => ({ ttsProvider: "openai", ttsVoice: "alloy", ttsRate: 1, ttsBaseUrl: "https://example.invalid/v1", ttsModel: "tts-1" }),
    getTtsKey: () => secrets.get("ttsApiKey"),
    fetchImpl, secrets,
  });
  return { dir, store, h: ipcMain.handlers };
}

test("IPC 导入音频：真实 WAV 经 ffprobe 测出 1 秒，挂资产、标记 import、时间重排", async () => {
  const { store, h } = setupIpcHarness();
  const { project } = store.createProject({ title: "T" }, 2);
  const shot = store.shotsOf(project.id)[0];
  store.updateShot(shot.id, { narration: "你好世界你好世界你好世界" }); // 估算 2.7 秒，先确认不是它
  const r = await h["video:shots.importAudio"](null, shot.id, { name: "voice.wav", data: wav1s() });
  assert.equal(r.ok, true);
  assert.equal(r.measured, true);
  assert.equal(r.seconds, 1);
  assert.equal(r.shot.audioSource, "import");
  assert.equal(r.shot.audioMeasured, true);
  assert.equal(r.shot.audioSeconds, 1);
  assert.equal(r.asset.source, "import");
  assert.equal(r.asset.kind, "audio");
  assert.equal(store.projects.get(project.id).totalSeconds, 1); // 第二镜空口播 0 秒
  // 同内容再导入：资产去重，只有一条音频资产
  const shot2 = store.shotsOf(project.id)[1];
  const r2 = await h["video:shots.importAudio"](null, shot2.id, { name: "again.wav", data: wav1s() });
  assert.equal(r2.deduped, true);
  assert.equal(store.assets.list({ kind: "audio" }).length, 1);
  // 非音频文件拒绝
  const bad = await h["video:shots.importAudio"](null, shot.id, { name: "x.txt", data: Buffer.from("hi") });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /仅支持音频文件/);
});

test("IPC 生成配音：OpenAI 假 fetch + 真实 WAV 时长；即梦返回明确错误且镜头标失败", async () => {
  const { store, h } = setupIpcHarness({ fetchImpl: fakeFetch({ body: wav1s() }) });
  const { project } = store.createProject({ title: "T" }, 1);
  const shot = store.shotsOf(project.id)[0];
  store.updateShot(shot.id, { narration: "你好世界" });
  const r = await h["video:shots.generateAudio"](null, shot.id, {});
  assert.equal(r.ok, true);
  assert.equal(r.provider, "openai");
  assert.equal(r.measured, true);
  assert.equal(r.seconds, 1);
  assert.equal(r.shot.audioSource, "generated");
  assert.equal(r.shot.status, "ready");
  // 试听数据：data URL 前缀与 mime 正确（生成音频按 mp3 格式落盘，故 mime 为 audio/mpeg）
  const audio = await h["video:shots.audioData"](null, shot.id);
  assert.equal(audio.ok, true);
  assert.ok(audio.dataUrl.startsWith("data:audio/mpeg;base64,"));
  // 即梦：不伪造，镜头标失败，错误含导入指引
  const bad = await h["video:shots.generateAudio"](null, shot.id, { provider: "jimeng" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /尚未自动接通/);
  assert.match(bad.error, /导入音频/);
  assert.equal(store.shots.get(shot.id).status, "failed");
  // providers 与 ffmpeg 状态通道
  const providers = await h["video:tts.providers"](null);
  assert.ok(providers.providers.some((p) => p.id === "openai" && p.automated));
  assert.ok(providers.providers.some((p) => p.id === "jimeng" && !p.automated));
  const ff = await h["video:ffmpeg.status"](null);
  assert.equal(typeof ff.ffmpeg, "boolean");
  assert.equal(typeof ff.ffprobe, "boolean");
  // 清除配音：链接清掉，时间退回估算
  const cleared = await h["video:shots.clearAudio"](null, shot.id);
  assert.equal(cleared.shot.audioAssetId, "");
  assert.equal(cleared.shot.audioSource, "");
});
