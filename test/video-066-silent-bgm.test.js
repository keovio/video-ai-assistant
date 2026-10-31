"use strict";
// 0.6.6：无口播镜头的手动时长 + 背景音乐音量/淡出
const test = require("node:test");
const assert = require("node:assert/strict");
const { measuredDuration, normalizeShot, voiceOf } = require("../lib/video-model");
const { buildFinalCommand, bgmVolumeFor, planSegments } = require("../lib/video/render");

test("无配音时长：手动 > 口播估算 > 片段时长 > 有画面 3 秒 > 0", () => {
  assert.equal(measuredDuration({ audioAssetId: "a", audioSeconds: 7.2, seconds: 3 }), 7.2);
  assert.equal(measuredDuration({ seconds: 5, narration: "很长很长的一段口播文案内容在这里" }), 5);
  assert.ok(measuredDuration({ narration: "你好世界" }) > 0);
  assert.equal(measuredDuration({ videoAssetId: "v", clipSeconds: 4.6 }), 4.6);
  assert.equal(measuredDuration({ imageAssetId: "i" }), 3);
  assert.equal(measuredDuration({}), 0);
  assert.equal(normalizeShot({ seconds: 9999 }).seconds, 600);
  assert.equal(normalizeShot({}).seconds, 0);
});

test("BGM 音量：自动按有无人声，手动 0–1，结尾淡出", () => {
  assert.equal(bgmVolumeFor(0, true), 0.18);
  assert.equal(bgmVolumeFor(0, false), 0.8);
  assert.equal(bgmVolumeFor(0.5, true), 0.5);
  assert.equal(voiceOf({ bgmVolume: 3 }).bgmVolume, 1);
  const j = buildFinalCommand({ segmentFiles: { listFile: "l.txt" }, srtPath: "a.srt", bgmFile: "b.mp3", output: "o.mp4", burnSubtitles: false, hasVoice: false, totalSeconds: 12 }).join(" ");
  assert.match(j, /volume=0\.8,afade=t=out:st=10:d=2/);
});

test("没有口播的镜头不再报“无配音”警告", () => {
  const { warnings } = planSegments([{ id: "s", order: 0, seconds: 3, imageAssetId: "i" }], { i: { path: "x.png" } });
  assert.ok(!warnings.some((w) => w.includes("无配音")));
});
