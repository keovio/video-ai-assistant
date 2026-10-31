"use strict";
// AI 文本分析（M4，纯 Node，不依赖 Electron，可单测）。
//
// 约定与 TTS（lib/video/tts.js）一致：fetchImpl 由主进程用 net.fetch 包装后
// 传入，签名 (url, opts) -> { ok, status, arrayBuffer(), text() }；单测注入假 fetch。
// 只做 OpenAI 兼容的 chat completions（/chat/completions），要求模型只返回 JSON；
// 解析与校验失败时抛 AiError，绝不编造分析结果。
const { estimateSeconds } = require("../video-model");

class AiError extends Error {
  constructor(message, { retryable = false, code = "" } = {}) {
    super(message);
    this.name = "AiError";
    this.retryable = retryable;
    this.code = code;
  }
}

const cleanStr = (v, max = 2000) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);
const cleanText = (v) => String(v == null ? "" : v).trim();

// 从模型返回的文本里抠 JSON：先整体解析，失败则取第一个 { 到最后一个 } 的
// 子串再解析；仍失败就明确报错，不猜内容。
function extractJson(text) {
  const s = cleanText(text);
  if (!s) throw new AiError("AI 返回了空内容，无法分析", { code: "EMPTY_RESPONSE" });
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
    throw new Error("not an object");
  } catch { /* fall through to substring */ }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new AiError("AI 返回的内容不是合法 JSON，无法分析（请重试；不要把这条当成分析结果）", { code: "BAD_JSON" });
  }
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
    throw new Error("not an object");
  } catch {
    throw new AiError("AI 返回的内容不是合法 JSON，无法分析（请重试；不要把这条当成分析结果）", { code: "BAD_JSON" });
  }
}

// 一次 chat completions 调用，返回模型 message 的 content 文本。
async function chatComplete(opts = {}) {
  const baseUrl = cleanStr(opts.baseUrl, 500).replace(/\/+$/, "");
  if (!baseUrl) throw new AiError("请先在设置里填写 AI 服务地址（AI Base URL）", { code: "NO_BASE_URL" });
  if (!opts.apiKey) throw new AiError("请先在设置里保存 AI Key", { code: "NO_API_KEY" });
  const fetchImpl = opts.fetchImpl;
  if (typeof fetchImpl !== "function") throw new AiError("AI 网络请求未接通（缺少 fetch 实现）", { code: "NO_FETCH" });
  const model = cleanStr(opts.model, 128) || "gpt-4o-mini";
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  if (!messages.length) throw new AiError("AI 请求缺少消息内容", { code: "EMPTY_MESSAGES" });
  // 部分 OpenAI 兼容服务不支持 response_format（会回 400）：遇到 400 且报错提到它时，去掉后重试一次。
  const send = async (withFormat) => {
    const body = {
      model,
      messages,
      temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.5,
      max_tokens: Number.isFinite(opts.maxTokens) ? opts.maxTokens : 3000,
    };
    if (withFormat) body.response_format = { type: "json_object" };
    try {
      return await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const msg = (err && (err.name === "AbortError" || /abort|timeout|超时/i.test(String(err.message)))) ? "AI 请求超时，请稍后重试" : `AI 请求失败：${(err && err.message) || err}`;
      throw new AiError(msg, { retryable: true, code: "FETCH_FAILED" });
    }
  };
  let res = await send(opts.jsonMode !== false);
  if (!res.ok && res.status === 400 && opts.jsonMode !== false) {
    let detail = "";
    try { detail = await res.text(); } catch { /* ignore */ }
    if (/response_format|json_object|json mode/i.test(detail)) res = await send(false);
    else res = { ok: false, status: 400, text: async () => detail };
  }
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch { /* ignore */ }
    const msg = detail ? detail.slice(0, 300) : `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      throw new AiError(`AI Key 无效或无权访问（HTTP ${res.status}）：${msg}`, { code: "AUTH_FAILED" });
    }
    if (res.status === 404) {
      throw new AiError(`AI 模型不存在（HTTP 404）：${msg}，请检查设置里的模型名`, { code: "NOT_FOUND" });
    }
    if (res.status === 400) {
      throw new AiError(`AI 请求被拒绝（HTTP 400）：${msg}`, { code: "BAD_REQUEST" });
    }
    if (res.status === 429 || res.status >= 500) {
      throw new AiError(`AI 服务限流或出错（HTTP ${res.status}），可稍后重试：${msg}`, { retryable: true, code: "RETRYABLE" });
    }
    throw new AiError(`AI 请求失败（HTTP ${res.status}）：${msg}`, { code: "HTTP_ERROR" });
  }
  let raw = "";
  try { raw = await res.text(); } catch { /* ignore */ }
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    throw new AiError("AI 服务返回的内容无法解析，请重试", { code: "BAD_RESPONSE" });
  }
  const content = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message
    ? parsed.choices[0].message.content : "";
  if (!String(content || "").trim()) throw new AiError("AI 返回了空内容，无法分析", { code: "EMPTY_RESPONSE" });
  return { content: String(content), usage: (parsed && parsed.usage) || null };
}

// 拉取服务端可用模型（OpenAI 兼容 GET /models）：返回去重排序后的模型 id 列表。
// 有的服务不开放 /models（404/405）：抛 AiError，页面提示手动填写。
async function listModels(opts = {}) {
  const baseUrl = cleanStr(opts.baseUrl, 500).trim().replace(/\/+$/, "");
  if (!baseUrl) throw new AiError("请先填写接口地址（Base URL）", { code: "NO_BASE_URL" });
  if (!opts.apiKey && opts.keyOptional !== true) throw new AiError("请先保存 Key，再获取模型列表", { code: "NO_API_KEY" });
  const fetchImpl = opts.fetchImpl;
  if (typeof fetchImpl !== "function") throw new AiError("网络请求未接通（缺少 fetch 实现）", { code: "NO_FETCH" });
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/models`, { method: "GET", headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {} });
  } catch (err) {
    throw new AiError(`获取模型列表失败：${(err && err.message) || err}`, { retryable: true, code: "FETCH_FAILED" });
  }
  let raw = "";
  try { raw = await res.text(); } catch { /* ignore */ }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new AiError(`Key 无效或无权访问（HTTP ${res.status}）`, { code: "AUTH_FAILED" });
    if (res.status === 404 || res.status === 405) throw new AiError("这个服务不提供模型列表，请手动填写模型名", { code: "NOT_SUPPORTED" });
    throw new AiError(`获取模型列表失败（HTTP ${res.status}）：${raw.slice(0, 200)}`, { retryable: res.status >= 500 || res.status === 429, code: "HTTP_ERROR" });
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new AiError("模型列表返回的内容无法解析", { code: "BAD_RESPONSE" }); }
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.data) ? parsed.data : Array.isArray(parsed && parsed.models) ? parsed.models : [];
  const ids = [...new Set(arr.map((m) => (typeof m === "string" ? m : m && (m.id || m.name || m.model))).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 128)))];
  ids.sort((a, b) => a.localeCompare(b));
  return ids;
}

const STYLE_KEYS = ["visual", "camera", "pacing", "mood", "colorLight", "sound", "hooks"];
const STYLE_LABELS = {
  visual: "画面风格", camera: "镜头与运镜", pacing: "节奏",
  mood: "情绪氛围", colorLight: "色彩与光线", sound: "声音与音乐", hooks: "文案与钩子",
};

// skill 名只留小写字母、数字、连字符；非法字符变连字符，空了退回默认。
function slugifySkillName(name) {
  const s = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return s || "douyin-style";
}

// 校验并规范化一次分析结果：缺关键字段（风格、skill、脚本、分镜）就报错，
// 绝不拿空模板充数。分镜每镜只保留白名单字段，秒数不合法时按口播字数估算。
function validateAnalysis(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  if (!o.style || typeof o.style !== "object") throw new AiError("AI 返回的分析缺少 style（风格拆解），请重试", { code: "VALIDATION_FAILED" });
  const style = {};
  for (const k of STYLE_KEYS) style[k] = cleanStr(o.style[k], 1000);
  if (!Object.values(style).some(Boolean)) throw new AiError("AI 返回的风格拆解全是空的，请重试", { code: "VALIDATION_FAILED" });
  if (!o.skill || typeof o.skill !== "object") throw new AiError("AI 返回的分析缺少 skill（风格 skill），请重试", { code: "VALIDATION_FAILED" });
  const skillName = slugifySkillName(o.skill.name);
  const skillDescription = cleanStr(o.skill.description, 500);
  const skillBody = cleanStr(o.skill.body, 8000);
  if (!skillDescription || !skillBody) throw new AiError("AI 返回的 skill 缺少描述或正文，请重试", { code: "VALIDATION_FAILED" });
  if (!o.script || typeof o.script !== "object") throw new AiError("AI 返回的分析缺少 script（脚本与分镜），请重试", { code: "VALIDATION_FAILED" });
  const title = cleanStr(o.script.title, 200).trim();
  const narration = cleanStr(o.script.narration, 5000).trim();
  if (!title && !narration) throw new AiError("AI 返回的脚本标题和口播都是空的，请重试", { code: "VALIDATION_FAILED" });
  const rawShots = Array.isArray(o.script.shots) ? o.script.shots : [];
  if (!rawShots.length) throw new AiError("AI 返回的分镜是空的（没有镜头），请重试", { code: "VALIDATION_FAILED" });
  if (rawShots.length > 30) throw new AiError("AI 返回的分镜超过 30 个镜头，请重试或手动删减", { code: "VALIDATION_FAILED" });
  const shots = rawShots.map((s, i) => {
    const x = s && typeof s === "object" ? s : {};
    const shotNarration = cleanStr(x.narration, 5000).trim();
    if (!shotNarration) throw new AiError(`AI 返回的分镜第 ${i + 1} 镜没有口播文案，请重试`, { code: "VALIDATION_FAILED" });
    const visual = cleanStr(x.visual, 2000);
    const imagePrompt = cleanStr(x.imagePrompt || x.visual, 2000);
    let seconds = Number(x.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) seconds = estimateSeconds(shotNarration);
    seconds = Math.min(30, Math.max(1, Math.round(seconds * 10) / 10));
    return { narration: shotNarration, visual, imagePrompt, seconds };
  });
  return {
    style,
    skill: { name: skillName, description: skillDescription, body: skillBody },
    script: { title: title || "未命名脚本", narration: narration || shots.map((s) => s.narration).join(""), shots },
  };
}

function buildAnalysisPrompt({ videoInfo = {}, manualText = "" } = {}) {
  const info = videoInfo && typeof videoInfo === "object" ? videoInfo : {};
  const lines = [];
  if (info.url) lines.push(`视频链接：${info.url}`);
  if (info.author) lines.push(`作者：${info.author}`);
  if (info.caption) lines.push(`视频文案：${info.caption}`);
  if (info.likeCountText) lines.push(`点赞：${info.likeCountText}`);
  if (info.commentCountText) lines.push(`评论：${info.commentCountText}`);
  if (info.shareCountText) lines.push(`分享：${info.shareCountText}`);
  if (manualText) lines.push(`用户补充说明：${cleanStr(manualText, 2000)}`);
  return lines.join("\n") || "（没有读到视频信息，请按通用短视频风格分析）";
}

// 分析一条抖音视频：一次调用同时产出风格拆解、skill、脚本与分镜。
// 返回 validateAnalysis 规范化后的结果；任何一步失败都抛 AiError，不返回假结果。
async function analyzeVideo(opts = {}) {
  const system = [
    "你是一名短视频风格分析师。只返回一个 JSON 对象，不要输出其他文字、不要用 Markdown 代码块包裹。",
    "JSON 结构：{\"style\": {\"visual\": \"\", \"camera\": \"\", \"pacing\": \"\", \"mood\": \"\", \"colorLight\": \"\", \"sound\": \"\", \"hooks\": \"\"},",
    "\"skill\": {\"name\": \"英文短横线小写名，如 melancholic-cinematic\", \"description\": \"一句话说明这个风格\", \"body\": \"SKILL.md 正文：风格定义、镜头语言、画面与声音要点、要做和不要做的清单\"},",
    "\"script\": {\"title\": \"\", \"narration\": \"60-90 秒口播全文，250-350 字，前 3 秒有钩子\", \"shots\": [{\"narration\": \"\", \"visual\": \"画面描述\", \"imagePrompt\": \"生视频提示词\", \"seconds\": 数字}]}}",
    "分镜数量按内容和原视频节奏决定（1-30 个），不要为了凑数硬拆或硬合，每镜一个完整意思；秒数合计参考原视频时长，没有参考时 60-90 秒；全部用简体中文；不要编造原视频里没有的台词、数据或作者信息。有画面截图时，画面、镜头、色彩光线按截图实际描述；没有截图时只写能从文案和常识推断的部分，并在 visual 里注明“未看画面”。声音与音乐无法直接听到，只能按文案和题材推断，写明是推断。",
  ].join("\n");
  const images = (Array.isArray(opts.images) ? opts.images : [])
    .filter((u) => typeof u === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(u)).slice(0, 4);
  const textUser = `请分析下面这条抖音视频，并按上面的 JSON 结构返回风格拆解、风格 skill、以及可直接拍的口播脚本与分镜。\n${buildAnalysisPrompt(opts)}`;
  const call = (userContent) => chatComplete({
    fetchImpl: opts.fetchImpl, apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model,
    messages: [{ role: "system", content: system }, { role: "user", content: userContent }],
    temperature: 0.5, maxTokens: 3000,
  });
  if (images.length) {
    // 附上视频画面截图：画面风格、构图、色彩、字幕样式按截图实看，不再只靠文案猜。
    const withFrames = [
      { type: "text", text: `${textUser}\n\n附上该视频播放中的 ${images.length} 张画面截图（按时间顺序），画面、运镜、色彩光线请以截图为准。` },
      ...images.map((url) => ({ type: "image_url", image_url: { url } })),
    ];
    try {
      const { content } = await call(withFrames);
      return { ...validateAnalysis(extractJson(content)), usedImages: true };
    } catch (err) {
      // 模型不支持图片（多为 400/404/422）时退回纯文本；Key 无效、限流等错误照常抛出。
      if (!(err instanceof AiError) || !["BAD_REQUEST", "HTTP_ERROR", "NOT_FOUND"].includes(err.code)) throw err;
    }
  }
  const { content } = await call(textUser);
  return { ...validateAnalysis(extractJson(content)), usedImages: false };
}

// 把一次分析结果渲染成 SKILL.md 文本（与 custom-skills 里的 skill 形状一致：
// frontmatter name/description + 正文）。纯函数，可单测。
function buildSkillText(analysis) {
  const a = analysis && typeof analysis === "object" ? analysis : {};
  const skill = a.skill || {};
  const style = a.style || {};
  const name = slugifySkillName(skill.name);
  const description = cleanStr(skill.description, 500);
  const body = cleanStr(skill.body, 8000);
  const styleLines = STYLE_KEYS
    .filter((k) => style[k])
    .map((k) => `- ${STYLE_LABELS[k]}：${style[k]}`);
  const parts = [
    "---",
    `name: ${name}`,
    `description: ${description.replace(/\n/g, " ")}`,
    "---",
    "",
    `# ${name}`,
    "",
    body,
  ];
  if (styleLines.length) parts.push("", "## 风格拆解（本次分析）", "", ...styleLines);
  if (a.script && a.script.title) parts.push("", `来源脚本：${cleanStr(a.script.title, 200)}`);
  return parts.join("\n") + "\n";
}

// 把分析里的分镜转成可导入项目的镜头输入（只含白名单字段，顺序即 order）。
function storyboardToShots(analysis) {
  const a = validateAnalysis(analysis);
  return a.script.shots.map((s) => ({ narration: s.narration, visual: s.visual, imagePrompt: s.imagePrompt }));
}

module.exports = {
  AiError, STYLE_KEYS, STYLE_LABELS,
  extractJson, chatComplete, listModels, slugifySkillName,
  buildAnalysisPrompt, validateAnalysis, analyzeVideo,
  buildSkillText, storyboardToShots,
};
