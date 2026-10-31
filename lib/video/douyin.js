"use strict";
// 抖音视频信息提取（M4）。本模块只负责“怎么读页面”，不依赖 Electron 本体：
// 调用方（主进程）把一个带 webContents 的内嵌视图传进来；单测用假 driver。
//
// ⚠️ 选择器图谱未经真机验证 ⚠️
// 下面的 SELECTORS 是按抖音网页常见结构写的占位选择器，当前环境没有登录态，
// 无法对真实抖音页面实测。提取不到任何信息时一律明确失败并交给手动兜底
// （粘贴链接/文案），绝不编造作者、文案或播放量。接通真机后第一件事就是
// 按实际页面修正这张表。
const DOUYIN_URL = "https://www.douyin.com";

const SELECTORS = {
  // UNVERIFIED：以下选择器均未对真实抖音页面验证，接通前必须实测修正。
  // 提取优先读页面里的结构化数据（JSON-LD / __NEXT_DATA__ 里的 video 数据），
  // 再退回按文本匹配的 DOM 选择器；两者都读不到就明确失败。
  videoContainer: "div[data-e2e='video-info'], [class*='video-info'], main video",
  authorName: "[data-e2e='user-name'], a[href*='/user/'] span, [class*='author']",
  caption: "[data-e2e='video-desc'], [class*='desc'], [class*='caption']",
  likeCount: "[data-e2e='like-count'], [class*='like'] span",
  commentCount: "[data-e2e='comment-count'], [class*='comment'] span",
  shareCount: "[data-e2e='share-count'], [class*='share'] span",
  videoElement: "video",
  canonicalLink: "link[rel='canonical']",
};

class DouyinError extends Error {
  constructor(message, { code = "", manualFallback = false } = {}) {
    super(message);
    this.name = "DouyinError";
    this.code = code;
    this.manualFallback = manualFallback;
  }
}

const str = (v, max = 2000) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);

// 抖音计数文本转数字（尽力而为）："1.2万" -> 12000，"3千" -> 3000，纯数字直接取；
// 读不懂时返回 null，调用方只展示原文，不拿它当精确数字用。
function parseCount(text) {
  const s = String(text || "").trim().replace(/,/g, "");
  if (!s) return null;
  const m = s.match(/^([\d.]+)\s*(万|千|w|k)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || "").toLowerCase();
  const mult = unit === "万" || unit === "w" ? 10000 : unit === "千" || unit === "k" ? 1000 : 1;
  return Math.round(n * mult);
}

// 从链接里取视频 id：https://www.douyin.com/video/1234567890…；短链（v.douyin.com）
// 在本机不解析、不猜 id，原样保留链接，分析时只用用户粘贴的文案。
function parseVideoId(url) {
  const m = String(url || "").match(/\/video\/(\d{6,})/);
  return m ? m[1] : "";
}

function isDouyinUrl(url) {
  return /^(https?:\/\/)?(www\.|v\.)?douyin\.com\//i.test(String(url || "").trim())
    || /^https?:\/\/v\.douyin\.com\//i.test(String(url || "").trim());
}

// 生成在页面里执行的提取脚本：返回一个普通对象（可 JSON 序列化），
// 不返回 DOM 节点。脚本本身不依赖任何选择器以外的页面结构。
function buildExtractScript(selectors = SELECTORS) {
  const sel = { ...SELECTORS, ...selectors };
  return `(() => {
    const q = (s) => { try { const el = document.querySelector(s); return el ? (el.textContent || "").trim() : ""; } catch { return ""; } };
    const pick = (s) => { const parts = String(s || "").split(",").map((x) => x.trim()).filter(Boolean); for (const p of parts) { const v = q(p); if (v) return v; } return ""; };
    const canon = (() => { try { const el = document.querySelector(${JSON.stringify(sel.canonicalLink)}); return el ? (el.getAttribute("href") || "") : ""; } catch { return ""; } })();
    const video = (() => { try { const v = document.querySelector(${JSON.stringify(sel.videoElement)}); return v ? (v.currentSrc || v.src || "") : ""; } catch { return ""; } })();
    let structured = null;
    try {
      const ld = document.querySelector('script[type="application/ld+json"]');
      if (ld) structured = JSON.parse(ld.textContent || "null");
    } catch { structured = null; }
    return {
      url: canon || location.href || "",
      author: pick(${JSON.stringify(sel.authorName)}),
      caption: pick(${JSON.stringify(sel.caption)}),
      likeCountText: pick(${JSON.stringify(sel.likeCount)}),
      commentCountText: pick(${JSON.stringify(sel.commentCount)}),
      shareCountText: pick(${JSON.stringify(sel.shareCount)}),
      videoSrc: video,
      structured: structured && typeof structured === "object" ? structured : null,
    };
  })()`;
}

// 规范化提取结果：只做清洗与计数解析，不补任何页面上没有的信息。
// structured 里若有 VideoObject 的 name/description，优先于 DOM 文本（更准），
// 但只取字符串字段，不信任它里面的播放量等数字。
function parseExtracted(raw, url = "") {
  const o = raw && typeof raw === "object" ? raw : {};
  const st = o.structured && typeof o.structured === "object" ? o.structured : null;
  const stObj = Array.isArray(st) ? st.find((x) => x && typeof x === "object") : st;
  const author = str(o.author || (stObj && stObj.author && (stObj.author.name || "")) || "");
  const caption = str(o.caption || (stObj && (stObj.name || stObj.description)) || "");
  const pageUrl = str(o.url || url || "");
  const likeCount = parseCount(o.likeCountText);
  const commentCount = parseCount(o.commentCountText);
  const shareCount = parseCount(o.shareCountText);
  return {
    url: pageUrl,
    videoId: parseVideoId(pageUrl),
    author,
    caption,
    likeCountText: str(o.likeCountText || ""),
    commentCountText: str(o.commentCountText || ""),
    shareCountText: str(o.shareCountText || ""),
    likeCount, commentCount, shareCount,
    videoSrc: str(o.videoSrc || ""),
  };
}

// 提取当前视频信息：driver 须提供 executeJavaScript(js) -> Promise<any>，
// 以及可选的 getURL()。什么都没读到（作者、文案、视频 id 全空）时抛
// NO_VIDEO_FOUND 且 manualFallback=true，调用方必须给手动粘贴兜底。
async function extractVideoInfo({ driver, selectors = SELECTORS, getURL = null } = {}) {
  if (!driver || typeof driver.executeJavaScript !== "function") {
    throw new DouyinError("抖音内嵌视图未接通，无法读取当前视频；请点“打开抖音”后再试，或用手动粘贴链接/文案。", { code: "NO_VIEW", manualFallback: true });
  }
  let raw;
  try {
    raw = await driver.executeJavaScript(buildExtractScript(selectors));
  } catch (err) {
    throw new DouyinError(`读取抖音页面失败：${err.message || err}，请确认已打开视频详情页，或用手动粘贴链接/文案。`, { code: "EXTRACT_FAILED", manualFallback: true });
  }
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = {}; }
  }
  let url = "";
  try { url = typeof getURL === "function" ? getURL() : (driver.getURL ? driver.getURL() : ""); } catch { /* ignore */ }
  const info = parseExtracted(raw, url);
  const found = info.author || info.caption || info.videoId || info.videoSrc;
  if (!found) {
    throw new DouyinError("当前抖音页面上没读到视频信息（可能还没打开视频详情页，或页面结构已改版、选择器未验证）：请先在左侧点开一个视频再点“分析当前视频”，或在右侧手动粘贴视频链接和文案。", { code: "NO_VIDEO_FOUND", manualFallback: true });
  }
  return info;
}

module.exports = {
  DOUYIN_URL, SELECTORS, DouyinError,
  parseCount, parseVideoId, isDouyinUrl,
  buildExtractScript, parseExtracted, extractVideoInfo,
};
