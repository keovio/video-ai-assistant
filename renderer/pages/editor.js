"use strict";
// 分镜编辑器（M1）：编辑标题/标签、逐镜改口播与画面描述、增删与排序、保存后重开还在。
// 配音/生图/合成是 M2/M3 的事：按钮置灰并标注，不做假功能。
(function () {
  const { h, card, modules } = window.Shell;
  const api = window.app;

  let currentId = null;
  let draft = null; // { project: {...}, shots: [...] }，shots 里 _new 表示未保存的新镜头
  let deletedIds = [];
  let newSeq = 0;

  const estimate = (text) => {
    const n = [...String(text || "")].filter((c) => !/\s/.test(c)).length;
    return n ? Math.ceil((n / 4.5) * 10) / 10 : 0;
  };
  const fmt = (s) => (Math.round(Number(s || 0) * 10) / 10) + " 秒";
  const fmtRange = (start, end) => `${fmt(start)} – ${fmt(end)}`;

  async function unwrap(r) {
    if (!r || !r.ok) throw new Error((r && r.error) || "操作失败");
    return r;
  }

  function timings(shots) {
    let t = 0;
    return shots.map((s) => {
      const d = estimate(s.narration);
      const start = Math.round(t * 10) / 10;
      t = Math.round((t + d) * 10) / 10;
      return { start, end: t, seconds: d };
    });
  }

  window.VideoApp = {
    openProject(id) { currentId = id; draft = null; deletedIds = []; },
    currentProjectId() { return currentId; },
  };

  window.Shell.registerPage({
    id: "editor",
    title: "分镜编辑",
    icon: "note",
    order: 20,
    async onShow(root) {
      if (!currentId) { renderEmpty(root); return; }
      if (!draft || draft.project.id !== currentId) await load(root, currentId);
    },
    render(root) {
      root.classList.add("page-wide");
      root._body = h("div", { id: "editor-body" });
      root.append(root._body);
      if (!currentId) renderEmpty(root);
      else load(root, currentId).catch((e) => window.Shell.toast(e.message, "error"));
    },
  });

  function renderEmpty(root) {
    const body = root._body || root;
    body.textContent = "";
    body.append(h("header", { class: "page-head" },
      h("div", {}, h("h1", {}, "分镜编辑"), h("p", { class: "sub" }, "先在“项目”页打开一个项目，再回来编辑它的脚本和分镜。"))),
      h("button", { class: "btn primary", onclick: () => window.Shell.navigate("projects") }, "去项目列表"));
  }

  async function load(root, id) {
    const r = await unwrap(await api.video.projects.get(id));
    draft = { project: { ...r.project }, shots: r.shots.map((s) => ({ ...s })) };
    deletedIds = [];
    renderForm(root);
  }

  function renderForm(root) {
    const body = root._body;
    body.textContent = "";
    const p = draft.project;
    const titleInput = h("input", { class: "input grow", value: p.title });
    const tagsInput = h("input", { class: "input grow", value: (p.tags || []).join("、"), placeholder: "标签，用、或逗号分隔" });
    const aspectSelect = h("select", { class: "input" },
      ...[["9:16", "9:16 竖屏"], ["16:9", "16:9 横屏"], ["1:1", "1:1 方形"]].map(([v, l]) => h("option", { value: v }, l)));
    aspectSelect.value = p.aspect || "9:16";
    const totalEl = h("span", { class: "muted" });
    const shotsBox = h("div", { id: "shot-list" });

    const redraw = () => {
      const ts = timings(draft.shots);
      totalEl.textContent = `共 ${draft.shots.length} 个镜头 · 预估总时长 ${fmt(ts.length ? ts[ts.length - 1].end : 0)}（按约 4.5 字/秒估算）`;
      shotsBox.textContent = "";
      draft.shots.forEach((s, i) => {
        const t = ts[i];
        const narration = h("textarea", { class: "input field-full", rows: 3, placeholder: "这镜的口播文案" }, s.narration || "");
        narration.addEventListener("input", () => { s.narration = narration.value; redrawTotals(); });
        const visual = h("textarea", { class: "input field-full", rows: 2, placeholder: "画面描述：主体、场景、构图、光线" }, s.visual || "");
        visual.addEventListener("input", () => { s.visual = visual.value; });
        const imagePrompt = h("textarea", { class: "input field-full", rows: 2, placeholder: "生图提示词（M3 用，可空，默认用画面描述）" }, s.imagePrompt || "");
        imagePrompt.addEventListener("input", () => { s.imagePrompt = imagePrompt.value; });
        const row = h("section", { class: "card module shot-row" },
          h("header", { class: "card-head" },
            h("h2", {}, `第 ${i + 1} 镜`),
            h("span", { class: "card-tag" }, fmtRange(t.start, t.end)),
            h("span", { class: "spacer" }),
            h("button", { class: "btn small", disabled: i === 0, onclick: () => { move(i, -1); } }, "上移"),
            h("button", { class: "btn small", disabled: i === draft.shots.length - 1, onclick: () => { move(i, 1); } }, "下移"),
            h("button", { class: "btn small danger-ghost", onclick: () => { removeShot(i); } }, "删除")),
          h("p", { class: "card-desc" }, "口播（预估 " + fmt(t.seconds) + "）"),
          narration,
          h("p", { class: "card-desc" }, "画面描述"),
          visual,
          h("p", { class: "card-desc" }, "生图提示词"),
          imagePrompt);
        shotsBox.append(row);
      });
      function redrawTotals() {
        const ts2 = timings(draft.shots);
        totalEl.textContent = `共 ${draft.shots.length} 个镜头 · 预估总时长 ${fmt(ts2.length ? ts2[ts2.length - 1].end : 0)}（按约 4.5 字/秒估算）`;
        // 只更新每镜的时间标签，不重建输入框，避免打字时丢焦点
        [...shotsBox.querySelectorAll(".shot-row")].forEach((rowEl, idx) => {
          const tag = rowEl.querySelector(".card-tag");
          if (tag && ts2[idx]) tag.textContent = fmtRange(ts2[idx].start, ts2[idx].end);
        });
      }
    };
    const move = (i, d) => {
      const j = i + d;
      if (j < 0 || j >= draft.shots.length) return;
      const [s] = draft.shots.splice(i, 1);
      draft.shots.splice(j, 0, s);
      redraw();
    };
    const removeShot = (i) => {
      const [s] = draft.shots.splice(i, 1);
      if (s && !s._new && s.id) deletedIds.push(s.id);
      redraw();
    };

    body.append(
      h("header", { class: "page-head" },
        h("div", {}, h("h1", {}, "分镜编辑"),
          h("p", { class: "sub" }, "改完点“保存”，离开页面前没保存的改动会丢。"))),
      modules(card({ title: "项目", icon: "folder" },
        h("div", { class: "actions" }, titleInput, tagsInput, aspectSelect),
        h("p", { class: "muted" }, "", totalEl),
        h("div", { class: "actions" },
          h("button", { class: "btn primary", id: "btn-save", onclick: save }, "保存"),
          h("button", { class: "btn", onclick: async () => { await load(root, currentId); window.Shell.toast("已放弃未保存的改动"); } }, "放弃改动"),
          h("button", { class: "btn", disabled: true, title: "M2 做" }, "生成配音（M2）"),
          h("button", { class: "btn", disabled: true, title: "M3 做" }, "生成画面（M3）"),
          h("button", { class: "btn", disabled: true, title: "M3 做" }, "合成导出（M3）")))),
      shotsBox,
      h("div", { class: "actions" },
        h("button", { class: "btn", onclick: () => { draft.shots.push({ _new: true, _tmp: "new-" + (++newSeq), narration: "", visual: "", imagePrompt: "", status: "pending" }); redraw(); } }, "＋ 添加镜头")));

    async function save() {
      const btn = body.querySelector("#btn-save");
      if (btn) btn.disabled = true;
      try {
        const tags = tagsInput.value.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean);
        await unwrap(await api.video.projects.update(currentId, { title: titleInput.value, tags, aspect: aspectSelect.value }));
        for (const id of deletedIds) await unwrap(await api.video.shots.remove(id));
        deletedIds = [];
        const finalIds = [];
        for (const s of draft.shots) {
          if (s._new) {
            const r = await unwrap(await api.video.shots.add(currentId, { narration: s.narration, visual: s.visual, imagePrompt: s.imagePrompt }));
            finalIds.push(r.shot.id);
          } else {
            await unwrap(await api.video.shots.update(s.id, { narration: s.narration, visual: s.visual, imagePrompt: s.imagePrompt }));
            finalIds.push(s.id);
          }
        }
        await unwrap(await api.video.shots.reorder(currentId, finalIds));
        await load(root, currentId);
        window.Shell.toast("已保存", "success");
      } catch (e) { window.Shell.toast(e.message, "error"); }
      finally { const b = body.querySelector("#btn-save"); if (b) b.disabled = false; }
    }
    redraw();
  }
})();
