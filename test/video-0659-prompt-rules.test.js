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

test("0.6.60 默认按国内审美写人脸", () => {
  const sys = ai.buildRewritePrompt({ shots: [{ visual: "女孩" }] })[0].content;
  assert.match(sys, /中国年轻女性/); assert.match(sys, /不要写单眼皮细长眼/); assert.doesNotMatch(sys, /毛孔绒毛的合理尺度/);
  const { facePrompt } = require("../lib/video/characters.js");
  assert.match(facePrompt({ anchor: "长发" }), /国内审美/);
  assert.doesNotMatch(facePrompt({ anchor: "长发" }, { refs: 1 }), /国内审美/);
});
