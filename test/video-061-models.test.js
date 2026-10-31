"use strict";
// 0.6.1：模型列表、音色列表、本地 TTS（Key 可空）
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { listModels } = require("../lib/video/ai");
const { listVoices, synthesize } = require("../lib/video/tts");

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), arrayBuffer: async () => Buffer.from(String(body)) });

test("listModels 解析 OpenAI 格式、去重排序，并带 Key", async () => {
  let seen;
  const ids = await listModels({ baseUrl: "https://x.test/v1/", apiKey: "k", fetchImpl: async (url, o) => { seen = { url, o }; return res(200, { data: [{ id: "b" }, { id: "a" }, { id: "b" }] }); } });
  assert.deepEqual(ids, ["a", "b"]);
  assert.equal(seen.url, "https://x.test/v1/models");
  assert.equal(seen.o.headers.Authorization, "Bearer k");
});

test("listModels：没 Key 报错，本地可空 Key；404 提示手填", async () => {
  await assert.rejects(listModels({ baseUrl: "https://x.test/v1", fetchImpl: async () => res(200, []) }), /Key/);
  const ids = await listModels({ baseUrl: "http://127.0.0.1:8880/v1", keyOptional: true, fetchImpl: async (u, o) => { assert.equal(o.headers.Authorization, undefined); return res(200, ["kokoro"]); } });
  assert.deepEqual(ids, ["kokoro"]);
  await assert.rejects(listModels({ baseUrl: "https://x.test/v1", apiKey: "k", fetchImpl: async () => res(404, "nope") }), /手动填写/);
});

test("listVoices 依次尝试 /audio/voices 与 /voices，拿不到返回空", async () => {
  const urls = [];
  const v = await listVoices({ baseUrl: "http://l/v1", fetchImpl: async (u) => { urls.push(u); return u.endsWith("/audio/voices") ? res(404, "") : res(200, { voices: ["zf_xiaobei", "af_bella"] }); } });
  assert.deepEqual(v, ["af_bella", "zf_xiaobei"]);
  assert.deepEqual(urls, ["http://l/v1/audio/voices", "http://l/v1/voices"]);
  assert.deepEqual(await listVoices({ baseUrl: "http://l/v1", fetchImpl: async () => { throw new Error("down"); } }), []);
});

test("本地 TTS 不需要 Key，不带 Authorization；连不上时提示检查服务", async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tts-")), "a.mp3");
  let seen;
  const r = await synthesize({ provider: "local", text: "你好", voice: "zf_xiaobei", model: "kokoro", outFile: out, baseUrl: "http://127.0.0.1:8880/v1",
    probeFn: () => 1.2, fetchImpl: async (u, o) => { seen = { u, o }; return res(200, "AUDIO"); } });
  assert.equal(seen.u, "http://127.0.0.1:8880/v1/audio/speech");
  assert.equal(seen.o.headers.Authorization, undefined);
  assert.equal(JSON.parse(seen.o.body).model, "kokoro");
  assert.ok(fs.existsSync(r.file));
  await assert.rejects(synthesize({ provider: "local", text: "你好", outFile: out, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }), /本地 TTS 服务/);
  await assert.rejects(synthesize({ provider: "openai", text: "你好", outFile: out, baseUrl: "https://x", fetchImpl: async () => res(200, "A") }), /TTS Key/);
});
