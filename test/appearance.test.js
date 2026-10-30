"use strict";
// 自定义背景图
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { checkImageFile, createBackgroundStore, MAX_BYTES } = require("../lib/appearance");
const { tmp } = require("./helpers");

test("checkImageFile：类型、存在、大小", () => {
  const d = tmp();
  const png = path.join(d, "a.png"); fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const txt = path.join(d, "a.txt"); fs.writeFileSync(txt, "x");
  const empty = path.join(d, "e.jpg"); fs.writeFileSync(empty, "");
  assert.equal(checkImageFile(png).ok, true);
  assert.equal(checkImageFile(png).mime, "image/png");
  assert.equal(checkImageFile(txt).ok, false);
  assert.equal(checkImageFile(path.join(d, "nope.png")).ok, false);
  assert.equal(checkImageFile(empty).ok, false);
  const big = path.join(d, "big.webp");
  fs.writeFileSync(big, ""); fs.truncateSync(big, MAX_BYTES + 1);
  assert.match(checkImageFile(big).error, /太大/);
});

test("背景存储：保存替换旧图、data URL、清除", () => {
  const d = tmp();
  const store = createBackgroundStore({ dir: path.join(d, "appearance") });
  assert.equal(store.dataUrl(), "");
  const a = path.join(d, "a.png"); fs.writeFileSync(a, "PNGDATA");
  const b = path.join(d, "b.jpg"); fs.writeFileSync(b, "JPGDATA");
  assert.equal(store.save(a).ok, true);
  assert.equal(store.dataUrl(), "data:image/png;base64," + Buffer.from("PNGDATA").toString("base64"));
  assert.equal(store.save(b).ok, true);
  assert.equal(store.dataUrl(), "data:image/jpeg;base64," + Buffer.from("JPGDATA").toString("base64"));
  assert.deepEqual(fs.readdirSync(path.join(d, "appearance")), ["background.jpg"]); // 旧图删掉了
  store.clear();
  assert.equal(store.has(), false);
  assert.equal(store.save(path.join(d, "x.bmp")).ok, false);
});
