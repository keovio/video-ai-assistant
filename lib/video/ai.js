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
  // 0.6.30：分析内容变多后，模型偶尔把 skill 写成字符串、漏写描述或正文。
  // 不再整条失败：能用的部分保留，缺的从 style 拼出来。
  const sk = o.skill && typeof o.skill === "object" ? o.skill : (typeof o.skill === "string" ? { body: o.skill } : {});
  const asText = (v) => Array.isArray(v) ? v.map(asText).join("\n") : (v && typeof v === "object" ? Object.entries(v).map(([k, x]) => `${k}：${asText(x)}`).join("\n") : cleanStr(v, 8000));
  const skillName = slugifySkillName(sk.name);
  const styleLines = STYLE_KEYS.filter((k) => style[k]).map((k) => `- ${STYLE_LABELS[k] || k}：${style[k]}`);
  const skillDescription = cleanStr(asText(sk.description), 500).trim() || cleanStr(style[STYLE_KEYS.find((k) => style[k])], 120).trim();
  const skillBody = cleanStr(asText(sk.body || sk.content || sk.text), 8000).trim() || `## 风格要点\n${styleLines.join("\n")}`;
  const skillPrompt = cleanStr(asText(sk.prompt), 600).trim();
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
    // 0.6.28：每镜拆成 主体/表情/动作/镜头/环境/光线 六项；有就拼进画面描述，避免描述空泛
    const F = [["subject", "主体"], ["expression", "表情"], ["emotionArc", "情绪线"], ["action", "动作"], ["camera", "镜头"], ["environment", "环境"], ["lighting", "光线色调"]];
    const detail = F.map(([k, l]) => { const v = cleanStr(x[k], k === "emotionArc" ? 600 : 400).trim(); return v ? `${l}：${v}` : ""; }).filter(Boolean).join("；");
    let visual = cleanStr(x.visual, 2000);
    if (detail) visual = visual.trim() ? `${visual.trim()}\n${detail}` : detail;
    if (!shotNarration && !visual.trim()) throw new AiError(`AI 返回的分镜第 ${i + 1} 镜既没有口播也没有画面描述，请重试`, { code: "VALIDATION_FAILED" });
    const imagePrompt = cleanStr(x.imagePrompt || x.visual, 2000);
    let seconds = Number(x.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) seconds = shotNarration ? estimateSeconds(shotNarration) : 3;
    seconds = Math.min(30, Math.max(1, Math.round(seconds * 10) / 10));
    return { narration: shotNarration, visual, imagePrompt, seconds };
  });
  // 0.6.28：AI 漏写风格时，把整体风格补到每镜提示词末尾
  const styleTail = [style.visual, style.colorLight, style.mood].map((v) => cleanStr(v, 200).replace(/\s+/g, " ").trim()).filter(Boolean).join("；");
  if (styleTail) for (const s of shots) if (s.imagePrompt && !/风格[:：]/.test(s.imagePrompt)) s.imagePrompt = cleanStr(`${s.imagePrompt}\n风格：${styleTail}`, 2000);
  return {
    style,
    skill: { name: skillName, description: skillDescription, prompt: skillPrompt, body: skillBody },
    script: { title: title || "未命名脚本", hasSpeech: hasSpeech && shots.some((s) => s.narration), narration: hasSpeech ? (narration || shots.map((s) => s.narration).join("")) : "", shots },
  };
}

// 0.6.28：相邻截图差异 ≥ 这个值才算换镜头
const CUT_DIFF = 0.3;

// 一镜到底时把 AI 拆出来的多镜合并成 1 镜：口播拼接，画面描述按先后合并，时长相加
function mergeToOneShot(script) {
  const shots = script.shots || [];
  if (shots.length <= 1) return script;
  const join = (k, sep) => shots.map((s) => String(s[k] || "").trim()).filter(Boolean).join(sep);
  const seconds = Math.min(600, Math.round(shots.reduce((a, s) => a + (Number(s.seconds) || 0), 0) * 10) / 10) || 3;
  const visual = shots.length > 1 ? shots.map((s, i) => `（${i + 1}）${String(s.visual || "").trim()}`).join("\n") : join("visual", "\n");
  return { ...script, shots: [{ narration: join("narration", ""), visual: cleanStr(visual, 2000), imagePrompt: cleanStr(join("imagePrompt", " 随后，"), 2000), seconds }] };
}
function enforceShotCount(result, opts = {}) {
  const diffs = Array.isArray(opts.frameDiffs) ? opts.frameDiffs.map(Number).filter(Number.isFinite) : [];
  if (diffs.length < 2 || !result || !result.script) return result;
  if (diffs.some((d) => d >= CUT_DIFF)) return result;
  if (result.script.shots.length <= 1) return result;
  return { ...result, script: mergeToOneShot(result.script), mergedShots: result.script.shots.length };
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
    const cuts = diffs.filter((d) => d >= CUT_DIFF).length;
    if (!cuts) parts.push("所有相邻截图之间都没有明显的画面切换，原视频是一镜到底，分镜必须只写 1 个镜头（动作和运镜的变化写进这一镜的 action/camera 里，不要拆成多镜）。");
    else parts.push(`截图里只有 ${cuts} 处明显的画面切换，分镜最多 ${cuts + 1} 个镜头（截图间隔里可能漏掉快速切换，但没有证据就不要多拆）。`);
  }
  return parts.length ? "\n" + parts.join("\n") : "";
}

function buildAnalysisPrompt({ videoInfo = {}, manualText = "", musicNotes = "" } = {}) {
  const info = videoInfo && typeof videoInfo === "object" ? videoInfo : {};
  const lines = [];
  const SITE = { douyin: "抖音", bilibili: "B 站", youtube: "YouTube", web: "网页" };
  if (info.site && SITE[info.site]) lines.push(`平台：${SITE[info.site]}`);
  if (info.url) lines.push(`视频链接：${info.url}`);
  if (info.title) lines.push(`标题：${cleanStr(info.title, 300)}`);
  if (info.author) lines.push(`作者：${info.author}`);
  if (Number(info.durationSec) > 0) lines.push(`视频时长：约 ${Math.round(Number(info.durationSec))} 秒`);
  if (info.caption) lines.push(`视频文案/简介（发布时写的说明，不是口播）：${cleanStr(info.caption, 2000)}`);
  if (info.music) lines.push(`背景音乐（页面标注）：${cleanStr(info.music, 200)}`);
  if (info.viewCountText) lines.push(`播放：${info.viewCountText}`);
  if (info.likeCountText) lines.push(`点赞：${info.likeCountText}`);
  if (info.commentCountText) lines.push(`评论：${info.commentCountText}`);
  if (info.shareCountText) lines.push(`分享：${info.shareCountText}`);
  if (info.transcript) lines.push(`字幕（视频口播原文，台词、节奏和钩子以此为准；外语请理解后用中文改写）：\n${cleanStr(info.transcript, 8000)}`);
  if (!info.transcript && (info.url || info.caption || info.title)) lines.push("没有读到字幕原文：是否有人说话只能看截图里的口播字幕判断，看不出来就当作没有口播（hasSpeech=false）。");
  if (manualText) lines.push(`用户补充说明：${cleanStr(manualText, 2000)}`);
  if (musicNotes) lines.push(cleanStr(musicNotes, 1500));
  return lines.join("\n") || "（没有读到视频信息，请按通用短视频风格分析）";
}

// 0.6.39：人脸镜头的微表情写法（分析和 AI 优化共用）
const FACE_RULES = [
  "人脸镜头（能看清脸，尤其近景/特写）的微表情要按“情绪线”写：",
  "① 先定情绪线：情绪从哪里开始、在哪个动作上转折、最后停在哪里（如：平静→想到某事短暂停顿→试着露出笑意→笑容慢慢消失→眼眶湿润），不要从头到尾同一种表情；",
  "② 把情绪词换成看得见的面部动作：不写“眼神悲伤”，写“视线从远处慢慢落下，焦点短暂失去”；不写“忍住眼泪”，写“轻轻抿唇，呼吸停顿一下，缓慢眨眼，眼眶逐渐泛起泪光”；",
  "③ 动作有先后和节奏：眼神先变，嘴角随后放松，呼吸再轻微停顿；用“逐渐”“短暂停留”“缓慢消退”过渡；不要眼睛、眉毛、嘴角同时大幅变化，也不要每秒都加新动作；",
  "④ 控制幅度：特写里细小变化就够（嘴角轻微扬起后自然松开、眼睑略微收紧、眼角逐渐湿润），不要夸张，也不要堆太多肌肉细节；",
  "⑤ 结尾要有铺垫：要流泪时不直接写“开始哭泣”，按“情绪压住→眼眶湿润→泪水积聚→一滴眼泪滑落→表情恢复平静”安排，镜头可在情绪变化后缓慢推进，泪落后短暂停留；",
  "写完自查：情绪线是否明确、表情动作是否具体、前后变化是否连贯。看不清脸、没有人脸的镜头不用写情绪线。",
].join("\n");

// 分析一条抖音视频：一次调用同时产出风格拆解、skill、脚本与分镜。
// 返回 validateAnalysis 规范化后的结果；任何一步失败都抛 AiError，不返回假结果。
async function analyzeVideo(opts = {}) {
  const system = [
    "你是一名短视频风格分析师。只返回一个 JSON 对象，不要输出其他文字、不要用 Markdown 代码块包裹。",
    "JSON 结构：{\"style\": {\"visual\": \"\", \"camera\": \"\", \"pacing\": \"\", \"mood\": \"\", \"colorLight\": \"\", \"sound\": \"\", \"hooks\": \"\"},",
    "\"skill\": {\"name\": \"英文短横线小写名，如 melancholic-cinematic\", \"description\": \"一句话说明这个风格\", \"prompt\": \"可直接接在任何画面提示词后面的通用风格提示词，60–150 字\", \"body\": \"SKILL.md 正文（通用风格指南，见第 7 条）\"},",
    "\"script\": {\"title\": \"\", \"hasSpeech\": true或false, \"narration\": \"口播全文，没有人说话就留空字符串\", \"shots\": [{\"narration\": \"这镜说的话，没有就留空\", \"visual\": \"一句话概括这镜发生了什么\", \"subject\": \"主体：人物/动物/物体是谁、外貌、穿着、数量和画面位置\", \"expression\": \"表情与神态，没有人脸写无\", \"emotionArc\": \"情绪线（只在能看清人脸时写，否则留空）：起点表情→转折在哪个动作→终点，每段写具体的眼神/嘴角/呼吸/眨眼变化，按先后顺序\", \"action\": \"具体动作与行为，按先后顺序写，包括手势、视线、身体朝向的变化\", \"camera\": \"景别（特写/近景/中景/全景）、拍摄角度（平视/俯拍/仰拍/自拍视角）、运镜（固定/推/拉/摇/移/跟/手持晃动）、构图\", \"environment\": \"场景地点、背景物件、前景遮挡、画面上的文字贴片\", \"lighting\": \"光线方向与软硬、色调、质感\", \"imagePrompt\": \"生视频提示词\", \"seconds\": 数字}]}}",
    "script 是按原视频复刻的脚本与分镜，必须忠于原视频，不要另写一条新视频：",
    "1. 分镜数 = 原视频实际的镜头数（画面切换才算新镜头）。一镜到底、固定机位、从头到尾同一个场景的视频就只写 1 个镜头；相邻截图差异很小说明是同一镜头，不要按台词或时间硬拆。最多 30 个。",
    "2. 口播只写原视频里真的有人说出来的话：有字幕原文就以字幕为准；截图里能看到的口播字幕也可以用；没有任何证据表明有人说话（只有音乐/环境音/纯画面），hasSpeech=false，narration 和每镜 narration 全部留空字符串。绝不能把标题、简介、话题标签或你的理解改写成口播。画面上的文字贴片属于画面，写进 visual，不算口播。",
    "3. 每镜 seconds 按原视频实际时长分配，合计约等于视频时长；没有时长信息时按内容估计。",
    "4. 每镜的 subject/expression/action/camera/environment/lighting 都要写具体、可看见的细节，不要用“温馨”“可爱”“氛围感”这类空泛词代替描述；看不出来的写“看不清”，不要编。",
    "5. imagePrompt 是给 AI 生视频网站用的一段话，按这个顺序写成连贯的中文，150–400 字：",
    "  ① 规格：画幅（按截图宽高写“16:9横屏”或“9:16竖屏”）、这镜秒数、一镜到底还是第几镜；",
    "  ② 主体外观写到能直接画出来：人数、画面位置、发型发色、头饰配饰、服装颜色款式材质和细节（领口、袖型、系带、纹样）、妆容；",
    "  ③ 动作按时间顺序并标时间点（如“约3秒后”“随后”“最后”），写清手、头、身体朝向、视线的变化；",
    "  ④ 表情：按情绪线写眼神、嘴角、眨眼等具体变化；明确写出不做的事（如“不笑、不说话”）；",
    "  ⑤ 运镜写起点→路径→终点：从哪个方位和景别开始、怎么移动、推到什么景别、停多久、是否拉回、手持晃动程度；",
    "  ⑥ 环境：场景地点，逐个列出看得到的道具和背景物件（含镜子里映出的东西），前景遮挡；",
    "  ⑦ 光线色调：主光是什么、从哪来、环境明暗、色调；",
    "  ⑧ 质感与否定：真实实拍/动画等质感，“无滤镜感”“无字幕”“无口播”等原视频确实没有的东西。",
    "  每镜都要能单独拿去生成，不能写“同上”。不含口播台词。结尾再加整条视频统一的风格，以“风格：”开头（画面风格、色彩光线、质感、氛围，与 style 一致），保证各镜统一。",
    "  style.visual 写成“整体风格”一句话总括（题材+场景+光线+运镜+收尾方式），例如：“漫展后台化妆镜前一镜到底的cos妆造幕后vlog风格，暖灯泡光、手持环绕推镜、面部特写收尾”。",
    "6. 人脸镜头必须写 emotionArc，并按情绪线把微表情的先后变化写进 imagePrompt（这类镜头 imagePrompt 可放宽到 450 字）。只写原视频里真的看得到的变化，看不清就写看不清，不要为了凑情绪线而编。",
    "7. skill 是可复用的“风格”，要能套到别的人物、别的内容上，所以 skill 里绝不写这条视频的具体人物外貌、服装、发型、具体动作顺序、具体道具和具体地点名。只提炼可迁移的手法：",
    "  skill.prompt：画幅与时长习惯、拍摄方式（手持/固定/自拍）、运镜和景别变化规律（如“从中景环绕推到面部大特写再拉回”）、剪辑节奏与音乐（BPM/卡点）、光线类型和色调、质感、氛围、否定项（无滤镜/无口播等）。",
    "  skill.body 分节：风格定义、适用题材、镜头语言、节奏剪辑与音乐、光线色调、画面质感、表演方式（写方法，如“表情克制、动作放慢、直视镜头停顿再移开”，不写剧情）、提示词模板（用【主体】【动作】【场景】【道具】占位，例：“16:9横屏，【主体】坐在【场景】里【动作】，手机手持从背后中景缓慢环绕推近到面部大特写再拉回……”）、要做、不要做。",
    "  具体的人物、动作、道具只写在 script.shots 里，不要写进 skill。",
    FACE_RULES,
    "全部用简体中文；不要编造原视频里没有的台词、数据或作者信息。有画面截图时，画面、镜头、色彩光线按截图实际描述；没有截图时只写能从文案和常识推断的部分，并在 visual 里注明“未看画面”。声音与音乐：有“音乐分析”数据时，style.sound 必须写出节奏快慢（BPM）、强弱推进和高潮位置、是否卡点剪辑，并据此写 style.pacing 和 mood，曲风/乐器结合音乐名和画面判断；剪辑节奏要和音乐对应（卡点视频的镜头时长贴合节拍）。没有音乐数据时只能按文案和题材推断，写明是推断。",
  ].join("\n");
  const images = (Array.isArray(opts.images) ? opts.images : [])
    .filter((u) => typeof u === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(u)).slice(0, 16);
  const textUser = `请分析下面这条短视频，并按上面的 JSON 结构返回风格拆解、风格 skill、以及按原视频复刻的脚本与分镜（镜头数、口播都以原视频实际为准）。\n${buildAnalysisPrompt(opts)}`;
  const call = (userContent) => chatComplete({
    fetchImpl: opts.fetchImpl, apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model,
    messages: [{ role: "system", content: system }, { role: "user", content: userContent }],
    temperature: 0.5, maxTokens: 14000,
  });
  // 0.6.31：直接把原视频（画面+声音）交给支持视频输入的模型（GLM-5.3-Flash 等）。失败由调用方退回截图。
  if (typeof opts.videoDataUrl === "string" && /^data:video\//.test(opts.videoDataUrl)) {
    const withVideo = [
      { type: "video_url", video_url: { url: opts.videoDataUrl } },
      { type: "text", text: `${textUser}\n\n附上的是原视频本身（有画面也有声音）。镜头数按视频里真实的换镜；口播按你实际听到的人声逐字写，听不到人说话就 hasSpeech=false；背景音乐和音效按实际听到的写进 style.sound，不用再写“推断”。` },
    ];
    const { content } = await call(withVideo);
    return { ...validateAnalysis(extractJson(content)), usedImages: false, usedVideo: true };
  }
  if (images.length) {
    // 附上视频画面截图：画面风格、构图、色彩、字幕样式按截图实看，不再只靠文案猜。
    const withFrames = [
      { type: "text", text: `${textUser}\n\n附上该视频播放中的 ${images.length} 张画面截图（按时间顺序），画面、运镜、色彩光线和镜头数请以截图为准。${frameNotes(opts, images.length)}` },
      ...images.map((url) => ({ type: "image_url", image_url: { url } })),
    ];
    try {
      const { content } = await call(withFrames);
      return { ...enforceShotCount(validateAnalysis(extractJson(content)), opts), usedImages: true };
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
// 0.6.24：优化/模仿改写每镜画面提示词。shots: [{ narration, visual, prompt }]，返回等长字符串数组
function buildRewritePrompt({ shots = [], mode = "optimize", reference = "", aspect = "" } = {}) {
  const list = shots.map((s, i) => `第${i + 1}镜\n口播：${cleanStr(s.narration, 400) || "（无）"}\n画面描述：${cleanStr(s.visual, 600) || "（无）"}\n现有提示词：${cleanStr(s.prompt, 1200) || "（无）"}`).join("\n\n");
  const ref = cleanStr(reference, 6000);
  const how = mode === "imitate" && ref
    ? `请模仿下面这份参考的写法来写：用词风格、句式结构、描述顺序、长度、常用的镜头/光线/质感词都尽量一致，但内容必须是每镜自己的画面，不要照抄参考的具体内容。\n【参考】\n${ref}`
    : "请把每镜改写成更适合 AI 生视频网站（即梦、可灵、海螺等）的画面提示词：主体+动作+场景+镜头运动+景别+光线色调+质感氛围，具体、可视化、一段话，去掉口播台词和抽象形容。";
  return [
    { role: "system", content: `你是 AI 视频画面提示词专家。只输出 JSON。\n${FACE_RULES}\n按“规格→主体外观→带时间点的动作→表情（含不做的事）→运镜起点到终点→环境道具→光线→质感与否定”的顺序写，150–400 字；有人脸的镜头按上面的方法写微表情（可放宽到 450 字）；画面描述里已有“情绪线”的要保留它的起点、转折和终点。` },
    { role: "user", content: `${how}\n${aspect ? `画幅：${aspect}。` : ""}保持镜头顺序和数量不变，每镜一条，中文。\n只输出 JSON：{"prompts":["第1镜提示词","第2镜提示词",…]}\n\n${list}` },
  ];
}

async function rewritePrompts(opts = {}) {
  const shots = Array.isArray(opts.shots) ? opts.shots.slice(0, 30) : [];
  if (!shots.length) throw new AiError("没有要改写的镜头", { code: "EMPTY" });
  const r = await chatComplete({ fetchImpl: opts.fetchImpl, apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model,
    messages: buildRewritePrompt({ ...opts, shots }), temperature: 0.6, maxTokens: Math.min(16000, 800 + shots.length * 500) });
  let data = null;
  try { data = extractJson(r.content); } catch { data = null; }
  const arr = data && Array.isArray(data.prompts) ? data.prompts : null;
  if (!arr) throw new AiError("AI 返回的格式不对，请重试", { code: "BAD_JSON" });
  return shots.map((_, i) => cleanStr(typeof arr[i] === "string" ? arr[i] : (arr[i] && arr[i].prompt) || "", 2000));
}

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
    ...(cleanStr(skill.prompt, 600) ? ["## 风格提示词（复制画面时接在后面）", "", cleanStr(skill.prompt, 600), ""] : []),
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

// 0.6.44：写角色的外貌锚点。text：用户的描述；image：一张人物照片（data URL，可选）
async function describeCharacter(opts = {}) {
  const text = cleanStr(opts.text, 2000);
  const image = typeof opts.image === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(opts.image) ? opts.image : "";
  if (!text && !image) throw new AiError("先写几句人物描述，或选一张人物照片", { code: "EMPTY" });
  const system = [
    "你是角色设定师，为 AI 生图/生视频写“固定人物形象”。只返回 JSON：{\"name\":\"简短中文名\",\"anchor\":\"外貌锚点\",\"outfit\":\"服装\"}。",
    "anchor 只写不随镜头和服装改变的特征，80–200 字，按顺序：性别和年龄感、脸型、眉眼（眼型、瞳色、双眼皮）、鼻、唇、肤色、发型发色和刘海、身材身高感、标志特征（痣、酒窝、雀斑、眼镜等）。用具体可画的词，不用“好看”“精致”这类空词。",
    "outfit 写这身服装和配饰，40–150 字：款式、颜色、材质、细节、鞋、头饰。",
    image ? "以照片里实际看到的为准，看不清的不要编；用户文字和照片冲突时以照片为准。" : "按用户描述补全成具体可画的样子，用户没说的选最自然的。",
  ].join("\n");
  const user = image
    ? [{ type: "text", text: `请根据这张照片写这个人物的设定。${text ? `\n用户补充：${text}` : ""}` }, { type: "image_url", image_url: { url: image } }]
    : `人物描述：${text}`;
  const r = await chatComplete({ fetchImpl: opts.fetchImpl, apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model,
    messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.4, maxTokens: 2000 });
  let d = null;
  try { d = extractJson(r.content); } catch { d = null; }
  if (!d || !d.anchor) throw new AiError("AI 返回的格式不对，请重试", { code: "BAD_JSON" });
  return { name: cleanStr(d.name, 60), anchor: cleanStr(d.anchor, 1500), outfit: cleanStr(d.outfit, 1000) };
}

// 0.6.51：通用“AI 调整”。fields: [{ key, label, text }]，instruction：用户一句话要求；context：这组内容是什么。
// 相关字段联动修改（口播变了画面和提示词跟着变；外貌变了锚点和提示词一起变），无关的原样返回。
function buildRefinePrompt({ fields = [], instruction = "", context = "" } = {}) {
  const list = fields.map((f) => `【${f.key}】${f.label || f.key}\n${f.text || "（空）"}`).join("\n\n");
  return [
    { role: "system", content: [
      "你是视频创作助手，按用户的修改要求调整一组相互关联的内容。只输出 JSON。",
      "规则：",
      "1. 先按要求改直接相关的字段，再检查其它字段：凡是和改动有关联的（同一镜的口播、画面描述、画面提示词；角色的外貌、服装、生图提示词；风格拆解和 skill），要同步改，保证前后一致、能对得上；和改动无关的字段原样返回，一个字都不要动。",
      "2. 保持每个字段原来的写法、结构、语言和大致长度；画面提示词保持“规格→主体外观→动作→表情→运镜→环境→光线→质感与否定”的结构。",
      "3. 不要新增或删掉字段，不要改 key。空字段除非要求，否则保持空。",
      FACE_RULES,
      '输出：{"fields":{"key":"新内容",…},"changed":["改了的key"],"note":"一句话说明改了什么"}，fields 里要包含全部 key。',
    ].join("\n") },
    { role: "user", content: `${context ? `内容：${cleanStr(context, 500)}\n` : ""}修改要求：${cleanStr(instruction, 1000)}\n\n${list}` },
  ];
}

async function refineFields(opts = {}) {
  const fields = (Array.isArray(opts.fields) ? opts.fields : []).slice(0, 120)
    .map((f) => ({ key: cleanStr(f && f.key, 60), label: cleanStr(f && f.label, 80), text: cleanStr(f && f.text, 8000) }))
    .filter((f) => f.key);
  if (!fields.length) throw new AiError("没有可调整的内容", { code: "EMPTY" });
  if (!cleanStr(opts.instruction, 1000).trim()) throw new AiError("先写一句要怎么改", { code: "EMPTY" });
  const total = fields.reduce((n, f) => n + f.text.length, 0);
  const r = await chatComplete({ fetchImpl: opts.fetchImpl, apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model,
    messages: buildRefinePrompt({ ...opts, fields }), temperature: 0.4, maxTokens: Math.min(16000, 1200 + Math.ceil(total * 1.6)) });
  let d = null;
  try { d = extractJson(r.content); } catch { d = null; }
  const map = d && d.fields && typeof d.fields === "object" ? d.fields : null;
  if (!map) throw new AiError("AI 返回的格式不对，请重试", { code: "BAD_JSON" });
  const out = {};
  const changed = [];
  for (const f of fields) {
    const v = typeof map[f.key] === "string" ? cleanStr(map[f.key], 8000) : f.text;
    out[f.key] = v;
    if (v !== f.text) changed.push(f.key);
  }
  return { fields: out, changed, note: cleanStr(d.note, 300) };
}

module.exports = {
  AiError, buildRefinePrompt, refineFields, STYLE_KEYS, STYLE_LABELS,
  extractJson, chatComplete, rewritePrompts, enforceShotCount, mergeToOneShot, buildRewritePrompt, thinkingParams, listModels, slugifySkillName,
  buildAnalysisPrompt, validateAnalysis, analyzeVideo, describeCharacter,
  buildSkillText, storyboardToShots,
};
