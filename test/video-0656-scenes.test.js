"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCharacterStore, scenePrompt, framePrompt } = require("../lib/video/characters");

test("场景和角色同库，按 type 分开列", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scn-"));
  const st = createCharacterStore({ dir });
  const a = st.save({ name: "小鹿", anchor: "女生" });
  const s = st.save({ type: "scene", name: "雨夜街角", anchor: "老街便利店门口" });
  assert.strictEqual(a.type, "character");
  assert.strictEqual(s.type, "scene");
  assert.deepStrictEqual(st.list("scene").map((x) => x.id), [s.id]);
  assert.deepStrictEqual(st.list("character").map((x) => x.id), [a.id]);
  // 再保存不会把场景变回角色
  assert.strictEqual(st.save({ id: s.id, name: "改名" }).type, "scene");
  const f = st.addImage(s.id, Buffer.from([1, 2, 3]), { kind: "wide" });
  assert.strictEqual(st.get(s.id).cover, f);
  assert.strictEqual(st.referenceFiles(s.id).length, 1);
});

test("场景提示词不出现人物；首帧可同时带人物和场景", () => {
  const scene = { anchor: "老街便利店门口", outfit: "夜晚霓虹" };
  assert.match(scenePrompt(scene, { kind: "wide", refs: 1 }), /场景全景[\s\S]*同一个地方[\s\S]*不要出现任何人物/);
  assert.match(scenePrompt(scene, { kind: "angle" }), /多角度/);
  const p = framePrompt({ anchor: "鹅蛋脸", outfit: "白T" }, "她回头", { refs: 2, scene, sceneRefs: 1 });
  assert.match(p, /前几张参考图[\s\S]*后几张参考图[\s\S]*鹅蛋脸[\s\S]*老街便利店门口/);
});
