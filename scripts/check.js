#!/usr/bin/env node
"use strict";
// 语法检查：对项目里所有 .js 跑 node --check，并校验 app.config.json。跨平台（不依赖 shell 通配符）。
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { loadConfig, validateConfig } = require("../lib/config");

const ROOT = path.resolve(__dirname, "..");
const SKIP = new Set(["node_modules", "release", "layer", ".git", "dist"]);
const found = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) found.push(p);
  }
})(ROOT);

let bad = 0;
for (const f of found.sort()) {
  try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); }
  catch (err) { bad++; console.error(`✗ ${path.relative(ROOT, f)}\n${err.stderr || err.message}`); }
}
const errs = validateConfig(loadConfig(ROOT));
for (const e of errs) console.error("✗ app.config.json：" + e);
if (bad || errs.length) process.exit(1);
console.log(`✓ ${found.length} 个 JS 文件语法正确，app.config.json 有效`);
