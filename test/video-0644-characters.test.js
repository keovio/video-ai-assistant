"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"); const os = require("os"); const path = require("path");
const { createCharacterStore, sheetPrompt, framePrompt } = require("../lib/video/characters");
const imageGen = require("../lib/video/image-gen");

test("角色库：保存、加图、参考图顺序、删除", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chars-"));
  const s = createCharacterStore({ dir });
  const c = s.save({ name: "小鹿", anchor: "20岁女生，鹅蛋脸", outfit: "白红古风" });
  assert.ok(c.id);
  s.addImage(c.id, Buffer.from("x"), { kind: "other", ext: "png" });
  const face = s.addImage(c.id, Buffer.from("y"), { kind: "face", ext: "jpg" });
  s.addImage(c.id, Buffer.from("z"), { kind: "frame", ext: "jpg" });
  const got = s.get(c.id);
  assert.strictEqual(got.images.length, 3);
  assert.strictEqual(got.cover, face, "面部特写优先做封面");
  const refs = s.referenceFiles(c.id);
  assert.strictEqual(refs.length, 2, "首帧图不当参考图");
  assert.ok(refs[0].endsWith(face));
  s.save({ id: c.id, name: "小鹿2" });
  assert.strictEqual(s.get(c.id).images.length, 3, "改名不丢图片");
  assert.strictEqual(s.list().length, 1);
  assert.ok(s.remove(c.id));
  assert.strictEqual(s.list().length, 0);
});

test("角色提示词：带锚点、去掉镜头里的风格尾巴", () => {
  const c = { anchor: "鹅蛋脸", outfit: "白裙" };
  assert.match(sheetPrompt(c, { refs: 2 }), /三视图[\s\S]*参考图中的同一个人[\s\S]*鹅蛋脸/);
  const p = framePrompt(c, "她转头看镜头\n风格：暖光", { refs: 1, aspect: "16:9", style: "手持" });
  assert.match(p, /16:9/); assert.match(p, /她转头看镜头/); assert.match(p, /风格：手持/); assert.doesNotMatch(p, /暖光/);
});

const fakeFetch = (log, reply) => async (url, init = {}) => {
  log.push({ url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
  if (/\.png$|cdn/.test(url)) return { ok: true, status: 200, arrayBuffer: async () => Buffer.from("dl") };
  return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
};
const b64 = { data: [{ b64_json: Buffer.from("img").toString("base64") }] };
const refs = ["data:image/jpeg;base64,AAAA", "data:image/png;base64,BBBB"];

test("生图：火山方舟 JSON 带参考图", async () => {
  const log = [];
  const out = await imageGen.generateImage({ fetchImpl: fakeFetch(log, b64), provider: "ark", apiKey: "k", prompt: "p", images: refs, size: imageGen.sizeFor("9:16", { provider: "ark" }) });
  assert.strictEqual(out.images[0].toString(), "img");
  assert.strictEqual(out.refsUsed, 2);
  assert.match(log[0].url, /ark\.cn-beijing\.volces\.com\/api\/v3\/images\/generations$/);
  assert.strictEqual(log[0].body.image.length, 2);
  assert.strictEqual(log[0].body.size, "1440x2560");
  assert.strictEqual(log[0].init.headers.Authorization, "Bearer k");
  await assert.rejects(imageGen.generateImage({ fetchImpl: fakeFetch([], b64), apiKey: "", prompt: "p" }), /API Key/);
});

test("生图：智谱只文生图，返回 url 再下载", async () => {
  const log = [];
  const out = await imageGen.generateImage({ fetchImpl: fakeFetch(log, { data: [{ url: "https://cdn.x/a.png" }] }), provider: "zhipu", apiKey: "k", prompt: "p", images: refs, size: imageGen.sizeFor("16:9", { provider: "zhipu", model: "glm-image" }) });
  assert.strictEqual(out.images[0].toString(), "dl");
  assert.strictEqual(out.refsIgnored, true);
  assert.match(log[0].url, /open\.bigmodel\.cn\/api\/paas\/v4\/images\/generations$/);
  assert.strictEqual(log[0].body.model, "glm-image");
  assert.strictEqual(log[0].body.size, "1728x960");
  assert.strictEqual(imageGen.sizeFor("9:16", { provider: "zhipu", model: "cogview-4" }), "768x1344");
  assert.strictEqual(log[0].body.image, undefined);
});

test("生图：OpenAI gpt-image 有参考图走 edits，dall-e-3 只文生图", async () => {
  const log = [];
  await imageGen.generateImage({ fetchImpl: fakeFetch(log, b64), provider: "openai", model: "gpt-image-1", apiKey: "k", prompt: "p", images: refs, size: "1024x1536" });
  assert.match(log[0].url, /api\.openai\.com\/v1\/images\/edits$/);
  assert.ok(log[0].init.body instanceof FormData);
  assert.strictEqual(log[0].init.body.getAll("image[]").length, 2);
  const log2 = [];
  const out = await imageGen.generateImage({ fetchImpl: fakeFetch(log2, b64), provider: "openai", model: "dall-e-3", apiKey: "k", prompt: "p", images: refs });
  assert.match(log2[0].url, /images\/generations$/);
  assert.strictEqual(log2[0].body.response_format, "b64_json");
  assert.strictEqual(log2[0].body.size, "1024x1024");
  assert.strictEqual(out.refsIgnored, true);
  assert.strictEqual(imageGen.sizeFor("9:16", { provider: "openai", model: "dall-e-3" }), "1024x1792");
  assert.strictEqual(imageGen.sizeFor("", { provider: "openai", kind: "sheet" }), "1536x1024");
});

test("生图：其他服务商必须填地址", async () => {
  await assert.rejects(imageGen.generateImage({ fetchImpl: fakeFetch([], b64), provider: "custom", apiKey: "k", prompt: "p", model: "x" }), /接口地址/);
  const log = [];
  await imageGen.generateImage({ fetchImpl: fakeFetch(log, b64), provider: "custom", baseUrl: "https://relay.example.com/v1/", apiKey: "k", prompt: "p", model: "nano-banana", images: refs.slice(0, 1) });
  assert.strictEqual(log[0].url, "https://relay.example.com/v1/images/generations");
  assert.strictEqual(log[0].body.image, refs[0]);
});
