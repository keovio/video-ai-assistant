"use strict";
// 当前项目 + 项目切换栏 + 新建项目弹窗（0.6.0）。
// - VideoApp：全局“当前项目”，记在本机（localStorage），重启后还是上次打开的项目。
// - ProjectPicker.bar()：分镜编辑、合成导出顶部的项目下拉，只能选，不能新建。
// - ProjectPicker.createDialog()：只有“项目”页用，弹窗填标题/镜头数/画幅后创建。
(function () {
  const { h, icon } = window.Shell;
  const api = window.app;
  const KEY = "video.currentProject";
  const ASPECTS = [["9:16", "9:16 竖屏"], ["16:9", "16:9 横屏"], ["1:1", "1:1 方形"]];

  let currentId = null;
  try { currentId = localStorage.getItem(KEY) || null; } catch { /* ignore */ }

  window.VideoApp = {
    openProject(id) {
      currentId = id || null;
      try { if (currentId) localStorage.setItem(KEY, currentId); else localStorage.removeItem(KEY); } catch { /* ignore */ }
    },
    currentProjectId() { return currentId; },
  };

  const fmtSecs = (s) => (Math.round((Number(s) || 0) * 10) / 10) + " 秒";
  const defaultShots = () => { try { return Number(window.Shell.getSettings().videoDefaultShotCount) || 6; } catch { return 6; } };
  const defaultAspect = () => { try { return window.Shell.getSettings().videoAspect || "9:16"; } catch { return "9:16"; } };

  // 新建项目弹窗：resolve(创建好的 project) 或 null（取消）
  function createDialog() {
    return new Promise((resolve) => {
      const title = h("input", { class: "input", placeholder: "例如：雨夜的街道", maxlength: 80 });
      // 镜头数自由输入（1–30），默认取设置里的“新建项目镜头数”
      const shots = h("input", { class: "input", type: "number", min: 1, max: 30, step: 1, inputmode: "numeric" });
      shots.value = String(defaultShots());
      const shotCountValue = () => Math.max(1, Math.min(30, Math.floor(Number(shots.value) || defaultShots())));
      const aspect = h("select", { class: "input" }, ...ASPECTS.map(([v, l]) => h("option", { value: v }, l)));
      aspect.value = defaultAspect();
      const okBtn = h("button", { class: "btn primary" }, "创建并打开");
      const finish = (v) => { overlay.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
      const submit = async () => {
        okBtn.disabled = true;
        try {
          const r = await api.video.projects.create({ title: title.value.trim(), shotCount: shotCountValue(), aspect: aspect.value });
          if (!r || !r.ok) throw new Error((r && r.error) || "创建失败");
          finish(r.project);
        } catch (e) { window.Shell.toast(e.message, "error"); okBtn.disabled = false; }
      };
      okBtn.onclick = submit;
      const onKey = (e) => {
        if (e.key === "Escape") finish(null);
        if (e.key === "Enter" && !e.isComposing && document.activeElement && document.activeElement.tagName !== "SELECT") { e.preventDefault(); submit(); }
      };
      const field = (label, el, hint) => h("label", { class: "form-field" }, h("span", { class: "form-label" }, label), el, hint ? h("span", { class: "form-hint" }, hint) : "");
      const overlay = h("div", { class: "modal-overlay", onclick: (e) => { if (e.target === overlay) finish(null); } },
        h("div", { class: "modal modal-form", role: "dialog", "aria-modal": "true" },
          h("h3", { class: "modal-title" }, "新建项目"),
          field("标题", title, "可空，默认“未命名项目”，之后在分镜编辑里也能改"),
          h("div", { class: "form-row" }, field("镜头数", shots), field("画幅", aspect)),
          h("div", { class: "actions end" }, h("button", { class: "btn", onclick: () => finish(null) }, "取消"), okBtn)));
      document.body.append(overlay);
      document.addEventListener("keydown", onKey);
      title.focus();
    });
  }

  // 项目切换栏。opts.beforeSwitch(): 返回 false 取消切换；opts.onSwitch(id): 切换后回调；opts.actions: 右侧按钮
  function bar({ beforeSwitch, onSwitch, actions = [] } = {}) {
    const select = h("select", { class: "input project-switch", title: "切换项目" });
    const meta = h("span", { class: "project-meta" });
    const right = h("div", { class: "project-bar-actions" }, ...actions);
    const el = h("header", { class: "project-bar" },
      h("span", { class: "project-bar-icon" }, icon("folder")), select, meta, h("span", { class: "spacer" }), right);
    let projects = [];

    select.addEventListener("change", async () => {
      const id = select.value;
      const prev = window.VideoApp.currentProjectId();
      if (!id || id === prev) return;
      if (beforeSwitch && (await beforeSwitch()) === false) { select.value = prev || ""; return; }
      window.VideoApp.openProject(id);
      if (onSwitch) await onSwitch(id);
    });

    async function refresh() {
      try {
        const r = await api.video.projects.list();
        projects = (r && r.ok && r.projects) || [];
      } catch { projects = []; }
      const cur = window.VideoApp.currentProjectId();
      select.replaceChildren(
        ...(cur && projects.some((p) => p.id === cur) ? [] : [h("option", { value: "" }, projects.length ? "选择项目…" : "还没有项目")]),
        ...projects.map((p) => h("option", { value: p.id }, p.title || "未命名项目")));
      select.value = cur && projects.some((p) => p.id === cur) ? cur : "";
      select.disabled = !projects.length;
      return projects;
    }
    function setMeta(text) { meta.textContent = text || ""; }
    function setActions(...nodes) { right.replaceChildren(...nodes.filter(Boolean)); }
    return { el, refresh, setMeta, setActions, get projects() { return projects; } };
  }

  // 没选项目时的空状态：有项目就给下拉，没有就指去项目页
  function emptyState(projects, onPick, text) {
    if (!projects.length) {
      return h("div", { class: "empty-state" },
        h("h3", {}, "还没有项目"),
        h("p", { class: "muted" }, "先去“项目”页新建一个。"),
        h("button", { class: "btn primary", onclick: () => window.Shell.navigate("projects") }, "去项目页"));
    }
    return h("div", { class: "empty-state" },
      h("h3", {}, "选一个项目开始"),
      h("p", { class: "muted" }, text || "在上面的下拉里选，或点下面任意一个。"),
      h("div", { class: "empty-pick" }, ...projects.slice(0, 6).map((p) =>
        h("button", { class: "pick-item", onclick: () => onPick(p.id) },
          h("b", {}, p.title || "未命名项目"),
          h("span", { class: "muted" }, `${p.shotCount} 镜 · ${fmtSecs(p.totalSeconds)} · ${p.aspect}`)))));
  }

  window.ProjectPicker = { createDialog, bar, emptyState, ASPECTS, fmtSecs };
})();
