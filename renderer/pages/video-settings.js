"use strict";
// 设置分组：视频默认值（新建项目时用）与配音设置（M2）。
// 设置项已在 main.js 的 schema 里声明。TTS Key 不走 settings.json：
// 页面只输入一次交给主进程加密存（safeStorage；无钥匙串时退回 0600 文件并明确提示），
// 页面永远拿不到 Key 本身，只能拿到“已设置/末 4 位”。
// 注意：本文件在 shell/pages/settings.js 之前加载，registerSettingsSection
// 要等外壳启动（onStart）时再注册，否则当时还不存在。
(function () {
  function register() {
    const { h, settingsUI } = window.Shell;
    const { row, select, range } = settingsUI;
    const api = window.app;
    const debounce = window.Shell.debounce || ((fn) => fn);
    // 文本输入框：改动后防抖保存到设置
    const textInput = (key, placeholder) => {
      const input = h("input", {
        class: "input", placeholder,
        value: String(window.Shell.getSettings()[key] ?? ""),
        oninput: debounce(() => window.Shell.saveSettings({ [key]: input.value }), 300),
      });
      window.Shell.onSettings((c, s) => { if (key in c && document.activeElement !== input) input.value = String(s[key] ?? ""); });
      return input;
    };
    window.Shell.registerSettingsSection({
      id: "video",
      title: "视频",
      order: 15,
      tag: "M2",
      render(box) {
        const keyInput = h("input", { class: "input", type: "password", placeholder: "TTS Key（OpenAI 兼容服务用；即梦网页版不需要）", autocomplete: "off" });
        const keyStatus = h("span", { class: "muted" }, "正在读取…");
        const refreshKeyStatus = async () => {
          try {
            const r = await api.video.secrets.status();
            keyStatus.textContent = r.set
              ? `已设置（末 4 位 …${r.last4}）${r.insecureFallback ? "，注意：本机无可用钥匙串，Key 以文件形式保存，未加密" : ""}`
              : "未设置";
          } catch (e) { keyStatus.textContent = "读取失败：" + e.message; }
        };
        const ffStatus = h("span", { class: "muted" }, "正在检测…");
        const refreshFf = async () => {
          try {
            const r = await api.video.ffmpeg.status();
            ffStatus.textContent = r.ok ? "ffmpeg 与 ffprobe 均可用" : r.warning;
          } catch (e) { ffStatus.textContent = "检测失败：" + e.message; }
        };
        box.append(
          row("画面比例", "新建项目的默认比例", select("videoAspect", [["9:16", "9:16 竖屏"], ["16:9", "16:9 横屏"], ["1:1", "1:1 方形"]])),
          row("新建项目镜头数", "新建项目时默认创建的空镜头数", range("videoDefaultShotCount", { min: 1, max: 12, step: 1, format: (v) => v + " 个" })),
          row("默认时长（参考）", "仅作新建时的参考值，实际时长按配音实测或口播字数估算", range("videoDefaultDuration", { min: 10, max: 300, step: 5, format: (v) => v + " 秒" })),
          row("配音服务商", "即梦目前尚未自动接通：选即梦后生成配音会明确报错并指引你导入即梦下载的音频", select("ttsProvider", [["openai", "OpenAI 兼容 TTS"], ["jimeng", "即梦（网页版，尚未自动接通）"]])),
          row("配音音色", "OpenAI 兼容服务用的音色名（如 alloy）；即梦的音色在即梦网页里选", textInput("ttsVoice", "如 alloy")),
          row("配音语速", "生成配音的语速倍率", range("ttsRate", { min: 0.5, max: 2, step: 0.05, format: (v) => v + " 倍" })),
          row("TTS 服务地址", "OpenAI 兼容服务的 Base URL；留空表示 https://api.openai.com/v1", textInput("ttsBaseUrl", "https://api.openai.com/v1")),
          row("TTS 模型", "OpenAI 兼容服务的模型名", textInput("ttsModel", "如 tts-1")),
          row("TTS Key", "只保存到主进程加密存储，不会显示在设置文件里；留空保存表示清除",
            h("div", {},
              keyInput,
              h("div", { class: "actions" },
                h("button", { class: "btn small primary", onclick: async () => {
                  const r = await api.video.secrets.set(keyInput.value);
                  if (r.ok) { keyInput.value = ""; window.Shell.toast("TTS Key 已保存", "success"); }
                  else window.Shell.toast(r.error || "保存失败", "error");
                  await refreshKeyStatus();
                } }, "保存 Key"),
                h("button", { class: "btn small", onclick: async () => { keyInput.value = ""; window.Shell.toast("已清空输入框（未改动已保存的 Key）"); } }, "清空输入")),
              h("p", { class: "muted" }, "", keyStatus))),
          row("系统 ffmpeg", "配音实测时长和后续合成导出都依赖系统 ffmpeg/ffprobe",
            h("div", {},
              h("div", { class: "actions" },
                h("button", { class: "btn small", onclick: refreshFf }, "重新检测")),
              h("p", { class: "muted" }, "", ffStatus))));
        refreshKeyStatus();
        refreshFf();
      },
    });
  }
  if (typeof window.Shell.registerSettingsSection === "function") register();
  else window.Shell.onStart(register);
})();
