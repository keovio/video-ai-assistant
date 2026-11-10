const test = require("node:test");
const assert = require("node:assert");
const PC = require("../renderer/shell/prompt-copy.js");

test("0.6.62 全部复制统一格式", () => {
  const a = PC.all({ shots: [{ prompt: "女孩坐窗边", seconds: 15 }, { prompt: "" }] });
  assert.strictEqual(a.text, "第 1 镜（15 秒）：女孩坐窗边"); assert.strictEqual(a.count, 1);
  const b = PC.all({ shots: [{ prompt: "p", seconds: 2.04 }], who: "黑长发", whoName: "小雨", style: "日系" });
  assert.strictEqual(b.text, "人物（小雨，全片同一人）：黑长发\n整体风格：日系\n\n第 1 镜（2 秒）：p");
  assert.strictEqual(PC.all({ shots: [] }).text, "");
});
