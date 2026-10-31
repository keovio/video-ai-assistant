"use strict";
// 0.6.7：AI 返回空正文（思考模型额度用尽 / SSE / 片段数组）时的兜底
const test = require("node:test");
const assert = require("node:assert/strict");
const { chatComplete, AiError } = require("../lib/video/ai");

const resp = (obj, raw) => ({ ok: true, status: 200, text: async () => (raw != null ? raw : JSON.stringify(obj)) });
const base = { apiKey: "k", baseUrl: "https://x/v1", model: "m", messages: [{ role: "user", content: "hi" }] };

test("finish_reason=length 且正文空：放大 max_tokens 重试一次", async () => {
  const seen = [];
  const fetchImpl = async (_u, o) => {
    const b = JSON.parse(o.body); seen.push(b.max_tokens);
    return seen.length === 1
      ? resp({ choices: [{ message: { content: "", reasoning_content: "想了很多" }, finish_reason: "length" }] })
      : resp({ choices: [{ message: { content: "{\"a\":1}" }, finish_reason: "stop" }] });
  };
  const r = await chatComplete({ ...base, fetchImpl, maxTokens: 3000 });
  assert.equal(r.content, "{\"a\":1}");
  assert.deepEqual(seen, [3000, 9000]);
});

test("仍为空时报出具体原因，而不是笼统的空内容", async () => {
  const fetchImpl = async () => resp({ choices: [{ message: { content: null }, finish_reason: "length" }] });
  await assert.rejects(chatComplete({ ...base, fetchImpl }), (e) => e instanceof AiError && e.code === "EMPTY_RESPONSE" && /思考/.test(e.message));
});

test("SSE 流式响应和片段数组都能读出正文", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"{\\"a\\":"}}]}\n\ndata: {"choices":[{"delta":{"content":"2}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n';
  const r1 = await chatComplete({ ...base, fetchImpl: async () => resp(null, sse) });
  assert.equal(r1.content, "{\"a\":2}");
  const r2 = await chatComplete({ ...base, fetchImpl: async () => resp({ choices: [{ message: { content: [{ type: "text", text: "{\"b\":3}" }] } }] }) });
  assert.equal(r2.content, "{\"b\":3}");
});

test("GLM 思考模型：5.3 系列降为 low，可关闭的系列关思考；参数被拒时去掉重试", async () => {
  const { thinkingParams } = require("../lib/video/ai");
  assert.deepEqual(thinkingParams("glm-5.3-flash"), { reasoning_effort: "low" });
  assert.deepEqual(thinkingParams("glm-4.7-flash"), { thinking: { type: "disabled" } });
  assert.deepEqual(thinkingParams("gpt-4o-mini"), {});
  const bodies = [];
  const fetchImpl = async (_u, o) => {
    const b = JSON.parse(o.body); bodies.push(b);
    if (b.reasoning_effort) return { ok: false, status: 400, text: async () => "unknown parameter reasoning_effort" };
    return resp({ choices: [{ message: { content: "{\"ok\":1}" }, finish_reason: "stop" }] });
  };
  const r = await chatComplete({ ...base, model: "glm-5.3-flash", fetchImpl });
  assert.equal(r.content, "{\"ok\":1}");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].reasoning_effort, undefined);
});
