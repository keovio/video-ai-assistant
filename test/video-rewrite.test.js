const test = require("node:test");
const assert = require("node:assert");
const { rewritePrompts, buildRewritePrompt } = require("../lib/video/ai");

test("rewritePrompts 返回与镜头等长的提示词", async () => {
  let body = null;
  const fetchImpl = async (_u, o) => { body = JSON.parse(o.body); return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"prompts":["雨夜街道，慢推","霓虹灯牌特写"]}' }, finish_reason: "stop" }] }) }; };
  const out = await rewritePrompts({ fetchImpl, apiKey: "k", baseUrl: "http://x/v1", model: "m", mode: "imitate", reference: "参考写法ABC",
    shots: [{ visual: "街道" }, { visual: "灯牌" }, { visual: "车" }] });
  assert.deepStrictEqual(out, ["雨夜街道，慢推", "霓虹灯牌特写", ""]);
  assert.match(body.messages[1].content, /参考写法ABC/);
});

test("没有参考时按优化模式写提示", () => {
  const m = buildRewritePrompt({ shots: [{ visual: "a" }], mode: "imitate", reference: "" });
  assert.match(m[1].content, /生视频网站/);
});
