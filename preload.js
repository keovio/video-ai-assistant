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
      setBgm: (id, file) => ipcRenderer.invoke("video:projects.setBgm", id, file),
      clearBgm: (id) => ipcRenderer.invoke("video:projects.clearBgm", id),
    },
    shots: {
      list: (projectId) => ipcRenderer.invoke("video:shots.list", projectId),
      add: (projectId, input) => ipcRenderer.invoke("video:shots.add", projectId, input),
      update: (id, patch) => ipcRenderer.invoke("video:shots.update", id, patch),
      remove: (id) => ipcRenderer.invoke("video:shots.remove", id),
      reorder: (projectId, ids) => ipcRenderer.invoke("video:shots.reorder", projectId, ids),
      generateAudio: (id, override) => ipcRenderer.invoke("video:shots.generateAudio", id, override),
      // 0.6.26：取消配音；不传 id 取消全部
      cancelAudio: (id) => ipcRenderer.invoke("video:shots.cancelAudio", id || ""),
      importAudio: (id, file) => ipcRenderer.invoke("video:shots.importAudio", id, file),
      audioData: (id) => ipcRenderer.invoke("video:shots.audioData", id),
      clearAudio: (id) => ipcRenderer.invoke("video:shots.clearAudio", id),
      generateClip: (id) => ipcRenderer.invoke("video:shots.generateClip", id),
      importVideo: (id, file) => ipcRenderer.invoke("video:shots.importVideo", id, file),
      clearVideo: (id) => ipcRenderer.invoke("video:shots.clearVideo", id),
    },
    assets: { list: (filter) => ipcRenderer.invoke("video:assets.list", filter) },
    downloads: {
      list: () => ipcRenderer.invoke("video:downloads.list"),
      attach: (name, shotId) => ipcRenderer.invoke("video:downloads.attach", name, shotId),
      remove: (name) => ipcRenderer.invoke("video:downloads.remove", name),
      openFolder: () => ipcRenderer.invoke("video:downloads.openFolder"),
      onChanged: on("video:downloads.changed"),
    },
    renders: {
      list: (projectId) => ipcRenderer.invoke("video:renders.list", projectId),
      start: (projectId, opts) => ipcRenderer.invoke("video:renders.start", projectId, opts),
      retry: (renderId) => ipcRenderer.invoke("video:renders.retry", renderId),
      openFolder: (renderId) => ipcRenderer.invoke("video:renders.openFolder", renderId),
      openOutput: (renderId) => ipcRenderer.invoke("video:renders.openOutput", renderId),
      remove: (renderId, opts) => ipcRenderer.invoke("video:renders.remove", renderId, opts),
    },
    // 内嵌浏览器工具栏：后退/前进/刷新/主页/地址栏/外部浏览器打开，以及导航状态推送
    embed: {
      nav: (kind, action, arg) => ipcRenderer.invoke("video:embed.nav", kind, action, arg),
      onState: on("video:embed.state"),
    },
    jimeng: {
      open: () => ipcRenderer.invoke("video:jimeng.open"),
      show: () => ipcRenderer.invoke("video:jimeng.show"),
      hide: () => ipcRenderer.invoke("video:jimeng.hide"),
      setBounds: (rect) => ipcRenderer.invoke("video:jimeng.setBounds", rect),
    },
    // 抖音分析（M4）：内嵌视图提取 + AI 分析 + 分析记录
    douyin: {
      open: () => ipcRenderer.invoke("video:douyin.open"),
      show: () => ipcRenderer.invoke("video:douyin.show"),
      hide: () => ipcRenderer.invoke("video:douyin.hide"),
      setBounds: (rect) => ipcRenderer.invoke("video:douyin.setBounds", rect),
      extract: () => ipcRenderer.invoke("video:douyin.extract"),
      analyze: (input) => ipcRenderer.invoke("video:douyin.analyze", input),
      cancelAnalyze: () => ipcRenderer.invoke("video:douyin.cancelAnalyze"),
    },
    ai: {
      status: () => ipcRenderer.invoke("video:ai.status"),
      setKey: (value) => ipcRenderer.invoke("video:ai.setKey", value),
      // kind: "ai" | "tts" | "tts-local" | "tts-voicebox" → { ok, models: [id…] }
      models: (kind) => ipcRenderer.invoke("video:ai.models", kind),
      // 0.6.24 { shots:[{narration,visual,prompt}], mode:"optimize"|"imitate", reference, aspect } → { ok, prompts }
      rewritePrompts: (input) => ipcRenderer.invoke("video:ai.rewritePrompts", input),
      voices: (kind) => ipcRenderer.invoke("video:tts.voices", kind),
    },
    publish: {
      draft: (renderId, opts) => ipcRenderer.invoke("video:publish.draft", renderId, opts),
      onStatus: on("video:publish.status"),
    },
    library: {
      renders: () => ipcRenderer.invoke("video:library.renders"),
      thumb: (renderId) => ipcRenderer.invoke("video:library.thumb", renderId),
    },
    analyses: {
      list: () => ipcRenderer.invoke("video:analyses.list"),
      get: (id) => ipcRenderer.invoke("video:analyses.get", id),
      upsert: (input) => ipcRenderer.invoke("video:analyses.upsert", input),
      remove: (id) => ipcRenderer.invoke("video:analyses.remove", id),
      saveSkill: (id) => ipcRenderer.invoke("video:analyses.saveSkill", id),
      openSkill: (id) => ipcRenderer.invoke("video:analyses.openSkill", id),
      removeSkill: (id) => ipcRenderer.invoke("video:analyses.removeSkill", id),
      import: (id) => ipcRenderer.invoke("video:analyses.import", id),
    },
    tts: { providers: () => ipcRenderer.invoke("video:tts.providers") },
    backups: {
      list: () => ipcRenderer.invoke("video:backups.list"),
      restore: (id) => ipcRenderer.invoke("video:backups.restore", id),
    },
    ffmpeg: { status: (opts) => ipcRenderer.invoke("video:ffmpeg.status", opts || {}) },
    secrets: {
      status: () => ipcRenderer.invoke("video:secrets.status"),
      set: (value) => ipcRenderer.invoke("video:secrets.set", value),
    },
  },
});
