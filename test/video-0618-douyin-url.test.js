"use strict";
// 0.6.18：抖音推荐页/弹窗里，原视频地址按当前播放视频的作品 ID 拼，不用地址栏
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildExtractScript, parseExtracted } = require("../lib/video/douyin");

function fakeEl({ text = "", attrs = {}, rect = { left: 0, top: 0, right: 0, bottom: 0 }, children = {}, video = null }) {
  const el = {
    textContent: text,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    getBoundingClientRect: () => rect,
    querySelector: (s) => children[s] || null,
    closest: () => null,
  };
  if (video) Object.assign(el, video);
  return el;
}
async function run({ search = "", pathname = "/", active }) {
  const prevV = fakeEl({ rect: { left: 0, top: -900, right: 500, bottom: -10 }, video: { paused: true, ended: false, readyState: 4, duration: 30, currentSrc: "prev.mp4" } });
  const curRoot = fakeEl({ attrs: { "data-e2e-vid": "7432100000000000001" }, children: { "[data-e2e='user-name']": fakeEl({ text: "当前作者" }) } });
  const curV = fakeEl({ rect: { left: 0, top: 0, right: 500, bottom: 800 }, video: { paused: false, ended: false, readyState: 4, duration: 12, currentSrc: "cur.mp4" } });
  curV.closest = () => curRoot;
  const document = {
    querySelector: (s) => {
      if (s === '[data-e2e="feed-active-video"]') return active ? curRoot : null;
      if (s === "[data-e2e='user-name']") return fakeEl({ text: "上一条作者" });
      if (s === "link[rel='canonical']") return fakeEl({ attrs: { href: "https://www.douyin.com/" } });
      return null;
    },
    querySelectorAll: (s) => (s === "video" ? [prevV, curV] : []),
    title: "抖音",
  };
  const location = { hostname: "www.douyin.com", href: "https://www.douyin.com/" + search, search, pathname };
  const fn = new Function("document", "location", "innerHeight", "innerWidth", "fetch", "return " + buildExtractScript());
  return parseExtracted(await fn(document, location, 900, 1400, async () => ({ ok: false })));
}

test("推荐页：按当前播放视频容器的 data-e2e-vid 拼地址，作者读当前容器", async () => {
  const r = await run({ active: false });
  assert.equal(r.url, "https://www.douyin.com/video/7432100000000000001");
  assert.equal(r.videoId, "7432100000000000001");
  assert.equal(r.author, "当前作者");
  assert.equal(r.durationSec, 12);
});

test("主页弹窗：没有容器 ID 时用 modal_id", async () => {
  const r = await run({ active: false, search: "?modal_id=7400000000000000009" });
  // 容器里有 ID 时优先容器；这里模拟容器没有 ID
  assert.match(r.url, /^https:\/\/www\.douyin\.com\/video\/\d+$/);
});
