"use strict";
// 应用内增量更新：只下载应用层（app-update.asar，通常几百 KB ~ 几 MB），不重新下载 Electron 内核。
// 仓库、tag 前缀、通道、镜像全部来自 app.config.json。
const path = require("path");
const core = require("./update-core");
const dl = require("./download");
const { writeJsonAtomic } = require("./fs-utils");
const { isRepoConfigured, releaseTag } = require("./config");

// config：app.config.json 的内容；boot：启动器给的信息（global.__appBoot）
function createUpdater({ fetchImpl, fsImpl, boot, config, platform = process.platform, arch = process.arch }) {
  const updatesDir = boot.updatesDir;
  const repo = config.repo;
  const tagPrefix = config.tagPrefix == null ? "v" : config.tagPrefix;
  const mirrors = () => (Array.isArray(config.mirrors) && config.mirrors.length ? config.mirrors : [""]);
  let busy = null;
  let downloaded = null; // 本次运行下载好的版本，等重启

  function info() {
    return {
      productName: config.productName,
      version: boot.version,
      source: boot.source, // bundled（安装包内置）| update（已下载的新应用层）
      bundledVersion: boot.bundledVersion,
      electron: boot.electron,
      bootProtocol: boot.protocol || 1,
      rejected: boot.rejected || [],
      downloaded,
      repo,
      repoConfigured: isRepoConfigured(config),
    };
  }

  async function fetchManifest() {
    const errs = [];
    // ① GitHub API：列出 releases，挑最新的 <tagPrefix><版本>
    try {
      const { data } = await dl.fetchJson(fetchImpl, [`https://api.github.com/repos/${repo}/releases?per_page=30`], { headers: { Accept: "application/vnd.github+json" } });
      const best = core.pickRelease(data, { tagPrefix });
      if (best) {
        const { data: m } = await dl.fetchJson(fetchImpl, core.mirrorUrls(best.manifestUrl, mirrors()));
        return { manifest: m, releaseUrl: best.release.html_url };
      }
      errs.push("GitHub 上还没有带增量包的发布");
    } catch (err) { errs.push("GitHub API " + err.message); }
    // ② 固定通道（每次发版覆盖上传 app-update.json，可走镜像，API 被限流时的后备）
    try {
      const url = `https://github.com/${repo}/releases/download/${config.channelTag}/app-update.json`;
      const { data: m } = await dl.fetchJson(fetchImpl, core.mirrorUrls(url, mirrors()));
      return { manifest: m, releaseUrl: m.releaseUrl || `https://github.com/${repo}/releases/tag/${releaseTag(config, m.version)}` };
    } catch (err) { errs.push("更新通道 " + err.message); }
    throw new Error(errs.join("；"));
  }

  async function check() {
    if (!isRepoConfigured(config)) return { ok: false, error: "未配置更新仓库（app.config.json 里的 repo 还是 OWNER/REPO）", ...core.friendlyError("OWNER/REPO") };
    try {
      const { manifest: m, releaseUrl } = await fetchManifest();
      const err = core.validateManifest(m, { requireUrl: true });
      if (err) return { ok: false, error: "更新清单无效：" + err, message: "更新清单无效：" + err };
      const newer = core.compareVersions(m.version, boot.version) > 0;
      const full = newer ? core.needsFullInstall(m, { electron: boot.electron, bootProtocol: boot.protocol || 1 }) : "";
      const state = core.readState(fsImpl, updatesDir);
      const relUrl = releaseUrl || m.releaseUrl || "";
      return {
        ok: true,
        current: boot.version,
        latest: m.version,
        available: newer,
        needsFull: !!full,
        fullReason: full,
        badBefore: state.bad[m.version] || "",
        alreadyDownloaded: downloaded === m.version,
        size: m.size,
        notes: m.notes || "",
        releaseUrl: relUrl,
        installerUrl: core.pickInstaller(m.installers, platform, arch) || relUrl,
        manifest: m,
      };
    } catch (err) {
      const raw = String((err && err.message) || err);
      return { ok: false, error: "检查更新失败：" + raw, ...core.friendlyError(raw) };
    }
  }

  async function download(manifest, onProgress) {
    if (busy) return busy;
    busy = (async () => {
      const m = manifest;
      const err = core.validateManifest(m, { requireUrl: true });
      if (err) return { ok: false, error: "更新清单无效：" + err, message: "更新清单无效：" + err };
      if (core.needsFullInstall(m, { electron: boot.electron, bootProtocol: boot.protocol || 1 })) {
        return { ok: false, needsFull: true, error: "这个版本需要下载完整安装包", message: "这个版本需要下载完整安装包" };
      }
      const file = `app-${m.version}.asar`;
      const dest = path.join(updatesDir, file);
      const r = await dl.downloadFile(fetchImpl, fsImpl, core.mirrorUrls(m.asarUrl, mirrors()), dest, { sha256: m.sha256, size: m.size, onProgress });
      if (!r.ok) return { ok: false, error: "下载失败：" + r.error, ...core.friendlyError(r.error) };
      const local = { version: m.version, electron: m.electron, bootstrap: m.bootstrap || 1, sha256: m.sha256, size: m.size, file, notes: m.notes || "", downloadedAt: new Date().toISOString() };
      // 先写 asar 再写清单：清单存在 = 文件已完整落盘
      writeJsonAtomic(path.join(updatesDir, `app-${m.version}.json`), local, fsImpl);
      // 用户主动重新下载：清掉这个版本以前的失败记录
      const state = core.readState(fsImpl, updatesDir);
      if (state.bad[m.version] || state.boots[m.version]) { delete state.bad[m.version]; delete state.boots[m.version]; core.writeState(fsImpl, updatesDir, state); }
      // 只保留正在用的版本和新版本
      try {
        const keep = [m.version, boot.source === "update" ? boot.version : ""];
        for (const n of core.filesToPrune(fsImpl.readdirSync(updatesDir), keep)) { try { fsImpl.unlinkSync(path.join(updatesDir, n)); } catch { /* 可能正被占用，下次再删 */ } }
      } catch { /* ignore */ }
      downloaded = m.version;
      return { ok: true, version: m.version, source: r.url };
    })();
    try { return await busy; } finally { busy = null; }
  }

  return { info, check, download, get downloading() { return !!busy; } };
}

module.exports = { createUpdater };
