"use strict";
// 视频数据模型：估算、排时间、实际时长重排、order 连续性、normalize 白名单
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeProject, normalizeShot, estimateSeconds, computeTimings, retimeFromAudio, countChars,
} = require("../lib/video-model");

test("estimateSeconds：4.5 字/秒，向上取整到 0.1 秒，空口播为 0", () => {
  assert.equal(estimateSeconds(""), 0);
  assert.equal(estimateSeconds("   "), 0);
  assert.equal(estimateSeconds("你好世界"), 0.9); // 4 字 / 4.5 = 0.888… → 0.9
  assert.equal(estimateSeconds("一二三四五六七八九"), 2); // 9 / 4.5
  assert.equal(estimateSeconds("一二三四五六七八九十"), 2.3); // 10 / 4.5 = 2.22… → 2.3
  assert.equal(estimateSeconds("你好 世界"), 0.9); // 空白不计字数
});

test("countChars：中文按字，空白不计", () => {
  assert.equal(countChars("你好，世界！"), 6);
  assert.equal(countChars("hello world"), 10);
});

test("computeTimings：按 order 顺序排 start/end，总时长为各镜之和", () => {
  const { shots, totalSeconds } = computeTimings([
    { id: "b", order: 1, narration: "一二三四五六七八九" },
    { id: "a", order: 0, narration: "你好世界" },
    { id: "c", order: 2, narration: "" },
  ]);
  assert.deepEqual(shots.map((s) => s.id), ["a", "b", "c"]);
  assert.deepEqual([shots[0].start, shots[0].end], [0, 0.9]);
  assert.deepEqual([shots[1].start, shots[1].end], [0.9, 2.9]);
  assert.deepEqual([shots[2].start, shots[2].end], [2.9, 2.9]);
  assert.equal(totalSeconds, 2.9);
  // 不改输入
  assert.equal(shots[0].narration, "你好世界");
});

test("retimeFromAudio：用实际时长重排，没有实际时长退回估算", () => {
  const shots = [
    { id: "a", order: 0, narration: "你好世界" },
    { id: "b", order: 1, narration: "一二三四五六七八九" },
    { id: "c", order: 2, narration: "你好世界" },
  ];
  const byMap = retimeFromAudio(shots, { a: 1.5, c: 0.4 });
  assert.deepEqual([byMap.shots[0].start, byMap.shots[0].end, byMap.shots[0].audioSeconds], [0, 1.5, 1.5]);
  assert.deepEqual([byMap.shots[1].start, byMap.shots[1].end, byMap.shots[1].audioSeconds], [1.5, 3.5, 2]); // b 退回估算 2 秒
  assert.deepEqual([byMap.shots[2].start, byMap.shots[2].end, byMap.shots[2].audioSeconds], [3.5, 3.9, 0.4]);
  assert.equal(byMap.totalSeconds, 3.9);

  const byArray = retimeFromAudio(shots, [1, 1, 1]);
  assert.equal(byArray.totalSeconds, 3);
  assert.deepEqual(byArray.shots.map((s) => s.audioSeconds), [1, 1, 1]);

  // 非法/0 时长退回估算
  const bad = retimeFromAudio(shots, { a: 0, b: -1, c: "x" });
  assert.equal(bad.totalSeconds, 3.8);
});

test("normalizeProject：默认值、白名单、非法值回退", () => {
  const p = normalizeProject({ title: "  ", status: "weird", aspect: "4:3", tags: "a、b,a,,", unknownField: 1, voice: { voice: "v1", rate: 9, bgm: "x.mp3" } });
  assert.equal(p.title, "未命名项目");
  assert.equal(p.status, "draft");
  assert.equal(p.aspect, "9:16");
  assert.deepEqual(p.tags, ["a", "b"]);
  assert.equal(p.unknownField, undefined);
  assert.deepEqual(p.voice, { ttsProvider: "", voice: "v1", rate: 2, bgm: "x.mp3" });
  assert.equal(p.totalSeconds, 0);
  const p2 = normalizeProject({ title: "T", aspect: "16:9", voice: { rate: 0.1 } });
  assert.equal(p2.aspect, "16:9");
  assert.equal(p2.voice.rate, 0.5);
});

test("normalizeShot：order/状态/数值夹取，未知字段 strip", () => {
  const s = normalizeShot({ projectId: "p1", order: -3, status: "done", audioSeconds: "2.34", retryCount: 200, narration: "你好", extra: 1 });
  assert.equal(s.order, 0);
  assert.equal(s.status, "pending");
  assert.equal(s.audioSeconds, 2.3);
  assert.equal(s.retryCount, 99);
  assert.equal(s.extra, undefined);
  assert.equal(normalizeShot({}).projectId, "");
  assert.equal(normalizeShot({ order: 2.9 }).order, 2);
});
