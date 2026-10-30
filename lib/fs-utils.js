"use strict";
// 通用文件工具：原子写 JSON、带进程存活检测的锁文件（纯 Node，可单测）
const fs = require("fs");
const path = require("path");

// 锁超过这个时间就当作残留（即使 pid 恰好被别的进程复用）
const STALE_LOCK_MS = 6 * 3600 * 1000;

function readJson(file, fallback, fsImpl = fs) {
  try { return JSON.parse(fsImpl.readFileSync(file, "utf8")); } catch { return fallback; }
}

// 先写临时文件再改名：写到一半断电/崩溃也不会留下半个 JSON
function writeJsonAtomic(file, data, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    fsImpl.renameSync(tmp, file);
  } catch (err) {
    try { fsImpl.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// 进程是否还活着（EPERM 表示进程存在但没权限发信号）
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function readLock(file) {
  if (!fs.existsSync(file)) return null;
  return readJson(file, { pid: -1, createdAt: 0 });
}

// 取锁：持有者还活着且没超时 → 抛错（code = LOCK_BUSY）；否则清掉残留锁。
// 返回 ""（正常取到）或一段说明（清理了残留锁）
function acquireLock(file, pid = process.pid, { staleMs = STALE_LOCK_MS } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let note = "";
  const info = readLock(file);
  if (info) {
    const age = Date.now() - Number(info.createdAt || 0);
    const alive = pidAlive(Number(info.pid)) && Number(info.pid) !== pid;
    if (alive && age <= staleMs) {
      const e = new Error(`已有任务在运行（进程 ${info.pid}），请稍后再试`);
      e.code = "LOCK_BUSY";
      throw e;
    }
    fs.rmSync(file, { force: true });
    note = `已清理残留锁（${Math.round(age / 60000)} 分钟前，进程${alive ? "仍在" : "已不在"}）`;
  }
  // wx：文件已存在就失败，防止两个进程同时抢到
  try {
    fs.writeFileSync(file, JSON.stringify({ pid, createdAt: Date.now() }), { flag: "wx" });
  } catch (err) {
    if (err.code === "EEXIST") { const e = new Error("已有任务在运行，请稍后再试"); e.code = "LOCK_BUSY"; throw e; }
    throw err;
  }
  return note;
}

// 只释放自己持有的锁
function releaseLock(file, pid = process.pid) {
  const info = readLock(file);
  if (info && Number(info.pid) === pid) fs.rmSync(file, { force: true });
}

module.exports = { STALE_LOCK_MS, readJson, writeJsonAtomic, pidAlive, readLock, acquireLock, releaseLock };
