"use strict";
// 0.6.44：火山方舟 Seedream 生图（即梦同款模型）。OpenAI Images 兼容接口：
// POST {baseUrl}/images/generations  { model, prompt, image?: string|string[], size, response_format, watermark }
// image 传 data:image/png;base64,... 作为参考图（多张=多图融合，保持同一人物）。
class ImageGenError extends Error {
  constructor(message, { code = "", status = 0 } = {}) { super(message); this.name = "ImageGenError"; this.code = code; this.status = status; }
}

const DEFAULT_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_MODEL = "doubao-seedream-4-0-250828";

// 画幅 → 像素尺寸（Seedream 4.x 面积需在 1024² 到 4096² 之间）
function sizeFor(aspect = "") {
  const a = String(aspect || "");
  if (/9\s*[:：x]\s*16|竖/.test(a)) return "1440x2560";
  if (/16\s*[:：x]\s*9|横/.test(a)) return "2560x1440";
  if (/3\s*[:：x]\s*4/.test(a)) return "1728x2304";
  if (/4\s*[:：x]\s*3/.test(a)) return "2304x1728";
  if (/1\s*[:：x]\s*1|方/.test(a)) return "2048x2048";
  return "2K";
}

async function generateImage({ fetchImpl, apiKey, baseUrl = "", model = "", prompt = "", images = [], size = "2K", signal } = {}) {
  if (!apiKey) throw new ImageGenError("请先在设置 → 人物生图 里保存火山方舟 API Key", { code: "NO_API_KEY" });
  if (typeof fetchImpl !== "function") throw new ImageGenError("网络请求未接通", { code: "NO_FETCH" });
  const p = String(prompt || "").trim();
  if (!p) throw new ImageGenError("提示词是空的", { code: "EMPTY" });
  const refs = (Array.isArray(images) ? images : []).filter((u) => /^data:image\/(png|jpeg|webp);base64,/.test(u)).slice(0, 10);
  const body = { model: String(model || DEFAULT_MODEL).trim(), prompt: p.slice(0, 3000), size: size || "2K", response_format: "b64_json", watermark: false, sequential_image_generation: "disabled" };
  if (refs.length === 1) body.image = refs[0];
  else if (refs.length > 1) body.image = refs;
  const url = `${String(baseUrl || DEFAULT_BASE).replace(/\/+$/, "")}/images/generations`;
  let res;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal });
  } catch (err) {
    throw new ImageGenError(`连不上生图服务：${(err && err.message) || err}`, { code: "NETWORK" });
  }
  let data = null;
  const text = await res.text().catch(() => "");
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const msg = (data && data.error && (data.error.message || data.error.code)) || text.slice(0, 300) || `HTTP ${res.status}`;
    throw new ImageGenError(`生图失败（${res.status}）：${msg}`, { code: "HTTP", status: res.status });
  }
  const out = (data && Array.isArray(data.data) ? data.data : []).map((x) => x && (x.b64_json || "")).filter(Boolean);
  if (!out.length) throw new ImageGenError("生图服务没有返回图片" + (data && data.data && data.data[0] && data.data[0].error ? `：${data.data[0].error.message}` : ""), { code: "EMPTY_RESULT" });
  return out.map((b64) => Buffer.from(b64, "base64"));
}

module.exports = { generateImage, sizeFor, ImageGenError, DEFAULT_BASE, DEFAULT_MODEL };
