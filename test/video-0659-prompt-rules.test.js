const test = require("node:test");
const assert = require("node:assert");
const ai = require("../lib/video/ai.js");
const { framePrompt } = require("../lib/video/characters.js");

test("0.6.59 画面提示词写法：分段、按秒时间线、否定集中", () => {
  const sys = ai.buildRewritePrompt({ shots: [{ narration: "", visual: "女孩窗边", prompt: "x" }] })[0].content;
  for (const k of ["【人物】", "【构图】", "【光影】", "【动作时间线】", "【镜头】", "【声音】", "【避免】", "0–3秒", "末尾定格"]) assert.ok(sys.includes(k), k);
  assert.doesNotMatch(sys, /150–400/);
});

test("0.6.59 首帧图去掉【风格】段，保留【避免】", () => {
  const p = framePrompt({ name: "A", appearance: "黑长发" }, "【人物】女孩\n【风格】暖光日系\n【避免】文字", { aspect: "9:16" });
  assert.doesNotMatch(p, /暖光日系/); assert.match(p, /【避免】文字/);
});
