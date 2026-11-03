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
    // 可手填、也可从服务端列表里选的输入框（模型、音色）。loadFn() → { ok, items, error }
    // 列表按 key 缓存在本机，下次打开设置直接可选；“获取列表”重新拉。
    const pickerInput = (key, placeholder, loadFn, what = "模型") => {
      const input = textInput(key, placeholder);
      const cacheKey = "video.pick." + key;
      const sel = h("select", { class: "input picker-select", title: `从服务端的${what}列表里选` });
      const fill = (items) => {
        const cur = input.value.trim();
        sel.replaceChildren(h("option", { value: "" }, `选择${what}（${items.length}）`), ...items.map((m) => h("option", { value: m }, m)));
        sel.value = items.includes(cur) ? cur : "";
        sel.hidden = !items.length;
      };
      sel.addEventListener("change", () => {
        if (!sel.value) return;
        input.value = sel.value;
        window.Shell.saveSettings({ [key]: sel.value });
      });
      input.addEventListener("input", () => { if ([...sel.options].some((o) => o.value === input.value.trim())) sel.value = input.value.trim(); else sel.value = ""; });
      let cached = [];
      try { cached = JSON.parse(localStorage.getItem(cacheKey) || "[]"); } catch { cached = []; }
      fill(Array.isArray(cached) ? cached : []);
      const btn = h("button", { class: "btn", title: `从接口拉取可用${what}` }, "获取列表");
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = "获取中…";
        try {
          const r = await loadFn();
          if (!r || !r.ok) { window.Shell.toast((r && r.error) || "获取失败", "error"); return; }
          const items = r.items || [];
          if (!items.length) { window.Shell.toast(`接口没返回${what}列表，请手动填写`); return; }
          try { localStorage.setItem(cacheKey, JSON.stringify(items)); } catch { /* ignore */ }
          fill(items);
          window.Shell.toast(`找到 ${items.length} 个${what}，在下拉里选`, "success");
          sel.focus();
        } catch (e) { window.Shell.toast(e.message, "error"); }
        finally { btn.disabled = false; btn.textContent = "获取列表"; }
      };
      return h("div", { class: "picker" }, input, sel, btn);
    };
    const models = (kind) => async () => { const r = await api.video.ai.models(kind); return r.ok ? { ok: true, items: r.models } : r; };
    const voices = (kind) => async () => { const r = await api.video.ai.voices(kind); return r.ok ? { ok: true, items: r.voices } : r; };

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
          row("新建项目镜头数", "新建项目时默认创建的空镜头数", range("videoDefaultShotCount", { min: 1, max: 30, step: 1, format: (v) => v + " 个" })),
          row("默认时长（参考）", "仅作参考，实际时长按配音实测或口播字数估算", range("videoDefaultDuration", { min: 10, max: 300, step: 5, format: (v) => v + " 秒" })));
      },
    });

    // ---------------- 配音 ----------------
    // 服务商切换时整块重画：云端（OpenAI 兼容）/ 本地 / 即梦各自只显示自己用得到的项
    window.Shell.registerSettingsSection({
      id: "video-voice", title: "配音", icon: "mic", order: 2,
      render(box) {
        const head = row("配音服务商", "", select("ttsProvider", [["openai", "云端 TTS（OpenAI 兼容）"], ["local", "本地 TTS（本机服务）"], ["voicebox", "Voicebox（本机声音克隆）"], ["jimeng", "即梦（网页版，手动导入）"]]));
        const body = h("div", {});
        const draw = () => {
          const p = window.Shell.getSettings().ttsProvider || "openai";
          const desc = head.querySelector(".set-desc") || head.querySelector(".set-text").appendChild(h("div", { class: "set-desc" }));
          const rate = row("语速", "项目没有单独设置时都用这个倍率", range("ttsRate", { min: 0.5, max: 2, step: 0.05, format: (v) => Number(v).toFixed(2) + " 倍" }));
          if (p === "jimeng") {
            desc.textContent = "即梦尚未自动接通：在即梦网页生成配音后，用分镜里的“导入音频”导入";
            body.replaceChildren();
          } else if (p === "voicebox") {
            desc.textContent = "先在 Voicebox 桌面版里用 5–15 秒录音克隆出声音档案，这里选档案名即可；Voicebox 需保持打开，不需要 Key";
            body.replaceChildren(
              row("服务地址", "Voicebox 后端地址，桌面版默认 http://127.0.0.1:17493", textInput("ttsVoiceboxBaseUrl", "http://127.0.0.1:17493"), { stack: true }),
              row("声音档案", "Voicebox 里的档案名；点“获取列表”从 Voicebox 读取", pickerInput("ttsVoice", "档案名", voices("tts-voicebox"), "档案")),
              row("引擎", "qwen 即 Qwen3-TTS，中文克隆推荐；其他引擎需先在 Voicebox 里下载", pickerInput("ttsVoiceboxEngine", "qwen", models("tts-voicebox"))),
              row("模型大小", "1.7B 质量更好，建议 16GB 内存以上；0.6B 更快更省内存", select("ttsVoiceboxModelSize", [["1.7B", "1.7B（质量优先）"], ["0.6B", "0.6B（速度优先）"]])),
              row("语言", "口播文案的语言", select("ttsVoiceboxLanguage", [["zh", "中文"], ["en", "英文"], ["ja", "日文"], ["ko", "韩文"]])));
          } else if (p === "local") {
            desc.textContent = "本机跑的语音服务，只要提供 OpenAI 兼容的 /audio/speech 接口就能用，比如 Kokoro-FastAPI、openedai-speech，或 CosyVoice、IndexTTS、GPT-SoVITS 的 OpenAI 兼容封装；不需要 Key";
            body.replaceChildren(
              row("服务地址", "本地服务的 Base URL，一般以 /v1 结尾，例如 http://127.0.0.1:8880/v1", textInput("ttsLocalBaseUrl", "http://127.0.0.1:8880/v1"), { stack: true }),
              row("模型", "本地服务里的模型名，例如 kokoro、tts-1；可点“获取列表”从服务里选", pickerInput("ttsLocalModel", "如 kokoro", models("tts-local"))),
              row("音色", "例如 zf_xiaobei（Kokoro 中文女声）；服务支持时可点“获取列表”", pickerInput("ttsVoice", "如 zf_xiaobei", voices("tts-local"), "音色")),
              rate);
          } else {
            desc.textContent = "OpenAI、硅基流动等提供 OpenAI 兼容语音接口的云服务";
            body.replaceChildren(
              row("接口地址", "OpenAI 兼容服务的 Base URL；留空表示 https://api.openai.com/v1", textInput("ttsBaseUrl", "https://api.openai.com/v1"), { stack: true }),
              row("模型", "例如 tts-1、gpt-4o-mini-tts；保存 Key 后可点“获取列表”选", pickerInput("ttsModel", "如 tts-1", models("tts"))),
              row("音色", "服务商的音色名，例如 alloy", pickerInput("ttsVoice", "如 alloy", voices("tts"), "音色")),
              rate,
              keyRow("TTS Key", "粘贴 TTS 服务的 API Key", () => api.video.secrets.status(), (v) => api.video.secrets.set(v)));
          }
        };
        window.Shell.onSettings((c) => { if ("ttsProvider" in c && box.isConnected) draw(); });
        box.append(head, body);
        draw();
      },
    });

    // ---------------- AI 分析 ----------------
    window.Shell.registerSettingsSection({
      id: "video-ai", title: "AI 分析", icon: "cpu", order: 3,
      render(box) {
        box.append(
          row("接口地址", "OpenAI 兼容服务的 Base URL；留空表示 https://api.openai.com/v1", textInput("aiBaseUrl", "https://api.openai.com/v1"), { stack: true }),
          row("模型", "保存 Key 后点“获取列表”从服务里选，也可以手填；支持看图的模型（如 gpt-4o-mini、qwen-vl-plus）会结合视频画面分析", pickerInput("aiModel", "如 gpt-4o-mini", models("ai"))),
          keyRow("AI Key", "粘贴 AI 服务的 API Key（视频分析用）", () => api.video.ai.status(), (v) => api.video.ai.setKey(v)));
      },
    });

    // ---------------- 0.6.44 人物生图 ----------------
    window.Shell.registerSettingsSection({
      id: "video-image", title: "人物生图", icon: "image", order: 3.5,
      render(box) {
        box.append(
          h("p", { class: "muted small-text" }, "作品库 → 角色 里生成三视图和镜头首帧图用。不填也能用：复制提示词和参考图，到即梦网页里自己生成，再导入。"));
        // 0.6.54：每家服务商各存一个 Key、各自勾选要用的模型；生图时从这里勾过的模型里选（可同时用几个）
        const dyn = h("div", {});
        box.append(dyn);
        const getConf = () => { try { return JSON.parse(window.Shell.getSettings().imageProviders || "{}") || {}; } catch { return {}; } };
        const saveConf = (conf) => window.Shell.saveSettings({ imageProviders: JSON.stringify(conf) });
        const fetched = {}; // 本次打开从服务商拉到的模型
        const draw = async () => {
          const r = await api.video.chars.providers().catch(() => null);
          const info = (r && r.ok && r.providers) || [];
          const conf = getConf();
          // 第一次保存时，把现在生效的（含旧设置迁移来的）启用模型写进去
          for (const P of info) if (!conf[P.id]) conf[P.id] = { models: P.enabled || [], baseUrl: P.baseUrl || "" };
          const enabledAll = info.flatMap((P) => (P.hasKey ? P.modelInfo.map((m) => ({ p: P, m })) : []));
          const defSel = h("select", { class: "input", onchange: () => { const [pid, mid] = defSel.value.split("|"); window.Shell.saveSettings({ imageProvider: pid, imageModel: mid }); } },
            ...(enabledAll.length ? enabledAll.map(({ p: P, m }) => h("option", { value: P.id + "|" + m.id }, `${P.label.replace(/（.*?）/g, "")} · ${m.label}`)) : [h("option", { value: "" }, "先在下面存 Key、勾模型")]));
          if (r && r.ok) defSel.value = r.current + "|" + r.model;
          if (!defSel.value && enabledAll[0]) defSel.selectedIndex = 0;
          const cards = info.map((P) => {
            const c = conf[P.id];
            const preset = (P.models || []).map(([id]) => id);
            const list = [...new Set([...preset, ...(fetched[P.id] || []), ...c.models])];
            const label = (id) => { const hit = (P.models || []).find(([m]) => m === id); return hit ? hit[1] : id; };
            const chips = h("div", { class: "model-pick" }, ...list.map((id) => {
              const cb = h("input", { type: "checkbox", checked: c.models.includes(id), onchange: async () => {
                c.models = cb.checked ? [...new Set([...c.models, id])] : c.models.filter((x) => x !== id);
                conf[P.id] = c; await saveConf(conf); draw();
              } });
              return h("label", { class: "model-chip", title: id }, cb, label(id));
            }), list.length ? null : h("span", { class: "muted small-text" }, "点“获取可用模型”或手动添加"));
            const addInput = h("input", { class: "input", placeholder: "手动添加模型名，回车" });
            addInput.addEventListener("keydown", async (e) => {
              if (e.key !== "Enter" || !addInput.value.trim()) return;
              c.models = [...new Set([...c.models, addInput.value.trim()])]; conf[P.id] = c; await saveConf(conf); draw();
            });
            const fetchBtn = h("button", { class: "btn small", onclick: async () => {
              fetchBtn.disabled = true; fetchBtn.textContent = "获取中…";
              const lr = await api.video.chars.listModels(P.id).catch((e) => ({ ok: false, error: e.message }));
              fetchBtn.disabled = false; fetchBtn.textContent = "获取可用模型";
              if (lr && lr.ok) {
                fetched[P.id] = lr.models;
                window.Shell.toast(lr.fetched ? `拿到 ${lr.models.length} 个生图模型，勾上你要用的` : `这家不提供模型列表（${lr.error || "未知原因"}），已列出常用模型`, lr.fetched ? "success" : "info", 5000);
                draw();
              } else window.Shell.toast((lr && lr.error) || "获取失败", "error");
            } }, "获取可用模型");
            const baseInput = h("input", { class: "input", placeholder: P.base ? `留空用默认 ${P.base}` : "必填，如 https://xxx.com/v1", value: c.baseUrl || "",
              oninput: debounce(() => { c.baseUrl = baseInput.value.trim(); conf[P.id] = c; saveConf(conf); }, 400) });
            return h("div", { class: "image-provider-card" },
              h("div", { class: "set-title" }, P.label, P.hasKey ? h("span", { class: "muted small-text" }, `  已启用 ${c.models.length} 个模型`) : h("span", { class: "muted small-text" }, "  未保存 Key")),
              keyRow(`${P.label.replace(/（.*?）/g, "")} API Key`, P.keyHint, () => api.video.chars.keyStatus(P.id), async (v) => { const x = await api.video.chars.setKey(v, P.id); setTimeout(draw, 50); return x; }),
              row("要用的模型", "勾上的模型才会出现在生图时的“用哪些模型”里；“无参考图”的模型只按文字生成，人物可能不像", h("div", {}, chips, h("div", { class: "actions" }, addInput, fetchBtn)), { stack: true }),
              row("接口地址", P.id === "custom" ? "中转/其他服务商必填" : "一般留空", baseInput, { stack: true }));
          });
          dyn.replaceChildren(
            row("默认模型", "只勾一个模型生图时默认用它；每家的 Key 分开存，互不影响", defSel, { stack: true }),
            ...cards);
        };
        draw();
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
