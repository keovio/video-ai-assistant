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
  const u = String(url || "");
  const m = u.match(/douyin\.com\/video\/(\d{6,})/) || u.match(/^\/?video\/(\d{6,})/) || u.match(/\/video\/(\d{6,})/);
  if (m) return m[1];
  const bv = u.match(/\/video\/(BV[\w]{8,})/i);
  if (bv) return bv[1];
  const yt = u.match(/[?&]v=([\w-]{6,})/) || u.match(/youtu\.be\/([\w-]{6,})/) || u.match(/\/shorts\/([\w-]{6,})/);
  return yt ? yt[1] : "";
}

function isDouyinUrl(url) {
  return /^(https?:\/\/)?(www\.|v\.)?douyin\.com\//i.test(String(url || "").trim())
    || /^https?:\/\/v\.douyin\.com\//i.test(String(url || "").trim());
}

// 0.6.9：按网址识别平台。抖音之外支持 B 站、YouTube，其他网站按通用规则（og 标签 / JSON-LD / 标题）读。
function siteOf(url) {
  const u = String(url || "");
  if (/(^|\/\/|\.)douyin\.com\//i.test(u)) return "douyin";
  if (/(^|\/\/|\.)(bilibili\.com|b23\.tv)\//i.test(u)) return "bilibili";
  if (/(^|\/\/|\.)(youtube\.com|youtu\.be)\//i.test(u)) return "youtube";
  return "web";
}
const SITE_NAMES = { douyin: "抖音", bilibili: "B 站", youtube: "YouTube", web: "网页" };

// 生成在页面里执行的提取脚本（async，executeJavaScript 会等它）：返回一个普通对象（可 JSON 序列化），
// 不返回 DOM 节点。B 站 / YouTube 额外取字幕（口播原文），最多 8000 字。
function buildExtractScript(selectors = SELECTORS) {
  const sel = { ...SELECTORS, ...selectors };
  return `(async () => {
    const MAXT = 8000;
    const q = (s) => { try { const el = document.querySelector(s); return el ? (el.textContent || "").trim() : ""; } catch { return ""; } };
    const pick = (s) => { const parts = String(s || "").split(",").map((x) => x.trim()).filter(Boolean); for (const p of parts) { const v = q(p); if (v) return v; } return ""; };
    const meta = (n) => { try { const el = document.querySelector('meta[property="' + n + '"], meta[name="' + n + '"]'); return el ? (el.getAttribute("content") || "").trim() : ""; } catch { return ""; } };
    const canon = (() => { try { const el = document.querySelector(${JSON.stringify(sel.canonicalLink)}); return el ? (el.getAttribute("href") || "") : ""; } catch { return ""; } })();
    const video = (() => { try { const v = document.querySelector(${JSON.stringify(sel.videoElement)}); return v ? { src: v.currentSrc || v.src || "", dur: isFinite(v.duration) ? v.duration : 0 } : { src: "", dur: 0 }; } catch { return { src: "", dur: 0 }; } })();
    const sig = () => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined);
    const getJson = async (u) => { const r = await fetch(u, { credentials: "include", signal: sig() }); return r.ok ? r.json() : null; };
    const host = location.hostname;
    // ---- B 站 ----
    if (/bilibili\\.com$/.test(host)) {
      const vd = (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.videoData) || {};
      let transcript = "";
      try {
        const page = Number(new URLSearchParams(location.search).get("p") || 1);
        const cid = (vd.pages && vd.pages[page - 1] && vd.pages[page - 1].cid) || vd.cid;
        if (vd.bvid && cid) {
          let r = await getJson("https://api.bilibili.com/x/player/wbi/v2?bvid=" + vd.bvid + "&cid=" + cid).catch(() => null);
          let subs = (r && r.data && r.data.subtitle && r.data.subtitle.subtitles) || [];
          if (!subs.length) { r = await getJson("https://api.bilibili.com/x/player/v2?bvid=" + vd.bvid + "&cid=" + cid).catch(() => null); subs = (r && r.data && r.data.subtitle && r.data.subtitle.subtitles) || []; }
          const s = subs.find((x) => /zh/i.test(x.lan || "")) || subs[0];
          if (s && s.subtitle_url) {
            const u = s.subtitle_url.startsWith("//") ? "https:" + s.subtitle_url : s.subtitle_url.replace(/^http:/, "https:");
            const j = await fetch(u, { signal: sig() }).then((x) => x.json()).catch(() => null);
            transcript = ((j && j.body) || []).map((x) => x.content).join("\\n");
          }
        }
      } catch { /* 没字幕就算了 */ }
      const st = vd.stat || {};
      const n = (v) => (v == null ? "" : String(v));
      return { site: "bilibili", url: location.href, title: vd.title || meta("og:title") || document.title,
        author: (vd.owner && vd.owner.name) || pick(".up-name, .up-detail-top a"), caption: vd.desc || meta("description"),
        viewCountText: n(st.view), likeCountText: n(st.like), commentCountText: n(st.reply), shareCountText: n(st.share),
        durationSec: Number(vd.duration) || video.dur, transcript: transcript.slice(0, MAXT), videoSrc: video.src, structured: null };
    }
    // ---- YouTube ----
    if (/youtube\\.com$/.test(host)) {
      const want = new URLSearchParams(location.search).get("v") || ((location.pathname.match(/\\/shorts\\/([\\w-]+)/) || [])[1]) || "";
      let pr = null;
      try { const mp = document.getElementById("movie_player"); pr = mp && mp.getPlayerResponse ? mp.getPlayerResponse() : null; } catch { pr = null; }
      if (!pr || (want && pr.videoDetails && pr.videoDetails.videoId !== want)) {
        const init = window.ytInitialPlayerResponse;
        if (init && init.videoDetails && (!want || init.videoDetails.videoId === want)) pr = init;
      }
      const vd = (pr && pr.videoDetails) || {};
      let transcript = "";
      try {
        const tracks = (pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
        const t = tracks.find((x) => /^zh/.test(x.languageCode) && x.kind !== "asr") || tracks.find((x) => /^zh/.test(x.languageCode))
          || tracks.find((x) => /^en/.test(x.languageCode) && x.kind !== "asr") || tracks.find((x) => /^en/.test(x.languageCode)) || tracks[0];
        if (t && t.baseUrl) {
          const j = await fetch(t.baseUrl + "&fmt=json3", { credentials: "include", signal: sig() }).then((x) => x.json()).catch(() => null);
          transcript = ((j && j.events) || []).map((e) => (e.segs || []).map((sg) => sg.utf8 || "").join("")).filter((x) => x.trim()).join("\\n");
        }
      } catch { /* 没字幕就算了 */ }
      const likeBtn = document.querySelector("like-button-view-model button, #segmented-like-button button");
      return { site: "youtube", url: location.href, title: vd.title || meta("og:title") || document.title,
        author: vd.author || pick("#owner #channel-name a, ytd-channel-name a"), caption: vd.shortDescription || meta("description"),
        viewCountText: vd.viewCount ? String(vd.viewCount) : "", likeCountText: likeBtn ? (likeBtn.getAttribute("aria-label") || likeBtn.textContent || "").trim().slice(0, 60) : "",
        commentCountText: "", shareCountText: "",
        durationSec: Number(vd.lengthSeconds) || video.dur, transcript: transcript.slice(0, MAXT), videoSrc: video.src, structured: null };
    }
    // ---- 抖音 / 其他网站 ----
    let structured = null;
    try {
      const ld = document.querySelector('script[type="application/ld+json"]');
      if (ld) structured = JSON.parse(ld.textContent || "null");
    } catch { structured = null; }
    const isDouyin = /douyin\\.com$/.test(host);
    return {
      site: isDouyin ? "douyin" : "web",
      url: canon || location.href || "",
      title: isDouyin ? "" : (meta("og:title") || document.title || ""),
      author: pick(${JSON.stringify(sel.authorName)}) || (isDouyin ? "" : meta("author")),
      caption: pick(${JSON.stringify(sel.caption)}) || (isDouyin ? "" : meta("og:description") || meta("description")),
      likeCountText: pick(${JSON.stringify(sel.likeCount)}),
      commentCountText: pick(${JSON.stringify(sel.commentCount)}),
      shareCountText: pick(${JSON.stringify(sel.shareCount)}),
      viewCountText: "", durationSec: video.dur, transcript: "",
      videoSrc: video.src,
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
  const site = ["douyin", "bilibili", "youtube", "web"].includes(o.site) ? o.site : siteOf(pageUrl);
  const dur = Number(o.durationSec);
  return {
    site,
    url: pageUrl,
    videoId: parseVideoId(pageUrl),
    title: str(o.title || "", 300),
    author,
    caption,
    viewCountText: str(o.viewCountText || "", 60),
    likeCountText: str(o.likeCountText || ""),
    commentCountText: str(o.commentCountText || ""),
    shareCountText: str(o.shareCountText || ""),
    likeCount, commentCount, shareCount,
    durationSec: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : 0,
    transcript: str(o.transcript || "", 8000),
    videoSrc: str(o.videoSrc || ""),
  };
}

// 提取当前视频信息：driver 须提供 executeJavaScript(js) -> Promise<any>，
// 以及可选的 getURL()。什么都没读到（作者、文案、视频 id 全空）时抛
// NO_VIDEO_FOUND 且 manualFallback=true，调用方必须给手动粘贴兜底。
async function extractVideoInfo({ driver, selectors = SELECTORS, getURL = null } = {}) {
  if (!driver || typeof driver.executeJavaScript !== "function") {
    throw new DouyinError("分析浏览器未接通，无法读取当前视频；请先在左边打开视频页后再试，或用手动粘贴链接/文案。", { code: "NO_VIEW", manualFallback: true });
  }
  let raw;
  try {
    raw = await driver.executeJavaScript(buildExtractScript(selectors));
  } catch (err) {
    throw new DouyinError(`读取视频页面失败：${err.message || err}，请确认已打开视频详情页，或用手动粘贴链接/文案。`, { code: "EXTRACT_FAILED", manualFallback: true });
  }
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = {}; }
  }
  let url = "";
  try { url = typeof getURL === "function" ? getURL() : (driver.getURL ? driver.getURL() : ""); } catch { /* ignore */ }
  const info = parseExtracted(raw, url);
  const found = info.author || info.caption || info.videoId || info.videoSrc || info.title || info.transcript;
  if (!found) {
    throw new DouyinError("当前页面上没读到视频信息（可能还没打开视频详情页，或页面结构已改版）：请先在左侧点开一个视频再点“分析当前视频”，或在右侧手动粘贴视频链接和文案。", { code: "NO_VIDEO_FOUND", manualFallback: true });
  }
  return info;
}

module.exports = {
  DOUYIN_URL, SELECTORS, DouyinError,
  parseCount, parseVideoId, isDouyinUrl, siteOf, SITE_NAMES,
  buildExtractScript, parseExtracted, extractVideoInfo,
};
