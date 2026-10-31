"use strict";
// 0.6.21：存草稿（TikTok / 抖音）+ 内嵌浏览器第三方登录兼容。
// 纯函数放这里便于单测；真正操作页面在 main.js（内嵌浏览器 + CDP DOM.setFileInputFiles）。

const PLATFORMS = {
  tiktok: {
    name: "TikTok",
    uploadUrl: "https://www.tiktok.com/tiktokstudio/upload?from=webapp",
    // 上传后的文案编辑器（Draft.js / contenteditable），按顺序试
    captionSelectors: [
      "[data-e2e='caption_container'] [contenteditable='true']",
      ".caption-editor [contenteditable='true']",
      ".public-DraftEditor-content",
      "div[contenteditable='true']",
    ],
    draftHint: "页面底部的“保存草稿”（Save draft）",
    captionMax: 2200,
  },
  douyin: {
    name: "抖音",
    uploadUrl: "https://creator.douyin.com/creator-micro/content/upload",
    captionSelectors: [
      ".zone-container[contenteditable='true']",
      "[data-placeholder*='简介'][contenteditable='true']",
      ".editor-kit-container [contenteditable='true']",
      "div[contenteditable='true']",
    ],
    titleSelectors: ["input[placeholder*='标题']"],
    draftHint: "页面底部的“暂存离开”/保存草稿",
    captionMax: 1000,
  },
};

function platformOf(id) { return PLATFORMS[id] ? id : "tiktok"; }

// 第三方登录弹窗（Google/Apple/Facebook/X/微软/LINE）：要用真正的弹窗打开（保留 window.opener），
// 否则登录完原页面收不到结果。
const AUTH_POPUP_RE = /^https:\/\/(accounts\.google\.com|appleid\.apple\.com|(www|m)\.facebook\.com\/(v[\d.]+\/)?dialog|(api\.)?(twitter|x)\.com\/(i\/)?oauth|login\.(microsoftonline|live)\.com|access\.line\.me|kauth\.kakao\.com)\//i;
function isAuthPopupUrl(u) { return AUTH_POPUP_RE.test(String(u || "")); }

// Google 会拦截内嵌浏览器（“此浏览器或应用可能不安全”）。对 accounts.google.com 用 Firefox UA，
// 并去掉会暴露 Chromium 内核版本的 Sec-CH-UA 头，这是 Electron 应用常用且有效的做法。
const GOOGLE_HOST_RE = /^https:\/\/accounts\.google\.com\//i;
function firefoxUserAgent(platform = process.platform) {
  const os = platform === "darwin" ? "Macintosh; Intel Mac OS X 10.15"
    : platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}; rv:135.0) Gecko/20100101 Firefox/135.0`;
}
function rewriteGoogleHeaders(headers, platform) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) if (!/^sec-ch-ua/i.test(k)) out[k] = v;
  out["User-Agent"] = firefoxUserAgent(platform);
  return out;
}

function trimCaption(text, platform) {
  const max = PLATFORMS[platformOf(platform)].captionMax;
  return String(text || "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

// 默认文案：分镜脚本标题 + 话题（项目里有就带上），没有就用项目名
function defaultCaption(project) {
  const p = project || {};
  const title = String(p.title || "").trim();
  return title && title !== "未命名项目" ? title : "";
}

// 页面里找“视频上传”文件框是否已出现（未登录时是登录页，没有）
function fileInputProbeScript() {
  return `(() => {
    const ins = [...document.querySelectorAll('input[type="file"]')];
    const v = ins.find((i) => /video|mp4|mov|\\*/i.test(i.accept || "")) || ins[0];
    return { url: location.href, hasInput: !!v, inputs: ins.length };
  })()`;
}

// 聚焦文案编辑器并全选，返回是否找到；随后用 CDP Input.insertText 输入（富文本编辑器认这种输入）
function focusCaptionScript(selectors) {
  return `(() => {
    const sels = ${JSON.stringify(selectors)};
    for (const s of sels) {
      const els = [...document.querySelectorAll(s)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 10; });
      const el = els[0];
      if (!el) continue;
      el.scrollIntoView({ block: "center" });
      el.focus();
      const sel = window.getSelection(); const range = document.createRange();
      range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
      return { ok: true, selector: s };
    }
    return { ok: false };
  })()`;
}

module.exports = { PLATFORMS, platformOf, isAuthPopupUrl, GOOGLE_HOST_RE, firefoxUserAgent, rewriteGoogleHeaders, trimCaption, defaultCaption, fileInputProbeScript, focusCaptionScript };
