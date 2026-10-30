"use strict";
// 日志：内存里保留最近 N 条（给日志页用），同时按天写到 <数据目录>/logs/app-YYYY-MM-DD.log，旧文件保留 keepDays 天（纯 Node，可单测）。
const fs = require("fs");
const path = require("path");
const util = require("util");

const LEVELS = ["debug", "info", "warn", "error"];
const rank = (l) => Math.max(0, LEVELS.indexOf(l));
const pad = (n, w = 2) => String(n).padStart(w, "0");
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

function fmtArgs(args) {
  return args.map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack || a.message) : util.inspect(a, { depth: 4, breakLength: 120 }))).join(" ");
}

function formatLine(e) {
  const d = new Date(e.time);
  return `${day(d)} ${clock(d)} [${e.level.toUpperCase()}]${e.scope ? ` [${e.scope}]` : ""} ${e.message}`;
}

function createLogger({ dir = "", maxEntries = 2000, keepDays = 7, level = "info", echo = false, now = Date.now, fsImpl = fs } = {}) {
  let minLevel = LEVELS.includes(level) ? level : "info";
  let buf = [];
  let seq = 0;
  const listeners = new Set();
  let writeFailed = false;

  const fileFor = (t) => path.join(dir, `app-${day(new Date(t))}.log`);

  function write(e) {
    if (!dir || writeFailed) return;
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      fsImpl.appendFileSync(fileFor(e.time), formatLine(e) + "\n", "utf8");
    } catch { writeFailed = true; } // 磁盘满 / 没权限：不影响应用，只停写文件
  }

  function log(lvl, scope, ...args) {
    if (!LEVELS.includes(lvl)) lvl = "info";
    if (rank(lvl) < rank(minLevel)) return null;
    const e = { id: ++seq, time: now(), level: lvl, scope: scope || "", message: fmtArgs(args) };
    buf.push(e);
    if (buf.length > maxEntries) buf = buf.slice(buf.length - maxEntries);
    write(e);
    if (echo) (lvl === "error" ? console.error : lvl === "warn" ? console.warn : console.log)(formatLine(e));
    for (const cb of listeners) { try { cb(e); } catch { /* ignore */ } }
    return e;
  }

  // filter: { level: 最低级别, q: 关键字, scope, limit, afterId }
  function entries({ level: lv, q, scope, limit = 500, afterId = 0 } = {}) {
    const needle = q ? String(q).toLowerCase() : "";
    const out = buf.filter((e) => e.id > afterId
      && (!lv || rank(e.level) >= rank(lv))
      && (!scope || e.scope === scope)
      && (!needle || e.message.toLowerCase().includes(needle) || e.scope.toLowerCase().includes(needle)));
    return out.slice(-limit);
  }

  // 删掉超过 keepDays 天的日志文件
  function prune() {
    if (!dir) return 0;
    let n = 0;
    try {
      const cutoff = day(new Date(now() - keepDays * 86400000));
      for (const f of fsImpl.readdirSync(dir)) {
        const m = /^app-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
        if (m && m[1] < cutoff) { fsImpl.rmSync(path.join(dir, f), { force: true }); n++; }
      }
    } catch { /* 目录还不存在 */ }
    return n;
  }

  const api = {
    LEVELS, dir,
    log,
    debug: (...a) => log("debug", "", ...a),
    info: (...a) => log("info", "", ...a),
    warn: (...a) => log("warn", "", ...a),
    error: (...a) => log("error", "", ...a),
    // 带模块名的子 logger：const log = logger.scope("updater"); log.info("…")
    scope: (name) => ({
      debug: (...a) => log("debug", name, ...a), info: (...a) => log("info", name, ...a),
      warn: (...a) => log("warn", name, ...a), error: (...a) => log("error", name, ...a),
    }),
    entries,
    clear: () => { buf = []; },
    setLevel: (l) => { if (LEVELS.includes(l)) minLevel = l; },
    getLevel: () => minLevel,
    onEntry: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    currentFile: () => (dir ? fileFor(now()) : ""),
    prune,
    formatLine,
  };
  return api;
}

module.exports = { LEVELS, createLogger, formatLine };
