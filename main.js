"use strict";
// 主进程。本文件可能来自安装包内置的 app.asar，也可能来自 <userData>/updates/ 里下载的新应用层；
// 所有资源路径都相对本文件的 __dirname，自然落在当前应用层里。
//
// 命令行参数：
//   --no-updates   不加载已下载的应用层，也不自动检查更新（由启动器处理加载部分）
//   --app-gpu      macOS 上恢复显卡加速（默认关闭，见下）
//   --smoke-test   CI 冒烟测试：打开窗口、检查页面和预加载接口后退出（退出码 0 = 通过）
const electron = require("electron");
const { app, BrowserWindow, BrowserView, WebContentsView, ipcMain, shell, net, nativeTheme, safeStorage } = electron;
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
const publish = require("./lib/video/publish");
const { setupVideoIpc } = require("./lib/video-ipc");
const { createSecretsStore } = require("./lib/video/secrets");
const { ensureBinPath } = require("./lib/video/bin-path");

// 从 Finder/Dock/开始菜单启动时 PATH 不含 Homebrew / winget 等目录，系统 ffmpeg 会“找不到”。
// 在任何 ffmpeg/ffprobe 调用之前补全一次。
try { ensureBinPath(); } catch { /* ignore */ }

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
  videoDefaultShotCount: { type: "number", min: 1, max: 30, step: 1, default: 6 },
  videoAspect: { type: "enum", values: ["9:16", "16:9", "1:1"], default: "9:16" },
  ttsProvider: { type: "enum", values: ["openai", "local", "voicebox", "jimeng"], default: "openai" },
  ttsVoice: { type: "string", maxLength: 64, default: "alloy" },
  ttsRate: { type: "number", min: 0.5, max: 2, step: 0.05, default: 1 },
  ttsBaseUrl: { type: "string", maxLength: 500, default: "" },
  ttsModel: { type: "string", maxLength: 128, default: "tts-1" },
  // 本地 TTS（0.6.1）：本机跑的 OpenAI 兼容语音服务（Kokoro-FastAPI、openedai-speech、CosyVoice/IndexTTS 的兼容封装等），Key 可空
  ttsLocalBaseUrl: { type: "string", maxLength: 500, default: "http://127.0.0.1:8880/v1" },
  ttsLocalModel: { type: "string", maxLength: 128, default: "kokoro" },
  // Voicebox（0.6.2）：本机声音克隆工作室，桌面版后端默认 17493 端口；引擎默认 qwen（Qwen3-TTS）
  ttsVoiceboxBaseUrl: { type: "string", maxLength: 500, default: "http://127.0.0.1:17493" },
  ttsVoiceboxEngine: { type: "string", maxLength: 64, default: "qwen" },
  ttsVoiceboxModelSize: { type: "enum", values: ["1.7B", "0.6B"], default: "1.7B" },
  ttsVoiceboxLanguage: { type: "enum", values: ["zh", "en", "ja", "ko"], default: "zh" },
  // AI 文本分析（M4：抖音分析用 OpenAI 兼容 chat completions；Key 走 secrets 存储，不进 settings.json）
  aiBaseUrl: { type: "string", maxLength: 500, default: "" },
  aiModel: { type: "string", maxLength: 128, default: "gpt-4o-mini" },
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
  // 窗口大小变了，内嵌视图按页面最新上报的位置重算一次（页面侧 resize 时也会上报）
  win.on("resize", () => { for (const st of embeddedViews.values()) if (st.visible) applyViewBounds(st); });
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

// ---------------- 内嵌视图（M4）：即梦 / 抖音嵌在主窗口里，不再弹独立窗口 ----------------
// WebContentsView（Electron 30+ 推荐）优先，拿不到时退回已弃用的 BrowserView。
// 视图只在对应页面激活时显示，切走页面时隐藏（页面侧 onHide 调 hide 通道）；
// 位置由页面侧上报占位元素的 rect（CSS 像素），这里按界面缩放换算成 DIP 后 setBounds。
const ViewClass = WebContentsView || BrowserView;
const USE_WCV = !!WebContentsView;
const embeddedViews = new Map(); // kind -> { view, bounds, loaded, visible, url }

function attachEmbeddedView(view) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (USE_WCV) mainWindow.contentView.addChildView(view);
  else mainWindow.setBrowserView(view);
  return true;
}
function detachEmbeddedView(view) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (USE_WCV) { try { mainWindow.contentView.removeChildView(view); } catch { /* ignore */ } }
  else if (typeof mainWindow.getBrowserView === "function" && mainWindow.getBrowserView() === view) mainWindow.setBrowserView(null);
}
function applyViewBounds(st) {
  if (!st || !st.bounds || !st.view || st.view.webContents.isDestroyed()) return;
  const zoom = Number(settings.get("zoom")) || 1;
  const b = st.bounds;
  try {
    st.view.setBounds({
      x: Math.max(0, Math.round(b.x * zoom)),
      y: Math.max(0, Math.round(b.y * zoom)),
      width: Math.max(50, Math.round(b.width * zoom)),
      height: Math.max(50, Math.round(b.height * zoom)),
    });
  } catch (err) { log.error("内嵌视图定位失败：" + err.message); }
}
function browserUserAgent() {
  const chrome = process.versions.chrome || "130.0.0.0";
  const os = process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7"
    : process.platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}
// 0.6.21：Google 会拦“内嵌浏览器”（此浏览器或应用可能不安全）。访问 accounts.google.com 时
// 请求头和页面里的 UA 都换成 Firefox，并去掉 Sec-CH-UA 头；离开后换回 Chrome UA。
function hookGoogleHeaders(sess) {
  if (!sess || sess.__googleUaHooked) return;
  sess.__googleUaHooked = true;
  try {
    sess.webRequest.onBeforeSendHeaders({ urls: ["https://accounts.google.com/*"] }, (details, cb) => {
      cb({ requestHeaders: publish.rewriteGoogleHeaders(details.requestHeaders) });
    });
  } catch (err) { log.warn("Google 登录兼容设置失败：" + err.message); }
}
function hookAuthUa(wc) {
  wc.on("did-start-navigation", (details, legacyUrl, _inPlace, legacyMain) => {
    // Electron 新版：details.url / details.isMainFrame；旧版：(event, url, isInPlace, isMainFrame)
    const u = (details && details.url) || legacyUrl;
    const isMain = details && details.isMainFrame !== undefined ? details.isMainFrame : legacyMain !== false;
    if (!isMain || !u) return;
    const want = publish.GOOGLE_HOST_RE.test(u) ? publish.firefoxUserAgent() : browserUserAgent();
    try { if (wc.getUserAgent() !== want) wc.setUserAgent(want); } catch { /* ignore */ }
  });
}
// 0.6.15：记住每类内嵌浏览器打开的标签（网址+当前标签），下次启动打开时恢复
const EMBED_TABS_FILE = path.join(DATA_DIR, "embed-tabs.json");
const embedSaveTimers = new Map();
function readSavedEmbedTabs(kind) {
  try {
    const all = JSON.parse(fs.readFileSync(EMBED_TABS_FILE, "utf8"));
    const o = all && all[kind];
    const urls = (o && Array.isArray(o.urls) ? o.urls : []).filter((u) => typeof u === "string" && /^https?:\/\//i.test(u)).slice(0, 12);
    if (!urls.length) return null;
    const active = Math.min(urls.length - 1, Math.max(0, Math.floor(Number(o.active) || 0)));
    return { urls, active };
  } catch { return null; }
}
function saveEmbedTabsNow(kind) {
  const st = embeddedViews.get(kind);
  if (!st || !st.loaded) return;
  const live = st.tabs.filter((t) => !t.view.webContents.isDestroyed());
  const urls = live.map((t) => t.view.webContents.getURL() || t.pendingUrl || "").filter((u) => /^https?:\/\//i.test(u || ""));
  if (!urls.length) return;
  const activeTab = live.find((t) => t.id === st.activeId);
  const active = Math.max(0, urls.indexOf(activeTab ? (activeTab.view.webContents.getURL() || activeTab.pendingUrl || "") : ""));
  let all = {};
  try { all = JSON.parse(fs.readFileSync(EMBED_TABS_FILE, "utf8")) || {}; } catch { all = {}; }
  all[kind] = { urls, active, savedAt: new Date().toISOString() };
  try { fs.writeFileSync(EMBED_TABS_FILE, JSON.stringify(all, null, 2)); } catch (err) { log.warn("保存内嵌浏览器标签失败：" + err.message); }
}
function saveEmbedTabsSoon(kind) {
  clearTimeout(embedSaveTimers.get(kind));
  embedSaveTimers.set(kind, setTimeout(() => saveEmbedTabsNow(kind), 800));
}
function saveAllEmbedTabs() { for (const kind of embeddedViews.keys()) { clearTimeout(embedSaveTimers.get(kind)); saveEmbedTabsNow(kind); } }

// 0.6.9：每类内嵌视图（jimeng=生成网站浏览器，douyin=视频分析浏览器）支持多标签。
// st.view 永远指向当前标签的视图，其余代码（显示/隐藏/定位/截图/自动化）照旧只认 st.view。
let tabSeq = 0;
function createTabView(kind, partition) {
  const view = new ViewClass({
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // 站内“新标签页打开”的链接：像浏览器一样开一个新标签
  view.webContents.setWindowOpenHandler(({ url: u }) => {
    // 0.6.21：第三方登录（Google/Apple/Facebook…）用真正的弹窗打开，保留 window.opener，登录完原页面才能拿到结果
    if (publish.isAuthPopupUrl(u)) {
      return { action: "allow", overrideBrowserWindowOptions: {
        width: 520, height: 720, autoHideMenuBar: true, title: "登录",
        webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
      } };
    }
    if (/^https?:\/\//.test(u)) setImmediate(() => { try { addEmbedTab(kind, u); } catch { /* ignore */ } });
    return { action: "deny" };
  });
  view.webContents.on("did-create-window", (child) => {
    try { child.webContents.setUserAgent(browserUserAgent()); } catch { /* ignore */ }
    hookAuthUa(child.webContents);
  });
  hookAuthUa(view.webContents);
  hookGoogleHeaders(view.webContents.session);
  const push = () => pushEmbedState(kind);
  // 页面缩放：跨站跳转后 Chromium 会重置，按本类视图记住的比例重新套上
  view.webContents.on("did-navigate", () => {
    const cur = embeddedViews.get(kind);
    if (cur && cur.zoom && cur.zoom !== 1) { try { view.webContents.setZoomFactor(cur.zoom); } catch { /* ignore */ } }
  });
  // 视图里的快捷键（焦点在网页里时页面的快捷键收不到）：Ctrl/⌘ + 加号/减号/0 缩放，T 新标签，W 关标签
  view.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !(input.control || input.meta) || input.alt) return;
    const k = String(input.key || "").toLowerCase();
    if (k === "t") { event.preventDefault(); addEmbedTab(kind); return; }
    if (k === "w") { event.preventDefault(); const cur = embeddedViews.get(kind); if (cur) closeEmbedTab(kind, cur.activeId); return; }
    const step = k === "=" || k === "+" ? 1 : k === "-" || k === "_" ? -1 : k === "0" ? 0 : null;
    if (step === null) return;
    event.preventDefault();
    setEmbedZoom(kind, step === 0 ? 1 : stepZoom(embedZoom(kind), step));
  });
  for (const ev of ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-start-loading", "did-stop-loading", "did-fail-load", "page-favicon-updated"]) {
    view.webContents.on(ev, push);
  }
  try { view.setBounds({ x: 260, y: 60, width: 640, height: 560 }); } catch { /* ignore */ }
  // 用不带 Electron/应用名标识的标准 Chrome UA，避免网站识别成“非浏览器环境”而拦截
  try { view.webContents.setUserAgent(browserUserAgent()); } catch { /* ignore */ }
  return { id: "t" + (++tabSeq), view };
}
function ensureEmbeddedView(kind, partition, url) {
  let st = embeddedViews.get(kind);
  if (st && st.view && !st.view.webContents.isDestroyed()) return st;
  if (!ViewClass) throw new Error("当前 Electron 版本不支持内嵌视图（WebContentsView / BrowserView 均不可用）");
  const tab = createTabView(kind, partition);
  // pageActive：对应页面当前是否在前台。后台任务（如即梦生成）只在页面在前台时才把视图显示出来。
  st = { view: tab.view, tabs: [tab], activeId: tab.id, partition, bounds: null, loaded: false, visible: false, pageActive: false, url };
  embeddedViews.set(kind, st);
  setupEmbedDownloads(kind, tab.view.webContents.session);
  return st;
}
function switchEmbedTab(kind, id) {
  const st = embeddedViews.get(kind);
  if (!st) return false;
  const tab = st.tabs.find((t) => t.id === id);
  if (!tab || tab.view.webContents.isDestroyed()) return false;
  if (st.activeId === id && st.view === tab.view) return true;
  const old = st.view;
  st.view = tab.view;
  st.activeId = id;
  if (st.zoom && st.zoom !== 1) { try { tab.view.webContents.setZoomFactor(st.zoom); } catch { /* ignore */ } }
  if (st.visible) {
    applyViewBounds(st);
    attachEmbeddedView(tab.view);
    if (old && old !== tab.view) detachEmbeddedView(old);
  }
  pushEmbedState(kind);
  return true;
}
function addEmbedTab(kind, url) {
  const cfg = EMBED_CONFIG[kind];
  if (!cfg) return null;
  const st = ensureEmbeddedView(kind, cfg[0], cfg[1]);
  if (st.tabs.length >= 12) { st.view.webContents.loadURL(url || cfg[1]).catch(() => {}); return st.activeId; }
  const tab = createTabView(kind, st.partition);
  st.tabs.push(tab);
  switchEmbedTab(kind, tab.id);
  tab.view.webContents.loadURL(url || cfg[1]).catch(() => {});
  st.loaded = true;
  return tab.id;
}
function closeEmbedTab(kind, id) {
  const st = embeddedViews.get(kind);
  if (!st) return false;
  const idx = st.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return false;
  if (st.tabs.length === 1) {
    // 最后一个标签不关，回到主页
    st.view.webContents.loadURL(EMBED_CONFIG[kind][1]).catch(() => {});
    return true;
  }
  const [tab] = st.tabs.splice(idx, 1);
  if (st.activeId === id) switchEmbedTab(kind, st.tabs[Math.min(idx, st.tabs.length - 1)].id);
  detachEmbeddedView(tab.view);
  try { tab.view.webContents.close(); } catch { /* ignore */ }
  pushEmbedState(kind);
  return true;
}
const ZOOM_STEPS = [0.5, 0.6, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
function embedZoom(kind) { const st = embeddedViews.get(kind); return (st && st.zoom) || 1; }
function stepZoom(cur, dir) {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > cur + 0.001) || ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001) || ZOOM_STEPS[0];
}
function setEmbedZoom(kind, factor) {
  const st = embeddedViews.get(kind);
  const z = Math.min(2, Math.max(0.5, Number(factor) || 1));
  if (!st) return z;
  st.zoom = z;
  for (const t of st.tabs || []) { try { if (!t.view.webContents.isDestroyed()) t.view.webContents.setZoomFactor(z); } catch { /* ignore */ } }
  pushEmbedState(kind);
  return z;
}
function embedState(kind) {
  const st = embeddedViews.get(kind);
  if (!st || !st.view || st.view.webContents.isDestroyed()) return { kind, opened: false, tabs: [] };
  const wc = st.view.webContents;
  const nav = wc.navigationHistory;
  const tabs = st.tabs.filter((t) => !t.view.webContents.isDestroyed()).map((t) => ({
    id: t.id, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle(), loading: t.view.webContents.isLoading(), active: t.id === st.activeId,
  }));
  return {
    kind, opened: st.loaded || !!wc.getURL(), url: wc.getURL() || st.url, title: wc.getTitle(), loading: wc.isLoading(), zoom: st.zoom || 1,
    canGoBack: nav ? nav.canGoBack() : wc.canGoBack(),
    canGoForward: nav ? nav.canGoForward() : wc.canGoForward(),
    tabs, activeId: st.activeId,
  };
}
function pushEmbedState(kind) {
  saveEmbedTabsSoon(kind);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send("video:embed.state", embedState(kind)); } catch { /* ignore */ }
}
// 地址栏输入：像网址就打开（补 https://），否则在该站内搜索（分析浏览器用抖音搜索）或用百度搜
function normalizeAddress(kind, input, curUrl = "") {
  const t = String(input || "").trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+(\/|$|:|\?)/.test(t)) return "https://" + t;
  if (kind === "douyin") {
    // 分析浏览器：按当前标签所在的平台站内搜索
    if (/bilibili\.com/.test(curUrl)) return "https://search.bilibili.com/all?keyword=" + encodeURIComponent(t);
    if (/youtube\.com/.test(curUrl)) return "https://www.youtube.com/results?search_query=" + encodeURIComponent(t);
    return "https://www.douyin.com/search/" + encodeURIComponent(t);
  }
  return "https://www.baidu.com/s?wd=" + encodeURIComponent(t);
}
const EMBED_CONFIG = { jimeng: ["persist:jimeng", "https://jimeng.jianying.com"], douyin: ["persist:douyin", "https://www.douyin.com"] };

// 0.6.9：生成网站浏览器里下载的视频（即梦/可灵/海螺/Vidu…任何站）自动收进 data/video/inbox，
// 合成页可挂到某个镜头。即梦自动生成期间（session.__autoCapture）让路给它自己的下载逻辑。
const EMBED_VIDEO_EXT = /\.(mp4|mov|webm|m4v|mkv)$/i;
function setupEmbedDownloads(kind, session) {
  if (kind !== "jimeng" || !session || session.__inboxHooked) return;
  session.__inboxHooked = true;
  session.on("will-download", (_e, item) => {
    if (session.__autoCapture) return;
    const name = String(item.getFilename() || "video.mp4").replace(/[\\/:*?"<>|]+/g, "_").slice(-120);
    const mime = String(item.getMimeType() || "");
    if (!EMBED_VIDEO_EXT.test(name) && !/^video\//.test(mime)) return; // 非视频走系统默认下载
    const inbox = path.join(videoDir, "inbox");
    try { fs.mkdirSync(inbox, { recursive: true }); } catch { /* ignore */ }
    const finalName = `${Date.now()}-${EMBED_VIDEO_EXT.test(name) ? name : name + ".mp4"}`;
    try { item.setSavePath(path.join(inbox, finalName)); } catch { return; }
    logger.scope("video").info(`浏览器下载开始：${name}`);
    item.on("done", (_ev, state) => {
      if (state === "completed") logger.scope("video").info(`浏览器下载完成：${name}，可在合成导出页挂到镜头`);
      else { logger.scope("video").warn(`浏览器下载未完成（${state}）：${name}`); try { fs.unlinkSync(path.join(inbox, finalName)); } catch { /* ignore */ } }
      broadcast("video:downloads.changed", { name: finalName, state });
    });
  });
}

// 0.6.21：成片存草稿（TikTok / 抖音）——在视频分析的内嵌浏览器里开创作者上传页，
// 等登录后自动把成片放进上传框（CDP DOM.setFileInputFiles），再填文案；最后由用户自己点“保存草稿”。
const publishJobs = new Map(); // tabId -> { cancelled }
async function runPublishDraft(wc, job, absFile, P, caption, status) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const alive = () => !job.cancelled && !wc.isDestroyed();
  // 1) 等上传框出现（没登录时停在登录页，最多等 15 分钟）
  let warned = false; const t0 = Date.now();
  for (;;) {
    if (!alive()) return status("cancelled", "已取消（标签被关闭）");
    let probe = null;
    try { probe = await wc.executeJavaScript(publish.fileInputProbeScript(), true); } catch { /* 页面跳转中 */ }
    if (probe && probe.hasInput) break;
    if (!warned && Date.now() - t0 > 6000) { warned = true; status("login", `请在左边浏览器里登录 ${P.name}（扫码或账号密码），登录后会自动继续`); }
    if (Date.now() - t0 > 15 * 60000) return status("failed", "等了 15 分钟还没看到上传框，已停止。登录后可以在作品库再点一次“存草稿”");
    await sleep(1500);
  }
  // 2) 放入成片
  const dbg = wc.debugger;
  let attachedHere = false;
  try {
    if (!dbg.isAttached()) { dbg.attach("1.3"); attachedHere = true; }
    const { root } = await dbg.sendCommand("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeIds } = await dbg.sendCommand("DOM.querySelectorAll", { nodeId: root.nodeId, selector: 'input[type="file"]' });
    if (!nodeIds || !nodeIds.length) throw new Error("没找到上传框");
    let target = nodeIds[0];
    for (const id of nodeIds) {
      const { attributes } = await dbg.sendCommand("DOM.getAttributes", { nodeId: id });
      const i = attributes.indexOf("accept");
      if (i >= 0 && /video|mp4|mov|\*/i.test(attributes[i + 1] || "")) { target = id; break; }
    }
    await dbg.sendCommand("DOM.setFileInputFiles", { nodeId: target, files: [absFile] });
    status("uploading", `成片已放进 ${P.name} 上传框，正在上传…`);
    // 3) 填文案（编辑器在上传开始后才出现，最多等 2 分钟）
    if (caption) {
      let focused = null; const t1 = Date.now();
      while (alive() && Date.now() - t1 < 120000) {
        try { focused = await wc.executeJavaScript(publish.focusCaptionScript(P.captionSelectors), true); } catch { focused = null; }
        if (focused && focused.ok) break;
        await sleep(1500);
      }
      if (focused && focused.ok) {
        await sleep(800);
        try { await wc.executeJavaScript(publish.focusCaptionScript([focused.selector]), true); } catch { /* ignore */ }
        await dbg.sendCommand("Input.insertText", { text: caption });
      } else status("uploading", "没找到文案输入框，文案请手动粘贴（已复制到剪贴板）");
    }
  } catch (err) {
    return status("failed", "自动放入失败：" + ((err && err.message) || err) + "。可以在页面里手动选择文件（已打开成片所在文件夹）");
  } finally {
    if (attachedHere) { try { dbg.detach(); } catch { /* ignore */ } }
  }
  status("ready", `已放好成片${caption ? "和文案" : ""}。等上传完成后，检查一下再点${P.draftHint}`);
}

ipcMain.handle("video:publish.draft", async (_e, renderId, opts = {}) => {
  try {
    const rec = videoStore.renders.get(renderId);
    if (!rec || !rec.outputPath) return { ok: false, error: "这条成片还没合成好" };
    const absFile = path.join(videoDir, rec.outputPath);
    if (!fs.existsSync(absFile)) return { ok: false, error: "成片文件已不在磁盘上" };
    const pid = publish.platformOf(opts.platform);
    const P = publish.PLATFORMS[pid];
    const caption = publish.trimCaption(opts.caption, pid);
    const st0 = embeddedViews.get("douyin");
    if (!st0 || !st0.loaded) { try { await openEmbeddedView("douyin", "persist:douyin", DOUYIN_EMBED_URL); } catch (err) { log.warn("打开视频浏览器：" + err.message); } }
    const tabId = addEmbedTab("douyin", P.uploadUrl);
    const st = embeddedViews.get("douyin");
    const tab = st && st.tabs.find((t) => t.id === tabId);
    if (!tab) return { ok: false, error: "打开上传页失败" };
    const wc = tab.view.webContents;
    const job = { cancelled: false };
    publishJobs.set(tabId, job);
    wc.once("destroyed", () => { job.cancelled = true; });
    const vlog = logger.scope("video");
    const status = (stage, message) => {
      (stage === "failed" ? vlog.warn : vlog.info).call(vlog, `存草稿（${P.name}）：${message}`);
      broadcast("video:publish.status", { renderId, platform: pid, stage, message });
      if (stage === "failed" || stage === "ready" || stage === "cancelled") publishJobs.delete(tabId);
      if (stage === "failed") { try { shell.showItemInFolder(absFile); } catch { /* ignore */ } }
    };
    status("opening", `正在打开 ${P.name} 上传页…`);
    runPublishDraft(wc, job, absFile, P, caption, status).catch((err) => status("failed", (err && err.message) || String(err)));
    return { ok: true, tabId, platform: pid };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle("video:embed.nav", async (_e, kind, action, arg) => {
  if (!EMBED_CONFIG[kind]) return { ok: false, error: "未知视图" };
  const st = embeddedViews.get(kind);
  if (action === "state") return { ok: true, state: embedState(kind) };
  if (!st || !st.view || st.view.webContents.isDestroyed()) return { ok: false, error: "视图还没打开" };
  const wc = st.view.webContents;
  const nav = wc.navigationHistory;
  try {
    if (action === "back") { if (nav ? nav.canGoBack() : wc.canGoBack()) (nav ? nav.goBack() : wc.goBack()); }
    else if (action === "forward") { if (nav ? nav.canGoForward() : wc.canGoForward()) (nav ? nav.goForward() : wc.goForward()); }
    else if (action === "reload") wc.reload();
    else if (action === "stop") wc.stop();
    else if (action === "home") wc.loadURL(EMBED_CONFIG[kind][1]).catch(() => {});
    else if (action === "go") { const u = normalizeAddress(kind, arg, wc.getURL()); if (u) wc.loadURL(u).catch(() => {}); }
    else if (action === "newTab") { const u = arg ? normalizeAddress(kind, arg, wc.getURL()) : ""; addEmbedTab(kind, u || undefined); }
    else if (action === "switchTab") switchEmbedTab(kind, String(arg || ""));
    else if (action === "closeTab") closeEmbedTab(kind, String(arg || st.activeId));
    else if (action === "zoom") setEmbedZoom(kind, arg);
    else if (action === "zoomIn") setEmbedZoom(kind, stepZoom(embedZoom(kind), 1));
    else if (action === "zoomOut") setEmbedZoom(kind, stepZoom(embedZoom(kind), -1));
    else if (action === "external") { const u = wc.getURL(); if (/^https?:\/\//.test(u)) shell.openExternal(u); }
    else return { ok: false, error: "未知操作" };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  return { ok: true, state: embedState(kind) };
});

function showEmbeddedView(kind) {
  const st = embeddedViews.get(kind);
  if (!st) return false;
  // 页面还没报过位置时先不挂（否则会先在默认位置闪一下），等 setBounds 到了再挂
  if (!st.bounds) { st.wantShow = true; return true; }
  st.wantShow = false;
  applyViewBounds(st);
  if (!attachEmbeddedView(st.view)) return false;
  st.visible = true;
  return true;
}
function hideEmbeddedView(kind) {
  const st = embeddedViews.get(kind);
  if (st) { st.pageActive = false; st.wantShow = false; }
  if (!st || !st.visible) return;
  detachEmbeddedView(st.view);
  st.visible = false;
}
function hideAllEmbeddedViews() { for (const kind of embeddedViews.keys()) hideEmbeddedView(kind); }
function setEmbeddedViewBounds(kind, rect) {
  const st = embeddedViews.get(kind);
  if (!st) return false;
  const r = rect && typeof rect === "object" ? rect : {};
  const b = { x: Number(r.x) || 0, y: Number(r.y) || 0, width: Number(r.width) || 0, height: Number(r.height) || 0 };
  if (b.width <= 0 || b.height <= 0) return false;
  st.bounds = b;
  if (st.visible) applyViewBounds(st);
  else if (st.wantShow) showEmbeddedView(kind);
  return true;
}
// 某类视图的“操作面”：给 video-ipc 用，形状与旧的 jimengWindow 保持兼容
// （webContents + session + show/focus），但背后是内嵌视图，不是独立窗口。
function embeddedSurface(kind, partition, url) {
  const st = ensureEmbeddedView(kind, partition, url);
  // 0.6.9 多标签：即梦自动生成要在即梦标签里跑——当前标签不是即梦就切到已有的即梦标签，没有就新开一个
  if (kind === "jimeng") {
    const isJimeng = (t) => /jianying\.com/.test(t.view.webContents.getURL() || "");
    const cur = st.tabs.find((t) => t.id === st.activeId);
    if (cur && !isJimeng(cur)) {
      const hit = st.tabs.find(isJimeng);
      if (hit) switchEmbedTab(kind, hit.id); else addEmbedTab(kind, url);
    }
  }
  return {
    webContents: st.view.webContents,
    session: st.view.webContents.session,
    show: () => (st.pageActive ? showEmbeddedView(kind) : false),
    focus: () => { if (st.pageActive && mainWindow && !mainWindow.isDestroyed()) mainWindow.focus(); },
  };
}
async function openEmbeddedView(kind, partition, url) {
  const st = ensureEmbeddedView(kind, partition, url);
  st.pageActive = true;
  showEmbeddedView(kind);
  if (!st.loaded) {
    // 0.6.15：有上次的标签就恢复：当前标签等加载，其余标签后台加载
    const saved = readSavedEmbedTabs(kind);
    if (saved) {
      for (let i = 1; i < saved.urls.length; i++) {
        const tab = createTabView(kind, st.partition);
        if (st.zoom && st.zoom !== 1) { try { tab.view.webContents.setZoomFactor(st.zoom); } catch { /* ignore */ } }
        st.tabs.push(tab);
      }
      saved.urls.forEach((u, i) => {
        const tab = st.tabs[i];
        tab.pendingUrl = u;
        if (i !== saved.active) tab.view.webContents.loadURL(u).catch(() => {});
      });
      url = saved.urls[saved.active];
      st.loaded = true;
      if (saved.active > 0) switchEmbedTab(kind, st.tabs[saved.active].id);
      log.info(`内嵌浏览器 ${kind} 恢复上次 ${saved.urls.length} 个标签`);
    }
    // 抖音/即梦首页会做站内重定向，loadURL 因此常以 ERR_ABORTED(-3) reject，但页面其实已经在加载；
    // 加载慢（超过 25 秒）也不算失败，视图里会继续加载。只有真正的网络错误才报给用户。
    try {
      await withTimeout(st.view.webContents.loadURL(url), TIMEOUT_MS, "页面加载");
    } catch (err) {
      const msg = String((err && err.message) || err);
      const benign = (err && (err.code === "ERR_ABORTED" || err.errno === -3)) || /ERR_ABORTED|\(-3\)|超时/.test(msg);
      if (!benign) throw err;
      log.warn(`内嵌视图 ${kind} 加载提示（已忽略）：${msg}`);
    }
    st.loaded = true;
  }
  return { opened: true, url };
}

// 抓当前视图画面若干帧（JPEG data URL，宽度缩到 ≤540），给 AI 看画面用。视图没开或不可见时返回空数组。
async function captureEmbeddedFrames(kind, { count = 3, intervalMs = 1500 } = {}) {
  const st = embeddedViews.get(kind);
  if (!st || !st.loaded || st.view.webContents.isDestroyed()) return [];
  const out = [];
  const n = Math.max(1, Math.min(8, Number(count) || 1));
  const times = []; const diffs = []; let prevSig = null;
  const wc = st.view.webContents;
  // 0.6.8：视频超过 8 秒时按时长均匀跳到几个位置截图（开头/中段/结尾都看到），截完回到原位置；
  // 读不到视频元素时退回按间隔连续截。
  let seekPlan = null;
  try {
    const d = await withTimeout(wc.executeJavaScript(`(() => { const v = [...document.querySelectorAll("video")].sort((a,b)=>b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight)[0]; return v && isFinite(v.duration) ? { dur: v.duration, cur: v.currentTime } : null; })()`), 3000, "读取视频时长");
    if (d && d.dur > 8) seekPlan = { cur: d.cur, points: Array.from({ length: n }, (_, i) => Math.round(d.dur * (0.1 + (0.8 * i) / Math.max(1, n - 1)) * 10) / 10) };
  } catch { seekPlan = null; }
  const seek = (t) => withTimeout(wc.executeJavaScript(`new Promise((res) => { const v = [...document.querySelectorAll("video")].sort((a,b)=>b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight)[0]; if (!v) return res(false); const done = () => setTimeout(() => res(true), 350); v.addEventListener("seeked", done, { once: true }); v.currentTime = ${Number(t) || 0}; setTimeout(() => res(true), 2500); })`), 4000, "跳转视频").catch(() => false);
  for (let i = 0; i < n; i++) {
    if (seekPlan) await seek(seekPlan.points[i]);
    else if (i > 0) await new Promise((r) => setTimeout(r, Math.max(200, Math.min(5000, Number(intervalMs) || 1500))));
    try {
      let img = await withTimeout(wc.capturePage(), 5000, "截图");
      if (!img || img.isEmpty()) continue;
      const size = img.getSize();
      // 0.6.17：16×16 灰度缩略图做相邻截图差异（0=完全一样，1=完全不同），帮 AI 判断有没有换镜
      try {
        const bmp = img.resize({ width: 16, height: 16 }).toBitmap();
        const sig = [];
        for (let p = 0; p + 2 < bmp.length; p += 4) sig.push((bmp[p] + bmp[p + 1] + bmp[p + 2]) / 765);
        if (prevSig && prevSig.length === sig.length) diffs.push(Math.round(sig.reduce((a, v, k) => a + Math.abs(v - prevSig[k]), 0) / sig.length * 100) / 100);
        prevSig = sig;
      } catch { /* ignore */ }
      if (size.width > 540) img = img.resize({ width: 540 });
      out.push("data:image/jpeg;base64," + img.toJPEG(70).toString("base64"));
      times.push(seekPlan ? seekPlan.points[i] : null);
    } catch (err) { log.warn("截取画面失败：" + ((err && err.message) || err)); }
  }
  if (seekPlan) await seek(seekPlan.cur);
  out.times = times; out.diffs = diffs;
  return out;
}

const JIMENG_EMBED_URL = "https://jimeng.jianying.com";
const DOUYIN_EMBED_URL = "https://www.douyin.com";
const embeddedViewsApi = {
  jimeng: {
    open: () => openEmbeddedView("jimeng", "persist:jimeng", JIMENG_EMBED_URL),
    show: () => { const st = embeddedViews.get("jimeng"); if (st) st.pageActive = true; return showEmbeddedView("jimeng"); },
    hide: () => hideEmbeddedView("jimeng"),
    setBounds: (rect) => setEmbeddedViewBounds("jimeng", rect),
    surface: () => embeddedSurface("jimeng", "persist:jimeng", JIMENG_EMBED_URL),
    url: JIMENG_EMBED_URL,
  },
  douyin: {
    open: () => openEmbeddedView("douyin", "persist:douyin", DOUYIN_EMBED_URL),
    show: () => { const st = embeddedViews.get("douyin"); if (st) st.pageActive = true; return showEmbeddedView("douyin"); },
    hide: () => hideEmbeddedView("douyin"),
    setBounds: (rect) => setEmbeddedViewBounds("douyin", rect),
    surface: () => embeddedSurface("douyin", "persist:douyin", DOUYIN_EMBED_URL),
    captureFrames: (opts) => captureEmbeddedFrames("douyin", opts),
    url: DOUYIN_EMBED_URL,
  },
};

// 视频项目存储（M1）：<数据目录>/data/video/*.json
// TTS Key 单独存（M2）：优先 safeStorage 加密，页面只拿到“已设置/末 4 位”，Key 只在主进程发 TTS 请求时用。
const videoDir = path.join(DATA_DIR, "data", "video");
const videoStore = createVideoStore(videoDir);
const ttsSecrets = createSecretsStore({ file: path.join(DATA_DIR, "secrets.json"), safeStorage });
// TTS / AI 网络请求走 net.fetch（走系统代理），包装成 tts.js 约定的 { ok, status, arrayBuffer, text }。
// 整个请求（含读响应体）最多 3 分钟，服务卡住时不再让镜头永远停在“配音中”。
const API_TIMEOUT_MS = 180000;
// 0.6.8：AI 分析单独放宽到 8 分钟（思考模型、长视频输出多，3 分钟常不够）
const AI_TIMEOUT_MS = 480000;
const makeFetch = (timeoutMs) => async (url, opts = {}) => {
  const mins = Math.round(timeoutMs / 60000);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`请求超时（${mins} 分钟）`)), timeoutMs);
  // 0.6.10：外部取消（后台任务“取消”）也能中断请求
  const ext = opts.signal;
  let cancelled = false;
  const cancelErr = () => { const e = new Error("已取消"); e.code = "TASK_CANCELLED"; e.name = "AbortError"; return e; };
  if (ext) {
    if (ext.aborted) { clearTimeout(timer); throw cancelErr(); }
    ext.addEventListener("abort", () => { cancelled = true; ctl.abort(); }, { once: true });
  }
  const fetchOpts = { ...opts }; delete fetchOpts.signal;
  let res;
  try { res = await net.fetch(url, { ...fetchOpts, signal: ctl.signal }); }
  catch (err) { clearTimeout(timer); if (cancelled) throw cancelErr(); throw ctl.signal.aborted ? new Error(`请求超时（${mins} 分钟），请检查网络或服务地址后重试`) : err; }
  const body = (fn) => async () => {
    try { return await fn(); }
    catch (err) { if (cancelled) throw cancelErr(); throw ctl.signal.aborted ? new Error(`读取响应超时（${mins} 分钟），请重试`) : err; }
    finally { clearTimeout(timer); }
  };
  if (!res.ok) clearTimeout(timer);
  return { ok: res.ok, status: res.status, arrayBuffer: body(() => res.arrayBuffer()), text: body(() => res.text()) };
};
const ttsFetch = makeFetch(API_TIMEOUT_MS);
const aiFetch = makeFetch(AI_TIMEOUT_MS);

setupVideoIpc({
  ipcMain, store: videoStore, videoDir,
  embeddedViews: embeddedViewsApi,
  openPath: (p) => { try { shell.openPath(p); } catch { /* ignore */ } return true; },
  videoDefaults: () => ({ defaultShotCount: settings.get("videoDefaultShotCount"), aspect: settings.get("videoAspect") }),
  getTtsSettings: () => ({
    ttsProvider: settings.get("ttsProvider"), ttsVoice: settings.get("ttsVoice"), ttsRate: settings.get("ttsRate"),
    ttsBaseUrl: settings.get("ttsBaseUrl"), ttsModel: settings.get("ttsModel"),
    ttsLocalBaseUrl: settings.get("ttsLocalBaseUrl"), ttsLocalModel: settings.get("ttsLocalModel"),
    ttsVoiceboxBaseUrl: settings.get("ttsVoiceboxBaseUrl"), ttsVoiceboxEngine: settings.get("ttsVoiceboxEngine"),
    ttsVoiceboxModelSize: settings.get("ttsVoiceboxModelSize"), ttsVoiceboxLanguage: settings.get("ttsVoiceboxLanguage"),
  }),
  getTtsKey: () => ttsSecrets.get("ttsApiKey"),
  getAiSettings: () => ({ aiBaseUrl: settings.get("aiBaseUrl"), aiModel: settings.get("aiModel") }),
  getAiKey: () => ttsSecrets.get("aiApiKey"),
  fetchImpl: ttsFetch,
  aiFetchImpl: aiFetch,
  tasks,
  logger,
  secrets: ttsSecrets,
});

// ---------------- CI 冒烟测试 ----------------
function runSmokeTest() {
  const errors = [];
  const hardStop = setTimeout(() => { console.log("SMOKE TIMEOUT"); app.exit(2); }, 60000);
  mainWindow.webContents.on("console-message", (_e, level, message) => { if (level >= 3 && !/ResizeObserver loop/.test(String(message))) errors.push(message); });
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
        const btnTexts = [...document.querySelectorAll("#page-editor .btn")].map((b) => b.textContent.trim());
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
      // 视频 M4：抖音分析页能打开（无 AI Key 时提示条为警告色并提示去设置；0.6.3 起按钮可点，点了带去设置），
      // 项目页以卡片展示（新建项目后出现 .project-card），再删掉。
      let videoM4Ok = false;
      try {
        window.Shell.navigate("douyin");
        for (let i = 0; i < 40 && !document.querySelector("#douyin-analyze-btn"); i++) await new Promise((r) => setTimeout(r, 50));
        const analyzeBtn = document.querySelector("#douyin-analyze-btn");
        const aiHint = document.querySelector("#douyin-ai-hint");
        for (let i = 0; i < 40 && aiHint && !aiHint.classList.contains("warn"); i++) await new Promise((r) => setTimeout(r, 50));
        const douyinOk = !!analyzeBtn && !!aiHint && aiHint.classList.contains("warn")
          && !!document.querySelector("#douyin-view-placeholder");
        const created4 = await a.video.projects.create({ title: "冒烟卡片" });
        window.Shell.navigate("projects");
        for (let i = 0; i < 40 && !document.querySelector("#page-projects .project-card"); i++) await new Promise((r) => setTimeout(r, 50));
        const cardOk = !!document.querySelector("#page-projects .project-card");
        await a.video.projects.remove(created4.project.id);
        videoM4Ok = douyinOk && cardOk;
      } catch (e) { videoM4Ok = false; }
      // 右侧运行日志面板能打开，外观设置能生效
      window.Shell.toggleLogDock(true);
      window.Shell.saveSettings({ background: "night", fontSize: 15 });
      await new Promise((r) => setTimeout(r, 300));
      const dock = !document.getElementById("logdock").hidden && !!document.querySelector("#logdock .log-list");
      const look = document.documentElement.dataset.bg === "night" && getComputedStyle(document.body).fontSize === "15px";
      window.Shell.toggleLogDock(false);
      return {
        videoM3Ok, videoM3Debug, videoM4Ok,
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
      && ["home", "projects", "editor", "render", "douyin", "tasks", "logs", "settings"].every((p) => out.navs.includes(p)) && out.settingsVisible
      && /^(light|dark)$/.test(out.theme) && out.task === "done" && out.logCount > 0 && out.dock && out.look && out.videoOk && out.videoM2Ok && out.videoM3Ok && out.videoM4Ok && !errors.length;
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
  app.on("before-quit", () => { saveAllEmbedTabs(); hideAllEmbeddedViews(); tasks.cancelAll(); log.info("退出"); });
}
