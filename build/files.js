"use strict";
// 打进 app.asar 的文件清单：electron-builder 配置和 build-layer.js 共用这一份，保证安装包和增量包内容一致。
// 新增顶层目录/文件时只改这里。
const DIRS = ["boot", "lib", "renderer"];
const FILES = ["main.js", "preload.js", "app.config.json"];
// 不打包的文件（相对路径，正斜杠）
const EXCLUDE = [/(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /(^|\/)node_modules(\/|$)/, /\.map$/];

module.exports = { DIRS, FILES, EXCLUDE };
