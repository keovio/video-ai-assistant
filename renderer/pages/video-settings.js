"use strict";
// 设置分组（业务设置）：画面与新建、配音、AI 分析、ffmpeg 四类，各自一张卡片，在设置页左侧导航里切换。
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
        oninput: debounce(() => window.Shell.saveSettings({ [key]: input.value.trim() }), 300),
      });
      window.Shell.onSettings((c, s) => { if (key in c && document.activeElement !== input) input.value = String(s[key] ?? ""); });
      return input;
    };
    // Key 输入行：密码框 + 保存/清除，状态显示在说明里（与 content-ai-assistant 的 API Key 行一致）
    const keyRow = (title, placeholder, statusFn, setFn) => {
      const input = h("input", { class: "input", type: "password", placeholder, autocomplete: "off" });
      const state = h("span", { class: "muted small-text" }, "正在读取…");
      const refresh = async () => {
        try {
          const r = await statusFn();
          state.textContent = r.set
            ? `已保存（…${r.last4}）${r.insecureFallback ? "，本机无可用钥匙串，Key 以文件保存、未加密" : "，已用系统钥匙串加密"}`
            : "还没有保存 Key";
        } catch (e) { state.textContent = "读取失败：" + e.message; }
      };
      const save = async (value) => {
        const r = await setFn(value);
        if (r.ok) { input.value = ""; window.Shell.toast(value ? `${title} 已保存` : `${title} 已清除`, "success"); }
        else window.Shell.toast(r.error || "保存失败", "error");
        refresh();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" && input.value.trim()) save(input.value.trim()); });
      refresh();
      return row(title, state, h("div", { class: "actions" }, input,
        h("button", { class: "btn", onclick: () => { if (!input.value.trim()) { window.Shell.toast("先粘贴 Key"); return; } save(input.value.trim()); } }, "保存"),
        h("button", { class: "btn ghost", onclick: async () => {
          if (!(await window.Shell.confirm(`清除已保存的 ${title}？`))) return;
          save("");
        } }, "清除")), { stack: true });
    };

    // ---------------- 画面与新建 ----------------
    window.Shell.registerSettingsSection({
      id: "video-general", title: "画面与新建", icon: "image", order: 1,
      render(box) {
        box.append(
          row("画面比例", "新建项目的默认比例", select("videoAspect", [["9:16", "9:16 竖屏"], ["16:9", "16:9 横屏"], ["1:1", "1:1 方形"]])),
          row("新建项目镜头数", "新建项目时默认创建的空镜头数", range("videoDefaultShotCount", { min: 1, max: 12, step: 1, format: (v) => v + " 个" })),
          row("默认时长（参考）", "仅作参考，实际时长按配音实测或口播字数估算", range("videoDefaultDuration", { min: 10, max: 300, step: 5, format: (v) => v + " 秒" })));
      },
    });

    // ---------------- 配音 ----------------
    window.Shell.registerSettingsSection({
      id: "video-voice", title: "配音", icon: "mic", order: 2,
      render(box) {
        box.append(
          row("配音服务商", "即梦尚未自动接通：选即梦后请在即梦网页生成配音，再用“导入音频”导入", select("ttsProvider", [["openai", "OpenAI 兼容 TTS"], ["jimeng", "即梦（网页版，手动导入）"]])),
          row("音色", "OpenAI 兼容服务的音色名，例如 alloy", textInput("ttsVoice", "如 alloy")),
          row("语速", "项目没有单独设置时都用这个倍率", range("ttsRate", { min: 0.5, max: 2, step: 0.05, format: (v) => Number(v).toFixed(2) + " 倍" })),
          row("接口地址", "OpenAI 兼容服务的 Base URL；留空表示 https://api.openai.com/v1", textInput("ttsBaseUrl", "https://api.openai.com/v1"), { stack: true }),
          row("模型", "例如 tts-1、gpt-4o-mini-tts", textInput("ttsModel", "如 tts-1")),
          keyRow("TTS Key", "粘贴 TTS 服务的 API Key", () => api.video.secrets.status(), (v) => api.video.secrets.set(v)));
      },
    });

    // ---------------- AI 分析 ----------------
    window.Shell.registerSettingsSection({
      id: "video-ai", title: "AI 分析", icon: "cpu", order: 3,
      render(box) {
        box.append(
          row("接口地址", "OpenAI 兼容服务的 Base URL；留空表示 https://api.openai.com/v1", textInput("aiBaseUrl", "https://api.openai.com/v1"), { stack: true }),
          row("模型", "聊天模型名；支持看图的模型（如 gpt-4o-mini、qwen-vl-plus）会结合视频画面分析", textInput("aiModel", "如 gpt-4o-mini")),
          keyRow("AI Key", "粘贴 AI 服务的 API Key（抖音分析用）", () => api.video.ai.status(), (v) => api.video.ai.setKey(v)));
      },
    });

    // ---------------- 系统依赖 ----------------
    window.Shell.registerSettingsSection({
      id: "video-system", title: "ffmpeg 与数据", icon: "terminal", order: 4,
      render(box) {
        const ffStatus = h("span", { class: "muted small-text" }, "正在检测…");
        const refreshFf = async (fresh) => {
          ffStatus.textContent = "正在检测…";
          try {
            const r = await api.video.ffmpeg.status({ fresh: !!fresh });
            ffStatus.textContent = r.ok ? "ffmpeg 与 ffprobe 均可用" : r.warning;
          } catch (e) { ffStatus.textContent = "检测失败：" + e.message; }
        };
        const backupBox = h("div", { class: "clip-list" });
        const refreshBackups = async () => {
          const r = await api.video.backups.list().catch(() => ({ backups: [] }));
          const list = (r && r.backups) || [];
          backupBox.replaceChildren(...(list.length ? list.slice(0, 10).map((b) => h("div", { class: "clip-row" },
            h("div", { class: "clip-row-head" },
              h("span", { class: "grow" }, b.reason || "备份"),
              h("span", { class: "chip" }, `${b.projectCount} 个项目`),
              h("button", { class: "btn small", onclick: async () => {
                if (!(await window.Shell.confirm(`恢复到“${b.reason}”时的数据？之后新建或修改的内容会被替换（恢复前会先自动备份当前数据）。`))) return;
                const res = await api.video.backups.restore(b.id);
                if (!res.ok) { window.Shell.toast(res.error || "恢复失败", "error"); return; }
                window.Shell.toast(`已恢复，共 ${res.projectCount} 个项目`, "success");
                refreshBackups();
              } }, "恢复")),
            h("div", { class: "clip-row-text" }, new Date(b.at).toLocaleString()))) : [h("p", { class: "muted small-text" }, "还没有备份。删除项目前会自动备份。")]));
        };
        box.append(row("系统 ffmpeg", ffStatus, h("button", { class: "btn", onclick: () => refreshFf(true) }, "重新检测")),
          h("p", { class: "muted small-text" }, "配音实测时长和合成导出依赖系统 ffmpeg / ffprobe。macOS：brew install ffmpeg；Windows：winget install ffmpeg。装完点“重新检测”，不用重启。"),
          row("数据备份", "删除项目前自动备份，误删可以在这里恢复", backupBox, { stack: true }));
        refreshFf(false);
        refreshBackups();
      },
    });
  }
  if (typeof window.Shell.registerSettingsSection === "function") register();
  else window.Shell.onStart(register);
})();
