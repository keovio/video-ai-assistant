"use strict";
// 测试公用：临时目录、sha256、假 fetch
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "eat-test-"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// routes: { url: { body } | { status } | { hang: true } }
function fakeFetch(routes, calls = []) {
  return async (url, opts = {}) => {
    calls.push(url);
    const r = routes[url];
    if (!r) throw new Error("ENOTFOUND " + url);
    if (r.hang) return new Promise((_res, rej) => opts.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; rej(e); }));
    if (r.status && r.status !== 200) return { ok: false, status: r.status, headers: new Map(), json: async () => ({}) };
    const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    let sent = false;
    return {
      ok: true, status: 200,
      headers: { get: (k) => (k === "content-length" ? String(body.length) : null) },
      json: async () => JSON.parse(body.toString()),
      body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(body) })), cancel: async () => {} }) },
    };
  };
}

module.exports = { tmp, sha, fakeFetch };
