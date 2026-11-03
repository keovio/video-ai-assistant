"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { refineFields, buildRefinePrompt } = require("../lib/video/ai");

const fakeFetch = (reply) => async (url, init) => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ choices: [{ message: { content: typeof reply === "function" ? reply(JSON.parse(init.body)) : reply } }] }),
  json: async () => ({ choices: [{ message: { content: typeof reply === "function" ? reply(JSON.parse(init.body)) : reply } }] }),
});

test("refine 提示词带全部字段和联动规则", () => {
  const m = buildRefinePrompt({ instruction: "改成雨天", fields: [{ key: "visual", label: "画面描述", text: "晴天街道" }, { key: "imagePrompt", label: "画面提示词", text: "" }] });
  assert.match(m[0].content, /同步改/);
  assert.match(m[1].content, /【visual】画面描述\n晴天街道/);
  assert.match(m[1].content, /【imagePrompt】画面提示词\n（空）/);
});

test("refine 只报告真正改了的字段，缺的 key 保留原文", async () => {
  const r = await refineFields({
    apiKey: "k", baseUrl: "https://x.test/v1", model: "m", instruction: "改成雨天",
    fields: [{ key: "a", label: "口播", text: "你好" }, { key: "b", label: "画面", text: "晴天" }, { key: "c", label: "提示词", text: "阳光" }],
    fetchImpl: fakeFetch('{"fields":{"a":"你好","b":"雨天"},"note":"换成雨天"}'),
  });
  assert.deepStrictEqual(r.changed, ["b"]);
  assert.strictEqual(r.fields.c, "阳光");
  assert.strictEqual(r.note, "换成雨天");
});

test("refine 没写要求时报错", async () => {
  await assert.rejects(refineFields({ apiKey: "k", fields: [{ key: "a", text: "x" }], instruction: " " }), /怎么改/);
});
