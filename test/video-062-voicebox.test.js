"use strict";
// 0.6.2：Voicebox（本机声音克隆）配音
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { synthesize, voiceboxProfiles, listProviders } = require("../lib/video/tts");

const res = (status, body) => ({ ok: status >= 200 && status < 300, status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(String(body))) });
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40)]);
const tmpOut = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vb-")), "a.mp3");

test("服务商列表里有 voicebox", () => {
  assert.ok(listProviders().some((p) => p.id === "voicebox" && p.automated));
});

test("voiceboxProfiles 读 /profiles，地址去掉 /v1 和末尾斜杠", async () => {
  let url;
  const ps = await voiceboxProfiles({ baseUrl: "http://127.0.0.1:17493/v1/", fetchImpl: async (u) => { url = u; return res(200, [{ id: "p1", name: "我的声音", language: "zh" }, { bad: 1 }]); } });
  assert.equal(url, "http://127.0.0.1:17493/profiles");
  assert.deepEqual(ps, [{ id: "p1", name: "我的声音", language: "zh" }]);
});

test("按档案名生成：异步排队后轮询 history，下载 wav 并改扩展名", async () => {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (u, o = {}) => {
    calls.push([o.method, u, o.body && JSON.parse(o.body)]);
    if (u.endsWith("/profiles")) return res(200, [{ id: "p1", name: "My Voice" }]);
    if (u.endsWith("/generate")) return res(200, { id: "g1", status: "generating" });
    if (u.includes("/history/g1")) { polls++; return res(200, { id: "g1", status: polls < 2 ? "generating" : "completed" }); }
    if (u.endsWith("/audio/g1")) return res(200, WAV);
    return res(404, "?");
  };
  const out = tmpOut();
  const r = await synthesize({ provider: "voicebox", text: "你好", voice: "my voice", model: "qwen", modelSize: "0.6B", language: "zh",
    outFile: out, baseUrl: "http://127.0.0.1:17493", fetchImpl, pollMs: 0, probeFn: () => 2 });
  assert.equal(r.ext, ".wav");
  assert.ok(r.file.endsWith("a.wav"));
  assert.equal(r.seconds, 2);
  assert.deepEqual(calls[1][2], { profile_id: "p1", text: "你好", language: "zh", engine: "qwen", model_size: "0.6B" });
  assert.equal(polls, 2);
});

test("旧版同步返回 completed 时不轮询；没有档案时提示先克隆", async () => {
  const urls = [];
  const fetchImpl = async (u) => {
    urls.push(u);
    if (u.endsWith("/profiles")) return res(200, [{ id: "p1", name: "A" }]);
    if (u.endsWith("/generate")) return res(200, { id: "g1", status: "completed" });
    return res(200, WAV);
  };
  await synthesize({ provider: "voicebox", text: "hi", voice: "p1", outFile: tmpOut(), fetchImpl, probeFn: () => 1 });
  assert.ok(!urls.some((u) => u.includes("/history/")));
  await assert.rejects(synthesize({ provider: "voicebox", text: "hi", voice: "x", outFile: tmpOut(), fetchImpl: async () => res(200, []) }), /先在 Voicebox 里克隆/);
});

test("生成失败、连不上、未选档案都给出明确错误", async () => {
  const failing = async (u) => u.endsWith("/profiles") ? res(200, [{ id: "p1", name: "A" }]) : res(200, { id: "g1", status: "failed", error: "OOM" });
  await assert.rejects(synthesize({ provider: "voicebox", text: "hi", voice: "A", outFile: tmpOut(), fetchImpl: failing }), /生成失败：OOM/);
  await assert.rejects(synthesize({ provider: "voicebox", text: "hi", voice: "A", outFile: tmpOut(), fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }), /打开 Voicebox/);
  await assert.rejects(synthesize({ provider: "voicebox", text: "hi", voice: "", outFile: tmpOut(), fetchImpl: async () => res(200, []) }), /声音档案/);
});
