"use strict";
// M4 抖音：选择器图谱、计数解析、提取脚本与结果规范化、提取 runner（假 driver，
// 不碰真实网络与真实抖音页面）。本文件不证明真机提取成功，只证明模块逻辑与失败兜底。
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SELECTORS, DouyinError, parseCount, parseVideoId, isDouyinUrl,
  buildExtractScript, parseExtracted, extractVideoInfo,
} = require("../lib/video/douyin");

test("选择器图谱：关键键齐全", () => {
  for (const key of ["authorName", "caption", "likeCount", "commentCount", "videoElement", "canonicalLink"]) {
    assert.ok(SELECTORS[key], `缺少选择器 ${key}`);
  }
});

test("计数解析：万/千/纯数字/读不懂", () => {
  assert.equal(parseCount("1.2万"), 12000);
  assert.equal(parseCount("3千"), 3000);
  assert.equal(parseCount("456"), 456);
  assert.equal(parseCount("1,234"), 1234);
  assert.equal(parseCount(""), null);
  assert.equal(parseCount("abc"), null);
  assert.equal(parseCount(null), null);
});

test("链接解析：视频 id 与抖音域名判断", () => {
  assert.equal(parseVideoId("https://www.douyin.com/video/7381234567890123456?x=1"), "7381234567890123456");
  assert.equal(parseVideoId("https://v.douyin.com/abc123/"), "");
  assert.equal(parseVideoId(""), "");
  assert.equal(isDouyinUrl("https://www.douyin.com/video/123456"), true);
  assert.equal(isDouyinUrl("https://v.douyin.com/abc/"), true);
  assert.equal(isDouyinUrl("https://example.com/video/1"), false);
});

test("提取脚本与结果规范化：DOM 文本 + 结构化数据优先，不补页面没有的信息", () => {
  const script = buildExtractScript();
  assert.match(script, /canonical/);
  assert.match(script, /location\.href/);
  const info = parseExtracted({
    url: "https://www.douyin.com/video/7381234567890123456",
    author: "阿山", caption: "雨夜街道", likeCountText: "1.2万", commentCountText: "345", shareCountText: "",
    videoSrc: "https://example.invalid/v.mp4",
    structured: { "@type": "VideoObject", name: "结构化标题", description: "结构化描述", author: { name: "结构化作者" } },
  });
  assert.equal(info.videoId, "7381234567890123456");
  assert.equal(info.author, "阿山"); // DOM 文本优先于结构化数据
  assert.equal(info.likeCount, 12000);
  assert.equal(info.commentCount, 345);
  assert.equal(info.shareCount, null);
  assert.equal(info.videoSrc, "https://example.invalid/v.mp4");
  const fromStructured = parseExtracted({ url: "", structured: { name: "只有结构化", author: { name: "小李" } } });
  assert.equal(fromStructured.caption, "只有结构化");
  assert.equal(fromStructured.author, "小李");
  assert.equal(fromStructured.videoId, "");
  const empty = parseExtracted({});
  assert.equal(empty.author, "");
  assert.equal(empty.caption, "");
});

function fakeDriver(raw) {
  return {
    calls: [],
    async executeJavaScript(js) { this.calls.push(js); return raw; },
    getURL() { return "https://www.douyin.com/video/7381234567890123456"; },
  };
}

test("提取 runner：读到信息返回规范化结果；什么都没读到时明确失败且转手动", async () => {
  const driver = fakeDriver({ author: "阿山", caption: "雨夜", likeCountText: "10", url: "" });
  const info = await extractVideoInfo({ driver });
  assert.equal(info.author, "阿山");
  assert.equal(info.videoId, "7381234567890123456"); // 来自 getURL
  assert.ok(driver.calls[0].includes("querySelector"));

  await assert.rejects(
    extractVideoInfo({ driver: fakeDriver({ author: "", caption: "", url: "" }), getURL: () => "" }),
    (e) => e instanceof DouyinError && e.code === "NO_VIDEO_FOUND" && e.manualFallback === true && /手动/.test(e.message),
  );
  await assert.rejects(
    extractVideoInfo({ driver: null }),
    (e) => e.code === "NO_VIEW" && e.manualFallback === true,
  );
  const throwing = { executeJavaScript: async () => { throw new Error("boom"); } };
  await assert.rejects(
    extractVideoInfo({ driver: throwing }),
    (e) => e.code === "EXTRACT_FAILED" && e.manualFallback === true,
  );
});

test("提取 runner：driver 返回 JSON 字符串也能解析", async () => {
  const driver = { executeJavaScript: async () => JSON.stringify({ author: "小李", caption: "海边" }) };
  const info = await extractVideoInfo({ driver, getURL: () => "https://www.douyin.com/video/111222333444555666" });
  assert.equal(info.author, "小李");
  assert.equal(info.videoId, "111222333444555666");
});
