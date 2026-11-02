"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { analyzeVideo } = require("../lib/video/ai");

const reply = { style: { visual: "暖色写实" }, skill: { name: "x", description: "d", body: "b" },
  script: { title: "t", hasSpeech: false, narration: "", shots: [{ visual: "猫", imagePrompt: "一只猫", seconds: 5 }] } };

test("0.6.31 原视频以 video_url 放在第一位发给模型", async () => {
  let sent = null;
  const fetchImpl = async (_u, o) => { sent = JSON.parse(o.body); return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }) }; };
  const r = await analyzeVideo({ fetchImpl, apiKey: "k", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.3-flash",
    videoDataUrl: "data:video/mp4;base64,AAAA", images: ["data:image/jpeg;base64,AAAA"] });
  assert.equal(r.usedVideo, true);
  const content = sent.messages[1].content;
  assert.equal(content[0].type, "video_url");
  assert.ok(!content.some((c) => c.type === "image_url"), "视频和图片不能同时发");
});
