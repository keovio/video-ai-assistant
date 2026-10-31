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
  if (!opts.apiKey) throw new TtsError("请先在设置里保存 TTS Key", { code: "NO_API_KEY" });
  const fetchImpl = opts.fetchImpl;
  if (typeof fetchImpl !== "function") throw new TtsError("TTS 网络请求未接通（缺少 fetch 实现）", { code: "NO_FETCH" });
  const outFile = opts.outFile;
  if (!outFile) throw new TtsError("缺少输出文件路径", { code: "NO_OUT_FILE" });
  const format = ["mp3", "wav", "opus", "aac", "flac", "pcm"].includes(opts.format) ? opts.format : "mp3";
  const voice = cleanStr(opts.voice, 64) || "alloy";
  const model = cleanStr(opts.model, 64) || "tts-1";
  const rate = clampRate(opts.rate);
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ model, input: text, voice, response_format: format, speed: rate }),
    });
  } catch (err) {
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

const BUILTIN = {
  openai: { id: "openai", label: "OpenAI 兼容 TTS", automated: true, synthesize: synthesizeOpenAI },
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
  synthesizeOpenAI, synthesizeJimeng,
  listProviders, getProvider, registerProvider, resetProviders, synthesize,
};
