"use strict";
// 项目列表：新建、打开、复制、删除；显示标题、镜头数、预估总时长、状态。
(function () {
  const { h, card, modules } = window.Shell;
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
      const titleInput = h("input", { class: "input grow", placeholder: "新项目标题（可空，默认“未命名项目”）", id: "new-project-title" });
      const shotSelect = h("select", { class: "input" },
        ...[3, 6, 9].map((n) => h("option", { value: String(n) }, `${n} 个镜头`)));
      shotSelect.value = "6";
      const aspectSelect = h("select", { class: "input" },
        ...[["9:16", "9:16 竖屏"], ["16:9", "16:9 横屏"], ["1:1", "1:1 方形"]].map(([v, l]) => h("option", { value: v }, l)));
      try { aspectSelect.value = (window.Shell.getSettings().videoAspect) || "9:16"; } catch { /* ignore */ }
      const listBox = h("div", { id: "project-list", class: "project-grid" });
      const newCard = card({ title: "新建项目", icon: "note" },
        h("div", { class: "actions" }, titleInput, shotSelect, aspectSelect,
          h("button", { class: "btn primary", onclick: async () => {
            try {
              const r = await unwrap(await api.video.projects.create({
                title: titleInput.value, shotCount: Number(shotSelect.value), aspect: aspectSelect.value,
              }));
              titleInput.value = "";
              window.VideoApp.openProject(r.project.id);
              window.Shell.navigate("editor");
            } catch (e) { window.Shell.toast(e.message, "error"); }
          } }, "新建并打开")));
      root.append(
        h("header", { class: "page-head" },
          h("div", {}, h("h1", {}, "视频项目"), h("p", { class: "sub" }, "一个项目就是一条口播视频：先写脚本和分镜，配音、画面、合成在 M2/M3 做。"))),
        modules(newCard),
        listBox);
      root._listBox = listBox;
    },
  });

  let refreshSeq = 0;
  async function refresh(root) {
    const box = root._listBox || root.querySelector("#project-list");
    if (!box) return;
    // 打开页面时 render 和 onShow 会同时刷新：只让最后一次落地，否则列表会重复显示
    const seq = ++refreshSeq;
    let r;
    try { r = await unwrap(await api.video.projects.list()); }
    catch (e) { if (seq === refreshSeq) box.replaceChildren(h("p", { class: "error" }, e.message)); return; }
    if (seq !== refreshSeq) return;
    box.textContent = "";
    if (!r.projects.length) {
      box.append(h("p", { class: "muted" }, "还没有项目，先在上面新建一个。"));
      return;
    }
    for (const p of r.projects) {
      const meta = `${STATUS_LABEL[p.status] || p.status} · ${p.aspect} · ${p.shotCount} 个镜头 · 预估 ${fmtSecs(p.totalSeconds)}`;
      box.append(h("section", { class: "card project-card" },
        h("header", { class: "card-head" }, h("h2", {}, p.title), h("span", { class: "card-tag" }, STATUS_LABEL[p.status] || p.status)),
        h("p", { class: "muted" }, meta),
        p.tags && p.tags.length ? h("p", { class: "muted" }, "标签：" + p.tags.join("、")) : null,
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
