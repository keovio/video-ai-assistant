"use strict";
// 视频 IPC：项目 / 镜头 / 资产 / 渲染记录的读写（M1 只做存储与编辑）。
// 注册方式沿用主进程的 ipcMain.handle；返回统一为 { ok: true, ... }，
// 出错时返回 { ok: false, error }，页面侧不需要再猜格式。
const { computeTimings } = require("./video-model");

function setupVideoIpc({ ipcMain, store, videoDefaults = {} }) {
  const h = (channel, fn) => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try { return await fn(...args); }
      catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
    });
  };
  const ok = (data) => ({ ok: true, ...data });
  const shotCountOf = (projectId) => store.shotsOf(projectId).length;
  const withCounts = (p) => ({ ...p, shotCount: shotCountOf(p.id) });

  h("video:projects.list", () => ok({ projects: store.projects.list().map(withCounts) }));

  h("video:projects.get", (id) => {
    const project = store.projects.get(id);
    if (!project) return { ok: false, error: "项目不存在" };
    const shots = store.shotsOf(id);
    const { totalSeconds } = computeTimings(shots);
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

  // M1 只读：资产与渲染记录的查询，写入留给 M2/M3
  h("video:assets.list", (filter = {}) => ok({ assets: store.assets.list(filter) }));
  h("video:renders.list", (projectId) => ok({ renders: store.renders.list({ projectId: projectId || "" }) }));
}

module.exports = { setupVideoIpc };
