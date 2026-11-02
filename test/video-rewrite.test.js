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

test("TikTok 链接识别与解析", () => {
  const { siteOf, parseExtracted } = require("../lib/video/douyin");
  assert.strictEqual(siteOf("https://www.tiktok.com/@a/video/7400000000000000001"), "tiktok");
  const info = parseExtracted({ site: "tiktok", url: "https://www.tiktok.com/@a/video/7400000000000000001", caption: "hi", likeCountText: "12" });
  assert.strictEqual(info.site, "tiktok");
  assert.strictEqual(info.videoId, "7400000000000000001");
});

test("0.6.28：截图没有明显切换时多镜合并成 1 镜", () => {
  const { enforceShotCount } = require("../lib/video/ai");
  const r = { script: { shots: [{ narration: "你", visual: "a", imagePrompt: "p1", seconds: 5 }, { narration: "好", visual: "b", imagePrompt: "p2", seconds: 10 }] } };
  const m = enforceShotCount(r, { frameDiffs: [0.05, 0.12, 0.2] });
  assert.strictEqual(m.script.shots.length, 1);
  assert.strictEqual(m.script.shots[0].seconds, 15);
  assert.strictEqual(m.script.shots[0].narration, "你好");
  assert.strictEqual(enforceShotCount(r, { frameDiffs: [0.05, 0.5] }).script.shots.length, 2);
});
