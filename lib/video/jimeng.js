"use strict";
// 即梦网页自动操作（M3）。本模块只负责“怎么操作页面”，不依赖 Electron 本体：
// 调用方（主进程）把一个带 webContents 的窗口传进来；单测用假 driver。
//
// ⚠️ 选择器图谱未经真机验证 ⚠️
// 下面的 SELECTORS 是按即梦网页常见结构写的占位选择器，当前环境没有登录态，
// 无法对真实页面实测。自动化运行时只要有一个关键选择器找不到，就会立刻失败并
// 把窗口交给用户手动完成（见 runJimengShot 的 manualFallback），绝不静默跳过、
// 绝不谎称生成成功。接通真机后第一件事就是按实际页面修正这张表。
// 即梦配音自动操作与视频生成不是同一页面/流程，不硬拼进同一个 runner：
// 配音仍走 M2 的占位 + 导入音频兜底（见 lib/video/tts.js），本模块不伪造配音自动化。
const JIMENG_URL = "https://jimeng.jianying.com";

const SELECTORS = {
  // UNVERIFIED：以下选择器均未对真实即梦页面验证，接通前必须实测修正。
  promptInput: "textarea[placeholder*='描述']",
  generateButton: "button:has-text('生成')", // 仅作语义标记；executeJavaScript 里按文本匹配按钮，不依赖 :has-text
  generateButtonText: "生成",
  generatingIndicator: "[class*='generating'], [class*='loading']",
  resultVideo: "video",
  downloadButtonText: "下载",
  voicePageMarker: "配音",
};

class JimengError extends Error {
  constructor(message, { code = "", manualFallback = false } = {}) {
    super(message);
    this.name = "JimengError";
    this.code = code;
    this.manualFallback = manualFallback;
  }
}

// 提示词：画面描述 + 运镜 + 风格 + 画幅。shot.imagePrompt 优先于 visual（与编辑器一致）。
function buildVideoPrompt(shot, project = {}) {
  const base = String((shot && (shot.imagePrompt || shot.visual)) || "").trim();
  const aspect = (project && project.aspect) || "9:16";
  const motion = "镜头缓慢平稳移动，主体动作自然连贯，画面稳定不抖动";
  const style = "电影感、自然光、真实质感";
  const parts = [base, `运镜：${motion}`, `风格：${style}`, `画幅：${aspect}竖屏`].filter(Boolean);
  return parts.join("，");
}

// 下载处理：把 session 的 will-download 接到“当前待下载文件”上。
// attachDownloadHandler(session, getSavePath)：session 须有 on(event, fn)；
// 返回的 handler(item, savePath) 供单测与主进程共用：item 须有 on('updated'/'done') 与 state。
function attachDownloadHandler(session, getSavePath) {
  if (!session || typeof session.on !== "function") throw new JimengError("下载会话未接通", { code: "NO_SESSION" });
  session.on("will-download", (_event, item) => {
    const savePath = typeof getSavePath === "function" ? getSavePath() : getSavePath;
    if (savePath && typeof item.setSavePath === "function") item.setSavePath(savePath);
  });
  return session;
}

// 单个下载项的完成等待（假 item 可注入）：state 变为 completed 时 resolve，cancelled/interrupted 时 reject。
function waitForDownloadItem(item) {
  return new Promise((resolve, reject) => {
    if (!item || typeof item.on !== "function") { reject(new JimengError("下载项无效", { code: "BAD_DOWNLOAD_ITEM" })); return; }
    item.on("done", (_e, state) => {
      if (state === "completed") resolve();
      else reject(new JimengError(`下载未完成（状态：${state}），请在窗口里手动下载后用“导入片段”导进来。`, { code: "DOWNLOAD_FAILED", manualFallback: true }));
    });
  });
}

// 自动操作 runner：driver 须提供 executeJavaScript(jsString) -> Promise<any>，
// 以及可选的 sleep(ms)。步骤：填提示词 -> 点生成 -> 轮询完成 -> 返回是否完成。
// 任何一步找不到元素都抛 SELECTOR_NOT_FOUND 且 manualFallback=true，调用方必须把窗口交给用户。
async function runJimengShot({ driver, prompt, selectors = SELECTORS, timeoutMs = 600000, pollMs = 5000, sleep = null } = {}) {
  if (!driver || typeof driver.executeJavaScript !== "function") {
    throw new JimengError("即梦内嵌窗口未接通，无法自动操作；请点“打开即梦”在窗口里手动生成，下载后用“导入片段”导进来。", { code: "NO_WINDOW", manualFallback: true });
  }
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const sel = { ...SELECTORS, ...selectors };
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
  // 1. 填提示词
  const filled = await driver.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(sel.promptInput)}); if (!el) return false; ` +
    `el.focus(); el.value = \`${esc(prompt)}\`; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
  );
  if (!filled) {
    throw new JimengError("在即梦页面上找不到提示词输入框（选择器未验证或页面已改版），已把窗口交给用户手动完成：请在窗口里手动填提示词、生成并下载，下载后用“导入片段”导进来。", { code: "SELECTOR_NOT_FOUND", manualFallback: true });
  }
  // 2. 点生成：按按钮文本匹配，不依赖某个具体 class
  const clicked = await driver.executeJavaScript(
    `(() => { const btns = [...document.querySelectorAll('button')]; ` +
    `const b = btns.find((x) => (x.textContent || '').trim().includes(${JSON.stringify(sel.generateButtonText)})); ` +
    `if (!b) return false; b.click(); return true; })()`,
  );
  if (!clicked) {
    throw new JimengError("在即梦页面上找不到“生成”按钮（选择器未验证或页面已改版），已把窗口交给用户手动完成：请在窗口里手动点生成并下载，下载后用“导入片段”导进来。", { code: "SELECTOR_NOT_FOUND", manualFallback: true });
  }
  // 3. 轮询：生成中指示器消失且页面出现 video 元素，视为完成；超时则交手动。
  const started = Date.now();
  for (;;) {
    const done = await driver.executeJavaScript(
      `(() => { const busy = document.querySelector(${JSON.stringify(sel.generatingIndicator)}); ` +
      `const v = document.querySelector(${JSON.stringify(sel.resultVideo)}); return !busy && !!v; })()`,
    );
    if (done) return { completed: true, manualFallback: false };
    if (Date.now() - started > timeoutMs) {
      throw new JimengError("即梦生成等待超时（可能在排队或需要验证），已把窗口交给用户：请在窗口里等生成完成并手动下载，下载后用“导入片段”导进来。", { code: "GENERATE_TIMEOUT", manualFallback: true });
    }
    await wait(pollMs);
  }
}

module.exports = {
  JIMENG_URL, SELECTORS, JimengError,
  buildVideoPrompt, attachDownloadHandler, waitForDownloadItem, runJimengShot,
  // 诚实标记：即梦配音自动操作未接通（与视频生成不同页面/流程），仍走 M2 占位 + 导入兜底。
  VOICE_AUTOMATION_SUPPORTED: false,
};
