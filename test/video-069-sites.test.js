"use strict";
// 0.6.9：多平台视频分析（B 站 / YouTube 字幕）+ 提示词带字幕
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { buildExtractScript, parseExtracted, siteOf, parseVideoId } = require("../lib/video/douyin");
const { buildAnalysisPrompt } = require("../lib/video/ai");

function runScript({ href, win = {}, fetchMap = {} }) {
  const url = new URL(href);
  const doc = { querySelector: () => null, querySelectorAll: () => [], getElementById: (id) => (win.__els || {})[id] || null, title: "页面标题" };
  const ctx = {
    window: win, document: doc, location: { href, hostname: url.hostname, search: url.search, pathname: url.pathname },
    URLSearchParams, AbortSignal,
    fetch: async (u) => {
      const key = Object.keys(fetchMap).find((k) => String(u).includes(k));
      return { ok: !!key, json: async () => (key ? fetchMap[key] : null) };
    },
  };
  Object.assign(ctx, win);
  return vm.runInNewContext(buildExtractScript(), ctx);
}

test("平台识别与视频 id", () => {
  assert.equal(siteOf("https://www.bilibili.com/video/BV1xx411c7mD"), "bilibili");
  assert.equal(siteOf("https://www.youtube.com/watch?v=abcdefg"), "youtube");
  assert.equal(siteOf("https://www.douyin.com/video/123456789"), "douyin");
  assert.equal(siteOf("https://klingai.com/x"), "web");
  assert.equal(parseVideoId("https://www.bilibili.com/video/BV1xx411c7mD?p=2"), "BV1xx411c7mD");
  assert.equal(parseVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
});

test("B 站：读 __INITIAL_STATE__ 和字幕", async () => {
  const raw = await runScript({
    href: "https://www.bilibili.com/video/BV1xx411c7mD",
    win: { __INITIAL_STATE__: { videoData: { bvid: "BV1xx411c7mD", cid: 99, title: "标题B", desc: "简介", duration: 95, owner: { name: "UP主" }, stat: { view: 1200, like: 30, reply: 4, share: 2 } } } },
    fetchMap: {
      "x/player/wbi/v2": { data: { subtitle: { subtitles: [{ lan: "ai-zh", subtitle_url: "//aisubtitle.hdslb.com/s.json" }] } } },
      "aisubtitle.hdslb.com/s.json": { body: [{ content: "大家好" }, { content: "今天讲剪辑" }] },
    },
  });
  const info = parseExtracted(raw);
  assert.equal(info.site, "bilibili");
  assert.equal(info.title, "标题B");
  assert.equal(info.author, "UP主");
  assert.equal(info.viewCountText, "1200");
  assert.equal(info.durationSec, 95);
  assert.equal(info.transcript, "大家好\n今天讲剪辑");
});

test("YouTube：读播放器数据和字幕", async () => {
  const pr = {
    videoDetails: { videoId: "abc123XYZ", title: "YT title", author: "Chan", shortDescription: "desc", viewCount: "999", lengthSeconds: "61" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: "en", kind: "asr", baseUrl: "https://www.youtube.com/api/timedtext?v=abc" }] } },
  };
  const raw = await runScript({
    href: "https://www.youtube.com/watch?v=abc123XYZ",
    win: { __els: { movie_player: { getPlayerResponse: () => pr } } },
    fetchMap: { "api/timedtext": { events: [{ segs: [{ utf8: "hello " }, { utf8: "world" }] }, { segs: [{ utf8: "\n" }] }, { segs: [{ utf8: "bye" }] }] } },
  });
  const info = parseExtracted(raw);
  assert.equal(info.site, "youtube");
  assert.equal(info.author, "Chan");
  assert.equal(info.durationSec, 61);
  assert.equal(info.transcript, "hello world\nbye");
});

test("提示词带平台、标题、时长和字幕", () => {
  const p = buildAnalysisPrompt({ videoInfo: { site: "bilibili", title: "T", durationSec: 95, transcript: "大家好" } });
  assert.match(p, /平台：B 站/);
  assert.match(p, /标题：T/);
  assert.match(p, /约 95 秒/);
  assert.match(p, /字幕[\s\S]*大家好/);
});
