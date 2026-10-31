"use strict";
// 0.6.22 分析时保存背景音乐名称
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const dy = require("../lib/video/douyin");
const { createVideoStore } = require("../lib/video-store");

test("提取结果带背景音乐，空白压缩、限长", () => {
  const info = dy.parseExtracted({ site: "douyin", url: "https://www.douyin.com/video/7300000000000000001", music: "  晴天 -\n 周杰伦 ", caption: "x" });
  assert.equal(info.music, "晴天 - 周杰伦");
  assert.equal(dy.parseExtracted({ music: "a".repeat(500), caption: "x" }).music.length, 200);
  assert.equal(dy.parseExtracted({ caption: "x" }).music, "");
});

test("提取脚本语法正确且包含音乐读取", () => {
  const s = dy.buildExtractScript();
  assert.doesNotThrow(() => new Function("return " + s));
  assert.match(s, /RENDER_DATA/);
  assert.match(s, /tag_type === "bgm"/);
  assert.match(s, /videoAttributeViewModel/);
});

test("分析记录保存 musicName", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "music-"));
  const store = createVideoStore(dir);
  const r = store.analyses.upsert({ sourceUrl: "https://x", musicName: "晴天 - 周杰伦" });
  assert.equal(store.analyses.get(r.id).musicName, "晴天 - 周杰伦");
});
