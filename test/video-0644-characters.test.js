"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"); const os = require("os"); const path = require("path");
const { createCharacterStore, sheetPrompt, framePrompt } = require("../lib/video/characters");
const seedream = require("../lib/video/seedream");

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

test("Seedream：请求体和返回解析", async () => {
  let sent = null;
  const fetchImpl = async (url, init) => { sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: Buffer.from("img").toString("base64") }] }) }; };
  const out = await seedream.generateImage({ fetchImpl, apiKey: "k", prompt: "p", images: ["data:image/jpeg;base64,AAAA", "data:image/png;base64,BBBB"], size: seedream.sizeFor("9:16") });
  assert.strictEqual(out[0].toString(), "img");
  assert.match(sent.url, /ark\.cn-beijing\.volces\.com\/api\/v3\/images\/generations$/);
  assert.strictEqual(sent.body.image.length, 2);
  assert.strictEqual(sent.body.size, "1440x2560");
  assert.strictEqual(sent.body.response_format, "b64_json");
  assert.strictEqual(sent.auth, "Bearer k");
  await assert.rejects(seedream.generateImage({ fetchImpl, apiKey: "", prompt: "p" }), /API Key/);
});
