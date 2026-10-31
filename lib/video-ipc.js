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
const { synthesize, listProviders, probeDurationAsync, listVoices, voiceboxProfiles, VOICEBOX_ENGINES, VOICEBOX_DEFAULT_URL } = require("./video/tts");

// 配音服务的地址与模型：本地 TTS 用单独的设置项（默认 http://127.0.0.1:8880/v1），不和云端混用
function ttsEndpoint(cfg = {}, provider = "openai") {
  if (provider === "voicebox") {
    return { baseUrl: cfg.ttsVoiceboxBaseUrl || VOICEBOX_DEFAULT_URL, model: cfg.ttsVoiceboxEngine || "qwen", modelSize: cfg.ttsVoiceboxModelSize || "1.7B", language: cfg.ttsVoiceboxLanguage || "zh" };
  }
  if (provider === "local") {
    return { baseUrl: cfg.ttsLocalBaseUrl || "http://127.0.0.1:8880/v1", model: cfg.ttsLocalModel || "kokoro" };
  }
  return { baseUrl: cfg.ttsBaseUrl || "https://api.openai.com/v1", model: cfg.ttsModel || "tts-1" };
}
const { storeAudioBytes, mimeFor, isAudioFile, ffmpegStatusAsync, AUDIO_EXTS } = require("./video/audio");
const { storeMediaBytes, storeMediaFile, isVideoFile, VIDEO_EXTS } = require("./video/media-store");
const { renderProject, RenderError, defaultRun: renderDefaultRun } = require("./video/render");
const { buildVideoPrompt, runJimengShot, JimengError } = require("./video/jimeng");
const { extractVideoInfo } = require("./video/douyin");
const { analyzeVideo, buildSkillText, AiError, listModels } = require("./video/ai");

function setupVideoIpc({ ipcMain, store, videoDir, videoDefaults = {}, probe = null, getTtsSettings = () => ({}), getTtsKey = () => "", getAiSettings = () => ({}), getAiKey = () => "", fetchImpl = null, aiFetchImpl = null, tasks = null, logger = null, secrets = null, embeddedViews = null, openPath = null, renderRun = null, renderCheck = null }) {
  // 运行日志（设置 → 日志 / 右侧运行日志面板里看，模块名 video）；没传 logger 时静默
  const noop = () => {};
  const log = logger && typeof logger.scope === "function" ? logger.scope("video") : { debug: noop, info: noop, warn: noop, error: noop };
  const h = (channel, fn) => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        const r = await fn(...args);
        if (r && r.ok === false && r.error) log.warn(`${channel} 失败：${r.error}`);
        return r;
      } catch (err) {
        const error = (err && err.message) || String(err);
        log.error(`${channel} 出错：${error}`);
        return { ok: false, error };
      }
    });
  };
  const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u || ""); } };
  const ok = (data) => ({ ok: true, ...data });
  // 默认值每次现读（设置页改了“默认镜头数/画幅”立即生效，不用重启）；兼容传对象。
  const defaults = () => (typeof videoDefaults === "function" ? (videoDefaults() || {}) : videoDefaults);
  const probeDur = (file) => (typeof probe === "function" ? Promise.resolve(probe(file)) : probeDurationAsync(file));
  // 上次强退/崩溃留下的“进行中”合成、配音、生成状态，启动时标为失败（否则该项目永远不能再合成）
  try { if (typeof store.recoverInterrupted === "function") store.recoverInterrupted(); } catch { /* ignore */ }
  const projectPrefix = (projectId) => `projects/${projectId}/`;
  // 资产按项目去重：同一项目内相同内容复用，跨项目各存一份，删项目时互不影响。
  const findProjectAsset = (projectId, kind, hash) => store.assets.list()
    .find((a) => a.kind === kind && a.hash === hash && a.path.startsWith(projectPrefix(projectId)));
  // 把某资产复制一份到另一个项目目录下，返回新资产记录（复制项目/搬家用）。
  function cloneAssetToProject(asset, projectId) {
    const src = assetAbs(asset);
    if (!src || !fs.existsSync(src)) return null;
    const existing = asset.hash ? findProjectAsset(projectId, asset.kind, asset.hash) : null;
    if (existing) return existing;
    const destRel = `${projectPrefix(projectId)}assets/${path.basename(asset.path)}`;
    const dest = path.join(videoDir, destRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = asset;
    return store.assets.upsert({ ...rest, path: destRel });
  }
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
  async function linkAudio(shot, bytes, ext, source) {
    const projectId = shot.projectId;
    const stored = storeAudioBytes(bytes, path.join(videoDir, `projects/${projectId}/assets`), ext);
    const rel = `projects/${projectId}/assets/${stored.rel}`;
    let asset = findProjectAsset(projectId, "audio", stored.hash);
    if (!asset) asset = store.assets.upsert({ kind: "audio", path: rel, hash: stored.hash, bytes: stored.bytes, source });
    const seconds = await probeDur(stored.abs);
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
    const d = defaults();
    const shotCount = Number(input.shotCount ?? d.defaultShotCount ?? 6);
    const { project, shots } = store.createProject({
      title: input.title, tags: input.tags, aspect: input.aspect || d.aspect || "9:16",
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

  // 背景音乐：文件存进项目素材目录，project.voice.bgm 记相对 videoDir 的路径，合成时循环铺满全片。
  h("video:projects.setBgm", async (id, file = {}) => {
    const old = store.projects.get(id);
    if (!old) return { ok: false, error: "项目不存在" };
    const name = String(file.name || "");
    if (!isAudioFile(name)) return { ok: false, error: `仅支持音频文件（${Object.keys(AUDIO_EXTS).join("、")}），当前文件：${name || "（未命名）"}` };
    let bytes;
    try {
      if (Buffer.isBuffer(file.data)) bytes = file.data;
      else if (file.data instanceof ArrayBuffer || file.data instanceof Uint8Array || Array.isArray(file.data)) bytes = Buffer.from(file.data);
      else throw new Error("音频数据格式不对");
    } catch (err) { return { ok: false, error: err.message }; }
    if (!bytes.length) return { ok: false, error: "音频文件为空" };
    const stored = storeAudioBytes(bytes, path.join(videoDir, `projects/${id}/assets`), path.extname(name).toLowerCase());
    const seconds = await probeDur(stored.abs);
    const voice = { ...(old.voice || {}), bgm: `projects/${id}/assets/${stored.rel}`, bgmName: name.slice(0, 200) };
    const project = store.projects.upsert({ ...old, voice, id });
    log.info(`已设置背景音乐：${name}${seconds ? `（${Math.round(seconds)} 秒）` : ""}`);
    return ok({ project: withCounts(project), seconds });
  });
  h("video:projects.clearBgm", (id) => {
    const old = store.projects.get(id);
    if (!old) return { ok: false, error: "项目不存在" };
    const project = store.projects.upsert({ ...old, voice: { ...(old.voice || {}), bgm: "", bgmName: "" }, id });
    return ok({ project: withCounts(project) });
  });

  // 删除项目：先把“别的项目还在用、但文件放在本项目目录下”的资产搬到使用方项目目录，
  // 再删记录，最后删掉整个项目目录（素材、成片、临时文件），磁盘不再只增不减。
  h("video:projects.remove", (id) => {
    if (!store.projects.get(id)) return ok({ removed: false });
    const running = store.renders.list({ projectId: id }).find((r) => r.status === "queued" || r.status === "running");
    if (running) return { ok: false, error: "该项目正在合成，请等合成结束后再删除" };
    const prefix = projectPrefix(id);
    for (const a of store.assets.list()) {
      if (!a.path.startsWith(prefix)) continue;
      const users = store.shots.list().filter((s) => s.projectId !== id
        && (s.audioAssetId === a.id || s.videoAssetId === a.id || s.imageAssetId === a.id));
      if (!users.length) continue;
      const target = users[0].projectId;
      const src = assetAbs(a);
      if (!src || !fs.existsSync(src)) continue;
      const destRel = `${projectPrefix(target)}assets/${path.basename(a.path)}`;
      const dest = path.join(videoDir, destRel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
      store.assets.upsert({ ...a, path: destRel });
    }
    // 删除前给全部数据拍快照（设置 → ffmpeg 与数据 里可一键恢复）；拍不了就不删
    const title = store.projects.get(id).title;
    try { store.snapshot(`删除项目“${title}”前`); }
    catch (err) { return { ok: false, error: "删除前备份失败，已取消删除：" + ((err && err.message) || err) }; }
    const before = store.projects.count();
    const removed = store.removeProject(id);
    const after = store.projects.count();
    // 项目目录里的素材挪到回收目录而不是直接删，恢复备份后素材还在
    const dir = path.join(videoDir, "projects", id);
    if (removed && dir.startsWith(path.join(videoDir, "projects") + path.sep) && fs.existsSync(dir)) {
      const trash = path.join(videoDir, "trash", `${Date.now()}-${id}`);
      try { fs.mkdirSync(path.dirname(trash), { recursive: true }); fs.renameSync(dir, trash); }
      catch { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
    return ok({ removed, before, after });
  });

  // 数据备份：列出 / 恢复（恢复时把回收目录里对应项目的素材搬回来）
  h("video:backups.list", () => ok({ backups: store.listBackups() }));
  h("video:backups.restore", (id) => {
    const r = store.restoreBackup(id);
    const trashDir = path.join(videoDir, "trash");
    if (fs.existsSync(trashDir)) {
      for (const p of store.projects.list()) {
        const dest = path.join(videoDir, "projects", p.id);
        if (fs.existsSync(dest)) continue;
        const hit = fs.readdirSync(trashDir).filter((n) => n.endsWith("-" + p.id)).sort().pop();
        if (hit) { try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(path.join(trashDir, hit), dest); } catch { /* ignore */ } }
      }
    }
    return ok(r);
  });

  // 复制项目：素材文件一并复制到新项目目录（各自独立，删原项目不影响副本）。
  h("video:projects.duplicate", (id) => {
    const { project } = store.duplicateProject(id);
    for (const s of store.shotsOf(project.id)) {
      const patch = {};
      for (const key of ["audioAssetId", "videoAssetId", "imageAssetId"]) {
        if (!s[key]) continue;
        const a = store.assets.get(s[key]);
        const cloned = a ? cloneAssetToProject(a, project.id) : null;
        if (cloned && cloned.id !== s[key]) patch[key] = cloned.id;
      }
      if (Object.keys(patch).length) store.shots.upsert({ ...store.shots.get(s.id), ...patch });
    }
    return ok({ project: withCounts(store.projects.get(project.id)), shots: store.shotsOf(project.id) });
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

  // ---- 0.6.20 作品库：所有项目的成片 + 缩略图 + 删除 ----
  const renderAbs = (rel) => (rel ? path.join(videoDir, rel) : "");
  h("video:library.renders", () => {
    const titles = new Map(store.projects.list().map((p) => [p.id, p.title || "未命名项目"]));
    const renders = store.renders.list({})
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((r) => {
        const abs = renderAbs(r.outputPath);
        let sizeBytes = 0, exists = false;
        if (abs) { try { const st = fs.statSync(abs); exists = st.isFile(); sizeBytes = st.size; } catch { /* 文件不在 */ } }
        return { ...r, projectTitle: titles.get(r.projectId) || "", projectExists: titles.has(r.projectId), exists, sizeBytes };
      });
    return ok({ renders });
  });
  // 缩略图：第 1 秒一帧，320 宽 jpg，存在成片旁边（xxx.mp4.thumb.jpg），返回 data URL（页面 CSP 只允许 data: 图片）
  const thumbBusy = new Map();
  h("video:library.thumb", async (renderId) => {
    const rec = store.renders.get(renderId);
    const abs = rec && renderAbs(rec.outputPath);
    if (!abs || !fs.existsSync(abs)) return { ok: false, error: "成片文件不在" };
    const thumb = abs + ".thumb.jpg";
    if (!fs.existsSync(thumb) || fs.statSync(thumb).mtimeMs < fs.statSync(abs).mtimeMs) {
      if (!thumbBusy.has(thumb)) {
        const run = renderRun || renderDefaultRun;
        const job = (async () => {
          try { await run(["-y", "-ss", "1", "-i", abs, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5", thumb]); }
          catch { await run(["-y", "-i", abs, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5", thumb]); } // 不到 1 秒的片子取第一帧
        })().finally(() => thumbBusy.delete(thumb));
        thumbBusy.set(thumb, job);
      }
      await thumbBusy.get(thumb);
    }
    let seconds = 0;
    try { seconds = Number(await probeDur(abs)) || 0; } catch { /* ignore */ }
    if (!fs.existsSync(thumb)) return ok({ thumb: "", seconds });
    return ok({ thumb: "data:image/jpeg;base64," + fs.readFileSync(thumb).toString("base64"), seconds });
  });
  h("video:renders.remove", (renderId, opts = {}) => {
    const rec = store.renders.get(renderId);
    if (!rec) return { ok: false, error: "记录不存在" };
    if (rec.status === "queued" || rec.status === "running") return { ok: false, error: "正在合成，不能删除" };
    let filesRemoved = 0;
    if (opts.deleteFiles !== false) {
      for (const rel of [rec.outputPath, rec.srtPath]) {
        const abs = renderAbs(rel);
        if (!abs || !abs.startsWith(videoDir)) continue;
        for (const f of [abs, abs + ".thumb.jpg"]) { try { if (fs.existsSync(f)) { fs.unlinkSync(f); filesRemoved++; } } catch { /* ignore */ } }
      }
    }
    store.renders.remove(renderId);
    return ok({ removed: true, filesRemoved });
  });

  // ---- M2：配音 ----
  h("video:tts.providers", () => ok({ providers: listProviders() }));

  h("video:ffmpeg.status", async (opts = {}) => ok(await ffmpegStatusAsync({ fresh: !!(opts && opts.fresh) })));

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
    // 语速：显式传入 > 项目单独设置（>0 才算设置过）> 设置页全局值 > 1
    const projectRate = project && project.voice ? Number(project.voice.rate) : 0;
    const rate = override.rate != null ? override.rate : (projectRate > 0 ? projectRate : Number(cfg.ttsRate) || 1);
    store.updateShot(shotId, { status: "voicing", error: "" });
    log.info(`开始生成配音：“${String(shot.narration || "").slice(0, 16)}…”，服务 ${provider}，音色 ${voice}`);
    const tmpFile = path.join(os.tmpdir(), `video-tts-${crypto.randomUUID()}.mp3`);
    try {
      const result = await synthesize({
        provider, text: shot.narration, voice, rate, format: "mp3", outFile: tmpFile,
        fetchImpl, apiKey: getTtsKey(),
        ...ttsEndpoint(cfg, provider),
      });
      const bytes = fs.readFileSync(result.file);
      const linked = await linkAudio(store.shots.get(shotId), bytes, result.ext || ".mp3", "generated");
      if (result.file !== tmpFile) { try { fs.unlinkSync(result.file); } catch { /* ignore */ } }
      log.info(`配音完成：${result.seconds ? result.seconds + " 秒" : "时长未测到"}`);
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
  h("video:shots.importAudio", async (shotId, file = {}) => {
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
    const linked = await linkAudio(shot, bytes, ext, "import");
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
  async function linkVideo(shot, { bytes = null, filePath = "", ext = ".mp4", source = "import" } = {}) {
    const assetsDir = path.join(videoDir, `projects/${shot.projectId}/assets`);
    const stored = bytes != null ? storeMediaBytes(bytes, assetsDir, ext) : storeMediaFile(filePath, assetsDir);
    const rel = `projects/${shot.projectId}/assets/${stored.rel}`;
    let asset = findProjectAsset(shot.projectId, "video", stored.hash);
    if (!asset) asset = store.assets.upsert({ kind: "video", path: rel, hash: stored.hash, bytes: stored.bytes, source });
    const seconds = await probeDur(stored.abs);
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
    const record = store.renders.upsert({ projectId, status: "queued", stage: "queued", pct: 0, message: "排队中", outputPath: "", srtPath: "", warnings: [], error: "", burnSubtitles: opts.burnSubtitles !== false });
    store.projects.upsert({ ...project, status: "rendering" });
    // 后台跑，不阻塞 IPC 返回；页面轮询 video:renders.list 看进度。
    void (async () => {
      const update = (patch) => { try { store.renders.upsert({ ...store.renders.get(record.id), ...patch, id: record.id }); } catch { /* ignore */ } };
      try {
        log.info(`开始合成：${project.title || projectId}`);
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
          else log.warn(`背景音乐文件找不到（${voice.bgmName || voice.bgm}），本次合成不加背景音乐`);
        }
        const result = await renderProject({
          project, shots: renderShots, assetsById: assetsById(), videoDir,
          outDir: path.join(videoDir, `projects/${projectId}/output`),
          burnSubtitles: opts.burnSubtitles !== false, bgmFile: bgmAbs, bgmVolume: voice.bgmVolume,
          run: renderRun || undefined, check: renderCheck || undefined,
          onProgress: ({ stage, pct, message }) => update({ stage, pct, message }),
        });
        const doneMessage = result.noSubs
          ? "合成完成（没有口播，无字幕）"
          : result.burned
          ? "合成完成（字幕已烧入，SRT 已另存）"
          : opts.burnSubtitles === false
            ? "合成完成（未烧字幕，SRT 已另存）"
            : "合成完成（字幕烧入失败，仅输出 SRT，见 warnings）";
        log.info(`合成完成：${result.outputPath}`);
        update({ status: "done", stage: "done", pct: 100, message: doneMessage, outputPath: result.outputPath, srtPath: result.srtPath, warnings: result.warnings, endedAt: Date.now() });
        store.projects.upsert({ ...store.projects.get(projectId), status: "done" });
      } catch (err) {
        const message = (err && err.message) || String(err);
        log.error(`合成失败：${message}`);
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
    return startRender(old.projectId, { burnSubtitles: old.burnSubtitles !== false });
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
    if (!v) return { ok: false, error: "分析浏览器未接通" };
    try { return ok(await v.open()); }
    catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  });
  h("video:douyin.show", () => {
    const v = douyinView();
    if (!v) return { ok: false, error: "分析浏览器未接通" };
    return ok({ shown: v.show() });
  });
  h("video:douyin.hide", () => {
    const v = douyinView();
    if (v) v.hide();
    return ok({ hidden: true });
  });
  h("video:douyin.setBounds", (rect) => {
    const v = douyinView();
    if (!v) return { ok: false, error: "分析浏览器未接通" };
    return ok({ applied: v.setBounds(rect) });
  });

  h("video:douyin.extract", async () => {
    const v = douyinView();
    if (!v) return { ok: false, error: "分析浏览器未接通：请先在左边打开视频页后再试，或用手动粘贴链接/文案", manual: true };
    let surface;
    try { surface = v.surface(); }
    catch (err) { return { ok: false, error: (err && err.message) || String(err), manual: true }; }
    if (!surface || !surface.webContents || surface.webContents.isDestroyed()) {
      return { ok: false, error: "分析浏览器未接通：请先在左边打开视频页后再试，或用手动粘贴链接/文案", manual: true };
    }
    try {
      const info = await extractVideoInfo({
        driver: {
          executeJavaScript: (js) => surface.webContents.executeJavaScript(js),
          getURL: () => surface.webContents.getURL(),
        },
      });
      const SITE = { douyin: "抖音", bilibili: "B 站", youtube: "YouTube", web: "网页" };
      log.info(`已读取当前视频（${SITE[info.site] || "网页"}）：${info.author || "未知作者"} · ${(info.title || info.caption || info.url || "").slice(0, 40)}${info.transcript ? `；字幕 ${info.transcript.length} 字` : "；没有字幕"}`);
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

  // 模型列表：kind = "ai"（分析）| "tts"（云端配音）| "tts-local"（本地配音），用对应的地址和 Key 拉 /models；Key 不出主进程
  h("video:ai.models", async (kind = "ai") => {
    try {
      let models;
      if (kind === "tts-voicebox") {
        models = [...VOICEBOX_ENGINES];
      } else if (kind === "tts" || kind === "tts-local") {
        const ep = ttsEndpoint(getTtsSettings(), kind === "tts-local" ? "local" : "openai");
        models = await listModels({ fetchImpl, apiKey: getTtsKey(), keyOptional: kind === "tts-local", baseUrl: ep.baseUrl });
      } else {
        models = await listModels({ fetchImpl, apiKey: getAiKey(), baseUrl: getAiSettings().aiBaseUrl || "https://api.openai.com/v1" });
      }
      return ok({ models });
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err), code: (err && err.code) || "" };
    }
  });

  // 音色列表（本地服务常见 GET /audio/voices）；拿不到返回空数组，页面提示手填
  h("video:tts.voices", async (kind = "tts-local") => {
    if (kind === "tts-voicebox") {
      // Voicebox 的音色 = 声音档案，下拉里显示档案名（生成时按名字找回 id）
      try { return ok({ voices: (await voiceboxProfiles({ fetchImpl, baseUrl: ttsEndpoint(getTtsSettings(), "voicebox").baseUrl })).map((p) => p.name) }); }
      catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
    }
    const ep = ttsEndpoint(getTtsSettings(), kind === "tts-local" ? "local" : "openai");
    try { return ok({ voices: await listVoices({ fetchImpl, apiKey: getTtsKey(), baseUrl: ep.baseUrl }) }); }
    catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  });

  // 分析：只接受已提取的视频信息和/或手动粘贴的文案；AI 失败时不保存、不编造。
  // 0.6.10：作为后台任务跑（任务面板里能看到、能取消），页面上的“取消”也走这里。
  const isCancel = (err) => !!(err && (err.code === "TASK_CANCELLED" || err.name === "AbortError"));
  async function runAnalysis(input = {}, ctx = null) {
    const cfg = getAiSettings();
    const t0 = Date.now();
    const info0 = input.videoInfo || {};
    const signal = ctx ? ctx.signal : undefined;
    const step = (msg) => { if (ctx) { ctx.throwIfCancelled(); ctx.progress(null, msg); } };
    log.info(`开始分析视频：${info0.author ? info0.author + " · " : ""}${(info0.title || info0.caption || input.manualText || info0.url || "（无文案）").slice(0, 40)}；模型 ${cfg.aiModel || "gpt-4o-mini"} @ ${hostOf(cfg.aiBaseUrl || "https://api.openai.com/v1")}`);
    // 看画面：分析浏览器开着时截几帧给支持图片的模型；不支持图片时 analyzeVideo 自动退回纯文本。
    let images = [];
    if (input.useFrames !== false) {
      step("截取画面…");
      const v = douyinView();
      if (v && typeof v.captureFrames === "function") {
        try { images = (await v.captureFrames({ count: 6, intervalMs: 1200 })) || []; }
        catch (err) { images = []; log.warn(`截取画面失败，只用文案分析：${(err && err.message) || err}`); }
      }
      log.info(images.length ? `已截取 ${images.length} 张画面，正在请求 AI…` : "没有截到画面（分析浏览器未打开），只用文案分析，正在请求 AI…");
    } else {
      log.info("手动分析，不截画面，正在请求 AI…");
    }
    step("等待 AI 回复…");
    const baseFetch = aiFetchImpl || fetchImpl;
    const analysis = await analyzeVideo({
      images: Array.from(images), frameTimes: images.times || [], frameDiffs: images.diffs || [],
      fetchImpl: signal ? (u, o = {}) => baseFetch(u, { ...o, signal }) : baseFetch,
      apiKey: getAiKey(),
      baseUrl: cfg.aiBaseUrl || "https://api.openai.com/v1",
      model: cfg.aiModel || "gpt-4o-mini",
      videoInfo: input.videoInfo || {},
      manualText: input.manualText || "",
    });
    if (ctx) ctx.throwIfCancelled();
    const skillText = buildSkillText(analysis);
    const info = input.videoInfo || {};
    const record = store.analyses.upsert({
      sourceUrl: info.url || "", site: info.site || "", sourceTitle: info.title || "",
      videoId: info.videoId || "", author: info.author || "", musicName: info.music || "",
      caption: info.caption || "", likeCountText: info.likeCountText || "",
      commentCountText: info.commentCountText || "", shareCountText: info.shareCountText || "",
      style: analysis.style, skill: analysis.skill, skillText,
      scriptTitle: analysis.script.title, scriptNarration: analysis.script.narration,
      shots: analysis.script.shots, manualText: input.manualText || "",
    });
    log.info(`分析完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒：《${analysis.script.title || "未命名"}》${analysis.script.shots.length} 个镜头${analysis.usedImages ? "，已结合画面" : "，仅依据文案"}`);
    return { analysis, skillText, record, usedImages: !!analysis.usedImages };
  }
  const failOut = (err, t0) => {
    if (isCancel(err)) { log.info("分析已取消"); return { ok: false, cancelled: true, error: "已取消分析" }; }
    log.error(`分析失败（${((Date.now() - t0) / 1000).toFixed(1)} 秒）：${(err && err.message) || err}`);
    return { ok: false, error: (err && err.message) || String(err), retryable: !!(err && err.retryable), code: (err && err.code) || "" };
  };
  let lastAnalysisError = null;
  if (tasks && typeof tasks.register === "function") {
    tasks.register("video-analyze", {
      title: "视频分析",
      single: true,
      async handler(input, ctx) {
        lastAnalysisError = null;
        try { return await runAnalysis(input, ctx); }
        catch (err) { lastAnalysisError = err; throw err; }
      },
    });
  }
  h("video:douyin.analyze", async (input = {}) => {
    const t0 = Date.now();
    if (!tasks) {
      try { return ok(await runAnalysis(input, null)); } catch (err) { return failOut(err, t0); }
    }
    const info0 = input.videoInfo || {};
    const label = (info0.title || info0.caption || info0.author || input.manualText || "").replace(/\s+/g, " ").slice(0, 24);
    const snap = tasks.run("video-analyze", input, { title: label ? `视频分析：${label}` : "视频分析" });
    if (snap.status === "running" && snap.startedAt && snap.startedAt < t0 - 50) return { ok: false, error: "已有一个分析在进行，等它结束或在后台任务里取消" };
    const fin = await tasks.wait(snap.id);
    if (fin && fin.status === "done") return ok(fin.result);
    if (fin && fin.status === "cancelled") return failOut({ code: "TASK_CANCELLED" }, t0);
    return failOut(lastAnalysisError || new Error((fin && fin.error) || "分析失败"), t0);
  });
  h("video:douyin.cancelAnalyze", () => {
    if (!tasks) return ok({ cancelled: 0 });
    let n = 0;
    for (const t of tasks.list()) if (t.type === "video-analyze" && t.cancellable && tasks.cancel(t.id)) n++;
    return ok({ cancelled: n });
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
      title: rec.scriptTitle || "视频分析导入",
      tags: rec.author ? [rec.author] : [],
      aspect: "9:16",
    }, rec.shots.length);
    const ordered = store.shotsOf(project.id);
    rec.shots.forEach((s, i) => {
      // 0.6.17：没有口播的纯画面镜头带上分析出的时长（有口播时配音时长优先）
      if (ordered[i]) store.updateShot(ordered[i].id, { narration: s.narration, visual: s.visual, imagePrompt: s.imagePrompt, ...(s.seconds > 0 && !String(s.narration || "").trim() ? { seconds: s.seconds } : {}) });
    });
    return ok({ project, shots: store.shotsOf(project.id) });
  });
  h("video:shots.importVideo", async (shotId, file = {}) => {
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
    const linked = await linkVideo(shot, { bytes, ext: path.extname(name).toLowerCase(), source: "import" });
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
      // 下载监听只在这一次等待期间挂着：超时/没点到按钮时立即摘掉，
      // 否则用户之后在视图里手动下载的文件会被悄悄截到素材目录里。
      const downloaded = await new Promise((resolve) => {
        const session = win.webContents.session;
        const savePath = path.join(videoDir, `projects/${shot.projectId}/assets/.jimeng-${shot.id}-${Date.now()}.mp4`);
        let settled = false;
        let timer = null;
        const onDownload = (_e, item) => {
          detach();
          try { item.setSavePath(savePath); } catch { /* ignore */ }
          item.on("done", (_ev, state) => {
            if (settled) { try { fs.unlinkSync(savePath); } catch { /* ignore */ } return; }
            done(state === "completed", savePath);
          });
        };
        // __autoCapture：通知主进程的通用“浏览器下载→收件箱”逻辑这次下载归自动生成，别抢
        const detach = () => { try { if (session) session.__autoCapture = false; if (session && typeof session.removeListener === "function") session.removeListener("will-download", onDownload); } catch { /* ignore */ } };
        const done = (okVal, file) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          detach();
          resolve({ ok: okVal, file });
        };
        try {
          if (session && typeof session.on === "function") { session.__autoCapture = true; session.on("will-download", onDownload); }
          else return done(false, "");
        } catch { return done(false, ""); }
        timer = setTimeout(() => done(false, ""), 90000);
        // 只点“下载”本身（或“下载视频/下载片段”），排除“下载APP/下载客户端”之类的推广按钮
        win.webContents.executeJavaScript(
          `(() => { const bad = /APP|App|app|客户端|电脑版|剪映/; const btns = [...document.querySelectorAll('button, [role=button]')].filter((x) => { const t = (x.textContent || '').trim(); return t && t.length <= 8 && /下载/.test(t) && !bad.test(t) && x.offsetParent !== null; }); const b = btns.find((x) => (x.textContent || '').trim() === '下载') || btns[btns.length - 1]; if (!b) return false; b.click(); return true; })()`,
        ).then((clicked) => { if (!clicked) done(false, ""); }).catch(() => done(false, ""));
      });
      if (!downloaded.ok || !downloaded.file || !fs.existsSync(downloaded.file)) {
        throw new JimengError("即梦片段已生成但自动下载未完成，已把内嵌视图留给用户：请在视图里手动下载片段，再用“导入片段”导进来。", { code: "DOWNLOAD_FAILED", manualFallback: true });
      }
      const linked = await linkVideo(store.shots.get(shotId), { filePath: downloaded.file, source: "generated" });
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

  // 0.6.9：生成网站浏览器里下载的视频（主进程收进 <video>/inbox），合成页列出并挂到镜头
  const inboxDir = () => path.join(videoDir, "inbox");
  const inboxFile = (name) => {
    const n = path.basename(String(name || ""));
    const abs = path.join(inboxDir(), n);
    return n && !n.startsWith(".") && fs.existsSync(abs) ? abs : "";
  };
  h("video:downloads.list", () => {
    let names = [];
    try { names = fs.readdirSync(inboxDir()).filter((n) => !n.startsWith(".") && isVideoFile(n)); } catch { names = []; }
    const files = names.map((name) => {
      const st = fs.statSync(path.join(inboxDir(), name));
      return { name, label: name.replace(/^\d{10,}-/, ""), bytes: st.size, mtime: st.mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime).slice(0, 50);
    return ok({ files });
  });
  h("video:downloads.attach", async (name, shotId) => {
    const abs = inboxFile(name);
    if (!abs) return { ok: false, error: "下载的文件找不到了，可能已被挂到镜头或删除" };
    const shot = store.shots.get(shotId);
    if (!shot) return { ok: false, error: "镜头不存在" };
    const linked = await linkVideo(shot, { filePath: abs, source: "import" });
    try { fs.unlinkSync(abs); } catch { /* ignore */ }
    log.info(`已把下载的片段挂到第 ${(shot.order || 0) + 1} 镜：${path.basename(abs).replace(/^\d{10,}-/, "")}`);
    return ok(linked);
  });
  h("video:downloads.remove", (name) => {
    const abs = inboxFile(name);
    if (abs) { try { fs.unlinkSync(abs); } catch (err) { return { ok: false, error: err.message }; } }
    return ok({ removed: !!abs });
  });
  h("video:downloads.openFolder", () => {
    fs.mkdirSync(inboxDir(), { recursive: true });
    if (typeof openPath === "function") openPath(inboxDir());
    return ok({ dir: inboxDir() });
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
