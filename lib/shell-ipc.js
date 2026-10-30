"use strict";
// 通用外壳的主进程部分：把设置、日志、后台任务接到 IPC 上，并处理设置的副作用（主题、缩放、开机自启、日志级别）。
// 页面侧对应 preload.js 里的 window.app.settings / logs / tasks / system。
const path = require("path");
const { createBackgroundStore } = require("./appearance");

function setupShellIpc({ electron, settings, logger, tasks, dataDir, broadcast, getWindows }) {
  const { ipcMain, nativeTheme, shell, app, session, dialog, BrowserWindow } = electron;
  const log = logger.scope("shell");

  // ---- 设置副作用 ----
  function applyTheme(v) { try { nativeTheme.themeSource = v || "system"; } catch { /* ignore */ } }
  function applyZoom(v) {
    for (const w of getWindows()) { try { if (!w.isDestroyed()) w.webContents.setZoomFactor(Number(v) || 1); } catch { /* ignore */ } }
  }
  function applyLogin(v) {
    if (process.platform === "linux") return; // Linux 各桌面环境不统一，不处理
    try { app.setLoginItemSettings({ openAtLogin: !!v }); } catch (err) { log.warn("设置开机自启失败：" + err.message); }
  }
  const s = settings.get();
  applyTheme(s.theme);
  logger.setLevel(s.logLevel);
  settings.onChange((changed, all) => {
    if ("theme" in changed) applyTheme(changed.theme);
    if ("zoom" in changed) applyZoom(changed.zoom);
    if ("openAtLogin" in changed) applyLogin(changed.openAtLogin);
    if ("logLevel" in changed) logger.setLevel(changed.logLevel);
    const keys = Object.keys(changed).filter((k) => !["sidebarWidth", "lastPage", "logDockWidth", "logFontSize", "backgroundDim", "fontSize"].includes(k));
    if (keys.length) log.debug("设置已修改：" + keys.join(", "));
    broadcast("settings:changed", { changed, settings: all });
  });
  nativeTheme.on("updated", () => broadcast("theme:updated", { dark: nativeTheme.shouldUseDarkColors }));

  // ---- 事件转发（日志条目做批量，避免刷屏时 IPC 过多） ----
  let pending = [];
  let flushTimer = null;
  logger.onEntry((e) => {
    pending.push(e);
    if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; const batch = pending; pending = []; broadcast("logs:entries", batch); }, 80);
  });
  tasks.onChange((t) => broadcast("tasks:changed", t));

  // ---- IPC ----
  const h = (ch, fn) => ipcMain.handle(ch, (_e, ...args) => fn(...args));

  h("settings:get", () => settings.get());
  h("settings:set", (patch) => settings.set(patch));
  h("settings:reset", (keys) => settings.reset(keys));
  h("settings:schema", () => settings.schema);

  h("logs:list", (filter) => logger.entries(filter || {}));
  h("logs:clear", () => { logger.clear(); return true; });
  h("logs:write", (level, message, scope) => { logger.log(String(level || "info"), String(scope || "renderer").slice(0, 40), String(message || "").slice(0, 8000)); return true; });
  h("logs:openDir", () => shell.openPath(logger.dir || dataDir));
  h("logs:file", () => logger.currentFile());

  h("tasks:list", () => tasks.list());
  h("tasks:types", () => tasks.types());
  h("tasks:run", (type, params, opts) => {
    try { return { ok: true, task: tasks.run(String(type), params || {}, opts || {}) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  h("tasks:cancel", (id) => tasks.cancel(String(id)));
  h("tasks:clearFinished", () => { tasks.clearFinished(); return true; });

  // 自定义背景图
  const bg = createBackgroundStore({ dir: path.join(dataDir, "appearance") });
  ipcMain.handle("appearance:pickBackground", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: "选择背景图片", properties: ["openFile"], filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif"] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    try {
      const res = bg.save(r.filePaths[0]);
      if (!res.ok) return res;
      settings.set({ background: "custom" });
      broadcast("appearance:background", {});
      log.info("已更换背景图片");
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  h("appearance:background", () => bg.dataUrl());
  h("appearance:clearBackground", () => {
    bg.clear();
    if (settings.get("background") === "custom") settings.set({ background: "aurora" });
    broadcast("appearance:background", {});
    return true;
  });

  h("system:info", () => ({
    platform: process.platform, arch: process.arch, dataDir,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    dark: nativeTheme.shouldUseDarkColors,
    canOpenAtLogin: process.platform !== "linux",
  }));
  h("system:openDataDir", () => shell.openPath(dataDir));
  h("system:openPath", (rel) => {
    // 只允许打开数据目录里的路径
    const p = path.resolve(dataDir, String(rel || ""));
    if (p !== dataDir && !p.startsWith(dataDir + path.sep)) return "路径不在数据目录内";
    return shell.openPath(p);
  });
  h("system:clearCache", async () => {
    try { await session.defaultSession.clearCache(); log.info("已清除缓存"); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  h("system:relaunch", () => { app.relaunch(); app.exit(0); return true; });

  return { applyZoom };
}

module.exports = { setupShellIpc };
