"use strict";
// 预加载脚本：在 contextIsolation + sandbox 下只暴露需要的几个接口给页面（window.app），页面拿不到 Node。
const { contextBridge, ipcRenderer } = require("electron");

// 订阅事件，返回取消订阅的函数
const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld("app", {
  info: () => ipcRenderer.invoke("app:info"),
  update: {
    info: () => ipcRenderer.invoke("update:info"),
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    restart: () => ipcRenderer.invoke("update:restart"),
    openUrl: (url) => ipcRenderer.invoke("update:openUrl", url),
    onProgress: on("update:progress"),
    onStatus: on("update:status"),
  },
  // 设置：get() 全部 / set({ key: value }) / reset([keys])；onChange(({ changed, settings }) => …)
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
    reset: (keys) => ipcRenderer.invoke("settings:reset", keys),
    schema: () => ipcRenderer.invoke("settings:schema"),
    onChange: on("settings:changed"),
  },
  // 日志：list({ level, q, limit }) / write(level, message, scope) / onEntries(batch => …)
  logs: {
    list: (filter) => ipcRenderer.invoke("logs:list", filter),
    clear: () => ipcRenderer.invoke("logs:clear"),
    write: (level, message, scope) => ipcRenderer.invoke("logs:write", level, message, scope),
    openDir: () => ipcRenderer.invoke("logs:openDir"),
    file: () => ipcRenderer.invoke("logs:file"),
    onEntries: on("logs:entries"),
  },
  // 后台任务（在 main.js 里 tasks.register 注册）：run(type, params) → { ok, task }；onChange(task => …)
  tasks: {
    list: () => ipcRenderer.invoke("tasks:list"),
    types: () => ipcRenderer.invoke("tasks:types"),
    run: (type, params, opts) => ipcRenderer.invoke("tasks:run", type, params, opts),
    cancel: (id) => ipcRenderer.invoke("tasks:cancel", id),
    clearFinished: () => ipcRenderer.invoke("tasks:clearFinished"),
    onChange: on("tasks:changed"),
  },
  // 外观：自定义背景图（选择 / 读取 data URL / 清除）；onBackground(() => …) 背景图变了
  appearance: {
    pickBackground: () => ipcRenderer.invoke("appearance:pickBackground"),
    background: () => ipcRenderer.invoke("appearance:background"),
    clearBackground: () => ipcRenderer.invoke("appearance:clearBackground"),
    onBackground: on("appearance:background"),
  },
  system: {
    info: () => ipcRenderer.invoke("system:info"),
    openDataDir: () => ipcRenderer.invoke("system:openDataDir"),
    openPath: (rel) => ipcRenderer.invoke("system:openPath", rel),
    clearCache: () => ipcRenderer.invoke("system:clearCache"),
    relaunch: () => ipcRenderer.invoke("system:relaunch"),
    onThemeUpdated: on("theme:updated"),
  },
  // 视频项目（M1：存储与分镜编辑；M2：配音生成/导入/试听；M3：即梦片段/合成导出）
  video: {
    projects: {
      list: () => ipcRenderer.invoke("video:projects.list"),
      get: (id) => ipcRenderer.invoke("video:projects.get", id),
      create: (input) => ipcRenderer.invoke("video:projects.create", input),
      update: (id, patch) => ipcRenderer.invoke("video:projects.update", id, patch),
      remove: (id) => ipcRenderer.invoke("video:projects.remove", id),
      duplicate: (id) => ipcRenderer.invoke("video:projects.duplicate", id),
    },
    shots: {
      list: (projectId) => ipcRenderer.invoke("video:shots.list", projectId),
      add: (projectId, input) => ipcRenderer.invoke("video:shots.add", projectId, input),
      update: (id, patch) => ipcRenderer.invoke("video:shots.update", id, patch),
      remove: (id) => ipcRenderer.invoke("video:shots.remove", id),
      reorder: (projectId, ids) => ipcRenderer.invoke("video:shots.reorder", projectId, ids),
      generateAudio: (id, override) => ipcRenderer.invoke("video:shots.generateAudio", id, override),
      importAudio: (id, file) => ipcRenderer.invoke("video:shots.importAudio", id, file),
      audioData: (id) => ipcRenderer.invoke("video:shots.audioData", id),
      clearAudio: (id) => ipcRenderer.invoke("video:shots.clearAudio", id),
      generateClip: (id) => ipcRenderer.invoke("video:shots.generateClip", id),
      importVideo: (id, file) => ipcRenderer.invoke("video:shots.importVideo", id, file),
      clearVideo: (id) => ipcRenderer.invoke("video:shots.clearVideo", id),
    },
    assets: { list: (filter) => ipcRenderer.invoke("video:assets.list", filter) },
    renders: {
      list: (projectId) => ipcRenderer.invoke("video:renders.list", projectId),
      start: (projectId, opts) => ipcRenderer.invoke("video:renders.start", projectId, opts),
      retry: (renderId) => ipcRenderer.invoke("video:renders.retry", renderId),
      openFolder: (renderId) => ipcRenderer.invoke("video:renders.openFolder", renderId),
      openOutput: (renderId) => ipcRenderer.invoke("video:renders.openOutput", renderId),
    },
    jimeng: { open: () => ipcRenderer.invoke("video:jimeng.open") },
    tts: { providers: () => ipcRenderer.invoke("video:tts.providers") },
    ffmpeg: { status: () => ipcRenderer.invoke("video:ffmpeg.status") },
    secrets: {
      status: () => ipcRenderer.invoke("video:secrets.status"),
      set: (value) => ipcRenderer.invoke("video:secrets.set", value),
    },
  },
});
