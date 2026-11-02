"use strict";
const test = require("node:test");
const assert = require("node:assert");
const f = require("../lib/video/frames");

test("planFrameTimes：没有换镜时全片均匀 16 张", () => {
  const t = f.planFrameTimes(60, [], { count: 16 });
  assert.strictEqual(t.length, 16);
  assert.ok(t[0] < 1 && t[15] > 50);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1]);
});

test("planFrameTimes：每个换镜点后都有一张", () => {
  const t = f.planFrameTimes(30, [5, 12.4, 20], { count: 16 });
  assert.strictEqual(t.length, 16);
  for (const c of [5, 12.4, 20]) assert.ok(t.some((x) => x > c && x - c < 0.5), `换镜 ${c} 后应有截图`);
});

test("planFrameTimes：短视频不截满，换镜太多时也留均匀点", () => {
  assert.ok(f.planFrameTimes(3, [1], { count: 16 }).length <= 6);
  const many = Array.from({ length: 40 }, (_, i) => i + 0.5);
  const t = f.planFrameTimes(41, many, { count: 16 });
  assert.strictEqual(t.length, 16);
});

test("diffsFromScenes / parseSceneTimes", () => {
  assert.deepStrictEqual(f.diffsFromScenes([0.3, 3, 6], [4]), [0.1, 0.6]);
  assert.deepStrictEqual(f.parseSceneTimes("[Parsed_showinfo_2] n:0 pts:4 pts_time:4.04 \n pts_time:9"), [4.04, 9]);
});

test("targetVideoKbps：太长返回 0", () => {
  assert.ok(f.targetVideoKbps(60, 15 * 1048576) > 120);
  assert.strictEqual(f.targetVideoKbps(3600, 15 * 1048576), 0);
});

test("extractFrames：用注入的 run 截图并给出差异", async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === "ffprobe") return { stdout: "20.0\n", stderr: "" };
    if (args.includes("null")) return { stdout: "", stderr: "pts_time:8.0\n" };
    return { stdout: Buffer.alloc(1000, 1), stderr: "" };
  };
  const im = await f.extractFrames("/x.mp4", { count: 16, run });
  assert.strictEqual(im.length, 16);
  assert.ok(im[0].startsWith("data:image/jpeg;base64,"));
  assert.strictEqual(im.diffs.filter((d) => d >= 0.3).length, 1);
  assert.deepStrictEqual(im.scenes, [8]);
});
