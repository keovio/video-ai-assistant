"use strict";
// 项目列表：新建、打开、复制、删除；显示标题、镜头数、预估总时长、状态。
(function () {
  const { h } = window.Shell;
  const api = window.app;

  const STATUS_LABEL = { draft: "草稿", script_ready: "脚本就绪", rendering: "渲染中", done: "已完成", failed: "失败" };

  async function unwrap(r) {
    if (!r || !r.ok) throw new Error((r && r.error) || "操作失败");
    return r;
  }

  window.Shell.registerPage({
    id: "projects",
    title: "项目",
    icon: "folder",
    order: 10,
    async onShow(root) { await refresh(root); },
    render(root, ctx) {
      root.classList.add("page-wide");
      const listBox = h("div", { id: "project-list", class: "project-grid" });
      // 新建只在这里：右上角按钮弹窗填标题/镜头数/画幅；分镜编辑、合成导出只能选项目
      const newBtn = h("button", { class: "btn primary", id: "new-project-btn", onclick: async () => {
        const p = await window.ProjectPicker.createDialog();
        if (!p) return;
        window.VideoApp.openProject(p.id);
        window.Shell.navigate("editor");
      } }, "＋ 新建项目");
      root.append(
        h("header", { class: "page-head" },
          h("div", {}, h("h1", {}, "视频项目"), h("p", { class: "sub" }, "一个项目就是一条口播视频：脚本和分镜 → 配音 → 画面 → 合成导出。")),
          newBtn),
        toolbar(root),
        listBox);
      root._listBox = listBox;
    },
  });

  // 0.6.48：搜索 + 状态筛选 + 排序（记在本机）
  const state = { q: "", status: localStorage.getItem("projects.status") || "", sort: localStorage.getItem("projects.sort") || "updated" };
  let cache = { projects: [], texts: {} };
  function toolbar(root) {
    const debounce = window.Shell.debounce || ((fn) => fn);
    const q = h("input", { class: "input lib-search", type: "search", placeholder: "搜索项目名、标签、口播、画面提示词（Ctrl/⌘ F）",
      oninput: debounce(() => { state.q = q.value.trim(); draw(root); }, 150),
      onkeydown: (e) => { if (e.key === "Escape") { q.value = ""; state.q = ""; draw(root); } } });
    root._q = q;
    const st = h("select", { class: "input small", onchange: () => { state.status = st.value; localStorage.setItem("projects.status", st.value); draw(root); } },
      h("option", { value: "" }, "全部状态"), ...Object.entries(STATUS_LABEL).map(([v, l]) => h("option", { value: v }, l)));
    st.value = state.status;
    const so = h("select", { class: "input small", onchange: () => { state.sort = so.value; localStorage.setItem("projects.sort", so.value); draw(root); } },
      h("option", { value: "updated" }, "最近修改在前"), h("option", { value: "created" }, "最新创建在前"), h("option", { value: "oldest" }, "最早创建在前"), h("option", { value: "title" }, "按名称"));
    so.value = state.sort;
    root._count = h("span", { class: "muted small-text" });
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && !root.hidden && root.isConnected) { e.preventDefault(); q.focus(); q.select(); }
    });
    return h("div", { class: "lib-toolbar project-toolbar" }, q, st, so, root._count);
  }
  const norm = (t) => String(t || "").toLowerCase();
  // 每个词都要命中（空格分隔）；返回命中的镜头片段
  function match(p, words) {
    if (!words.length) return { ok: true, hits: [] };
    const shots = cache.texts[p.id] || [];
    const head = norm([p.title, (p.tags || []).join(" ")].join(" "));
    const all = head + " " + norm(shots.map((x) => x.text).join(" "));
    if (!words.every((w) => all.includes(w))) return { ok: false, hits: [] };
    const hits = shots.filter((x) => words.some((w) => norm(x.text).includes(w))).slice(0, 3);
    return { ok: true, hits };
  }
  function snippet(text, words) {
    const low = norm(text);
    const at = Math.max(0, Math.min(...words.map((w) => { const i = low.indexOf(w); return i < 0 ? Infinity : i; })));
    const start = Number.isFinite(at) ? Math.max(0, at - 16) : 0;
    const part = (start ? "…" : "") + text.slice(start, start + 70) + (text.length > start + 70 ? "…" : "");
    // 高亮
    const out = []; let rest = part;
    const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
    while (rest) {
      const m = re.exec(rest);
      if (!m) { out.push(rest); break; }
      if (m.index) out.push(rest.slice(0, m.index));
      out.push(h("mark", {}, m[0]));
      rest = rest.slice(m.index + m[0].length);
    }
    return out;
  }

  let refreshSeq = 0;
  async function refresh(root) {
    const box = root._listBox || root.querySelector("#project-list");
    if (!box) return;
    // 打开页面时 render 和 onShow 会同时刷新：只让最后一次落地，否则列表会重复显示
    const seq = ++refreshSeq;
    let r;
    let t;
    try { [r, t] = await Promise.all([api.video.projects.list().then(unwrap), api.video.projects.texts().catch(() => null)]); }
    catch (e) { if (seq === refreshSeq) box.replaceChildren(h("p", { class: "error" }, e.message)); return; }
    if (seq !== refreshSeq) return;
    cache = { projects: r.projects, texts: (t && t.ok && t.texts) || {} };
    draw(root);
  }

  function draw(root) {
    const box = root._listBox;
    if (!box) return;
    box.textContent = "";
    if (!cache.projects.length) {
      if (root._count) root._count.textContent = "";
      box.append(h("p", { class: "muted" }, "还没有项目，点右上角“新建项目”开始。"));
      return;
    }
    const words = norm(state.q).split(/\s+/).filter(Boolean);
    let list = cache.projects.filter((p) => !state.status || p.status === state.status)
      .map((p) => ({ p, m: match(p, words) })).filter((x) => x.m.ok);
    const by = { updated: (a, b) => (b.p.updatedAt || 0) - (a.p.updatedAt || 0), created: (a, b) => (b.p.createdAt || 0) - (a.p.createdAt || 0),
      oldest: (a, b) => (a.p.createdAt || 0) - (b.p.createdAt || 0), title: (a, b) => String(a.p.title).localeCompare(String(b.p.title), "zh") };
    list.sort(by[state.sort] || by.updated);
    if (root._count) root._count.textContent = words.length || state.status ? `${list.length} / ${cache.projects.length} 个项目` : `${cache.projects.length} 个项目`;
    if (!list.length) {
      box.append(h("p", { class: "muted" }, "没有匹配的项目。"));
      return;
    }
    for (const { p, m } of list) {
      const meta = `${STATUS_LABEL[p.status] || p.status} · ${p.aspect} · ${p.shotCount} 个镜头 · 预估 ${fmtSecs(p.totalSeconds)}`;
      box.append(h("section", { class: "card project-card" },
        h("header", { class: "card-head" }, h("h2", {}, p.title), h("span", { class: "card-tag" }, STATUS_LABEL[p.status] || p.status)),
        h("p", { class: "muted" }, meta),
        p.tags && p.tags.length ? h("p", { class: "muted" }, "标签：" + p.tags.join("、")) : null,
        ...m.hits.map((x) => h("p", { class: "small-text search-hit", title: x.text }, h("b", {}, `第 ${x.i} 镜 `), ...snippet(x.text, words))),
        h("div", { class: "actions" },
          h("button", { class: "btn small primary", onclick: () => { window.VideoApp.openProject(p.id); window.Shell.navigate("editor"); } }, "打开"),
          h("button", { class: "btn small", onclick: async () => {
            try { const d = await unwrap(await api.video.projects.duplicate(p.id)); window.Shell.toast("已复制为“" + d.project.title + "”"); await refresh(root); }
            catch (e) { window.Shell.toast(e.message, "error"); }
          } }, "复制"),
          h("button", { class: "btn small danger-ghost", onclick: async () => {
            if (!await window.Shell.confirm(`确定删除项目“${p.title}”吗？删除前会自动备份，误删可在“设置 → ffmpeg 与数据”里恢复。`)) return;
            try {
              const d = await unwrap(await api.video.projects.remove(p.id));
              if (window.VideoApp.currentProjectId() === p.id) window.VideoApp.openProject(null);
              window.Shell.toast(`已删除“${p.title}”，还剩 ${d.after} 个项目`);
              await refresh(root);
            }
            catch (e) { window.Shell.toast(e.message, "error"); }
          } }, "删除"))));
    }
  }

  function fmtSecs(s) {
    const n = Number(s) || 0;
    return (Math.round(n * 10) / 10) + " 秒";
  }
})();
