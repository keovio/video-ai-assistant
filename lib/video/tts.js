"use strict";
// TTS 适配器层（纯 Node，不依赖 Electron，可单测）。
//
// 约定：每个 provider 实现 synthesize({ text, voice, rate, format, outFile, fetchImpl, ...providerOpts })
//   -> { file, seconds }，seconds 为实测时长（能测到时）；测不到时为 null，调用方
//   必须退回字数字符估算并明确提示“估算值”，绝不能把估算值说成实测值。
// 失败用 TtsError，retryable 区分可重试（超时/限流/5xx）与不可重试（Key 无效/音色不存在/未实现）。
const fs = require("fs");
const path = require("path");
const { execFileSync, execFile } = require("child_process");

class TtsError extends Error {
  constructor(message, { retryable = false, code = "" } = {}) {
    super(message);
    this.name = "TtsError";
    this.retryable = retryable;
    this.code = code;
  }
}

const clampRate = (rate) => {
  const n = Number(rate);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0.5, n));
};

const cleanText = (text) => String(text == null ? "" : text).trim();
const cleanStr = (v, max = 200) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);

// 用系统 ffprobe 读音频时长（秒，取整到 0.1）。ffprobe 不存在或读失败时返回 null。
// probeFn 可注入（单测用），签名 (file) -> number|null。
function probeDuration(file, probeFn) {
  if (typeof probeFn === "function") {
    try {
      const v = probeFn(file);
      return Number.isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : null;
    } catch { return null; }
  }
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", file,
    ], { encoding: "utf8", timeout: 15000 });
    const n = Number(String(out).trim());
    return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
  } catch { return null; }
}

// 异步版（主进程里用这个，不阻塞界面）：execFile 回调，最多 15 秒。
function probeDurationAsync(file, probeFn) {
  if (typeof probeFn === "function") return Promise.resolve(probeDuration(file, probeFn));
  return new Promise((resolve) => {
    execFile("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", file,
    ], { encoding: "utf8", timeout: 15000, windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const n = Number(String(out).trim());
      resolve(Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null);
    });
  });
}

function ffprobeAvailable(checkFn) {
  if (typeof checkFn === "function") { try { return !!checkFn(); } catch { return false; } }
  try { execFileSync("ffprobe", ["-version"], { stdio: "ignore", timeout: 10000 }); return true; }
  catch { return false; }
}

// ---- OpenAI 兼容 TTS ----
// POST {baseUrl}/audio/speech，body { model, input, voice, response_format, speed }，
// Bearer Key。baseUrl 末尾的斜杠会被去掉；默认 model 为 tts-1（OpenAI 兼容服务各家名字不同，
// 设置里可改）。fetchImpl 约定：(url, opts) -> { ok, status, arrayBuffer(), text() }，
// 主进程用 net.fetch 包装后传入；单测用注入的假 fetch。
async function synthesizeOpenAI(opts = {}) {
  const text = cleanText(opts.text);
  if (!text) throw new TtsError("口播文案为空，无法生成配音", { code: "EMPTY_TEXT" });
  const baseUrl = cleanStr(opts.baseUrl, 500).replace(/\/+$/, "");
  if (!baseUrl) throw new TtsError("请先在设置里填写 TTS 服务地址（TTS Base URL）", { code: "NO_BASE_URL" });
  if (!opts.apiKey && opts.keyOptional !== true) throw new TtsError("请先在设置里保存 TTS Key", { code: "NO_API_KEY" });
  const fetchImpl = opts.fetchImpl;
  if (typeof fetchImpl !== "function") throw new TtsError("TTS 网络请求未接通（缺少 fetch 实现）", { code: "NO_FETCH" });
  const outFile = opts.outFile;
  if (!outFile) throw new TtsError("缺少输出文件路径", { code: "NO_OUT_FILE" });
  const format = ["mp3", "wav", "opus", "aac", "flac", "pcm"].includes(opts.format) ? opts.format : "mp3";
  const voice = cleanStr(opts.voice, 128) || "alloy";
  const model = cleanStr(opts.model, 128) || "tts-1";
  const rate = clampRate(opts.rate);
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({ model, input: text, voice, response_format: format, speed: rate }),
    });
  } catch (err) {
    if (opts.keyOptional === true) {
      throw new TtsError(`连不上本地 TTS 服务（${baseUrl}）：${err.message || err}。请确认服务已启动、地址和端口正确`, { retryable: true, code: "FETCH_FAILED" });
    }
    throw new TtsError(`TTS 请求失败：${err.message || err}`, { retryable: true, code: "FETCH_FAILED" });
  }
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch { /* ignore */ }
    const msg = detail ? detail.slice(0, 300) : `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      throw new TtsError(`TTS Key 无效或无权访问（HTTP ${res.status}）：${msg}`, { code: "AUTH_FAILED" });
    }
    if (res.status === 404) {
      throw new TtsError(`TTS 模型或音色不存在（HTTP 404）：${msg}，请检查设置里的模型名和音色名`, { code: "NOT_FOUND" });
    }
    if (res.status === 429 || res.status >= 500) {
      throw new TtsError(`TTS 服务限流或出错（HTTP ${res.status}），可稍后重试：${msg}`, { retryable: true, code: "RETRYABLE" });
    }
    throw new TtsError(`TTS 请求失败（HTTP ${res.status}）：${msg}`, { code: "HTTP_ERROR" });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new TtsError("TTS 返回了空音频", { retryable: true, code: "EMPTY_AUDIO" });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, buf);
  return { file: outFile, seconds: probeDuration(outFile, opts.probeFn) };
}

// ---- 即梦（网页自动操作，M2 在此不伪造） ----
// 即梦配音只能在即梦网页里操作，需要登录态 + 页面选择器实测，当前环境无法验证，
// 所以这里明确拒绝自动生成，并指引用户用“导入音频”把即梦下载的配音导进来。
// 这不是故障，是诚实的分工：M2 的即梦自动化留待 M3 在真机登录态下实测后再接通。
async function synthesizeJimeng() {
  throw new TtsError(
    "即梦配音尚未自动接通：请先在即梦网页生成配音并下载音频，再用编辑器里该镜头的“导入音频”导进来（导入音频同样按实际时长重排时间）。",
    { code: "JIMENG_NOT_AUTOMATED" },
  );
}

// ---- 本地 TTS ----
// 本机/局域网里跑的 OpenAI 兼容语音服务（POST /audio/speech），Key 可空，默认 http://127.0.0.1:8880/v1。
async function synthesizeLocal(opts = {}) {
  return synthesizeOpenAI({ ...opts, keyOptional: true, baseUrl: opts.baseUrl || "http://127.0.0.1:8880/v1" });
}

// 拉音色列表：先试 Kokoro-FastAPI 等的 GET /audio/voices，再试 /voices；拿不到返回空数组（音色仍可手填）
async function listVoices(opts = {}) {
  const baseUrl = cleanStr(opts.baseUrl, 500).trim().replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl;
  if (!baseUrl || typeof fetchImpl !== "function") return [];
  for (const p of ["/audio/voices", "/voices"]) {
    try {
      const res = await fetchImpl(`${baseUrl}${p}`, { method: "GET", headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {} });
      if (!res.ok) continue;
      const data = JSON.parse(await res.text());
      const arr = Array.isArray(data) ? data : Array.isArray(data && data.voices) ? data.voices : Array.isArray(data && data.data) ? data.data : [];
      const ids = [...new Set(arr.map((v) => (typeof v === "string" ? v : v && (v.id || v.name || v.voice_id))).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 128)))];
      if (ids.length) return ids.sort((a, b) => a.localeCompare(b));
    } catch { /* 试下一个 */ }
  }
  return [];
}

// ---- Voicebox（本机声音克隆工作室，0.6.2） ----
// Voicebox 桌面版默认在 http://127.0.0.1:17493 跑后端。声音在 Voicebox 里克隆成“声音档案”，
// 这里的 voice 填档案名（不区分大小写）或档案 id。流程：GET /profiles 解析档案 →
// POST /generate { profile_id, text, language, engine, model_size } →（新版异步）轮询 GET /history/{id}
// 直到 completed/failed → GET /audio/{id} 下载音频（一般是 wav）。没有 Key。
const VOICEBOX_ENGINES = ["qwen", "qwen_custom_voice", "omnivoice", "chatterbox", "chatterbox_turbo", "luxtts", "tada", "kokoro"];
const VOICEBOX_DEFAULT_URL = "http://127.0.0.1:17493";
const voiceboxBase = (u) => (cleanStr(u, 500).trim().replace(/\/+$/, "").replace(/\/v1$/, "") || VOICEBOX_DEFAULT_URL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function voiceboxJson(fetchImpl, url, init, base) {
  let res;
  try { res = await fetchImpl(url, init); }
  catch (err) {
    throw new TtsError(`连不上 Voicebox（${base}）：${err.message || err}。请先打开 Voicebox 桌面版，并确认设置里的地址和端口`, { retryable: true, code: "FETCH_FAILED" });
  }
  let body = "";
  try { body = await res.text(); } catch { /* ignore */ }
  if (!res.ok) {
    let msg = body.slice(0, 300) || `HTTP ${res.status}`;
    try { const j = JSON.parse(body); if (j && j.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail).slice(0, 300); } catch { /* 原样 */ }
    if (res.status === 404) throw new TtsError(`Voicebox 找不到资源（HTTP 404）：${msg}`, { code: "NOT_FOUND" });
    if (res.status === 429 || res.status >= 500) throw new TtsError(`Voicebox 出错（HTTP ${res.status}），可稍后重试：${msg}`, { retryable: true, code: "RETRYABLE" });
    throw new TtsError(`Voicebox 请求失败（HTTP ${res.status}）：${msg}`, { code: "HTTP_ERROR" });
  }
  try { return JSON.parse(body); } catch { throw new TtsError("Voicebox 返回的不是 JSON", { retryable: true, code: "BAD_JSON" }); }
}

async function voiceboxProfiles({ baseUrl, fetchImpl }) {
  const base = voiceboxBase(baseUrl);
  const data = await voiceboxJson(fetchImpl, `${base}/profiles`, { method: "GET" }, base);
  return (Array.isArray(data) ? data : []).filter((p) => p && typeof p.id === "string")
    .map((p) => ({ id: p.id, name: cleanStr(p.name, 128) || p.id, language: cleanStr(p.language, 16) }));
}

async function synthesizeVoicebox(opts = {}) {
  const text = cleanText(opts.text);
  if (!text) throw new TtsError("口播文案为空，无法生成配音", { code: "EMPTY_TEXT" });
  const fetchImpl = opts.fetchImpl;
  if (typeof fetchImpl !== "function") throw new TtsError("TTS 网络请求未接通（缺少 fetch 实现）", { code: "NO_FETCH" });
  if (!opts.outFile) throw new TtsError("缺少输出文件路径", { code: "NO_OUT_FILE" });
  const base = voiceboxBase(opts.baseUrl);
  const want = cleanStr(opts.voice, 128).trim();
  if (!want) throw new TtsError("请先在设置里选一个 Voicebox 声音档案（音色）", { code: "NO_VOICE" });
  const profiles = await voiceboxProfiles({ baseUrl: base, fetchImpl });
  const profile = profiles.find((p) => p.id === want) || profiles.find((p) => p.name.toLowerCase() === want.toLowerCase());
  if (!profile) {
    const names = profiles.map((p) => p.name).slice(0, 10).join("、");
    throw new TtsError(`Voicebox 里没有名为“${want}”的声音档案${names ? `（现有：${names}）` : "，请先在 Voicebox 里克隆一个声音"}`, { code: "NOT_FOUND" });
  }
  const engine = VOICEBOX_ENGINES.includes(opts.model) ? opts.model : "qwen";
  const body = { profile_id: profile.id, text, language: /^[a-z]{2}$/.test(opts.language || "") ? opts.language : "zh", engine };
  if (["qwen", "qwen_custom_voice", "tada"].includes(engine)) body.model_size = ["1.7B", "0.6B", "1B", "3B"].includes(opts.modelSize) ? opts.modelSize : "1.7B";
  let gen = await voiceboxJson(fetchImpl, `${base}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, base);
  const id = gen && gen.id;
  if (!id) throw new TtsError("Voicebox 没有返回生成记录 id", { retryable: true, code: "BAD_RESPONSE" });
  // 新版 /generate 立即返回 status=generating，后台排队生成；首次用某模型时还要下载模型，所以等得久一点
  const deadline = Date.now() + (Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 15 * 60 * 1000);
  const interval = Number(opts.pollMs) >= 0 && opts.pollMs != null ? Number(opts.pollMs) : 1500;
  while (gen && gen.status && gen.status !== "completed") {
    if (gen.status === "failed") throw new TtsError(`Voicebox 生成失败：${cleanStr(gen.error, 300) || "未知原因"}`, { retryable: true, code: "GEN_FAILED" });
    if (Date.now() > deadline) throw new TtsError("Voicebox 生成超时（首次使用会先下载模型，可在 Voicebox 里看进度后重试）", { retryable: true, code: "TIMEOUT" });
    if (opts.signal && opts.signal.aborted) throw new TtsError("已取消配音", { code: "CANCELLED" });
    await sleep(interval);
    if (opts.signal && opts.signal.aborted) throw new TtsError("已取消配音", { code: "CANCELLED" });
    gen = await voiceboxJson(fetchImpl, `${base}/history/${encodeURIComponent(id)}`, { method: "GET" }, base);
  }
  let res;
  try { res = await fetchImpl(`${base}/audio/${encodeURIComponent(id)}`, { method: "GET" }); }
  catch (err) { throw new TtsError(`下载 Voicebox 音频失败：${err.message || err}`, { retryable: true, code: "FETCH_FAILED" }); }
  if (!res.ok) throw new TtsError(`下载 Voicebox 音频失败（HTTP ${res.status}）`, { retryable: true, code: "RETRYABLE" });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new TtsError("Voicebox 返回了空音频", { retryable: true, code: "EMPTY_AUDIO" });
  // 按文件头判断格式，输出文件扩展名跟着改（调用方用返回的 ext 存档）
  const head = buf.subarray(0, 4).toString("latin1");
  const ext = head === "RIFF" ? ".wav" : head === "fLaC" ? ".flac" : head === "OggS" ? ".ogg" : ".mp3";
  const outFile = opts.outFile.replace(/\.[^./\\]+$/, "") + ext;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, buf);
  return { file: outFile, ext, seconds: probeDuration(outFile, opts.probeFn), profile: profile.name };
}

const BUILTIN = {
  openai: { id: "openai", label: "OpenAI 兼容 TTS", automated: true, synthesize: synthesizeOpenAI },
  local: { id: "local", label: "本地 TTS（OpenAI 兼容接口）", automated: true, synthesize: synthesizeLocal },
  voicebox: { id: "voicebox", label: "Voicebox（本机声音克隆）", automated: true, synthesize: synthesizeVoicebox },
  jimeng: { id: "jimeng", label: "即梦（网页版，尚未自动接通）", automated: false, synthesize: synthesizeJimeng },
};

const registry = new Map(Object.entries(BUILTIN));

function listProviders() {
  return [...registry.values()].map((p) => ({ id: p.id, label: p.label, automated: p.automated }));
}

function getProvider(id) {
  return registry.get(id) || null;
}

// 注册自定义 provider（单测与后续扩展用）。impl 须是 synthesize 函数。
function registerProvider(id, impl) {
  if (!id || typeof impl !== "function") throw new Error("注册 TTS provider 需要 id 和 synthesize 函数");
  registry.set(id, { id, label: id, automated: true, synthesize: impl });
  return getProvider(id);
}

function resetProviders() {
  registry.clear();
  for (const [k, v] of Object.entries(BUILTIN)) registry.set(k, v);
}

// 统一入口：按 provider id 分发；未知 provider 直接报错，不静默换一家。
async function synthesize(opts = {}) {
  const provider = getProvider(opts.provider || "openai");
  if (!provider) throw new TtsError(`未知的 TTS 服务商：${opts.provider}，请在设置里重新选择`, { code: "UNKNOWN_PROVIDER" });
  return provider.synthesize(opts);
}

module.exports = {
  TtsError, clampRate, probeDuration, probeDurationAsync, ffprobeAvailable,
  synthesizeOpenAI, synthesizeLocal, synthesizeJimeng, listVoices,
  synthesizeVoicebox, voiceboxProfiles, VOICEBOX_ENGINES, VOICEBOX_DEFAULT_URL,
  listProviders, getProvider, registerProvider, resetProviders, synthesize,
};
