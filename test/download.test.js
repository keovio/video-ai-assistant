"use strict";
// 下载器：多源回退、sha256 校验、超时、不留半截文件
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const dl = require("../lib/download");
const { tmp, sha, fakeFetch } = require("./helpers");

test("downloadFile 依次换源并校验 sha256", async () => {
  const d = tmp();
  const data = Buffer.from("hello asar");
  const f = fakeFetch({ "https://a/x": { status: 503 }, "https://b/x": { body: Buffer.from("tampered!!") }, "https://c/x": { body: data } });
  const progress = [];
  const r = await dl.downloadFile(f, fs, ["https://a/x", "https://b/x", "https://c/x"], path.join(d, "out.asar"), { sha256: sha(data), size: data.length, onProgress: (p) => progress.push(p.pct) });
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://c/x");
  assert.equal(fs.readFileSync(path.join(d, "out.asar"), "utf8"), "hello asar");
  assert.equal(progress.at(-1), 100);
  assert.ok(!fs.existsSync(path.join(d, "out.asar.download")));
});

test("downloadFile 全部失败时汇总原因，不留半截文件", async () => {
  const d = tmp();
  const f = fakeFetch({ "https://a/x": { hang: true }, "https://b/x": { body: "nope" } });
  const r = await dl.downloadFile(f, fs, ["https://a/x", "https://b/x"], path.join(d, "o"), { sha256: "0".repeat(64), opts: { firstByteTimeoutMs: 50 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /连接超时/);
  assert.match(r.error, /sha256/);
  assert.deepEqual(fs.readdirSync(d), []);
});

test("downloadFile 大小不符视为失败", async () => {
  const d = tmp();
  const f = fakeFetch({ "https://a/x": { body: "12345" } });
  const r = await dl.downloadFile(f, fs, ["https://a/x"], path.join(d, "o"), { size: 6 });
  assert.equal(r.ok, false);
  assert.match(r.error, /大小不符/);
});

test("fetchJson 换源与超时", async () => {
  const f = fakeFetch({ "https://a/j": { hang: true }, "https://b/j": { body: { ok: 1 } } });
  const r = await dl.fetchJson(f, ["https://a/j", "https://b/j"], { timeoutMs: 50 });
  assert.equal(r.url, "https://b/j");
  assert.deepEqual(r.data, { ok: 1 });
  await assert.rejects(dl.fetchJson(f, ["https://a/j"], { timeoutMs: 30 }), /超时/);
  await assert.rejects(dl.fetchJson(f, []), /没有可用/);
});
