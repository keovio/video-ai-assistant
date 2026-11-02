"use strict";
// 0.6.34：视频分析浏览器的预加载脚本（和油猴脚本同样的思路）：页面脚本运行前，在页面里挂上
// fetch / XHR 钩子，从抖音 / TikTok 的接口数据里记下每个作品的原视频地址（play_addr / playAddr），
// 存到 window.__harkMedia[作品ID]，下载原视频时直接用，不再依赖 <video> 的 src（分段流是 blob:）。
const HOOK = `(() => {
  if (window.__harkMedia) return;
  const M = window.__harkMedia = {};
  const pick = (l) => (Array.isArray(l) ? l : []).filter((u) => typeof u === "string" && /^https?:/.test(u));
  const srcs = (l) => (Array.isArray(l) ? l : []).map((p) => p && (p.src || p.url)).filter((u) => typeof u === "string");
  function take(o) {
    try {
      const id = String(o.aweme_id || o.awemeId || o.id || "");
      const v = o.video;
      if (!id || !v || typeof v !== "object") return;
      let urls = [];
      const br = Array.isArray(v.bit_rate) ? v.bit_rate.slice().sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0)) : [];
      for (const b of br) urls.push(...pick(b.play_addr && b.play_addr.url_list));
      urls.push(...pick(v.play_addr && v.play_addr.url_list), ...pick(v.download_addr && v.download_addr.url_list));
      const brl = Array.isArray(v.bitRateList) ? v.bitRateList.slice().sort((a, b) => (b.bitRate || 0) - (a.bitRate || 0)) : [];
      for (const b of brl) urls.push(...srcs(b.playAddr));
      if (Array.isArray(v.playAddr)) urls.push(...srcs(v.playAddr));
      if (typeof v.playAddr === "string") urls.push(v.playAddr);
      if (typeof v.downloadAddr === "string") urls.push(v.downloadAddr);
      if (Array.isArray(v.bitrateInfo)) for (const b of v.bitrateInfo) urls.push(...pick(b && b.PlayAddr && b.PlayAddr.UrlList));
      urls = [...new Set(urls.map((u) => (u.startsWith("//") ? "https:" + u : u.replace(/^http:/, "https:"))))];
      if (urls.length) M[id] = { urls, t: Date.now() };
    } catch (e) { /* ignore */ }
  }
  function walk(o, d) {
    if (!o || typeof o !== "object" || d > 9) return;
    if (o.video && (o.aweme_id || o.awemeId || o.id)) take(o);
    if (Array.isArray(o)) { for (const x of o) walk(x, d + 1); return; }
    for (const k in o) { const x = o[k]; if (x && typeof x === "object") walk(x, d + 1); }
  }
  window.__harkMediaWalk = walk;
  const want = (u) => /aweme|\\/api\\/|item|feed|detail|post|search|related|recommend/i.test(u || "");
  const of = window.fetch;
  if (of) window.fetch = function (...a) {
    const p = of.apply(this, a);
    p.then((r) => { try { if (want(r.url) && /json/.test(r.headers.get("content-type") || "")) r.clone().json().then((j) => walk(j, 0)).catch(() => {}); } catch (e) { /* ignore */ } }).catch(() => {});
    return p;
  };
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener("load", () => {
      try {
        if (!want(this.responseURL)) return;
        const rt = this.responseType;
        const t = rt === "" || rt === "text" ? this.responseText : rt === "json" ? this.response : null;
        if (t) walk(typeof t === "string" ? JSON.parse(t) : t, 0);
      } catch (e) { /* ignore */ }
    });
    return os.apply(this, a);
  };
})();`;

try {
  const { contextBridge, webFrame } = require("electron");
  if (contextBridge && typeof contextBridge.executeInMainWorld === "function") {
    contextBridge.executeInMainWorld({ func: new Function(HOOK) });
  } else if (webFrame) {
    webFrame.executeJavaScript(HOOK);
  }
} catch (e) { /* 预加载失败不影响页面 */ }
