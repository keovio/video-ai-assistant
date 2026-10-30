"use strict";
// TTS Key 的主进程存储（纯 Node 逻辑，safeStorage 可注入，单测不用 Electron）。
// 优先用 Electron safeStorage 加密后存文件；没有可用钥匙串时退回 0600 权限文件，
// 并在 status 里明确标 insecureFallback，让界面和 README 如实提示，不假装已加密。
// Key 本身只在主进程用（TTS 请求在主进程发），绝不回传给页面；页面只拿到“已设置/末 4 位”。
const fs = require("fs");
const path = require("path");

function createSecretsStore({ file, safeStorage = null }) {
  const readAll = () => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
  };
  const writeAll = (data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
  };
  const encrypted = () => !!(safeStorage && typeof safeStorage.isEncryptionAvailable === "function"
    && safeStorage.isEncryptionAvailable() && typeof safeStorage.encryptString === "function");

  function set(key, value) {
    const data = readAll();
    if (!value) { delete data[key]; writeAll(data); return { set: false, last4: "" }; }
    if (encrypted()) {
      data[key] = { encrypted: safeStorage.encryptString(String(value)).toString("base64") };
    } else {
      data[key] = { plain: Buffer.from(String(value), "utf8").toString("base64"), insecureFallback: true };
    }
    writeAll(data);
    return status(key);
  }
  function get(key) {
    const entry = readAll()[key];
    if (!entry) return "";
    try {
      if (entry.encrypted && safeStorage && typeof safeStorage.decryptString === "function") {
        return safeStorage.decryptString(Buffer.from(entry.encrypted, "base64"));
      }
      if (entry.plain) return Buffer.from(entry.plain, "base64").toString("utf8");
    } catch { return ""; }
    return "";
  }
  function status(key) {
    const entry = readAll()[key];
    if (!entry) return { set: false, last4: "", insecureFallback: false };
    const value = get(key);
    return {
      set: !!value,
      last4: value ? value.slice(-4) : "",
      insecureFallback: !!entry.insecureFallback,
    };
  }
  return { set, get, status };
}

module.exports = { createSecretsStore };
