"use strict";
// 内置页面：设置。每个分组是一张模块卡片，宽窗口自动排成多列（瀑布流）。
// 外观（布局、深浅色、主题色、缩放）、背景（预设 / 自定义图片、遮罩、毛玻璃、性能模式）、字体、关于与更新（含系统信息）、日志与数据。
// 加自己的设置分组（一张卡片）：
//   Shell.registerSettingsSection({ id: "sync", title: "同步", order: 15, tag: "可选", render(box, ctx) { box.append(row(...)) } });
// 设置项要先在 main.js 的 schema 里声明，读写用 Shell.getSettings() / Shell.saveSettings({ key: value })。
(function () {
  const { h, icon } = window.Shell;
  const api = window.app;
  const sections = [];

  window.Shell.registerSettingsSection = function (def) {
    if (!def || !def.id || typeof def.render !== "function") throw new Error("registerSettingsSection 需要 id 和 render");
    sections.push(def);
  };

  // ---- 通用控件 ----
  // 一行设置：左边标题 + 说明，右边控件
  function row(title, desc, control, { stack = false } = {}) {
    return h("div", { class: "set-row" + (stack ? " stack" : "") },
      h("div", { class: "set-text" }, h("div", { class: "set-title" }, title), desc ? h("div", { class: "set-desc" }, desc) : null),
      h("div", { class: "set-control" }, control));
  }
  function toggle(key, { onChange } = {}) {
    const input = h("input", { type: "checkbox", role: "switch", checked: !!window.Shell.getSettings()[key],
      onchange: () => { window.Shell.saveSettings({ [key]: input.checked }); onChange && onChange(input.checked); } });
    window.Shell.onSettings((c, s) => { if (key in c) input.checked = !!s[key]; });
    return h("label", { class: "switch" }, input, h("span", { class: "slider" }));
  }
  function segmented(key, options) {
    const box = h("div", { class: "segmented", role: "radiogroup" });
    const draw = (v) => { for (const b of box.children) b.classList.toggle("active", b.dataset.value === v); };
    for (const [value, label] of options) {
      box.append(h("button", { dataset: { value }, role: "radio", onclick: () => { window.Shell.saveSettings({ [key]: value }); draw(value); } }, label));
    }
    draw(String(window.Shell.getSettings()[key]));
    window.Shell.onSettings((c, s) => { if (key in c) draw(String(s[key])); });
    return box;
  }
  function select(key, options, { parse = (v) => v } = {}) {
    const sel = h("select", { class: "input", onchange: () => window.Shell.saveSettings({ [key]: parse(sel.value) }) },
      ...options.map(([value, label]) => h("option", { value: String(value) }, label)));
    sel.value = String(window.Shell.getSettings()[key]);
    window.Shell.onSettings((c, s) => { if (key in c) sel.value = String(s[key]); });
    return sel;
  }
  // 滑块：range(key, { min, max, step, format })
  function range(key, { min, max, step = 1, format = (v) => String(v) } = {}) {
    const out = h("span", { class: "range-val" });
    const input = h("input", { type: "range", class: "range", min, max, step,
      oninput: () => { out.textContent = format(Number(input.value)); window.Shell.saveSettings({ [key]: Number(input.value) }); } });
    const draw = (v) => { input.value = String(v); out.textContent = format(Number(v)); };
    draw(window.Shell.getSettings()[key]);
    window.Shell.onSettings((c, s) => { if (key in c && document.activeElement !== input) draw(s[key]); });
    return h("div", { class: "range-wrap" }, input, out);
  }
  // 色块 / 图块选择：swatches(key, [[value, label, className]], { extra })
  function swatches(key, options, { cls = "swatch", extra } = {}) {
    const box = h("div", { class: "swatches", role: "radiogroup" });
    const draw = (v) => { for (const b of box.querySelectorAll("[data-value]")) { const on = b.dataset.value === v; b.classList.toggle("active", on); b.setAttribute("aria-checked", String(on)); } };
    for (const [value, label, className] of options) {
      box.append(h("button", { class: `${cls} ${className || ""}`, dataset: { value }, role: "radio", title: label, "aria-label": label,
        onclick: () => { window.Shell.saveSettings({ [key]: value }); draw(value); } },
      cls === "bg-swatch" ? h("span", { class: "bg-swatch-label" }, label) : null));
    }
    if (extra) box.append(extra);
    draw(String(window.Shell.getSettings()[key]));
    window.Shell.onSettings((c, s) => { if (key in c) draw(String(s[key])); });
    return box;
  }
  window.Shell.settingsUI = { row, toggle, segmented, select, range, swatches };

  // ---- 应用更新卡片（元素 id 供冒烟测试检查） ----
  function updateCard(info) {
    const ui = {};
    ui.status = h("p", { class: "status", id: "update-status" }, "点击「检查更新」看看有没有新版本");
    ui.notes = h("p", { class: "notes", id: "update-notes", hidden: true });
    ui.bar = h("div", { class: "bar", id: "update-bar" });
    ui.progress = h("div", { class: "progress", id: "update-progress", hidden: true }, ui.bar);
    ui.error = h("p", { class: "error", id: "update-error", hidden: true });
    ui.check = h("button", { class: "btn", id: "btn-check" }, "检查更新");
    ui.download = h("button", { class: "btn primary", id: "btn-download", hidden: true }, "下载更新");
    ui.full = h("button", { class: "btn primary", id: "btn-full", hidden: true }, "下载完整安装包");
    ui.restart = h("button", { class: "btn primary", id: "btn-restart", hidden: true }, "重启生效");
    const card = h("div", { class: "subcard", id: "update-card" },
      ui.status, ui.notes, ui.progress, ui.error,
      h("div", { class: "actions" }, ui.check, ui.download, ui.full, ui.restart));

    let installerUrl = "";
    const show = (el, on) => { el.hidden = !on; };
    const mb = (b) => (b / 1048576).toFixed(1) + " MB";
    function setError(res) {
      const msg = res && (res.message || res.error);
      ui.error.textContent = msg || "";
      ui.error.title = (res && res.detail) || "";
      show(ui.error, !!msg);
    }
    function renderDownloaded(version) {
      show(ui.progress, false); show(ui.download, false); show(ui.full, false);
      ui.status.textContent = `新版本 ${version} 已下载好，重启后生效`;
      show(ui.restart, true);
    }
    function renderCheck(r) {
      setError(null);
      show(ui.download, false); show(ui.full, false); show(ui.notes, false);
      if (!r) return;
      if (!r.ok) { ui.status.textContent = "检查更新没有成功"; setError(r); return; }
      if (r.alreadyDownloaded) { renderDownloaded(r.latest); return; }
      if (!r.available) { ui.status.textContent = `已是最新版本（${r.current}）`; return; }
      if (r.notes) { ui.notes.textContent = r.notes; show(ui.notes, true); }
      if (r.needsFull) {
        ui.status.textContent = `发现新版本 ${r.latest}，需要下载完整安装包（${r.fullReason}）`;
        installerUrl = r.installerUrl || r.releaseUrl || "";
        show(ui.full, !!installerUrl);
        return;
      }
      ui.status.textContent = `发现新版本 ${r.latest}（约 ${mb(r.size)}）`;
      if (r.badBefore) setError({ message: "这个版本上次启动失败，已自动退回。可以重新下载再试一次。", detail: r.badBefore });
      show(ui.download, true);
    }
    async function busy(btn, label, fn) {
      const old = btn.textContent;
      btn.disabled = true; btn.textContent = label;
      try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
    }
    ui.check.addEventListener("click", () => busy(ui.check, "正在检查…", async () => {
      ui.status.textContent = "正在检查更新…";
      renderCheck(await api.update.check());
    }));
    ui.download.addEventListener("click", () => busy(ui.download, "正在下载…", async () => {
      setError(null);
      ui.bar.style.width = "0%"; show(ui.progress, true);
      ui.check.disabled = true;
      try {
        const r = await api.update.download();
        if (r.ok) renderDownloaded(r.version);
        else {
          show(ui.progress, false);
          if (r.needsFull) { installerUrl = r.installerUrl || ""; show(ui.full, !!installerUrl); show(ui.download, false); }
          setError(r);
        }
      } finally { ui.check.disabled = false; }
    }));
    ui.full.addEventListener("click", () => { if (installerUrl) api.update.openUrl(installerUrl); });
    ui.restart.addEventListener("click", () => api.update.restart());
    api.update.onProgress((p) => {
      show(ui.progress, true);
      ui.bar.style.width = (p.pct || 0) + "%";
      ui.status.textContent = p.total ? `正在下载… ${p.pct}%（${mb(p.received)} / ${mb(p.total)}）` : "正在下载…";
    });
    api.update.onStatus((s) => {
      if (s.phase === "checked") renderCheck(s.result);
      else if (s.phase === "downloaded") renderDownloaded(s.result.version);
      else if (s.phase === "error") { show(ui.progress, false); setError(s.result); }
    });
    (async () => {
      if (!info.repoConfigured) {
        ui.status.textContent = "更新功能还没有配置";
        setError({ message: "请在 app.config.json 里把 repo 改成你的 GitHub 仓库" });
        ui.check.disabled = true;
        return;
      }
      const u = await api.update.info();
      if (u.downloaded) renderDownloaded(u.downloaded);
      else if (u.lastCheck) renderCheck(u.lastCheck);
    })();
    return card;
  }

  // ---- 内置分组 ----
  const ACCENTS = [["blue", "蓝"], ["violet", "紫"], ["pink", "粉"], ["orange", "橙"], ["green", "绿"], ["teal", "青"], ["graphite", "石墨"]];
  const BACKGROUNDS = [["none", "纯色"], ["aurora", "极光"], ["sunset", "晚霞"], ["ocean", "海洋"], ["forest", "森林"], ["mist", "薄雾"], ["night", "夜空"]];
  const FONTS = [["system", "系统默认"], ["sans", "现代无衬线"], ["serif", "宋体 / 衬线"], ["rounded", "圆体"], ["mono", "等宽"], ["custom", "自定义…"]];
  const COMMON_FONTS = ["PingFang SC", "Microsoft YaHei", "HarmonyOS Sans SC", "MiSans", "Source Han Sans SC", "Noto Sans CJK SC", "LXGW WenKai", "Songti SC", "Kaiti SC", "Inter", "JetBrains Mono"];

  function backgroundPicker() {
    const upload = h("button", { class: "bg-swatch bg-upload", dataset: { value: "custom" }, role: "radio", title: "自定义图片", "aria-label": "自定义图片",
      onclick: async () => {
        if (window.Shell.getSettings().background !== "custom") {
          const has = await api.appearance.background();
          if (has) { window.Shell.saveSettings({ background: "custom" }); return; }
        }
        const r = await api.appearance.pickBackground();
        if (!r.ok && !r.canceled) window.Shell.toast(r.error || "设置背景失败", "error");
      } }, icon("image"), h("span", { class: "bg-swatch-label" }, "自定义"));
    return swatches("background", BACKGROUNDS.map(([v, l]) => [v, l, "bg-" + v]), { cls: "bg-swatch", extra: upload });
  }

  const sub = (text) => h("div", { class: "set-sub" }, text);

  const builtin = [
    { id: "appearance", title: "外观", icon: "palette", order: 10, render(box) {
      box.append(
        row("布局", "卡片：宽窗口自动排成多列；经典：单列列表", segmented("layout", [["cards", "卡片"], ["classic", "经典"]])),
        row("主题", "跟随系统会随系统的深浅色自动切换", segmented("theme", [["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]])),
        row("主题色", "按钮、选中项和进度条的颜色", swatches("accent", ACCENTS.map(([v, l]) => [v, l, "accent-" + v]))),
        row("界面缩放", "调整所有文字和控件的大小", select("zoom", [[0.8, "80%"], [0.9, "90%"], [1, "100%"], [1.1, "110%"], [1.25, "125%"], [1.5, "150%"]], { parse: Number })));
    } },
    { id: "background", title: "背景", icon: "image", order: 12, tag: (s) => (s.performanceMode ? "性能模式" : ""), render(box) {
      const clearBtn = h("button", { class: "btn small ghost", onclick: async () => { await api.appearance.clearBackground(); window.Shell.toast("已移除自定义背景", "success"); } }, "移除自定义图片");
      const changeBtn = h("button", { class: "btn small", onclick: async () => { const r = await api.appearance.pickBackground(); if (!r.ok && !r.canceled) window.Shell.toast(r.error || "设置背景失败", "error"); } }, "更换图片…");
      const customTools = h("div", { class: "actions" }, changeBtn, clearBtn);
      const drawCustom = (s) => { customTools.hidden = s.background !== "custom"; };
      drawCustom(window.Shell.getSettings());
      window.Shell.onSettings((c, s) => { if ("background" in c) drawCustom(s); });
      box.append(
        row("背景", "预设渐变，或选一张自己的图片（15 MB 以内）", h("div", {}, backgroundPicker(), customTools), { stack: true }),
        row("背景遮罩", "图片太花时调暗一些，文字更清楚", range("backgroundDim", { min: 0, max: 0.8, step: 0.05, format: (v) => Math.round(v * 100) + "%" })),
        row("毛玻璃", "卡片和侧边栏半透明模糊，透出背景", toggle("glass")),
        row("性能模式", "关闭毛玻璃模糊、阴影和动画，界面更流畅、更省电。老电脑或开很多窗口时推荐", toggle("performanceMode")));
    } },
    { id: "font", title: "字体", order: 14, render(box) {
      const custom = h("input", { class: "input", list: "font-suggest", placeholder: "输入字体名，如 LXGW WenKai", value: window.Shell.getSettings().fontCustom || "",
        oninput: window.Shell.debounce(() => window.Shell.saveSettings({ fontCustom: custom.value }), 300) });
      const datalist = h("datalist", { id: "font-suggest" }, ...COMMON_FONTS.map((f) => h("option", { value: f })));
      const customRow = row("自定义字体", "填电脑上已安装的字体名，多个用逗号隔开；没装的会退回系统字体", h("div", {}, custom, datalist), { stack: true });
      const drawCustom = (s) => { customRow.hidden = s.fontFamily !== "custom"; };
      drawCustom(window.Shell.getSettings());
      window.Shell.onSettings((c, s) => { if ("fontFamily" in c) drawCustom(s); });
      box.append(
        row("字体", null, select("fontFamily", FONTS)),
        customRow,
        row("字号", "正文文字大小（界面缩放会再整体放大）", range("fontSize", { min: 12, max: 18, step: 1, format: (v) => v + " px" })),
        h("div", { class: "font-preview" }, h("div", { class: "fp-big" }, "敏捷的棕色狐狸 The quick brown fox"), h("div", { class: "muted small" }, "0123456789 · 预览当前字体和字号")));
    } },
    { id: "update", title: "关于与更新", icon: "arrowDown", order: 30, render(box, ctx) {
      const i = ctx.info, sy = ctx.system;
      const stat = (k, v) => h("div", { class: "stat" }, h("div", { class: "muted small" }, k), h("div", { class: "stat-v" }, v));
      const kv = (k, v) => h("div", { class: "kv" }, h("span", { class: "muted" }, k), h("span", { class: "mono" }, v));
      box.append(...[
        h("div", { class: "stats" },
          stat("当前版本", "v" + i.version),
          stat("来源", i.source === "update" ? `增量（安装包 v${i.bundledVersion}）` : "安装包"),
          stat("内核", "Electron " + sy.versions.electron)),
        updateCard(i),
        row("自动检查更新", "启动后在后台检查，有新版本自动下载，重启生效；新版本启动失败会自动退回", toggle("autoCheckUpdate")),
        sy.canOpenAtLogin ? row("开机自动启动", "登录系统后自动打开应用", toggle("openAtLogin")) : null,
        h("details", { class: "set-details" }, h("summary", {}, "系统信息"),
          h("div", { class: "kv-list" },
            kv("应用", i.productName),
            kv("版本", `${i.version}（${i.source === "update" ? `已更新，安装包 ${i.bundledVersion}` : "安装包内置"}）`),
            kv("Electron", sy.versions.electron), kv("Chromium", sy.versions.chrome), kv("Node.js", sy.versions.node),
            kv("系统", `${sy.platform}-${sy.arch}`),
            i.repoConfigured ? kv("仓库", i.repo) : null)),
      ].filter(Boolean));
    } },
    { id: "data", title: "日志与数据", icon: "terminal", order: 40, render(box, ctx) {
      box.append(
        sub("日志"),
        row("日志级别", "「调试」会记录更多细节，排查问题时再打开", select("logLevel", [["debug", "调试"], ["info", "信息"], ["warn", "警告"], ["error", "错误"]])),
        row("日志面板字号", "右侧运行日志面板（Ctrl/⌘ + L）的文字大小，也可以在面板上按住 Ctrl/⌘ 滚动滚轮", range("logFontSize", { min: 10, max: 18, step: 1, format: (v) => v + " px" })),
        row("日志文件", "按天保存，保留 7 天", h("button", { class: "btn", onclick: () => api.logs.openDir() }, "打开文件夹")),
        sub("数据"),
        row("数据目录", ctx.system.dataDir, h("button", { class: "btn", onclick: () => api.system.openDataDir() }, "打开")),
        row("清除缓存", "清掉网页缓存，不影响设置和数据", h("button", { class: "btn", onclick: async () => {
          const r = await api.system.clearCache();
          window.Shell.toast(r.ok ? "缓存已清除" : "清除失败：" + r.error, r.ok ? "success" : "error");
        } }, "清除")),
        row("恢复默认设置", "所有设置回到初始值（不删除数据）", h("button", { class: "btn danger-ghost", onclick: async () => {
          if (!(await window.Shell.confirm("确定把所有设置恢复为默认值吗？", { okText: "恢复默认", danger: true }))) return;
          await api.settings.reset();
          window.Shell.toast("已恢复默认设置", "success");
        } }, "恢复默认")));
    } },
  ];

  window.Shell.registerPage({
    id: "settings", title: "设置", icon: "settings", section: "system", order: 30,
    async render(root, ctx) {
      root.classList.add("page-wide");
      root.append(h("header", { class: "page-head" }, h("div", {}, h("h1", {}, "设置"), h("p", { class: "sub" }, "修改立即生效并自动保存"))));
      const body = window.Shell.modules();
      body.classList.add("settings");
      root.append(body);
      const c = { ...ctx, system: await api.system.info() };
      for (const sec of [...builtin, ...sections].sort((a, b) => (a.order ?? 50) - (b.order ?? 50))) {
        const box = h("div", { class: "set-group-body" });
        const tagEl = h("span", { class: "card-tag" });
        const drawTag = () => { const t = typeof sec.tag === "function" ? sec.tag(window.Shell.getSettings()) : sec.tag; tagEl.textContent = t || ""; tagEl.hidden = !t; };
        drawTag();
        if (typeof sec.tag === "function") window.Shell.onSettings(drawTag);
        body.append(h("section", { class: "card module set-group", id: `settings-${sec.id}` },
          h("header", { class: "card-head" }, h("h2", {}, sec.icon ? icon(sec.icon) : null, sec.title), tagEl), box));
        try { await sec.render(box, c); } catch (err) { window.Shell.reportError(err); box.append(h("p", { class: "error" }, err.message)); }
        if (!box.childElementCount) document.getElementById(`settings-${sec.id}`)?.remove();
      }
    },
  });
})();
