"use strict";
// 主进程。本文件可能来自安装包内置的 app.asar，也可能来自 <userData>/updates/ 里下载的新应用层；
// 所有资源路径都相对本文件的 __dirname，自然落在当前应用层里。
//
// 命令行参数：
//   --no-updates   不加载已下载的应用层，也不自动检查更新（由启动器处理加载部分）
//   --app-gpu      macOS 上恢复显卡加速（默认关闭，见下）
//   --smoke-test   CI 冒烟测试：打开窗口、检查页面和预加载接口后退出（退出码 0 = 通过）
const electron = require("electron");
const { app, BrowserWindow, ipcMain, shell, net, nativeTheme, safeStorage } = electron;
const path = require("path");
const fs = require("fs");
const { loadConfig } = require("./lib/config");
const { createUpdater } = require("./lib/updater");
const core = require("./lib/update-core");
const { createSettings, BASE_SCHEMA } = require("./lib/settings");
const { createLogger } = require("./lib/logger");
const { createTaskManager } = require("./lib/tasks");
const { setupShellIpc } = require("./lib/shell-ipc");
const { createVideoStore } = require("./lib/video-store");
const { setupVideoIpc } = require("./lib/video-ipc");
const { createSecretsStore } = require("./lib/video/secrets");

const config = loadConfig(__dirname);
const TIMEOUT_MS = 25000; // 所有页面加载 / 网络请求的超时上限
const SMOKE = process.argv.includes("--smoke-test");
const NO_UPDATES = process.argv.includes("--no-updates") || process.env.APP_NO_UPDATES === "1";

// 部分 Mac 上 Chromium 的 ANGLE Metal 后端编译着色器失败（日志里是 "Function main0 was not found"），
// 窗口一直黑屏不出画面。默认关掉硬件加速改用软件合成（必须在 app ready 之前调用）；
// 需要显卡加速（WebGL、大量动画）时加 --app-gpu 启动。
if (process.platform === "darwin" && !process.argv.includes("--app-gpu") && !app.isReady()) {
  try { app.disableHardwareAcceleration(); } catch { /* ignore */ }
}

// ---------------- 应用层信息（由 boot/bootstrap.js 提供；直接 electron main.js 运行时用兜底值） ----------------
const LAYER_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version; } catch { return app.getVersion(); } })();
const BOOT = global.__appBoot || {
  protocol: core.BOOT_PROTOCOL, version: LAYER_VERSION, bundledVersion: LAYER_VERSION, source: "bundled", electron: process.versions.electron,
  updatesDir: path.join(app.getPath("userData"), "updates"), rejected: [],
  markReady() {}, markGood() {}, cancelLaunch() {}, fail() {},
};

// ---------------- 通用外壳：设置、日志、后台任务 ----------------
// 数据目录 = userData（boot/bootstrap.js 已设为 appData/<appName>）；APP_DATA_DIR 可覆盖（测试用）
const DATA_DIR = process.env.APP_DATA_DIR || app.getPath("userData");
// 自己的设置项加在这里，例如 { ...BASE_SCHEMA, exportDir: { type: "string", default: "" } }
const settings = createSettings({ file: path.join(DATA_DIR, "settings.json"), schema: {
  ...BASE_SCHEMA,
  // 视频默认值（M1：新建项目时用）与配音设置（M2：服务商/音色/语速/服务地址/模型）
  videoDefaultDuration: { type: "number", min: 10, max: 300, step: 1, default: 75 },
  videoDefaultShotCount: { type: "number", min: 1, max: 12, step: 1, default: 6 },
  videoAspect: { type: "enum", values: ["9:16", "16:9", "1:1"], default: "9:16" },
  ttsProvider: { type: "enum", values: ["openai", "jimeng"], default: "openai" },
  ttsVoice: { type: "string", maxLength: 64, default: "alloy" },
  ttsRate: { type: "number", min: 0.5, max: 2, step: 0.05, default: 1 },
  ttsBaseUrl: { type: "string", maxLength: 500, default: "" },
  ttsModel: { type: "string", maxLength: 64, default: "tts-1" },
} });
const logger = createLogger({ dir: path.join(DATA_DIR, "logs"), level: settings.get("logLevel"), echo: !app.isPackaged || SMOKE });
const tasks = createTaskManager({ concurrency: 2, logger });
const log = logger.scope("main");
logger.prune();
log.info(`启动 ${config.productName} ${LAYER_VERSION}（${BOOT.source === "update" ? "已更新的应用层" : "安装包内置"}，Electron ${process.versions.electron}，${process.platform}-${process.arch}）`);
for (const r of BOOT.rejected || []) log.warn("跳过的应用层：" + (typeof r === "string" ? r : JSON.stringify(r)));

// 在这里注册自己的后台任务（见 lib/tasks.js 顶部注释）。示例任务：分步骤模拟一个耗时操作
tasks.register("demo", {
  title: "示例任务",
  async handler({ steps = 20, interval = 250 } = {}, ctx) {
    const n = Math.max(1, Math.min(200, Number(steps) || 20));
    for (let i = 1; i <= n; i++) {
      await new Promise((r) => setTimeout(r, Math.max(10, Math.min(5000, Number(interval) || 250))));
      ctx.throwIfCancelled();
      ctx.progress((i / n) * 100, `第 ${i}/${n} 步`);
      if (i === Math.ceil(n / 2)) ctx.log("示例任务过半");
    }
    return { steps: n };
  },
});

// 带超时的 Promise：超时后 reject（用于页面加载、executeJavaScript 等）
function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}超时（${Math.round(ms / 1000)} 秒）`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

// net.fetch（走系统代理）+ 25 秒内必须拿到响应头；拿到后不限制下载时长（下载器自己有卡顿检测）
function timedFetch(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, ctl.signal]) : ctl.signal;
  return net.fetch(url, { ...opts, signal }).finally(() => clearTimeout(t));
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
  }
}

// ---------------- 单实例 ----------------
const gotLock = SMOKE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  BOOT.cancelLaunch();
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) createWindow();
    else { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  });
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    title: config.productName,
    show: false, // 先隐藏，画好第一帧再显示，避免白屏闪烁
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#17191e" : "#f5f6f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const win = mainWindow;
  // ready-to-show 偶尔不来（GPU/合成问题）：3 秒后兜底显示，再强制重绘一次
  let revealed = false;
  const reveal = () => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    if (SMOKE) return; // 冒烟测试不弹窗
    win.show(); win.focus();
    setTimeout(() => { if (!win.isDestroyed()) { try { win.webContents.invalidate(); } catch { /* ignore */ } } }, 120);
  };
  win.once("ready-to-show", reveal);
  setTimeout(reveal, 3000);
  win.on("closed", () => { if (mainWindow === win) mainWindow = null; });
  win.webContents.once("did-finish-load", () => BOOT.markReady());
  win.webContents.on("did-finish-load", () => { try { win.webContents.setZoomFactor(settings.get("zoom")); } catch { /* ignore */ } });
  win.webContents.on("render-process-gone", (_e, d) => log.error(`页面进程退出：${d.reason}（${d.exitCode}）`));
  // 外部链接一律交给系统浏览器，且只放行 https
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:")) e.preventDefault(); });
  return withTimeout(win.loadFile(path.join(__dirname, "renderer", "index.html")), TIMEOUT_MS, "页面加载")
    .catch((err) => { log.error(err.message); });
}

// ---------------- 应用内增量更新 ----------------
const ofs = (() => { try { return require("original-fs"); } catch { return fs; } })(); // .asar 当普通文件写
const updater = createUpdater({ fetchImpl: timedFetch, fsImpl: ofs, boot: BOOT, config });
const ulog = logger.scope("update");
let lastCheck = null;

function stripManifest(r) { if (!r) return r; const { manifest, ...rest } = r; return rest; }

async function checkUpdate({ auto } = {}) {
  const r = await updater.check();
  lastCheck = r;
  if (!r.ok) ulog.warn("检查更新失败：" + (r.detail || r.message || r.error));
  else if (r.available) ulog.info(`发现新版本 ${r.latest}${r.needsFull ? "（需要完整安装包）" : ""}`);
  else ulog.debug("已是最新版本");
  broadcast("update:status", { phase: "checked", result: stripManifest(r) });
  // 启动后自动检查：有可增量更新的新版本就直接在后台下载，下载完界面提示「重启生效」
  if (auto && r.ok && r.available && !r.needsFull && !r.badBefore && !r.alreadyDownloaded) await downloadUpdate(r.manifest);
  return r;
}
async function downloadUpdate(manifest) {
  broadcast("update:progress", { pct: 0, received: 0, total: manifest.size, source: "" });
  ulog.info(`开始下载 ${manifest.version}`);
  const r = await updater.download(manifest, (p) => broadcast("update:progress", p));
  if (r.ok) ulog.info(`已下载 ${r.version}，重启后生效`); else ulog.error("下载更新失败：" + (r.detail || r.message || r.error));
  broadcast("update:status", { phase: r.ok ? "downloaded" : "error", result: r });
  return r;
}

ipcMain.handle("app:info", () => ({ ...updater.info(), platform: process.platform, arch: process.arch }));
ipcMain.handle("update:info", () => ({ ...updater.info(), lastCheck: stripManifest(lastCheck), downloading: updater.downloading }));
ipcMain.handle("update:check", async () => stripManifest(await checkUpdate({ auto: false })));
ipcMain.handle("update:download", async () => {
  if (!lastCheck || !lastCheck.ok || !lastCheck.available) await checkUpdate({ auto: false });
  if (!lastCheck || !lastCheck.ok) return { ok: false, error: (lastCheck && lastCheck.error) || "检查更新失败", message: (lastCheck && lastCheck.message) || "检查更新失败" };
  if (!lastCheck.available) return { ok: false, error: "已是最新版本", message: "已是最新版本" };
  if (lastCheck.needsFull) return { ok: false, needsFull: true, installerUrl: lastCheck.installerUrl, error: "需要下载完整安装包", message: "这个版本需要下载完整安装包" };
  return downloadUpdate(lastCheck.manifest);
});
ipcMain.handle("update:restart", () => { app.relaunch(); app.exit(0); return true; });
ipcMain.handle("update:openUrl", (_e, url) => { if (/^https:\/\//.test(String(url))) shell.openExternal(String(url)); return true; });

setupShellIpc({ electron, settings, logger, tasks, dataDir: DATA_DIR, broadcast, getWindows: () => BrowserWindow.getAllWindows() });

// 视频项目存储（M1）：<数据目录>/data/video/*.json
// TTS Key 单独存（M2）：优先 safeStorage 加密，页面只拿到“已设置/末 4 位”，Key 只在主进程发 TTS 请求时用。
const videoDir = path.join(DATA_DIR, "data", "video");
const videoStore = createVideoStore(videoDir);
const ttsSecrets = createSecretsStore({ file: path.join(DATA_DIR, "secrets.json"), safeStorage });
// TTS 网络请求走 net.fetch（走系统代理），包装成 tts.js 约定的 { ok, status, arrayBuffer, text }。
const ttsFetch = async (url, opts) => {
  const res = await net.fetch(url, opts);
  return { ok: res.ok, status: res.status, arrayBuffer: async () => res.arrayBuffer(), text: async () => res.text() };
};
// 即梦内嵌窗口（M3）：持久会话 persist:jimeng，登录一次后保持；
// 生成与下载仍由用户或 jimeng.js 的自动操作在窗口里完成，主进程不读页面账号密码。
let jimengWindow = null;
function createJimengWindow() {
  if (jimengWindow && !jimengWindow.isDestroyed()) { jimengWindow.show(); jimengWindow.focus(); return jimengWindow; }
  const win = new BrowserWindow({
    width: 1200, height: 800, title: "即梦",
    webPreferences: { partition: "persist:jimeng", contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => { if (jimengWindow === win) jimengWindow = null; });
  jimengWindow = win;
  win.loadURL("https://jimeng.jianying.com").catch((err) => log.error("打开即梦失败：" + err.message));
  return win;
}

setupVideoIpc({
  ipcMain, store: videoStore, videoDir,
  createJimengWindow,
  openPath: (p) => { try { shell.openPath(p); } catch { /* ignore */ } return true; },
  videoDefaults: { defaultShotCount: settings.get("videoDefaultShotCount"), aspect: settings.get("videoAspect") },
  getTtsSettings: () => ({
    ttsProvider: settings.get("ttsProvider"), ttsVoice: settings.get("ttsVoice"), ttsRate: settings.get("ttsRate"),
    ttsBaseUrl: settings.get("ttsBaseUrl"), ttsModel: settings.get("ttsModel"),
  }),
  getTtsKey: () => ttsSecrets.get("ttsApiKey"),
  fetchImpl: ttsFetch,
  secrets: ttsSecrets,
});

// ---------------- CI 冒烟测试 ----------------
function runSmokeTest() {
  const errors = [];
  const hardStop = setTimeout(() => { console.log("SMOKE TIMEOUT"); app.exit(2); }, 60000);
  mainWindow.webContents.on("console-message", (_e, level, message) => { if (level >= 3) errors.push(message); });
  const run = async () => {
    const out = await withTimeout(mainWindow.webContents.executeJavaScript(`(async () => {
      const a = window.app;
      const info = await a.info();
      const upd = await a.update.info();
      await new Promise((r) => setTimeout(r, 500));
      const navs = [...document.querySelectorAll("#nav .nav-item")].map((b) => b.dataset.page);
      // 切到设置页，确认更新卡片在
      window.Shell.navigate("settings");
      for (let i = 0; i < 40 && !document.getElementById("update-card"); i++) await new Promise((r) => setTimeout(r, 50));
      const settingsVisible = !document.getElementById("page-settings").hidden;
      // 跑一个很快的示例任务，等它完成
      const res = await a.tasks.run("demo", { steps: 3, interval: 20 });
      let task = null;
      for (let i = 0; i < 100 && res.ok; i++) {
        task = (await a.tasks.list()).find((t) => t.id === res.task.id);
        if (task && ["done", "failed", "cancelled"].includes(task.status)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const logs = await a.logs.list({});
      // 视频 M1：新建项目、打开分镜编辑器，确认镜头行渲染出来，再删掉
      let videoOk = false;
      try {
        const created = await a.video.projects.create({ title: "冒烟项目" });
        const pid = created.project.id;
        window.VideoApp.openProject(pid);
        window.Shell.navigate("editor");
        for (let i = 0; i < 40 && !document.querySelector("#page-editor .shot-row"); i++) await new Promise((r) => setTimeout(r, 50));
        const shotRows = document.querySelectorAll("#page-editor .shot-row").length;
        const reopened = await a.video.projects.get(pid);
        videoOk = created.ok && shotRows >= 1 && reopened.ok && reopened.shots.length >= 1 && reopened.project.title === "冒烟项目";
        await a.video.projects.remove(pid);
      } catch (e) { videoOk = false; }
      // 视频 M2：导入配音（真实 WAV 走 ffprobe 实测）、试听数据、服务商列表、ffmpeg 状态、
      // 即梦占位报错、编辑器里每镜的配音按钮渲染出来，再删掉（不点文件选择框与真实网络生成）
      let videoM2Ok = false;
      try {
        const created2 = await a.video.projects.create({ title: "冒烟配音" });
        const pid2 = created2.project.id;
        const got2 = await a.video.projects.get(pid2);
        const shotId = got2.shots[0].id;
        await a.video.shots.update(shotId, { narration: "你好世界" });
        const wavBuf = (() => {
          const samples = 8000, buf = new ArrayBuffer(44 + samples * 2), v = new DataView(buf);
          const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
          ws(0, "RIFF"); v.setUint32(4, 36 + samples * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
          v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
          v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
          ws(36, "data"); v.setUint32(40, samples * 2, true); return buf;
        })();
        const imp = await a.video.shots.importAudio(shotId, { name: "voice.wav", data: wavBuf });
        const after = await a.video.projects.get(pid2);
        const shotAfter = after.shots.find((s) => s.id === shotId);
        const audio = await a.video.shots.audioData(shotId);
        const providers = await a.video.tts.providers();
        const ff = await a.video.ffmpeg.status();
        const jimeng = await a.video.shots.generateAudio(shotId, { provider: "jimeng" });
        window.VideoApp.openProject(pid2);
        window.Shell.navigate("editor");
        for (let i = 0; i < 40 && !document.querySelector("#page-editor .shot-row"); i++) await new Promise((r) => setTimeout(r, 50));
        const btnTexts = [...document.querySelectorAll("#page-editor .shot-row .btn")].map((b) => b.textContent.trim());
        videoM2Ok = imp.ok && imp.measured && shotAfter.audioSource === "import" && shotAfter.audioSeconds === 1
          && audio.ok && audio.dataUrl.startsWith("data:audio/wav;base64,")
          && providers.providers.some((p) => p.id === "openai") && providers.providers.some((p) => p.id === "jimeng" && !p.automated)
          && typeof ff.ffmpeg === "boolean" && typeof ff.ffprobe === "boolean"
          && jimeng.ok === false && /尚未自动接通/.test(jimeng.error)
          && btnTexts.includes("生成配音") && btnTexts.includes("导入音频") && btnTexts.includes("试听");
        await a.video.projects.remove(pid2);
      } catch (e) { videoM2Ok = false; }
      // 视频 M3：导入 1 秒配音后开始合成（真实系统 ffmpeg），轮询到完成，
      // 成片与 SRT 路径齐全；合成导出页能打开并显示“开始合成”按钮。
      // （ffmpeg 缺失时合成应明确失败，冒烟按“失败且错误含 ffmpeg”判定，不谎称成功）
      let videoM3Ok = false;
      let videoM3Debug = {};
      try {
        const created3 = await a.video.projects.create({ title: "冒烟合成" });
        const pid3 = created3.project.id;
        const got3 = await a.video.projects.get(pid3);
        const shotId3 = got3.shots[0].id;
        await a.video.shots.update(shotId3, { narration: "你好世界" });
        const wavBuf3 = (() => {
          const samples = 8000, buf = new ArrayBuffer(44 + samples * 2), v = new DataView(buf);
          const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
          ws(0, "RIFF"); v.setUint32(4, 36 + samples * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
          v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
          v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
          ws(36, "data"); v.setUint32(40, samples * 2, true); return buf;
        })();
        const imp3 = await a.video.shots.importAudio(shotId3, { name: "voice.wav", data: wavBuf3 });
        const ff3 = await a.video.ffmpeg.status();
        const started = await a.video.renders.start(pid3, { burnSubtitles: false });
        let rec = null;
        for (let i = 0; i < 120 && started.ok; i++) {
          const rs = await a.video.renders.list(pid3);
          rec = (rs.renders || [])[0] || null;
          if (rec && (rec.status === "done" || rec.status === "failed")) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        window.VideoApp.openProject(pid3);
        window.Shell.navigate("render");
        let renderBtns = [];
        for (let i = 0; i < 100; i++) {
          renderBtns = [...document.querySelectorAll("#page-render .btn")].map((b) => b.textContent.trim());
          if (renderBtns.includes("开始合成")) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        videoM3Ok = imp3.ok && started.ok && !!rec
          && ((ff3.ok && rec.status === "done" && rec.outputPath.endsWith(".mp4") && rec.srtPath.endsWith(".srt"))
            || (!ff3.ok && rec.status === "failed" && /ffmpeg/.test(rec.error || "")))
          && renderBtns.includes("开始合成");
        videoM3Debug = { imp3: imp3.ok, started: started.ok, startedError: started.error || "", ffOk: ff3.ok, rec: rec ? { status: rec.status, outputPath: rec.outputPath, srtPath: rec.srtPath, error: rec.error, message: rec.message } : null, renderBtns };
        await a.video.projects.remove(pid3);
      } catch (e) { videoM3Ok = false; videoM3Debug = { exception: e.message }; }
      // 右侧运行日志面板能打开，外观设置能生效
      window.Shell.toggleLogDock(true);
      window.Shell.saveSettings({ background: "night", fontSize: 15 });
      await new Promise((r) => setTimeout(r, 300));
      const dock = !document.getElementById("logdock").hidden && !!document.querySelector("#logdock .log-list");
      const look = document.documentElement.dataset.bg === "night" && getComputedStyle(document.body).fontSize === "15px";
      window.Shell.toggleLogDock(false);
      return {
        videoM3Ok, videoM3Debug,
        api: typeof a === "object" && typeof a.update.check === "function" && typeof a.settings.set === "function",
        nodeHidden: typeof require === "undefined" && typeof process === "undefined",
        name: document.getElementById("app-name").textContent.trim(),
        version: document.getElementById("app-version").textContent.trim(),
        card: !!document.getElementById("update-card"),
        navs, settingsVisible,
        theme: document.documentElement.dataset.theme || "",
        task: task && task.status,
        logCount: logs.length, dock, look, videoOk, videoM2Ok,
        info, source: upd.source,
      };
    })()`, true), TIMEOUT_MS, "页面脚本");
    const result = { ...out, layerVersion: LAYER_VERSION, boot: { source: BOOT.source, version: BOOT.version, bundled: BOOT.bundledVersion, electron: BOOT.electron }, platform: process.platform, rendererErrors: errors };
    const ok = out.api && out.nodeHidden && out.card && out.name === config.productName && out.version.includes(LAYER_VERSION)
      && ["home", "projects", "editor", "render", "tasks", "logs", "settings"].every((p) => out.navs.includes(p)) && out.settingsVisible
      && /^(light|dark)$/.test(out.theme) && out.task === "done" && out.logCount > 0 && out.dock && out.look && out.videoOk && out.videoM2Ok && out.videoM3Ok && !errors.length;
    console.log((ok ? "SMOKE OK " : "SMOKE FAIL ") + JSON.stringify(result));
    clearTimeout(hardStop);
    BOOT.markGood();
    app.exit(ok ? 0 : 1);
  };
  const go = () => run().catch((err) => { console.log("SMOKE FAIL " + ((err && err.stack) || err)); app.exit(1); });
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once("did-finish-load", go); else go();
}

// ---------------- 启动 ----------------
if (gotLock) {
  app.whenReady().then(() => {
    createWindow();
    if (SMOKE) { runSmokeTest(); return; }
    if (!NO_UPDATES && settings.get("autoCheckUpdate")) setTimeout(() => { checkUpdate({ auto: true }).catch(() => {}); }, 6000);
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  // macOS 习惯：关掉窗口应用仍留在 Dock；其他系统直接退出
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", () => { tasks.cancelAll(); log.info("退出"); });
}
