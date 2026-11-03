"use strict";
// 0.6.47：人物生图多服务商。都走 OpenAI Images 风格接口，差别在参考图、尺寸、返回格式：
// - ark（火山方舟 Seedream，即梦同款）：JSON `image` 字段传参考图（单张字符串/多张数组），b64_json
// - zhipu（智谱 CogView）：只文生图，返回 url，需要再下载
// - openai（gpt-image-1 / dall-e-3）：无参考图走 /images/generations；gpt-image 有参考图走 /images/edits（multipart）
// - custom（OpenAI 兼容中转）：同 ark 的 JSON 写法，参考图放 `image` 字段（服务端不认就会忽略）
class ImageGenError extends Error {
  constructor(message, { code = "", status = 0 } = {}) { super(message); this.name = "ImageGenError"; this.code = code; this.status = status; }
}

const PROVIDERS = {
  ark: {
    label: "火山方舟（Seedream / 即梦同款）",
    base: "https://ark.cn-beijing.volces.com/api/v3",
    models: [
      ["doubao-seedream-4-0-250828", "Seedream 4.0（支持参考图）"],
      ["doubao-seedream-4-5-251128", "Seedream 4.5（支持参考图）"],
      ["doubao-seedream-3-0-t2i-250415", "Seedream 3.0（只文生图）"],
    ],
    keyHint: "火山方舟控制台 → API Key 管理",
  },
  zhipu: {
    label: "智谱（GLM-Image / CogView）",
    base: "https://open.bigmodel.cn/api/paas/v4",
    models: [["glm-image", "GLM-Image（旗舰，0.1 元/张）"], ["cogview-4-250304", "CogView-4"], ["cogview-4", "CogView-4（最新）"], ["cogview-3-flash", "CogView-3-Flash（免费）"]],
    keyHint: "智谱开放平台 → API Keys；可以和 AI 分析用同一个",
  },
  openai: {
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    models: [["gpt-image-1", "gpt-image-1（支持参考图）"], ["gpt-image-1-mini", "gpt-image-1-mini（支持参考图）"], ["dall-e-3", "DALL·E 3（只文生图）"]],
    keyHint: "platform.openai.com → API keys",
  },
  custom: {
    label: "其他（OpenAI 兼容接口）",
    base: "",
    models: [],
    keyHint: "中转/其他服务商的 Key",
  },
};
const DEFAULT_PROVIDER = "ark";

const providerOf = (p) => (PROVIDERS[p] ? p : DEFAULT_PROVIDER);
const defaultModel = (p) => { const m = PROVIDERS[providerOf(p)].models; return m.length ? m[0][0] : ""; };

// 能不能用参考图（保持同一个人的关键）
function supportsRefs(provider, model = "") {
  const p = providerOf(provider); const m = String(model || defaultModel(p));
  if (p === "ark") return !/t2i|seedream-3/i.test(m);
  if (p === "openai") return /^gpt-image/i.test(m);
  if (p === "custom") return true;
  return false;
}

// 画幅 → 尺寸。kind: sheet（横版三视图）| face（方图）| frame（按画幅）
function ratioOf(aspect = "", kind = "frame") {
  if (kind === "sheet") return "16:9";
  if (kind === "face") return "1:1";
  if (kind === "angle") return "16:9";
  const a = String(aspect || "");
  if (/9\s*[:：x]\s*16|竖/.test(a)) return "9:16";
  if (/16\s*[:：x]\s*9|横/.test(a)) return "16:9";
  if (/3\s*[:：x]\s*4/.test(a)) return "3:4";
  if (/4\s*[:：x]\s*3/.test(a)) return "4:3";
  return "1:1";
}
const SIZES = {
  ark: { "9:16": "1440x2560", "16:9": "2560x1440", "3:4": "1728x2304", "4:3": "2304x1728", "1:1": "2048x2048" },
  glmimage: { "9:16": "960x1728", "16:9": "1728x960", "3:4": "1088x1472", "4:3": "1472x1088", "1:1": "1280x1280" },
  zhipu: { "9:16": "768x1344", "16:9": "1344x768", "3:4": "864x1152", "4:3": "1152x864", "1:1": "1024x1024" },
  gptimage: { "9:16": "1024x1536", "16:9": "1536x1024", "3:4": "1024x1536", "4:3": "1536x1024", "1:1": "1024x1024" },
  dalle: { "9:16": "1024x1792", "16:9": "1792x1024", "3:4": "1024x1792", "4:3": "1792x1024", "1:1": "1024x1024" },
};
function sizeFor(aspect = "", { provider = DEFAULT_PROVIDER, model = "", kind = "frame" } = {}) {
  const p = providerOf(provider); const r = ratioOf(aspect, kind);
  if (p === "zhipu") return (/glm-image/i.test(model) ? SIZES.glmimage : SIZES.zhipu)[r];
  if (p === "openai") return (/dall-e/i.test(model) ? SIZES.dalle : SIZES.gptimage)[r];
  return SIZES.ark[r]; // ark、custom
}

const dataUrlToBlob = (u) => {
  const m = /^data:(image\/(png|jpeg|webp));base64,(.+)$/.exec(u);
  return m ? { blob: new Blob([Buffer.from(m[3], "base64")], { type: m[1] }), ext: m[2] === "jpeg" ? "jpg" : m[2] } : null;
};

async function readJson(res) {
  const text = await res.text().catch(() => "");
  let data = null; try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const e = data && (data.error || data);
    const msg = (e && (e.message || e.msg || e.code)) || text.slice(0, 300) || `HTTP ${res.status}`;
    throw new ImageGenError(`生图失败（${res.status}）：${msg}`, { code: "HTTP", status: res.status });
  }
  return data;
}

async function generateImage({ fetchImpl, provider = DEFAULT_PROVIDER, apiKey, baseUrl = "", model = "", prompt = "", images = [], size = "", signal } = {}) {
  const p = providerOf(provider); const P = PROVIDERS[p];
  if (!apiKey) throw new ImageGenError(`请先在设置 → 人物生图 里保存 ${P.label} 的 API Key`, { code: "NO_API_KEY" });
  if (typeof fetchImpl !== "function") throw new ImageGenError("网络请求未接通", { code: "NO_FETCH" });
  const text = String(prompt || "").trim();
  if (!text) throw new ImageGenError("提示词是空的", { code: "EMPTY" });
  const base = String(baseUrl || P.base).replace(/\/+$/, "");
  if (!base) throw new ImageGenError("请在设置 → 人物生图 里填写接口地址", { code: "NO_BASE" });
  const mdl = String(model || defaultModel(p)).trim();
  if (!mdl) throw new ImageGenError("请在设置 → 人物生图 里填写模型名", { code: "NO_MODEL" });
  const useRefs = supportsRefs(p, mdl);
  const refs = useRefs ? (Array.isArray(images) ? images : []).filter((u) => /^data:image\/(png|jpeg|webp);base64,/.test(u)).slice(0, p === "openai" ? 16 : 10) : [];
  const sz = size || sizeFor("", { provider: p, model: mdl });
  const auth = { Authorization: `Bearer ${apiKey}` };
  const post = async (url, init) => {
    try { return await fetchImpl(url, { method: "POST", ...init, signal }); }
    catch (err) { throw new ImageGenError(`连不上生图服务：${(err && err.message) || err}`, { code: "NETWORK" }); }
  };
  let data;
  if (p === "openai" && refs.length) {
    const fd = new FormData();
    fd.append("model", mdl); fd.append("prompt", text.slice(0, 32000)); fd.append("size", sz); fd.append("n", "1");
    refs.forEach((u, i) => { const b = dataUrlToBlob(u); if (b) fd.append("image[]", b.blob, `ref${i + 1}.${b.ext}`); });
    data = await readJson(await post(`${base}/images/edits`, { headers: auth, body: fd }));
  } else {
    const body = { model: mdl, prompt: text.slice(0, p === "zhipu" ? 1000 : p === "openai" && /dall-e/i.test(mdl) ? 4000 : 3000), size: sz };
    if (p === "ark" || p === "custom") { body.response_format = "b64_json"; body.watermark = false; }
    if (p === "ark") body.sequential_image_generation = "disabled";
    if (p === "openai" && /dall-e/i.test(mdl)) body.response_format = "b64_json";
    if (p === "openai") body.n = 1;
    if (refs.length) body.image = refs.length === 1 ? refs[0] : refs;
    data = await readJson(await post(`${base}/images/generations`, { headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify(body) }));
  }
  const items = data && Array.isArray(data.data) ? data.data : [];
  const out = [];
  for (const x of items) {
    if (x && x.b64_json) out.push(Buffer.from(x.b64_json, "base64"));
    else if (x && x.url) {
      let r;
      try { r = await fetchImpl(x.url, { signal }); } catch (err) { throw new ImageGenError(`图片下载失败：${(err && err.message) || err}`, { code: "DOWNLOAD" }); }
      if (!r.ok) throw new ImageGenError(`图片下载失败（${r.status}）`, { code: "DOWNLOAD", status: r.status });
      out.push(Buffer.from(await r.arrayBuffer()));
    }
  }
  if (!out.length) throw new ImageGenError("生图服务没有返回图片" + (items[0] && items[0].error ? `：${items[0].error.message}` : ""), { code: "EMPTY_RESULT" });
  return { images: out, refsUsed: refs.length, refsIgnored: !useRefs && Array.isArray(images) && images.length > 0, model: mdl, provider: p };
}

// 给设置页用的公开信息（不含密钥）
const providerList = () => Object.entries(PROVIDERS).map(([id, v]) => ({ id, label: v.label, base: v.base, models: v.models, keyHint: v.keyHint }));

module.exports = { generateImage, sizeFor, supportsRefs, providerList, defaultModel, PROVIDERS, DEFAULT_PROVIDER, ImageGenError };
