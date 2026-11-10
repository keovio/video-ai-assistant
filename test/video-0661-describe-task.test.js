const test = require("node:test");
const assert = require("node:assert");
const { describeCharacter } = require("../lib/video/ai.js");

test("0.6.61 AI 帮写：分步日志", async () => {
  const steps = [];
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ name: "小雨", anchor: "中国年轻女性", outfit: "白T" }) } }] }) });
  const r = await describeCharacter({ fetchImpl, apiKey: "k", baseUrl: "https://x/v1", model: "m", text: "女孩", onStep: (m) => steps.push(m) });
  assert.strictEqual(r.anchor, "中国年轻女性");
  assert.match(steps[0], /发给 AI（模型 m/); assert.match(steps[1], /AI 已返回/);
});
