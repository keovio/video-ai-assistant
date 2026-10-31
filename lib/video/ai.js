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

// 0.6.8：思考模型降低/关闭思考，否则额度全耗在思考上、正文为空，还很慢。
// 智谱 GLM-5.3 / 5.3-Flash / FlashX 强制思考（传 disabled 会 400），只能 reasoning_effort: "low"；
// GLM-4.5/4.6/4.7/5/5.1/5.2 可以 thinking.disabled。其他模型不加参数。
function thinkingParams(model) {
  const m = String(model || "").toLowerCase();
  if (!/glm/.test(m)) return {};
  if (/glm-?5\.3/.test(m)) return { reasoning_effort: "low" };
  if (/glm-?(4\.5|4\.6|4\.7|5\.2|5\.1|5)(\b|-|$)/.test(m)) return { thinking: { type: "disabled" } };
  return {};
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
  let extra = opts.noThinkingParams ? {} : thinkingParams(model);
  const send = async (withFormat) => {
    const body = {
      model,
      messages,
      temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.5,
      max_tokens: Number.isFinite(opts.maxTokens) ? opts.maxTokens : 3000,
      ...extra,
    };
    if (withFormat) body.response_format = { type: "json_object" };
    try {
      return await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (err && err.code === "TASK_CANCELLED") throw err; // 用户取消，原样抛出
      const msg = (err && (err.name === "AbortError" || /abort|timeout|超时/i.test(String(err.message)))) ? "AI 请求超时，请稍后重试" : `AI 请求失败：${(err && err.message) || err}`;
      throw new AiError(msg, { retryable: true, code: "FETCH_FAILED" });
    }
  };
  let res = await send(opts.jsonMode !== false);
  if (!res.ok && res.status === 400 && opts.jsonMode !== false) {
    let detail = "";
    try { detail = await res.text(); } catch { /* ignore */ }
    if (/response_format|json_object|json mode/i.test(detail)) res = await send(false);
    else if (Object.keys(extra).length && /thinking|reasoning/i.test(detail)) { extra = {}; res = await send(true); }
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
  const parsed = parseCompletion(raw);
  if (!parsed) throw new AiError("AI 服务返回的内容无法解析，请重试", { code: "BAD_RESPONSE" });
  const { content, reasoning, finishReason } = readChoice(parsed);
  if (String(content || "").trim()) return { content: String(content), usage: parsed.usage || null, finishReason };
  // 0.6.7：思考/推理模型（DeepSeek-R1、Qwen3 思考模式、豆包深度思考、o 系列等）常把输出额度
  // 全用在思考上，正文为空、finish_reason=length。先放大额度重试一次；思考内容里如果已经带了 JSON 也接受。
  if (reasoning && /\{[\s\S]*\}/.test(reasoning)) {
    try { extractJson(reasoning); return { content: reasoning, usage: parsed.usage || null, finishReason, fromReasoning: true }; } catch { /* 继续 */ }
  }
  if (finishReason === "length" && !opts._retried) {
    const bigger = Math.min(16000, (Number.isFinite(opts.maxTokens) ? opts.maxTokens : 3000) * 3);
    return chatComplete({ ...opts, maxTokens: bigger, _retried: true });
  }
  const why = finishReason === "length"
    ? `输出被截断（finish_reason=length），模型「${model}」可能是思考/推理模型，额度都用在思考上了。建议在设置里换成非思考模型（如 deepseek-chat、qwen-plus、gpt-4o-mini），或关闭思考模式`
    : finishReason === "content_filter"
      ? "内容被服务方安全审核拦截（finish_reason=content_filter），换一条视频或换个模型试试"
      : `模型「${model}」没有返回正文${finishReason ? `（finish_reason=${finishReason}）` : ""}，可能不支持当前请求格式，建议换个模型重试`;
  throw new AiError(`AI 返回了空内容：${why}`, { code: "EMPTY_RESPONSE", retryable: true });
}

// 兼容普通 JSON 响应和被代理强制成流式（SSE，"data: {...}" 多行）的响应。
function parseCompletion(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* 可能是 SSE */ }
  if (!/^data:/m.test(text)) return null;
  let content = "", reasoning = "", finishReason = "", usage = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^data:\s*(.*)$/.exec(line.trim());
    if (!m || !m[1] || m[1] === "[DONE]") continue;
    let j; try { j = JSON.parse(m[1]); } catch { continue; }
    const c = j.choices && j.choices[0];
    if (c) {
      const d = c.delta || c.message || {};
      content += partsText(d.content);
      reasoning += partsText(d.reasoning_content || d.reasoning);
      if (c.finish_reason) finishReason = c.finish_reason;
    }
    if (j.usage) usage = j.usage;
  }
  return { choices: [{ message: { content, reasoning_content: reasoning }, finish_reason: finishReason }], usage };
}

// content 可能是字符串，也可能是 [{type:"text", text}] 片段数组
function partsText(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((p) => (typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : "")).join("");
  return "";
}

function readChoice(parsed) {
  const c = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
  const m = (c && c.message) || {};
  return {
    content: partsText(m.content),
    reasoning: partsText(m.reasoning_content || m.reasoning),
    finishReason: (c && c.finish_reason) || "",
  };
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

  const hasSpeech = o.script.hasSpeech !== false && o.script.hasSpeech !== "false";
  const rawShots = Array.isArray(o.script.shots) ? o.script.shots : [];
  if (!rawShots.length) throw new AiError("AI 返回的分镜是空的（没有镜头），请重试", { code: "VALIDATION_FAILED" });
  if (rawShots.length > 30) throw new AiError("AI 返回的分镜超过 30 个镜头，请重试或手动删减", { code: "VALIDATION_FAILED" });
  const shots = rawShots.map((s, i) => {
    const x = s && typeof s === "object" ? s : {};
    // 0.6.17：没人说话的镜头口播可以为空（纯画面），但画面描述和口播不能都空
    const shotNarration = hasSpeech ? cleanStr(x.narration, 5000).trim() : "";
    const visual = cleanStr(x.visual, 2000);
    if (!shotNarration && !visual.trim()) throw new AiError(`AI 返回的分镜第 ${i + 1} 镜既没有口播也没有画面描述，请重试`, { code: "VALIDATION_FAILED" });
    const imagePrompt = cleanStr(x.imagePrompt || x.visual, 2000);
    let seconds = Number(x.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) seconds = shotNarration ? estimateSeconds(shotNarration) : 3;
    seconds = Math.min(30, Math.max(1, Math.round(seconds * 10) / 10));
    return { narration: shotNarration, visual, imagePrompt, seconds };
  });
  return {
    style,
    skill: { name: skillName, description: skillDescription, body: skillBody },
    script: { title: title || "未命名脚本", hasSpeech: hasSpeech && shots.some((s) => s.narration), narration: hasSpeech ? (narration || shots.map((s) => s.narration).join("")) : "", shots },
  };
}

// 截图时间点 + 相邻截图差异（main.js 用缩略图算的 0–1），给 AI 判断是不是同一个镜头
function frameNotes(opts = {}, n = 0) {
  const times = Array.isArray(opts.frameTimes) ? opts.frameTimes : [];
  const diffs = Array.isArray(opts.frameDiffs) ? opts.frameDiffs.map(Number).filter(Number.isFinite) : [];
  const parts = [];
  if (times.length === n && times.every((t) => Number.isFinite(Number(t)) && t !== null)) parts.push(`截图时间点：${times.map((t) => Number(t) + " 秒").join("、")}。`);
  if (diffs.length) {
    const tag = (d) => (d < 0.06 ? "几乎相同" : d < 0.15 ? "略有变化" : d < 0.3 ? "变化较大" : "明显不同");
    parts.push(`相邻截图画面差异（0=完全相同，1=完全不同）：${diffs.map((d, i) => `第${i + 1}→${i + 2}张 ${d}（${tag(d)}）`).join("；")}。`);
    if (diffs.every((d) => d < 0.15)) parts.push("所有截图几乎是同一画面，原视频很可能是一镜到底，分镜应为 1 个镜头。");
  }
  return parts.length ? "\n" + parts.join("\n") : "";
}

function buildAnalysisPrompt({ videoInfo = {}, manualText = "" } = {}) {
  const info = videoInfo && typeof videoInfo === "object" ? videoInfo : {};
  const lines = [];
  const SITE = { douyin: "抖音", bilibili: "B 站", youtube: "YouTube", web: "网页" };
  if (info.site && SITE[info.site]) lines.push(`平台：${SITE[info.site]}`);
  if (info.url) lines.push(`视频链接：${info.url}`);
  if (info.title) lines.push(`标题：${cleanStr(info.title, 300)}`);
  if (info.author) lines.push(`作者：${info.author}`);
  if (Number(info.durationSec) > 0) lines.push(`视频时长：约 ${Math.round(Number(info.durationSec))} 秒`);
  if (info.caption) lines.push(`视频文案/简介（发布时写的说明，不是口播）：${cleanStr(info.caption, 2000)}`);
  if (info.viewCountText) lines.push(`播放：${info.viewCountText}`);
  if (info.likeCountText) lines.push(`点赞：${info.likeCountText}`);
  if (info.commentCountText) lines.push(`评论：${info.commentCountText}`);
  if (info.shareCountText) lines.push(`分享：${info.shareCountText}`);
  if (info.transcript) lines.push(`字幕（视频口播原文，台词、节奏和钩子以此为准；外语请理解后用中文改写）：\n${cleanStr(info.transcript, 8000)}`);
  if (!info.transcript && (info.url || info.caption || info.title)) lines.push("没有读到字幕原文：是否有人说话只能看截图里的口播字幕判断，看不出来就当作没有口播（hasSpeech=false）。");
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
    "\"script\": {\"title\": \"\", \"hasSpeech\": true或false, \"narration\": \"口播全文，没有人说话就留空字符串\", \"shots\": [{\"narration\": \"这镜说的话，没有就留空\", \"visual\": \"画面描述\", \"imagePrompt\": \"生视频提示词\", \"seconds\": 数字}]}}",
    "script 是按原视频复刻的脚本与分镜，必须忠于原视频，不要另写一条新视频：",
    "1. 分镜数 = 原视频实际的镜头数（画面切换才算新镜头）。一镜到底、固定机位、从头到尾同一个场景的视频就只写 1 个镜头；相邻截图差异很小说明是同一镜头，不要按台词或时间硬拆。最多 30 个。",
    "2. 口播只写原视频里真的有人说出来的话：有字幕原文就以字幕为准；截图里能看到的口播字幕也可以用；没有任何证据表明有人说话（只有音乐/环境音/纯画面），hasSpeech=false，narration 和每镜 narration 全部留空字符串。绝不能把标题、简介、话题标签或你的理解改写成口播。画面上的文字贴片属于画面，写进 visual，不算口播。",
    "3. 每镜 seconds 按原视频实际时长分配，合计约等于视频时长；没有时长信息时按内容估计。",
    "全部用简体中文；不要编造原视频里没有的台词、数据或作者信息。有画面截图时，画面、镜头、色彩光线按截图实际描述；没有截图时只写能从文案和常识推断的部分，并在 visual 里注明“未看画面”。声音与音乐无法直接听到，只能按文案和题材推断，写明是推断。",
  ].join("\n");
  const images = (Array.isArray(opts.images) ? opts.images : [])
    .filter((u) => typeof u === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(u)).slice(0, 8);
  const textUser = `请分析下面这条短视频，并按上面的 JSON 结构返回风格拆解、风格 skill、以及按原视频复刻的脚本与分镜（镜头数、口播都以原视频实际为准）。\n${buildAnalysisPrompt(opts)}`;
  const call = (userContent) => chatComplete({
    fetchImpl: opts.fetchImpl, apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model,
    messages: [{ role: "system", content: system }, { role: "user", content: userContent }],
    temperature: 0.5, maxTokens: 6000,
  });
  if (images.length) {
    // 附上视频画面截图：画面风格、构图、色彩、字幕样式按截图实看，不再只靠文案猜。
    const withFrames = [
      { type: "text", text: `${textUser}\n\n附上该视频播放中的 ${images.length} 张画面截图（按时间顺序），画面、运镜、色彩光线和镜头数请以截图为准。${frameNotes(opts, images.length)}` },
      ...images.map((url) => ({ type: "image_url", image_url: { url } })),
    ];
    try {
      const { content } = await call(withFrames);
      return { ...validateAnalysis(extractJson(content)), usedImages: true };
    } catch (err) {
      // 模型不支持图片（多为 400/404/422）时退回纯文本；Key 无效、限流等错误照常抛出。
      // 0.6.7：带图请求返回空内容（部分模型不认图片就静默返回空）也退回纯文本再试一次。
      if (!(err instanceof AiError) || !["BAD_REQUEST", "HTTP_ERROR", "NOT_FOUND", "EMPTY_RESPONSE"].includes(err.code)) throw err;
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
  extractJson, chatComplete, thinkingParams, listModels, slugifySkillName,
  buildAnalysisPrompt, validateAnalysis, analyzeVideo,
  buildSkillText, storyboardToShots,
};
