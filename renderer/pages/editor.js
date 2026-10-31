"use strict";
// 分镜编辑器（M1 存储与编辑；M2 增加配音：生成、导入、试听、清除；M3 增加画面状态，片段生成与合成在“合成导出”页；M4 改左右结构）。
// 左栏：紧凑的镜头列表（可滚动，点一行选中）；右栏：选中镜头的详情表单 + 项目保存栏。
// 镜头顺序、增删、配音操作的语义与之前一致：未保存的新镜头要先点“保存”才能操作配音。
(function () {
  const { h, icon } = window.Shell;
  const api = window.app;

  let currentId = null;
  let draft = null; // { project: {...}, shots: [...] }，shots 里 _new 表示未保存的新镜头
  let deletedIds = [];
  let newSeq = 0;
  let currentAudio = null;
  let currentListenBtn = null;

  const estimate = (text) => {
    const n = [...String(text || "")].filter((c) => !/\s/.test(c)).length;
    return n ? Math.ceil((n / 4.5) * 10) / 10 : 0;
  };
  const fmt = (s) => (Math.round(Number(s || 0) * 10) / 10) + " 秒";
  const fmtRange = (start, end) => `${fmt(start)} – ${fmt(end)}`;
  // 某镜的计时用时长：已挂配音且有秒数时用该秒数（实测或估算见 audioMeasured），否则字数估算
  // 0.6.6：没有配音时依次用 手动时长 > 口播估算 > 视频片段时长 > 有画面默认 3 秒 > 0（与 lib/video-model.measuredDuration 一致）
  const r1 = (x) => Math.round(Number(x) * 10) / 10;
  const shotSeconds = (s) => {
    if (s.audioAssetId && Number(s.audioSeconds) > 0) return r1(s.audioSeconds);
    if (Number(s.seconds) > 0) return r1(s.seconds);
    const est = estimate(s.narration);
    if (est > 0) return est;
    if (s.videoAssetId && Number(s.clipSeconds) > 0) return r1(s.clipSeconds);
    if (s.videoAssetId || s.imageAssetId) return 3;
    return 0;
  };
  const audioText = (s) => {
    if (!s.audioAssetId) return s.error ? `配音：失败（${s.error}）` : "配音：暂无，请生成或导入音频";
    const src = s.audioSource === "import" ? "导入" : "TTS 生成";
    const how = s.audioMeasured ? "实测" : "估算（未检测到 ffprobe）";
    return `配音：${src} · ${how} ${fmt(s.audioSeconds)}`;
  };
  const videoText = (s) => (s.videoAssetId
    ? `画面：片段已挂（${s.clipSeconds ? fmt(s.clipSeconds) : "时长未知"}），合成时按配音时长对齐（短了循环、长了截断）`
    : "画面：暂无片段，合成时该镜用黑场兜底，配音保留；去“合成导出”页生成或导入片段");
  const stopListen = () => {
    if (currentAudio) { try { currentAudio.pause(); } catch { /* ignore */ } currentAudio = null; }
    if (currentListenBtn) { currentListenBtn.textContent = "试听"; currentListenBtn = null; }
  };

  async function unwrap(r) {
    if (!r || !r.ok) throw new Error((r && r.error) || "操作失败");
    return r;
  }

  function timings(shots) {
    let t = 0;
    return shots.map((s) => {
      const d = shotSeconds(s);
      const start = Math.round(t * 10) / 10;
      t = Math.round((t + d) * 10) / 10;
      return { start, end: t, seconds: d };
    });
  }

  let editorRoot = null;
  // 有未保存改动时静默保存（切项目、离开页面前调用）；返回 false 表示保存失败，调用方应停下
  async function autoSave(root) {
    if (root && root._isDirty && root._isDirty()) return root._save({ silent: true });
    return true;
  }

  window.Shell.registerPage({
    id: "editor",
    title: "分镜编辑",
    icon: "note",
    order: 20,
    render(root) {
      editorRoot = root;
      root.classList.add("page-wide");
      root._bar = window.ProjectPicker.bar({
        beforeSwitch: () => autoSave(root),
        onSwitch: (id) => load(root, id),
      });
      root._body = h("div", { id: "editor-body" });
      root.append(root._bar.el, root._body);
    },
    async onShow(root) {
      await root._bar.refresh();
      const id = window.VideoApp.currentProjectId();
      if (!id) { renderEmpty(root); return; }
      if (!draft || draft.project.id !== id) await load(root, id);
    },
    async onHide(root) {
      stopListen();
      await autoSave(root);
    },
  });

  // Ctrl/⌘ + S 保存
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "s" || e.key === "S") && window.Shell.current === "editor" && editorRoot && editorRoot._save) {
      e.preventDefault();
      editorRoot._save();
    }
  });

  function renderEmpty(root) {
    draft = null; currentId = null;
    root._isDirty = null; root._save = null;
    root._bar.setMeta("");
    root._bar.setActions();
    root._body.replaceChildren(window.ProjectPicker.emptyState(root._bar.projects, async (id) => {
      window.VideoApp.openProject(id);
      await root._bar.refresh();
      await load(root, id);
    }, "选好项目后在这里写口播、画面描述，生成配音。"));
  }

  async function load(root, id) {
    stopListen();
    let r;
    try { r = await unwrap(await api.video.projects.get(id)); }
    catch (e) {
      window.Shell.toast("打开项目失败：" + e.message, "error");
      window.VideoApp.openProject(null);
      await root._bar.refresh();
      renderEmpty(root);
      return;
    }
    currentId = id;
    draft = { project: { ...r.project }, shots: r.shots.map((s) => ({ ...s })) };
    deletedIds = [];
    renderForm(root);
  }

  function renderForm(root) {
    const body = root._body;
    body.textContent = "";
    const p = draft.project;
    let selectedIdx = 0;
    let savedSnap = ""; // 上次保存/加载时的草稿快照，用来判断有没有未保存改动

    const titleInput = h("input", { class: "input grow", value: p.title });
    const tagsInput = h("input", { class: "input grow", value: (p.tags || []).join("、"), placeholder: "标签，用、或逗号分隔" });
    const aspectSelect = h("select", { class: "input" },
      ...[["9:16", "9:16 竖屏"], ["16:9", "16:9 横屏"], ["1:1", "1:1 方形"]].map(([v, l]) => h("option", { value: v }, l)));
    aspectSelect.value = p.aspect || "9:16";
    const dirtyTag = h("span", { class: "dirty-tag", hidden: true }, "未保存");
    const infoRow = h("div", { class: "project-info-row", hidden: true },
      h("label", { class: "form-field grow" }, h("span", { class: "form-label" }, "标题"), titleInput),
      h("label", { class: "form-field grow" }, h("span", { class: "form-label" }, "标签"), tagsInput),
      h("label", { class: "form-field" }, h("span", { class: "form-label" }, "画幅"), aspectSelect));
    const countEl = h("span", { class: "muted" });
    const listBox = h("div", { id: "shot-list", class: "shot-list" });
    const detailBox = h("div", { id: "shot-detail" });

    const updateTotals = () => {
      const ts = timings(draft.shots);
      const total = fmt(ts.length ? ts[ts.length - 1].end : 0);
      root._bar.setMeta(`${draft.shots.length} 镜 · ${total} · ${aspectSelect.value}`);
      countEl.textContent = `${draft.shots.length} 个 · ${total}`;
      countEl.title = "有配音的镜头按配音时长，没有配音的按约 4.5 字/秒估算";
      refreshDirty();
      return ts;
    };

    const redrawList = () => {
      const ts = updateTotals();
      listBox.textContent = "";
      draft.shots.forEach((s, i) => {
        const t = ts[i];
        const preview = (s.narration || "").trim().slice(0, 40) || "（空口播）";
        const status = s.error ? h("span", { class: "chip err" }, "失败") : s.audioAssetId ? h("span", { class: "chip ok" }, "已配音") : h("span", { class: "chip" }, "待配音");
        const clip = s.videoAssetId ? h("span", { class: "chip ok" }, "有画面") : "";
        const row = h("div", {
          class: "shot-row" + (i === selectedIdx ? " selected" : ""),
          onclick: () => { selectedIdx = i; redrawList(); renderDetail(); },
        },
          h("div", { class: "shot-row-head" },
            h("b", {}, `第 ${i + 1} 镜`),
            h("span", { class: "muted small-text grow" }, fmtRange(t.start, t.end)),
            status, clip),
          h("div", { class: "muted shot-row-preview" }, preview));
        listBox.append(row);
      });
      if (!draft.shots.length) listBox.append(h("p", { class: "muted" }, "还没有镜头，点下面“添加镜头”。"));
      const sel = listBox.querySelector(".shot-row.selected");
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
    };

    const renderDetail = () => {
      detailBox.textContent = "";
      const s = draft.shots[selectedIdx];
      if (!s) {
        detailBox.append(h("p", { class: "muted" }, "左侧选一个镜头，这里显示它的详情。"));
        return;
      }
      const i = selectedIdx;
      const ts = timings(draft.shots);
      const t = ts[i];
      const narration = h("textarea", { class: "input field-full", rows: 4, placeholder: "这镜的口播文案" }, s.narration || "");
      narration.addEventListener("input", () => { s.narration = narration.value; updateTotals(); redrawListLight(); });
      const visual = h("textarea", { class: "input field-full", rows: 3, placeholder: "画面描述：主体、场景、构图、光线" }, s.visual || "");
      visual.addEventListener("input", () => { s.visual = visual.value; refreshDirty(); });
      const imagePrompt = h("textarea", { class: "input field-full", rows: 3, placeholder: "可空，默认用画面描述" }, s.imagePrompt || "");
      imagePrompt.addEventListener("input", () => { s.imagePrompt = imagePrompt.value; refreshDirty(); });

      // 手动时长：没有配音时生效（纯画面、只放背景音乐的镜头）；留空 = 自动
      const secondsInput = h("input", { class: "input shot-seconds", type: "number", min: 0, max: 600, step: 0.5,
        placeholder: "自动", value: Number(s.seconds) > 0 ? String(s.seconds) : "" });
      const secondsHint = h("span", { class: "muted small-text" });
      const drawSecondsHint = () => {
        secondsHint.textContent = s.audioAssetId
          ? "已有配音，按配音时长（" + fmt(s.audioSeconds) + "），这里不生效"
          : Number(s.seconds) > 0 ? "按手动时长" : "自动：当前 " + fmt(shotSeconds(s)) + "（口播估算 / 片段时长 / 有画面默认 3 秒）";
      };
      drawSecondsHint();
      secondsInput.addEventListener("input", () => {
        const v = Number(secondsInput.value);
        s.seconds = Number.isFinite(v) && v > 0 ? Math.min(600, Math.round(v * 10) / 10) : 0;
        drawSecondsHint(); updateTotals(); redrawListLight();
        const tagEl = detailBox.querySelector(".shot-detail .card-head .small-text");
        const tt = timings(draft.shots)[i]; if (tagEl && tt) tagEl.textContent = fmtRange(tt.start, tt.end);
      });
      const listenBtn = h("button", { class: "btn small", disabled: !s.audioAssetId, onclick: () => listenShot(s, listenBtn) }, "试听");
      const genBtn = h("button", { class: "btn small", onclick: () => generateShot(s, genBtn) }, "生成配音");
      const importInput = h("input", { type: "file", accept: ".mp3,.wav,.m4a,.ogg,.flac,.aac,.opus,audio/*", hidden: true,
        onchange: async () => { const f = importInput.files && importInput.files[0]; if (!f) return; await importShot(s, f); importInput.value = ""; } });
      const importBtn = h("button", { class: "btn small", onclick: () => importInput.click() }, "导入音频");
      const clearBtn = h("button", { class: "btn small danger-ghost", disabled: !s.audioAssetId,
        onclick: async () => {
          const fresh = await ensureSaved(s); if (!fresh) return;
          const r = await api.video.shots.clearAudio(fresh.id);
          if (r.ok) { window.Shell.toast("已清除该镜头配音"); await load(root, currentId); }
          else window.Shell.toast(r.error || "清除失败", "error");
        } }, "清除配音");

      const label = (text, extra) => h("div", { class: "field-label" }, h("span", {}, text), extra ? h("span", { class: "muted small-text" }, extra) : "");
      detailBox.append(
        h("section", { class: "card module shot-detail" },
          h("header", { class: "card-head" },
            h("h2", {}, `第 ${i + 1} 镜`),
            h("span", { class: "muted small-text" }, fmtRange(t.start, t.end)),
            h("span", { class: "spacer" }),
            h("button", { class: "btn small ghost", title: "上移", disabled: i === 0, onclick: () => move(i, -1) }, "↑ 上移"),
            h("button", { class: "btn small ghost", title: "下移", disabled: i === draft.shots.length - 1, onclick: () => move(i, 1) }, "↓ 下移"),
            h("button", { class: "btn small danger-ghost", onclick: () => removeShot(i) }, "删除")),
          label("口播", "约 " + fmt(t.seconds) + "，可留空做纯画面镜头"),
          narration,
          label("时长（秒）", "没有配音时用"),
          h("div", { class: "seconds-line" }, secondsInput, secondsHint),
          label("画面描述"),
          visual,
          label("即梦提示词", "生成视频片段时用"),
          imagePrompt,
          h("div", { class: "asset-box" },
            h("div", { class: "asset-line" },
              h("b", {}, "配音"), h("span", { class: "muted small-text grow" }, audioText(s).replace(/^配音：/, "")),
              genBtn, importBtn, listenBtn, clearBtn, importInput),
            h("div", { class: "asset-line" },
              h("b", {}, "画面"), h("span", { class: "muted small-text grow" }, videoText(s).replace(/^画面：/, "")),
              h("button", { class: "btn small", onclick: () => window.Shell.navigate("render") }, "去合成导出")))));
    };

    // 只更新列表里的时间标签和预览，不重建输入框，避免打字时丢焦点
    const redrawListLight = () => {
      const ts = timings(draft.shots);
      [...listBox.querySelectorAll(".shot-row")].forEach((rowEl, idx) => {
        const tag = rowEl.querySelector(".shot-row-head .small-text");
        if (tag && ts[idx]) tag.textContent = fmtRange(ts[idx].start, ts[idx].end);
        const prev = rowEl.querySelector(".shot-row-preview");
        const s = draft.shots[idx];
        if (prev && s) prev.textContent = (s.narration || "").trim().slice(0, 40) || "（空口播）";
      });
    };

    const move = (i, d) => {
      const j = i + d;
      if (j < 0 || j >= draft.shots.length) return;
      const [s] = draft.shots.splice(i, 1);
      draft.shots.splice(j, 0, s);
      selectedIdx = j;
      redrawList();
      renderDetail();
    };
    const removeShot = (i) => {
      const [s] = draft.shots.splice(i, 1);
      if (s && !s._new && s.id) deletedIds.push(s.id);
      selectedIdx = Math.max(0, Math.min(selectedIdx, draft.shots.length - 1));
      redrawList();
      renderDetail();
    };
    // ---- M2 配音操作：都需要已保存的镜头（未保存的新镜头没有服务端 id） ----
    // 0.5.0：配音操作前若有未保存的改动（改了口播、增删/移动镜头、改标题），先自动保存再操作。
    // 之前是直接用服务端的旧口播生成、操作完重载草稿，把没保存的改动整个吞掉。
    const snapshot = () => JSON.stringify({
      t: titleInput.value, g: tagsInput.value, a: aspectSelect.value, d: deletedIds.length,
      s: draft.shots.map((x) => [x.id || "", !!x._new, x.narration || "", x.visual || "", x.imagePrompt || "", Number(x.seconds) || 0]),
    });
    const isDirty = () => snapshot() !== savedSnap;
    function refreshDirty() {
      if (!savedSnap) return;
      const d = isDirty();
      dirtyTag.hidden = !d;
      const sb = root._bar.el.querySelector("#btn-save");
      if (sb) sb.classList.toggle("pulse", d);
    }
    root._isDirty = isDirty;
    root._save = (opts) => save(opts);
    const ensureSaved = async (s) => {
      const idx = draft.shots.indexOf(s);
      if (!isDirty() && !s._new && s.id) return s;
      const saved = await save({ silent: true });
      if (!saved) return null;
      const fresh = idx >= 0 ? draft.shots[idx] : null;
      if (!fresh || fresh._new || !fresh.id) { window.Shell.toast("自动保存后没找到这个镜头，请重新选择后再试", "error"); return null; }
      return fresh;
    };
    const generateShot = async (s0, btn) => {
      const s = await ensureSaved(s0); if (!s) return;
      if (!String(s.narration || "").trim()) { window.Shell.toast("这镜没有口播文案，无法生成配音", "error"); return; }
      const old = btn.textContent; btn.disabled = true; btn.textContent = "生成中…";
      try {
        const r = await api.video.shots.generateAudio(s.id);
        if (!r.ok) window.Shell.toast(r.error || "生成配音失败", "error");
        else if (r.warning) window.Shell.toast("配音已生成，但时长是估算值：" + r.warning, "error");
        else window.Shell.toast("配音已生成（实测 " + fmt(r.seconds) + "）", "success");
        await load(root, currentId);
      } catch (e) { window.Shell.toast(e.message, "error"); }
      finally { btn.disabled = false; btn.textContent = old; }
    };
    const importShot = async (s0, file) => {
      const s = await ensureSaved(s0); if (!s) return;
      try {
        const data = await file.arrayBuffer();
        const r = await api.video.shots.importAudio(s.id, { name: file.name, data });
        if (!r.ok) window.Shell.toast(r.error || "导入音频失败", "error");
        else if (r.warning) window.Shell.toast("音频已导入，但时长是估算值：" + r.warning, "error");
        else window.Shell.toast("音频已导入（实测 " + fmt(r.seconds) + (r.deduped ? "，与已有音频内容相同，已复用" : "") + "）", "success");
        await load(root, currentId);
      } catch (e) { window.Shell.toast(e.message, "error"); }
    };
    const listenShot = async (s, btn) => {
      if (currentListenBtn === btn) { stopListen(); return; }
      stopListen();
      const r = await api.video.shots.audioData(s.id);
      if (!r.ok) { window.Shell.toast(r.error || "试听失败", "error"); return; }
      const audio = new Audio(r.dataUrl);
      currentAudio = audio; currentListenBtn = btn; btn.textContent = "停止";
      audio.onended = () => stopListen();
      audio.onerror = () => { stopListen(); window.Shell.toast("音频播放失败", "error"); };
      try { await audio.play(); }
      catch (e) { stopListen(); window.Shell.toast("音频播放失败：" + e.message, "error"); }
    };
    const generateAll = async (btn) => {
      if (isDirty() || draft.shots.some((s) => s._new)) { if (!(await save({ silent: true }))) return; }
      const ids = draft.shots.filter((s) => String(s.narration || "").trim()).map((s) => s.id);
      if (!ids.length) { window.Shell.toast("没有可生成配音的口播文案", "error"); return; }
      const old = btn.textContent; btn.disabled = true; btn.textContent = "生成中…";
      let done = 0, failed = 0;
      try {
        for (const id of ids) {
          const r = await api.video.shots.generateAudio(id);
          if (r.ok) done++; else failed++;
        }
        window.Shell.toast(failed ? `配音生成完成：成功 ${done} 镜，失败 ${failed} 镜（失败原因写在对应镜头下）` : `配音已生成 ${done} 镜`, failed ? "error" : "success");
        await load(root, currentId);
      } finally { btn.disabled = false; btn.textContent = old; }
    };

    async function save({ silent = false } = {}) {
      const btn = root._bar.el.querySelector("#btn-save");
      if (btn) btn.disabled = true;
      try {
        const tags = tagsInput.value.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean);
        await unwrap(await api.video.projects.update(currentId, { title: titleInput.value, tags, aspect: aspectSelect.value }));
        for (const id of deletedIds) await unwrap(await api.video.shots.remove(id));
        deletedIds = [];
        const finalIds = [];
        for (const s of draft.shots) {
          if (s._new) {
            const r = await unwrap(await api.video.shots.add(currentId, { narration: s.narration, visual: s.visual, imagePrompt: s.imagePrompt, seconds: Number(s.seconds) || 0 }));
            finalIds.push(r.shot.id);
          } else {
            await unwrap(await api.video.shots.update(s.id, { narration: s.narration, visual: s.visual, imagePrompt: s.imagePrompt, seconds: Number(s.seconds) || 0 }));
            finalIds.push(s.id);
          }
        }
        await unwrap(await api.video.shots.reorder(currentId, finalIds));
        await load(root, currentId);
        if (!silent) window.Shell.toast("已保存", "success");
        return true;
      } catch (e) { window.Shell.toast((silent ? "自动保存失败：" : "") + e.message, "error"); return false; }
      finally { const b = root._bar.el.querySelector("#btn-save"); if (b) b.disabled = false; }
    }

    [titleInput, tagsInput].forEach((el) => el.addEventListener("input", refreshDirty));
    aspectSelect.addEventListener("change", () => updateTotals());
    const infoBtn = h("button", { class: "btn", onclick: () => { infoRow.hidden = !infoRow.hidden; infoBtn.classList.toggle("active", !infoRow.hidden); if (!infoRow.hidden) titleInput.focus(); } }, "项目信息");
    root._bar.setActions(
      dirtyTag,
      infoBtn,
      h("button", { class: "btn", title: "丢掉没保存的改动", onclick: async () => {
        if (isDirty() && !(await window.Shell.confirm("放弃所有没保存的改动？"))) return;
        await load(root, currentId);
      } }, "放弃改动"),
      h("button", { class: "btn primary", id: "btn-save", title: "保存（Ctrl/⌘ S）", onclick: () => save() }, "保存"),
      h("button", { class: "btn", onclick: () => window.Shell.navigate("render") }, "合成导出 →"));

    body.append(
      infoRow,
      h("div", { class: "split-layout editor-layout" },
        h("div", { class: "split-left shot-pane" },
          h("div", { class: "pane-head" },
            h("b", {}, "镜头"), countEl, h("span", { class: "spacer" }),
            h("button", { class: "btn small", id: "btn-voice-all", title: "给所有有口播的镜头生成配音", onclick: (e) => generateAll(e.currentTarget) }, "全部配音")),
          listBox,
          h("button", { class: "btn block add-shot", onclick: () => {
            draft.shots.push({ _new: true, _tmp: "new-" + (++newSeq), narration: "", visual: "", imagePrompt: "", status: "pending" });
            selectedIdx = draft.shots.length - 1;
            redrawList(); renderDetail();
          } }, "＋ 添加镜头")),
        h("div", { class: "split-right" }, detailBox)));

    savedSnap = snapshot();
    redrawList();
    refreshDirty();
    renderDetail();
  }
})();
