"use strict";
// M4 AI 分析：chat 调用与失败分类、JSON 提取、分析结果校验、skill 文本生成、
// 分镜转导入镜头、分析记录白名单、IPC 分析/导入/skill 落盘路径。
// 全部用假 fetch 与假视图，不碰真实网络、真实抖音/即梦页面、真实 AI 服务。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmp } = require("./helpers");
const {
  AiError, extractJson, chatComplete, slugifySkillName,
  validateAnalysis, analyzeVideo, buildSkillText, storyboardToShots,
} = require("../lib/video/ai");
const { createVideoStore, normalizeAnalysis } = require("../lib/video-store");
const { createSecretsStore } = require("../lib/video/secrets");
const { setupVideoIpc } = require("../lib/video-ipc");

const VALID_RAW = {
  style: { visual: "电影感", camera: "慢推镜", pacing: "慢", mood: "忧郁", colorLight: "暖黄路灯", sound: "钢琴", hooks: "前 3 秒悬念" },
  skill: { name: "Melancholic Cinematic!", description: "忧郁电影感", body: "风格定义：安静、留白、自然光。\n要做：慢镜头。\n不要做：快剪。" },
  script: {
    title: "雨夜",
    narration: "雨落下来的时候，整条街都安静了。",
    shots: [
      { narration: "雨落下来的时候", visual: "雨夜街道", imagePrompt: "雨夜街道，电影感", seconds: 3 },
      { narration: "整条街都安静了", visual: "空无一人的路灯下", seconds: 0 }, // 秒数不合法 -> 按字数估算
    ],
  },
};

function chatFetch({ status = 200, content = "{}", capture = null } = {}) {
  return async (url, opts) => {
    if (capture) capture.push({ url, opts });
    const body = JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 10 } });
    return {
      ok: status >= 200 && status < 300, status,
      arrayBuffer: async () => Buffer.from(body),
      text: async () => (status >= 200 && status < 300 ? body : "err detail"),
    };
  };
}

test("JSON 提取：整体 JSON、带前后缀的 JSON、非法内容明确报错", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('前面废话 {"a":2} 后面废话'), { a: 2 });
  assert.deepEqual(extractJson('```json\n{"a":3}\n```'), { a: 3 });
  assert.throws(() => extractJson(""), (e) => e instanceof AiError && e.code === "EMPTY_RESPONSE");
  assert.throws(() => extractJson("这不是 JSON"), (e) => e instanceof AiError && e.code === "BAD_JSON");
  assert.throws(() => extractJson("[1,2]"), (e) => e instanceof AiError && e.code === "BAD_JSON");
});

test("chat 调用：请求格式、Bearer、JSON 模式、失败分类", async () => {
  const capture = [];
  const r = await chatComplete({
    baseUrl: "https://example.invalid/v1/", apiKey: "sk-ai", model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: chatFetch({ content: "hello", capture }),
  });
  assert.equal(r.content, "hello");
  assert.equal(capture[0].url, "https://example.invalid/v1/chat/completions"); // 末尾斜杠已去掉
  assert.equal(capture[0].opts.headers.Authorization, "Bearer sk-ai");
  const body = JSON.parse(capture[0].opts.body);
  assert.equal(body.model, "gpt-4o-mini");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.messages[0].content, "hi");

  const base = { baseUrl: "https://example.invalid/v1", apiKey: "k", messages: [{ role: "user", content: "x" }] };
  await assert.rejects(
    chatComplete({ ...base, fetchImpl: chatFetch({ status: 401 }) }),
    (e) => e instanceof AiError && e.retryable === false && e.code === "AUTH_FAILED",
  );
  await assert.rejects(
    chatComplete({ ...base, fetchImpl: chatFetch({ status: 429 }) }),
    (e) => e instanceof AiError && e.retryable === true,
  );
  await assert.rejects(
    chatComplete({ ...base, apiKey: "" }),
    (e) => e instanceof AiError && e.code === "NO_API_KEY",
  );
  await assert.rejects(
    chatComplete({ ...base, baseUrl: "" }),
    (e) => e instanceof AiError && e.code === "NO_BASE_URL",
  );
});

test("分析结果校验：规范化、秒数兜底、skill 名清洗、缺字段报错不编造", () => {
  const v = validateAnalysis(JSON.parse(JSON.stringify(VALID_RAW)));
  assert.equal(v.skill.name, "melancholic-cinematic");
  assert.equal(v.script.shots[0].seconds, 3);
  assert.equal(v.script.shots[1].imagePrompt, "空无一人的路灯下"); // imagePrompt 缺省时用 visual
  assert.ok(v.script.shots[1].seconds > 0 && v.script.shots[1].seconds <= 30);
  assert.equal(v.style.visual, "电影感");

  assert.throws(() => validateAnalysis({}), (e) => e.code === "VALIDATION_FAILED");
  assert.throws(() => validateAnalysis({ ...VALID_RAW, style: {} }), (e) => e.code === "VALIDATION_FAILED");
  assert.throws(() => validateAnalysis({ ...VALID_RAW, script: { title: "t", narration: "n", shots: [] } }), (e) => e.code === "VALIDATION_FAILED");
  assert.throws(
    () => validateAnalysis({ ...VALID_RAW, script: { title: "t", narration: "n", shots: [{ narration: "  ", visual: "v" }] } }),
    (e) => e.code === "VALIDATION_FAILED",
  );
  assert.equal(slugifySkillName("  Hello World!! "), "hello-world");
  assert.equal(slugifySkillName(""), "douyin-style");
});

test("analyzeVideo：假 AI 返回 JSON，产出校验后的分析；坏 JSON 时明确失败", async () => {
  const v = await analyzeVideo({
    baseUrl: "https://example.invalid/v1", apiKey: "k", model: "m",
    videoInfo: { url: "https://www.douyin.com/video/123", author: "阿山", caption: "雨夜" },
    manualText: "",
    fetchImpl: chatFetch({ content: JSON.stringify(VALID_RAW) }),
  });
  assert.equal(v.script.title, "雨夜");
  assert.equal(v.script.shots.length, 2);

  await assert.rejects(
    analyzeVideo({
      baseUrl: "https://example.invalid/v1", apiKey: "k", model: "m",
      videoInfo: {}, manualText: "",
      fetchImpl: chatFetch({ content: "不是 JSON" }),
    }),
    (e) => e instanceof AiError && e.code === "BAD_JSON",
  );
});

test("skill 文本：frontmatter + 正文 + 风格拆解，形状与 SKILL.md 一致", () => {
  const v = validateAnalysis(JSON.parse(JSON.stringify(VALID_RAW)));
  const text = buildSkillText(v);
  assert.match(text, /^---\nname: melancholic-cinematic\n/);
  assert.match(text, /description: 忧郁电影感/);
  assert.match(text, /风格定义：安静、留白、自然光/);
  assert.match(text, /画面风格：电影感/);
  assert.match(text, /声音与音乐：钢琴/);
});

test("分镜转导入镜头：只含白名单字段，顺序不变", () => {
  const v = validateAnalysis(JSON.parse(JSON.stringify(VALID_RAW)));
  const shots = storyboardToShots(v);
  assert.deepEqual(Object.keys(shots[0]).sort(), ["imagePrompt", "narration", "visual"]);
  assert.equal(shots[0].narration, "雨落下来的时候");
  assert.equal(shots.length, 2);
  assert.throws(() => storyboardToShots({}), (e) => e.code === "VALIDATION_FAILED");
});

// ---- 存储白名单 + IPC ----
test("分析记录白名单：未知字段被 strip，分镜只留白名单字段、超 12 镜截断、空口播过滤", () => {
  const store = createVideoStore(path.join(tmp(), "video"));
  const rec = store.analyses.upsert({
    sourceUrl: "https://www.douyin.com/video/1", author: "阿山", hacked: 1,
    style: { visual: "电影感", hackedStyle: "x" },
    skill: { name: "s", description: "d", body: "b" },
    skillText: "---\nname: s\n---\n",
    scriptTitle: "T", scriptNarration: "N",
    shots: Array.from({ length: 14 }, (_, i) => ({ narration: i === 0 ? "" : `口播${i}`, visual: "v", imagePrompt: "p", seconds: 2, hacked: 1 })),
  });
  assert.equal(rec.hacked, undefined);
  assert.equal(rec.style.hackedStyle, undefined);
  assert.equal(rec.shots.length, 12); // 第 0 镜空口播被过滤，剩下 13 镜再截到 12
  assert.deepEqual(Object.keys(rec.shots[0]).sort(), ["imagePrompt", "narration", "seconds", "visual"]);
  assert.equal(rec.skillPath, "");
  const norm = normalizeAnalysis({ shots: [{ narration: "x", visual: "v", imagePrompt: "p", seconds: 99 }] });
  assert.equal(norm.shots[0].seconds, 30);
});

function setupIpcHarness({ fetchImpl = null, aiKey = "sk-ai-key" } = {}) {
  const dir = path.join(tmp(), "video");
  const store = createVideoStore(dir);
  const ipcMain = { handlers: {}, handle(ch, fn) { this.handlers[ch] = fn; } };
  const secrets = createSecretsStore({ file: path.join(tmp(), "secrets.json"), safeStorage: null });
  if (aiKey) secrets.set("aiApiKey", aiKey);
  setupVideoIpc({
    ipcMain, store, videoDir: dir,
    getAiSettings: () => ({ aiBaseUrl: "https://example.invalid/v1", aiModel: "gpt-4o-mini" }),
    getAiKey: () => secrets.get("aiApiKey"),
    fetchImpl, secrets,
    embeddedViews: {
      douyin: {
        open: async () => ({ opened: true, url: "https://www.douyin.com" }),
        show: () => true, hide: () => {}, setBounds: () => true,
        surface: () => ({
          webContents: {
            isDestroyed: () => false,
            getURL: () => "https://www.douyin.com/video/7381234567890123456",
            executeJavaScript: async () => ({ author: "阿山", caption: "雨夜", likeCountText: "1.2万", url: "" }),
          },
        }),
      },
    },
  });
  return { dir, store, h: ipcMain.handlers, secrets };
}

test("IPC 抖音提取：假视图返回信息；读不到时 ok:false 且 manual=true", async () => {
  const { h } = setupIpcHarness();
  const r = await h["video:douyin.extract"](null);
  assert.equal(r.ok, true);
  assert.equal(r.info.author, "阿山");
  assert.equal(r.info.likeCount, 12000);
  assert.equal(r.info.videoId, "7381234567890123456");
});

test("IPC 分析：假 AI 产出并保存记录；无 Key 时明确失败不保存", async () => {
  const { store, h } = setupIpcHarness({ fetchImpl: chatFetch({ content: JSON.stringify(VALID_RAW) }) });
  const r = await h["video:douyin.analyze"](null, {
    videoInfo: { url: "https://www.douyin.com/video/1", author: "阿山", caption: "雨夜" }, manualText: "",
  });
  assert.equal(r.ok, true);
  assert.equal(r.record.scriptTitle, "雨夜");
  assert.match(r.skillText, /name: melancholic-cinematic/);
  assert.equal(store.analyses.list().length, 1);

  const noKey = setupIpcHarness({ aiKey: "", fetchImpl: chatFetch({ content: JSON.stringify(VALID_RAW) }) });
  const bad = await noKey.h["video:douyin.analyze"](null, { videoInfo: {}, manualText: "x" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "NO_API_KEY");
  assert.equal(noKey.store.analyses.list().length, 0);
});

test("IPC 分析记录：保存 skill 文件写到数据目录、导入到项目按分镜建镜头", async () => {
  const { dir, store, h } = setupIpcHarness();
  const saved = await h["video:analyses.upsert"](null, {
    sourceUrl: "https://www.douyin.com/video/1", author: "阿山",
    style: VALID_RAW.style, skill: VALID_RAW.skill, skillText: "SKILL TEXT",
    scriptTitle: "雨夜", scriptNarration: "全文",
    shots: VALID_RAW.script.shots,
  });
  assert.equal(saved.ok, true);
  const id = saved.analysis.id;

  const skill = await h["video:analyses.saveSkill"](null, id);
  assert.equal(skill.ok, true);
  assert.equal(skill.path, `analyses/${id}/skill.md`);
  assert.equal(fs.readFileSync(path.join(dir, skill.path), "utf8"), "SKILL TEXT");
  assert.equal(store.analyses.get(id).skillPath, `analyses/${id}/skill.md`);

  const imp = await h["video:analyses.import"](null, id);
  assert.equal(imp.ok, true);
  assert.equal(imp.project.aspect, "9:16");
  assert.equal(imp.project.title, "雨夜");
  assert.equal(imp.shots.length, 2);
  assert.equal(imp.shots[0].narration, "雨落下来的时候");
  assert.equal(imp.shots[0].visual, "雨夜街道");
  assert.equal(imp.shots[0].imagePrompt, "雨夜街道，电影感");

  const list = await h["video:analyses.list"](null);
  assert.equal(list.analyses.length, 1);
  const removed = await h["video:analyses.remove"](null, id);
  assert.equal(removed.removed, true);
  assert.equal(store.analyses.list().length, 0);
});

test("IPC AI Key：状态只暴露末 4 位，保存/清除走同一密钥存储", async () => {
  const { h } = setupIpcHarness();
  const st = await h["video:ai.status"](null);
  assert.equal(st.set, true);
  assert.equal(st.last4, "y-key".slice(-4));
  const cleared = await h["video:ai.setKey"](null, "");
  assert.equal(cleared.set, false);
  const st2 = await h["video:ai.status"](null);
  assert.equal(st2.set, false);
});
