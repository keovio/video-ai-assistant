"use strict";
// 视频 IPC：项目 / 镜头 / 资产 / 渲染记录的读写（M1 存储与编辑；M2 增加配音）。
// 注册方式沿用主进程的 ipcMain.handle；返回统一为 { ok: true, ... }，
// 出错时返回 { ok: false, error }，页面侧不需要再猜格式。
// 注意：TTS Key 只在主进程用（本文件内读 secrets），绝不回传给页面；页面只拿到“已设置/末 4 位”。
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { computeMeasuredTimings, estimateSeconds } = require("./video-model");
const { synthesize, listProviders, probeDuration } = require("./video/tts");
const { storeAudioBytes, mimeFor, isAudioFile, ffmpegStatus, AUDIO_EXTS } = require("./video/audio");
const { storeMediaBytes, storeMediaFile, isVideoFile, VIDEO_EXTS } = require("./video/media-store");
const { renderProject, RenderError } = require("./video/render");
const { buildVideoPrompt, runJimengShot, JimengError } = require("./video/jimeng");
const { extractVideoInfo } = require("./video/douyin");
const { analyzeVideo, buildSkillText, AiError } = require("./video/ai");

function setupVideoIpc({ ipcMain, store, videoDir, videoDefaults = {}, getTtsSettings = () => ({}), getTtsKey = () => "", getAiSettings = () => ({}), getAiKey = () => "", fetchImpl = null, secrets = null, embeddedViews = null, openPath = null, renderRun = null, renderCheck = null }) {
  const h = (channel, fn) => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try { return await fn(...args); }
      catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
    });
  };
  const ok = (data) => ({ ok: true, ...data });
  const shotCountOf = (projectId) => store.shotsOf(projectId).length;
  const withCounts = (p) => ({ ...p, shotCount: shotCountOf(p.id) });
  const assetAbs = (asset) => {
    if (!asset || !asset.path) return "";
    const abs = path.join(videoDir, asset.path);
    return abs.startsWith(videoDir + path.sep) ? abs : "";
  };

  // 把一份音频 bytes 落盘、去重、测时长、挂到镜头上。生成与导入走同一条路，
  // 所以导入音频的时长、缓存、重排逻辑与生成音频完全一致。
  // 返回 { shot, asset, seconds, measured, warning, deduped }；seconds 为 null 时 measured=false。
  function linkAudio(shot, bytes, ext, source) {
    const projectId = shot.projectId;
    const stored = storeAudioBytes(bytes, path.join(videoDir, `projects/${projectId}/assets`), ext);
    const rel = `projects/${projectId}/assets/${stored.rel}`;
    let asset = store.assets.list().find((a) => a.kind === "audio" && a.hash === stored.hash);
    if (!asset) asset = store.assets.upsert({ kind: "audio", path: rel, hash: stored.hash, bytes: stored.bytes, source });
    const seconds = probeDuration(stored.abs);
    const measured = seconds != null;
    const audioSeconds = measured ? seconds : estimateSeconds(shot.narration);
    const warning = measured ? "" : "未检测到系统 ffprobe，当前时长为字数估算（约 4.5 字/秒），不是实测时长；请安装系统 ffmpeg/ffprobe 后重新生成或导入，时间才会按实测重排。";
    const updated = store.updateShot(shot.id, {
      audioAssetId: asset.id, audioSeconds, audioSource: source, audioMeasured: measured, status: "ready", error: "",
    });
    return { shot: updated, asset, seconds, measured, warning, deduped: stored.deduped };
  }

  h("video:projects.list", () => ok({ projects: store.projects.list().map(withCounts) }));

  h("video:projects.get", (id) => {
    const project = store.projects.get(id);
    if (!project) return { ok: false, error: "项目不存在" };
    const shots = store.shotsOf(id);
    const { totalSeconds } = computeMeasuredTimings(shots);
    return ok({ project: withCounts({ ...project, totalSeconds }), shots });
  });

  h("video:projects.create", (input = {}) => {
    const shotCount = Number(input.shotCount ?? videoDefaults.defaultShotCount ?? 6);
    const { project, shots } = store.createProject({
      title: input.title, tags: input.tags, aspect: input.aspect || videoDefaults.aspect || "9:16",
      accountId: input.accountId, voice: input.voice,
    }, shotCount);
    return ok({ project: withCounts(project), shots });
  });

  h("video:projects.update", (id, patch = {}) => {
    const old = store.projects.get(id);
    if (!old) return { ok: false, error: "项目不存在" };
    const project = store.projects.upsert({ ...old, ...patch, id });
    return ok({ project: withCounts(project) });
  });

  h("video:projects.remove", (id) => ok({ removed: store.removeProject(id) }));

  h("video:projects.duplicate", (id) => {
    const { project, shots } = store.duplicateProject(id);
    return ok({ project: withCounts(project), shots });
  });

  h("video:shots.list", (projectId) => ok({ shots: store.shotsOf(projectId) }));

  h("video:shots.add", (projectId, input = {}) => {
    if (!store.projects.get(projectId)) return { ok: false, error: "项目不存在" };
    return ok({ shot: store.addShot(projectId, input) });
  });

  h("video:shots.update", (id, patch = {}) => ok({ shot: store.updateShot(id, patch) }));

  h("video:shots.remove", (id) => ok({ removed: store.removeShot(id) }));

  h("video:shots.reorder", (projectId, ids) => ok({ shots: store.reorderShots(projectId, ids) }));

  h("video:assets.list", (filter = {}) => ok({ assets: store.assets.list(filter) }));
  h("video:renders.list", (projectId) => ok({ renders: store.renders.list({ projectId: projectId || "" }) }));

  // ---- M2：配音 ----
  h("video:tts.providers", () => ok({ providers: listProviders() }));

  h("video:ffmpeg.status", () => ok(ffmpegStatus()));

  h("video:secrets.status", () => ok(secrets ? secrets.status("ttsApiKey") : { set: false, last4: "", insecureFallback: false }));

  h("video:secrets.set", (value) => {
    if (!secrets) return { ok: false, error: "密钥存储未接通" };
    if (typeof value !== "string") return { ok: false, error: "Key 格式不对" };
    return ok(secrets.set("ttsApiKey", value));
  });

  // 生成配音：失败时把失败原因写进 shot.error 并返回 ok:false，不清掉已有的旧配音。
  h("video:shots.generateAudio", async (shotId, override = {}) => {
    const shot = store.shots.get(shotId);
    if (!shot) return { ok: false, error: "镜头不存在" };
    const project = store.projects.get(shot.projectId);
    const cfg = getTtsSettings();
    const provider = override.provider || (project && project.voice && project.voice.ttsProvider) || cfg.ttsProvider || "openai";
    const voice = override.voice || (project && project.voice && project.voice.voice) || cfg.ttsVoice || "alloy";
    const rate = override.rate != null ? override.rate : (project && project.voice ? project.voice.rate : cfg.ttsRate) || 1;
    store.updateShot(shotId, { status: "voicing", error: "" });
    const tmpFile = path.join(os.tmpdir(), `video-tts-${crypto.randomUUID()}.mp3`);
    try {
      const result = await synthesize({
        provider, text: shot.narration, voice, rate, format: "mp3", outFile: tmpFile,
        fetchImpl, apiKey: getTtsKey(),
        baseUrl: cfg.ttsBaseUrl || "https://api.openai.com/v1",
        model: cfg.ttsModel || "tts-1",
      });
      const bytes = fs.readFileSync(result.file);
      const linked = linkAudio(store.shots.get(shotId), bytes, ".mp3", "generated");
      return ok({ ...linked, provider });
    } catch (err) {
      const message = (err && err.message) || String(err);
      try { store.updateShot(shotId, { status: "failed", error: message }); } catch { /* ignore */ }
      return { ok: false, error: message, retryable: !!(err && err.retryable), code: (err && err.code) || "" };
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  });

  // 导入配音：页面用 <input type=file> 读成 ArrayBuffer 后传过来（主进程无权直接读页面选的文件）。
  // data 可能是 ArrayBuffer / Uint8Array / Buffer；一律转成 Buffer。
  h("video:shots.importAudio", (shotId, file = {}) => {
    const shot = store.shots.get(shotId);
    if (!shot) return { ok: false, error: "镜头不存在" };
    const name = String(file.name || "");
    const ext = path.extname(name).toLowerCase();
    if (!isAudioFile(name)) {
      return { ok: false, error: `仅支持音频文件（${Object.keys(AUDIO_EXTS).join("、")}），当前文件：${name || "（未命名）"}` };
    }
    let bytes;
    try {
      if (Buffer.isBuffer(file.data)) bytes = file.data;
      else if (file.data instanceof ArrayBuffer) bytes = Buffer.from(file.data);
      else if (file.data instanceof Uint8Array) bytes = Buffer.from(file.data);
      else if (Array.isArray(file.data)) bytes = Buffer.from(file.data);
      else throw new Error("音频数据格式不对");
    } catch (err) { return { ok: false, error: err.message }; }
    if (!bytes.length) return { ok: false, error: "音频文件为空" };
    const linked = linkAudio(shot, bytes, ext, "import");
    return ok(linked);
  });

  // 试听：主进程读资产文件转 data URL 回页面播放。CSP 里 media-src 已放行 data:，
  // 页面不直接拼 file:// 路径（打包后 file:// 跨目录访问不可靠）。
  h("video:shots.audioData", (shotId) => {
    const shot = store.shots.get(shotId);
    if (!shot || !shot.audioAssetId) return { ok: false, error: "该镜头还没有配音，请先生成或导入音频" };
    const asset = store.assets.get(shot.audioAssetId);
    const abs = assetAbs(asset);
    if (!abs || !fs.existsSync(abs)) return { ok: false, error: "配音文件已不在磁盘上，请重新生成或导入" };
    const dataUrl = `data:${mimeFor(abs)};base64,${fs.readFileSync(abs).toString("base64")}`;
    return ok({ dataUrl, mime: mimeFor(abs), seconds: shot.audioSeconds, source: shot.audioSource });
  });

  // 把一份视频文件（磁盘路径或 bytes）落盘、去重、测时长、挂到镜头上。
  // 返回 { shot, asset, seconds, deduped }；seconds 为 null 时表示未测到时长，渲染时按音频时长兜底。
  function linkVideo(shot, { bytes = null, filePath = "", ext = ".mp4", source = "import" } = {}) {
    const assetsDir = path.join(videoDir, `projects/${shot.projectId}/assets`);
    const stored = bytes != null ? storeMediaBytes(bytes, assetsDir, ext) : storeMediaFile(filePath, assetsDir);
    const rel = `projects/${shot.projectId}/assets/${stored.rel}`;
    let asset = store.assets.list().find((a) => a.kind === "video" && a.hash === stored.hash);
    if (!asset) asset = store.assets.upsert({ kind: "video", path: rel, hash: stored.hash, bytes: stored.bytes, source });
    const seconds = probeDuration(stored.abs);
    const updated = store.updateShot(shot.id, {
      videoAssetId: asset.id, clipSeconds: seconds != null ? seconds : 0,
      status: shot.audioAssetId ? "ready" : "imaging", error: "",
    });
    // 资产记录补上实测秒数（渲染时用来判断循环/截断）
    if (seconds != null && asset.seconds !== seconds) store.assets.upsert({ ...asset, seconds });
    return { shot: updated, asset: store.assets.get(asset.id), seconds, deduped: stored.deduped };
  }

  // ---- M3：渲染 ----
  function assetsById() {
    const map = {};
    for (const a of store.assets.list()) map[a.id] = a;
    return map;
  }

  // 同一项目同时只跑一个合成任务：已有 queued/running 的渲染记录时拒绝再开。
  async function startRender(projectId, opts = {}) {
    const project = store.projects.get(projectId);
    if (!project) return { ok: false, error: "项目不存在" };
    const running = store.renders.list({ projectId }).find((r) => r.status === "queued" || r.status === "running");
    if (running) return { ok: false, error: "该项目已有正在进行的合成任务，请等它完成或失败后再试", render: running };
    const record = store.renders.upsert({ projectId, status: "queued", stage: "queued", pct: 0, message: "排队中", outputPath: "", srtPath: "", warnings: [], error: "" });
    store.projects.upsert({ ...project, status: "rendering" });
    // 后台跑，不阻塞 IPC 返回；页面轮询 video:renders.list 看进度。
    void (async () => {
      const update = (patch) => { try { store.renders.upsert({ ...store.renders.get(record.id), ...patch, id: record.id }); } catch { /* ignore */ } };
      try {
        update({ status: "running", stage: "prepare", pct: 0, message: "准备合成", startedAt: Date.now() });
        const shots = store.shotsOf(projectId);
        const { shots: timed } = computeMeasuredTimings(shots);
        const timedById = new Map(timed.map((s) => [s.id, s]));
        const renderShots = shots.map((s) => ({ ...s, ...(timedById.get(s.id) || {}) }));
        const voice = project.voice || {};
        let bgmAbs = "";
        if (voice.bgm) {
          const cand = path.join(videoDir, voice.bgm);
          if (cand.startsWith(videoDir + path.sep) && fs.existsSync(cand)) bgmAbs = cand;
        }
        const result = await renderProject({
          project, shots: renderShots, assetsById: assetsById(), videoDir,
          outDir: path.join(videoDir, `projects/${projectId}/output`),
          burnSubtitles: opts.burnSubtitles !== false, bgmFile: bgmAbs,
          run: renderRun || undefined, check: renderCheck || undefined,
          onProgress: ({ stage, pct, message }) => update({ stage, pct, message }),
        });
        const doneMessage = result.burned
          ? "合成完成（字幕已烧入，SRT 已另存）"
          : opts.burnSubtitles === false
            ? "合成完成（未烧字幕，SRT 已另存）"
            : "合成完成（字幕烧入失败，仅输出 SRT，见 warnings）";
        update({ status: "done", stage: "done", pct: 100, message: doneMessage, outputPath: result.outputPath, srtPath: result.srtPath, warnings: result.warnings, endedAt: Date.now() });
        store.projects.upsert({ ...store.projects.get(projectId), status: "done" });
      } catch (err) {
        const message = (err && err.message) || String(err);
        update({ status: "failed", stage: "failed", pct: 0, message, error: message, endedAt: Date.now() });
        try { store.projects.upsert({ ...store.projects.get(projectId), status: "failed" }); } catch { /* ignore */ }
      }
    })();
    return ok({ render: store.renders.get(record.id) });
  }

  h("video:renders.start", (projectId, opts = {}) => startRender(projectId, opts));
  h("video:renders.retry", (renderId) => {
    const old = store.renders.get(renderId);
    if (!old) return { ok: false, error: "渲染记录不存在" };
    return startRender(old.projectId, {});
  });
  h("video:renders.openFolder", (renderId) => {
    const rec = store.renders.get(renderId);
    if (!rec || !rec.outputPath) return { ok: false, error: "该渲染还没有成片，请先合成导出" };
    const abs = path.join(videoDir, rec.outputPath);
    if (!openPath) return { ok: false, error: "打开文件夹未接通" };
    openPath(path.dirname(abs));
    return ok({ opened: true });
  });
  h("video:renders.openOutput", (renderId) => {
    const rec = store.renders.get(renderId);
    if (!rec || !rec.outputPath) return { ok: false, error: "该渲染还没有成片，请先合成导出" };
    const abs = path.join(videoDir, rec.outputPath);
    if (!fs.existsSync(abs)) return { ok: false, error: "成片文件已不在磁盘上，请重新合成" };
    if (!openPath) return { ok: false, error: "打开成片未接通" };
    openPath(abs);
    return ok({ opened: true });
  });

  // ---- M3：即梦视频片段（导入 / 自动操作 / 清除） ----
  // 即梦内嵌视图（M4 起）：不再是独立窗口，视图嵌在“合成导出”页左侧；
  // embeddedViews.jimeng 由主进程提供（surface 形状与旧窗口兼容：webContents + session + show/focus）。
  const jimengView = () => (embeddedViews && embeddedViews.jimeng ? embeddedViews.jimeng : null);
  const douyinView = () => (embeddedViews && embeddedViews.douyin ? embeddedViews.douyin : null);

  h("video:jimeng.open", async () => {
    const v = jimengView();
    if (!v) return { ok: false, error: "即梦内嵌视图未接通" };
    try { return ok(await v.open()); }
    catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  });
  h("video:jimeng.show", () => {
    const v = jimengView();
    if (!v) return { ok: false, error: "即梦内嵌视图未接通" };
    return ok({ shown: v.show() });
  });
  h("video:jimeng.hide", () => {
    const v = jimengView();
    if (v) v.hide();
    return ok({ hidden: true });
  });
  h("video:jimeng.setBounds", (rect) => {
    const v = jimengView();
    if (!v) return { ok: false, error: "即梦内嵌视图未接通" };
    return ok({ applied: v.setBounds(rect) });
  });

  // ---- M4：抖音分析（内嵌视图提取 + AI 分析 + 分析记录） ----
  h("video:douyin.open", async () => {
    const v = douyinView();
    if (!v) return { ok: false, error: "抖音内嵌视图未接通" };
    try { return ok(await v.open()); }
    catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  });
  h("video:douyin.show", () => {
    const v = douyinView();
    if (!v) return { ok: false, error: "抖音内嵌视图未接通" };
    return ok({ shown: v.show() });
  });
  h("video:douyin.hide", () => {
    const v = douyinView();
    if (v) v.hide();
    return ok({ hidden: true });
  });
  h("video:douyin.setBounds", (rect) => {
    const v = douyinView();
    if (!v) return { ok: false, error: "抖音内嵌视图未接通" };
    return ok({ applied: v.setBounds(rect) });
  });

  h("video:douyin.extract", async () => {
    const v = douyinView();
    if (!v) return { ok: false, error: "抖音内嵌视图未接通：请点“打开抖音”后再试，或用手动粘贴链接/文案", manual: true };
    let surface;
    try { surface = v.surface(); }
    catch (err) { return { ok: false, error: (err && err.message) || String(err), manual: true }; }
    if (!surface || !surface.webContents || surface.webContents.isDestroyed()) {
      return { ok: false, error: "抖音内嵌视图未接通：请点“打开抖音”后再试，或用手动粘贴链接/文案", manual: true };
    }
    try {
      const info = await extractVideoInfo({
        driver: {
          executeJavaScript: (js) => surface.webContents.executeJavaScript(js),
          getURL: () => surface.webContents.getURL(),
        },
      });
      return ok({ info });
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err), manual: !!(err && err.manualFallback), code: (err && err.code) || "" };
    }
  });

  h("video:ai.status", () => ok(secrets ? secrets.status("aiApiKey") : { set: false, last4: "", insecureFallback: false }));

  h("video:ai.setKey", (value) => {
    if (!secrets) return { ok: false, error: "密钥存储未接通" };
    if (typeof value !== "string") return { ok: false, error: "Key 格式不对" };
    return ok(secrets.set("aiApiKey", value));
  });

  // 分析：只接受已提取的视频信息和/或手动粘贴的文案；AI 失败时不保存、不编造。
  h("video:douyin.analyze", async (input = {}) => {
    const cfg = getAiSettings();
    try {
      const analysis = await analyzeVideo({
        fetchImpl, apiKey: getAiKey(),
        baseUrl: cfg.aiBaseUrl || "https://api.openai.com/v1",
        model: cfg.aiModel || "gpt-4o-mini",
        videoInfo: input.videoInfo || {},
        manualText: input.manualText || "",
      });
      const skillText = buildSkillText(analysis);
      const info = input.videoInfo || {};
      const record = store.analyses.upsert({
        sourceUrl: info.url || "", videoId: info.videoId || "", author: info.author || "",
        caption: info.caption || "", likeCountText: info.likeCountText || "",
        commentCountText: info.commentCountText || "", shareCountText: info.shareCountText || "",
        style: analysis.style, skill: analysis.skill, skillText,
        scriptTitle: analysis.script.title, scriptNarration: analysis.script.narration,
        shots: analysis.script.shots, manualText: input.manualText || "",
      });
      return ok({ analysis, skillText, record });
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err), retryable: !!(err && err.retryable), code: (err && err.code) || "" };
    }
  });

  h("video:analyses.list", () => ok({ analyses: store.analyses.list() }));

  h("video:analyses.get", (id) => {
    const a = store.analyses.get(id);
    if (!a) return { ok: false, error: "分析记录不存在" };
    return ok({ analysis: a });
  });

  h("video:analyses.upsert", (input = {}) => {
    if (!input || typeof input !== "object") return { ok: false, error: "数据格式不对" };
    return ok({ analysis: store.analyses.upsert(input) });
  });

  h("video:analyses.remove", (id) => ok({ removed: store.analyses.remove(id) }));

  // 保存 skill 文件：写到 <数据目录>/video/analyses/<id>/skill.md，只存相对路径。
  h("video:analyses.saveSkill", (id) => {
    const rec = store.analyses.get(id);
    if (!rec) return { ok: false, error: "分析记录不存在" };
    const text = rec.skillText || buildSkillText({ skill: rec.skill, style: rec.style, script: { title: rec.scriptTitle } });
    const dir = path.join(videoDir, "analyses", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "skill.md"), text, "utf8");
    const updated = store.analyses.upsert({ ...rec, skillPath: `analyses/${id}/skill.md` });
    return ok({ analysis: updated, path: `analyses/${id}/skill.md` });
  });

  // 导入到项目：按分析分镜新建项目（9:16），镜头按顺序填口播/画面/提示词。
  h("video:analyses.import", (id) => {
    const rec = store.analyses.get(id);
    if (!rec) return { ok: false, error: "分析记录不存在" };
    if (!rec.shots || !rec.shots.length) return { ok: false, error: "这条分析没有可导入的分镜" };
    const { project } = store.createProject({
      title: rec.scriptTitle || "抖音分析导入",
      tags: rec.author ? [rec.author] : [],
      aspect: "9:16",
    }, rec.shots.length);
    const ordered = store.shotsOf(project.id);
    rec.shots.forEach((s, i) => {
      if (ordered[i]) store.updateShot(ordered[i].id, { narration: s.narration, visual: s.visual, imagePrompt: s.imagePrompt });
    });
    return ok({ project, shots: store.shotsOf(project.id) });
  });
  h("video:shots.importVideo", (shotId, file = {}) => {
    const shot = store.shots.get(shotId);
    if (!shot) return { ok: false, error: "镜头不存在" };
    const name = String(file.name || "");
    if (!isVideoFile(name)) {
      return { ok: false, error: `仅支持视频文件（${Object.keys(VIDEO_EXTS).join("、")}），当前文件：${name || "（未命名）"}` };
    }
    let bytes;
    try {
      if (Buffer.isBuffer(file.data)) bytes = file.data;
      else if (file.data instanceof ArrayBuffer) bytes = Buffer.from(file.data);
      else if (file.data instanceof Uint8Array) bytes = Buffer.from(file.data);
      else if (Array.isArray(file.data)) bytes = Buffer.from(file.data);
      else throw new Error("视频数据格式不对");
    } catch (err) { return { ok: false, error: err.message }; }
    if (!bytes.length) return { ok: false, error: "视频文件为空" };
    const linked = linkVideo(shot, { bytes, ext: path.extname(name).toLowerCase(), source: "import" });
    return ok(linked);
  });

  h("video:shots.clearVideo", (shotId) => {
    const shot = store.shots.get(shotId);
    if (!shot) return { ok: false, error: "镜头不存在" };
    const updated = store.updateShot(shotId, { videoAssetId: "", clipSeconds: 0, status: shot.audioAssetId ? "ready" : "pending", error: "" });
    return ok({ shot: updated });
  });

  // 即梦自动生成片段：runner 成功只表示“页面上生成完成”，下载是另一步。
  // 下载按钮找不到 / 下载超时 / 选择器失效时一律转手动：内嵌视图保持可见，镜头标失败并写明手动步骤。
  h("video:shots.generateClip", async (shotId) => {
    const shot = store.shots.get(shotId);
    if (!shot) return { ok: false, error: "镜头不存在" };
    const v = jimengView();
    if (!v) return { ok: false, error: "即梦内嵌视图未接通：请用“打开即梦”在视图里手动生成，下载后用“导入片段”导进来", manual: true };
    const project = store.projects.get(shot.projectId);
    store.updateShot(shotId, { status: "imaging", error: "" });
    let win = null;
    try {
      win = v.surface();
      if (!win || !win.webContents || win.webContents.isDestroyed()) throw new JimengError("即梦内嵌视图未接通", { code: "NO_WINDOW", manualFallback: true });
      win.show();
      const prompt = buildVideoPrompt(shot, project);
      const driver = { executeJavaScript: (js) => win.webContents.executeJavaScript(js) };
      await runJimengShot({ driver, prompt });
      // 生成完成后再点“下载”：按按钮文本匹配；找不到则转手动。
      const downloaded = await new Promise((resolve) => {
        const session = win.webContents.session;
        const savePath = path.join(videoDir, `projects/${shot.projectId}/assets/.jimeng-${shot.id}-${Date.now()}.mp4`);
        let settled = false;
        const done = (okVal, file) => { if (!settled) { settled = true; resolve({ ok: okVal, file }); } };
        try {
          if (session && typeof session.once === "function") {
            session.once("will-download", (_e, item) => {
              try { item.setSavePath(savePath); } catch { /* ignore */ }
              item.on("done", (_ev, state) => done(state === "completed", savePath));
            });
          } else done(false, "");
        } catch { done(false, ""); }
        setTimeout(() => done(false, ""), 90000);
        win.webContents.executeJavaScript(
          `(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().includes('下载')); if (!b) return false; b.click(); return true; })()`,
        ).then((clicked) => { if (!clicked) done(false, ""); }).catch(() => done(false, ""));
      });
      if (!downloaded.ok || !downloaded.file || !fs.existsSync(downloaded.file)) {
        throw new JimengError("即梦片段已生成但自动下载未完成，已把内嵌视图留给用户：请在视图里手动下载片段，再用“导入片段”导进来。", { code: "DOWNLOAD_FAILED", manualFallback: true });
      }
      const linked = linkVideo(store.shots.get(shotId), { filePath: downloaded.file, source: "generated" });
      try { fs.unlinkSync(downloaded.file); } catch { /* ignore */ }
      return ok({ ...linked, provider: "jimeng" });
    } catch (err) {
      const message = (err && err.message) || String(err);
      const manual = !!(err && err.manualFallback);
      try {
        if (win && typeof win.show === "function") win.show();
        if (win && typeof win.focus === "function") win.focus();
      } catch { /* ignore */ }
      try { store.updateShot(shotId, { status: "failed", error: message }); } catch { /* ignore */ }
      return { ok: false, error: message, manual, code: (err && err.code) || "" };
    }
  });

  // 清除镜头配音链接（资产记录与文件保留，可重新生成/导入）。
  h("video:shots.clearAudio", (shotId) => {
    const shot = store.shots.get(shotId);
    if (!shot) return { ok: false, error: "镜头不存在" };
    const updated = store.updateShot(shotId, { audioAssetId: "", audioSeconds: 0, audioSource: "", audioMeasured: false, status: "pending", error: "" });
    return ok({ shot: updated });
  });
}

module.exports = { setupVideoIpc };
