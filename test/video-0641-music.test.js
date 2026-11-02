"use strict";
const test = require("node:test");
const assert = require("node:assert");
const m = require("../lib/video/music");
const { buildAnalysisPrompt } = require("../lib/video/ai");

function track(bpm, dur) {
  const x = new Float32Array(m.SR * dur);
  for (let t = 0.1; t < dur; t += 60 / bpm) { const s = Math.round(t * m.SR); for (let i = 0; i < 300 && s + i < x.length; i++) x[s + i] += 0.8 * Math.exp(-i / 60) * Math.sin(i * 0.9); }
  return x;
}

test("音乐：能测出节拍 BPM", () => {
  for (const b of [80, 100, 128, 150]) {
    const r = m.analyzeSamples(track(b, 20));
    assert.ok(Math.abs(r.tempo.bpm - b) <= 3, `${b} 测成 ${r.tempo.bpm}`);
  }
});

test("音乐：静音识别为没有声音", () => {
  const r = m.analyzeSamples(new Float32Array(m.SR * 5));
  assert.strictEqual(r.silent, true);
  assert.match(m.describeMusic(r), /几乎没有声音/);
});

test("音乐：卡点统计和描述进提示词", () => {
  const r = m.analyzeSamples(track(120, 20));
  const b = r.tempo.beats;
  const text = m.describeMusic(r, { scenes: [b[4], b[8], b[12]], musicName: "测试曲" });
  assert.match(text, /BPM/);
  assert.match(text, /3 处换镜中有 3 处落在节拍上/);
  assert.match(buildAnalysisPrompt({ musicNotes: text }), /测试曲/);
});

test("0.6.43：skill 带通用风格提示词并写进 SKILL.md", () => {
  const { validateAnalysis, buildSkillText } = require("../lib/video/ai");
  const a = validateAnalysis({ style: { visual: "v" }, skill: { name: "a", description: "d", prompt: "手持环绕推镜，暖光", body: "b" },
    script: { title: "t", hasSpeech: false, shots: [{ visual: "x", imagePrompt: "y", seconds: 3 }] } });
  assert.strictEqual(a.skill.prompt, "手持环绕推镜，暖光");
  assert.match(buildSkillText(a), /风格提示词[\s\S]*手持环绕推镜/);
});
