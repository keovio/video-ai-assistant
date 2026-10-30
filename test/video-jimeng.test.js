"use strict";
// M3 即梦：选择器图谱、提示词拼接、下载处理、自动操作 runner（假 driver，
// 不碰真实网络与真实即梦页面）。本文件不证明真机自动化成功，只证明模块逻辑与失败兜底。
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SELECTORS, JimengError, buildVideoPrompt,
  attachDownloadHandler, waitForDownloadItem, runJimengShot, VOICE_AUTOMATION_SUPPORTED,
} = require("../lib/video/jimeng");

test("选择器图谱：关键键齐全且标注未验证；提示词含画面、运镜、风格、画幅", () => {
  for (const key of ["promptInput", "generateButtonText", "generatingIndicator", "resultVideo"]) {
    assert.ok(SELECTORS[key], `缺少选择器 ${key}`);
  }
  const prompt = buildVideoPrompt(
    { visual: "雨夜街道，路灯", imagePrompt: "" },
    { aspect: "9:16" },
  );
  assert.match(prompt, /雨夜街道/);
  assert.match(prompt, /运镜/);
  assert.match(prompt, /9:16/);
  const fromImagePrompt = buildVideoPrompt({ visual: "旧描述", imagePrompt: "新提示词" }, {});
  assert.match(fromImagePrompt, /新提示词/);
  assert.equal(VOICE_AUTOMATION_SUPPORTED, false);
});

test("下载处理：will-download 接到保存路径；完成/中断分别 resolve/reject", async () => {
  let listener = null;
  const session = { on: (ev, fn) => { if (ev === "will-download") listener = fn; } };
  let savePath = "";
  attachDownloadHandler(session, () => savePath);
  assert.equal(typeof listener, "function");
  savePath = "/tmp/clip.mp4";
  let saved = "";
  listener(null, { setSavePath: (p) => { saved = p; } });
  assert.equal(saved, "/tmp/clip.mp4");
  assert.throws(() => attachDownloadHandler(null, () => ""), /下载会话未接通/);

  const okItem = { on: (ev, fn) => { if (ev === "done") setTimeout(() => fn(null, "completed"), 0); } };
  await waitForDownloadItem(okItem);
  const badItem = { on: (ev, fn) => { if (ev === "done") setTimeout(() => fn(null, "cancelled"), 0); } };
  await assert.rejects(waitForDownloadItem(badItem), (e) => e instanceof JimengError && e.manualFallback === true);
});

function fakeDriver({ fill = true, click = true, pollResults = [false, true] } = {}) {
  let polls = 0;
  return {
    calls: [],
    async executeJavaScript(js) {
      this.calls.push(js);
      if (js.includes("el.focus")) return fill;
      if (js.includes("b.click")) return click;
      if (js.includes("busy")) return pollResults[Math.min(polls++, pollResults.length - 1)];
      return null;
    },
  };
}

test("自动操作 runner：填词->点生成->轮询完成，全程假 driver", async () => {
  const driver = fakeDriver();
  const r = await runJimengShot({ driver, prompt: "雨夜街道", pollMs: 1 });
  assert.equal(r.completed, true);
  assert.equal(r.manualFallback, false);
  assert.ok(driver.calls.some((c) => c.includes("雨夜街道")));
});

test("自动操作 runner：找不到输入框/生成按钮时明确失败且转手动，不谎称成功", async () => {
  await assert.rejects(
    runJimengShot({ driver: fakeDriver({ fill: false }), prompt: "x", pollMs: 1 }),
    (e) => e instanceof JimengError && e.code === "SELECTOR_NOT_FOUND" && e.manualFallback === true && /手动/.test(e.message),
  );
  await assert.rejects(
    runJimengShot({ driver: fakeDriver({ click: false }), prompt: "x", pollMs: 1 }),
    (e) => e.code === "SELECTOR_NOT_FOUND" && e.manualFallback === true,
  );
  await assert.rejects(
    runJimengShot({ driver: fakeDriver({ pollResults: [false] }), prompt: "x", timeoutMs: 30, pollMs: 5 }),
    (e) => e.code === "GENERATE_TIMEOUT" && e.manualFallback === true,
  );
  await assert.rejects(
    runJimengShot({ driver: null, prompt: "x" }),
    (e) => e.code === "NO_WINDOW" && e.manualFallback === true,
  );
});
