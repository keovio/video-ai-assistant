"use strict";
// 0.6.21 存草稿 + 第三方登录兼容
const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../lib/video/publish");

test("第三方登录弹窗识别", () => {
  assert.equal(p.isAuthPopupUrl("https://accounts.google.com/o/oauth2/v2/auth?client_id=x"), true);
  assert.equal(p.isAuthPopupUrl("https://appleid.apple.com/auth/authorize?x"), true);
  assert.equal(p.isAuthPopupUrl("https://www.facebook.com/v18.0/dialog/oauth?x"), true);
  assert.equal(p.isAuthPopupUrl("https://www.tiktok.com/@someone"), false);
  assert.equal(p.isAuthPopupUrl("javascript:alert(1)"), false);
});

test("Google 请求头：换 Firefox UA，去掉 Sec-CH-UA", () => {
  const h = p.rewriteGoogleHeaders({ "User-Agent": "Chrome", "sec-ch-ua": '"Chromium";v="140"', "sec-ch-ua-platform": "macOS", Accept: "*/*" }, "darwin");
  assert.match(h["User-Agent"], /Firefox\/\d+/);
  assert.match(h["User-Agent"], /Macintosh/);
  assert.equal(Object.keys(h).some((k) => /^sec-ch-ua/i.test(k)), false);
  assert.equal(h.Accept, "*/*");
  assert.equal(p.GOOGLE_HOST_RE.test("https://accounts.google.com/v3/signin"), true);
});

test("平台与文案", () => {
  assert.equal(p.platformOf("douyin"), "douyin");
  assert.equal(p.platformOf("xx"), "tiktok");
  assert.match(p.PLATFORMS.tiktok.uploadUrl, /^https:\/\/www\.tiktok\.com\/tiktokstudio\/upload/);
  assert.match(p.PLATFORMS.douyin.uploadUrl, /^https:\/\/creator\.douyin\.com\//);
  assert.equal(p.trimCaption("  a\r\nb  ", "tiktok"), "a\nb");
  assert.equal(p.trimCaption("x".repeat(3000), "douyin").length, 1000);
  for (const s of [p.fileInputProbeScript(), p.focusCaptionScript(["#a"])]) assert.doesNotThrow(() => new Function("return " + s));
});
