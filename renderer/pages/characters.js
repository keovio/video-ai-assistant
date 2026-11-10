"use strict";
// 0.6.44：角色库（固定人物形象）。不是独立导航页，给作品库（角色 tab）和合成导出（每镜首帧图）用。
// window.Characters = { section(), openEditor(id), openFrame(opts), projectChar: { get, set }, list(), whoText(c) }
(function () {
  const { h } = window.Shell;
  const api = window.app;
  const C = () => api.video.chars;
  const JIMENG = "https://jimeng.jianying.com";
  const KIND = { sheet: "三视图", face: "面部特写", frame: "镜头首帧", other: "参考图", wide: "场景全景", angle: "场景多角度" };
  // 0.6.56：角色和场景共用这一套（同一个库，type 区分）
  const TYPES = {
    character: { word: "角色", ph: "👤", namePh: "角色名，如 小鹿", descPh: "一句话描述，如：20岁女生，粉色双丸子头，古风cos服",
      aLabel: "外貌锚点（每次生图都会带上，保证是同一个人）", aPh: "外貌锚点：性别年龄感、脸型、眉眼、鼻唇、肤色、发型发色、身材、标志特征（不写服装）", aName: "外貌锚点",
      oLabel: "服装", oPh: "服装：款式、颜色、材质、配饰、头饰", oName: "服装",
      empty: "还没有角色。新建一个，写下外貌、生成三视图，之后每镜首帧图都会是同一个人。",
      refineCtx: "AI 生图用的固定角色设定（外貌锚点只写不随镜头变的特征）", refinePh: "告诉 AI 怎么改，如：改成短发、年龄小一点、换成白衬衫（外貌和服装会一起对上）",
      editPh: "要怎么改，如：头发改成齐肩短发；衣服换成白色衬衫；表情更开心", syncLabel: "同时更新外貌锚点/服装（长期特征改了就勾上，后面生图都会跟着变）",
      gens: [["sheet", "三视图"], ["face", "面部特写"]], kinds: ["sheet", "face", "frame", "other"], main: "sheet", genTitle: "生成形象图",
      genHint: "网页生成：会复制提示词和参考图并打开即梦，生成后下载，再用“导入图片”放回来（选对类型）。三视图 + 面部特写都有时，首帧图最稳。" },
    scene: { word: "场景", ph: "🏞", namePh: "场景名，如 雨夜街角", descPh: "一句话描述，如：深夜下雨的老街便利店门口，霓虹灯",
      aLabel: "场景描述（每次生图都会带上，保证是同一个地方）", aPh: "地点、空间布局、主要陈设和位置、墙地材质颜色、标志性物件、远景（不写人物）", aName: "场景描述",
      oLabel: "光线与氛围", oPh: "时间、主光方向和色温、天气、整体色调", oName: "光线与氛围",
      empty: "还没有场景。新建一个，写下地点和陈设、生成场景全景，之后每镜首帧图的背景都会是同一个地方。",
      refineCtx: "AI 生图用的固定场景设定（不写人物）", refinePh: "告诉 AI 怎么改，如：改成白天、加一排书架、换成暖色调（描述和氛围会一起对上）",
      editPh: "要怎么改，如：改成黄昏；墙换成红砖；去掉桌上的杂物", syncLabel: "同时更新场景描述/光线氛围（长期特征改了就勾上，后面生图都会跟着变）",
      gens: [["wide", "场景全景"], ["angle", "多角度"]], kinds: ["wide", "angle", "frame", "other"], main: "wide", genTitle: "生成场景图",
      genHint: "场景图里不会出现人物。有了场景全景，首帧图选上这个场景，背景就能保持一致。" },
  };
  const kindOpts = (t) => TYPES[t].kinds.map((v) => h("option", { value: v }, KIND[v]));
  const toast = (m, t) => window.Shell.toast(m, t);
  const call = async (p, okMsg) => {
    const r = await p.catch((e) => ({ ok: false, error: e.message }));
    if (r && r.ok) { if (okMsg) toast(okMsg, "success"); return r; }
    toast((r && r.error) || "操作失败", "error");
    return null;
  };
  const copy = async (text, msg) => { try { await navigator.clipboard.writeText(text); toast(msg, "success"); } catch (e) { toast("复制失败：" + e.message, "error"); } };
  // 0.6.61：照片先缩到长边 1280、转 JPEG 再发给 AI（手机原图十几 MB 会让 AI 卡到超时）
  const shrinkImage = (dataUrl, max = 1280) => new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const cv = document.createElement("canvas"); cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      try { res(cv.toDataURL("image/jpeg", 0.88)); } catch { res(dataUrl); }
    };
    img.onerror = () => res(dataUrl);
    img.src = dataUrl;
  });
  const readFile = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
  const whoText = (c) => (c ? [c.anchor && `外貌：${c.anchor}`, c.outfit && `服装：${c.outfit}`].filter(Boolean).join("；") : "");
  const projectChar = {
    get: (pid) => (pid ? localStorage.getItem("render.char." + pid) || "" : ""),
    set: (pid, id) => { if (!pid) return; if (id) localStorage.setItem("render.char." + pid, id); else localStorage.removeItem("render.char." + pid); },
  };
  const cache = {};
  async function list(fresh, type = "character") {
    if (!cache[type] || fresh) { const r = await C().list(type).catch(() => null); cache[type] = (r && r.ok && r.characters) || []; }
    return cache[type];
  }
  function modal(title, ...children) {
    const api0 = { beforeClose: null };
    const close = async () => { if (api0.beforeClose && !(await api0.beforeClose())) return; overlay.remove(); };
    const overlay = h("div", { class: "modal-overlay", onclick: (e) => { if (e.target === overlay) modalNudge(overlay); } },
      h("div", { class: "modal modal-form modal-wide modal-char", role: "dialog" }, h("h2", {}, title), ...children,
        h("div", { class: "actions end" }, h("button", { class: "btn", onclick: close }, "关闭"))));
    document.body.append(overlay);
    return Object.assign(api0, { overlay, close });
  }
  // 去合成导出页右边浏览器，新开即梦标签
  function openJimeng() {
    window.Shell.navigate("render");
    setTimeout(() => api.video.embed.nav("jimeng", "newTab", JIMENG).catch(() => {}), 300);
  }
  // 网页手动生成：复制提示词 + 参考图（剪贴板只能放一张图，放封面/面部图），打开即梦
  async function webFlow(id, prompt) {
    await copy(prompt, "提示词已复制");
    const r = await C().copyImage(id).catch(() => null);
    toast(r && r.ok ? "提示词已复制；参考图也复制好了，在即梦里先粘贴提示词，再上传/粘贴参考图" : "提示词已复制（这个角色还没图片，先文生图）", "success");
    openJimeng();
  }

  // ---------- 角色卡片区（作品库） ----------
  function section(onChange, type = "character") {
    const T = TYPES[type];
    const grid = h("div", { class: "lib-grid lib-grid-chars" });
    const box = h("section", { class: "lib-section" },
      h("div", { class: "lib-section-head" }, h("h2", {}, T.word),
        h("button", { class: "btn small primary", onclick: () => openEditor(null, refresh, type) }, "＋ 新建" + T.word)),
      grid);
    async function refresh() {
      const all = await list(true, type);
      grid.textContent = "";
      if (!all.length) grid.append(h("p", { class: "muted small-text" }, T.empty));
      for (const c of all) {
        grid.append(h("div", { class: "lib-card lib-char", onclick: () => openEditor(c.id, refresh, type) },
          h("div", { class: "lib-thumb" }, c.coverUrl ? h("img", { src: c.coverUrl, alt: "" }) : h("span", { class: "lib-thumb-ph" }, T.ph)),
          h("div", { class: "lib-card-body" },
            h("div", { class: "lib-card-title" }, c.name),
            h("div", { class: "lib-card-meta" },
              h("span", { class: "chip" }, `${c.images.length} 张图`),
              c.images.some((x) => x.kind === T.main) ? h("span", { class: "chip ok" }, "有" + KIND[T.main]) : h("span", { class: "chip warn" }, "缺" + KIND[T.main])),
            h("div", { class: "muted small-text two-line", title: c.anchor }, c.anchor || "还没写" + T.aName))));
      }
      if (onChange) onChange(all.length);
    }
    refresh();
    return box;
  }

  // ---------- 角色编辑弹窗 ----------
  async function openEditor(id, onDone, type = "character") {
    let cur = id ? ((await C().get(id).catch(() => null)) || {}).character || null : null;
    if (cur && cur.type) type = cur.type;
    const T = TYPES[type] || TYPES.character;
    const name = h("input", { class: "input", placeholder: T.namePh, value: cur ? cur.name : "" });
    const anchor = h("textarea", { class: "input", rows: 4, placeholder: T.aPh }, cur ? cur.anchor : "");
    const outfit = h("textarea", { class: "input", rows: 2, placeholder: T.oPh }, cur ? cur.outfit : "");
    // AI 帮写
    const desc = h("input", { class: "input grow", placeholder: T.descPh });
    const photo = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
    let photoUrl = "";
    const photoBtn = h("button", { class: "btn small", onclick: () => photo.click() }, "选照片");
    photo.onchange = async () => { const f = photo.files && photo.files[0]; if (!f) return; photoUrl = await shrinkImage(await readFile(f)); photoBtn.textContent = "已选照片 ✓"; };
    // 生成中：显示已用时间、可取消；关弹窗前确认（关了就取消）
    let busy = false, tick = null;
    const status = h("div", { class: "muted small-text", hidden: true });
    const stopBtn = h("button", { class: "btn small ghost", hidden: true, onclick: () => C().cancelDescribe().catch(() => {}) }, "取消");
    const aiBtn = h("button", { class: "btn small", onclick: async () => {
      busy = true; aiBtn.disabled = true; aiBtn.textContent = "AI 写中…"; stopBtn.hidden = false; status.hidden = false;
      const t0 = Date.now();
      const draw = () => { status.textContent = `AI 正在${photoUrl ? "看照片并" : ""}写，已用 ${Math.round((Date.now() - t0) / 1000)} 秒（最多 2 分钟）。请先别关弹窗，关掉会取消；进度在运行日志里。`; };
      draw(); tick = setInterval(draw, 1000);
      const r = await call(C().describe({ text: desc.value.trim(), image: photoUrl, type }));
      clearInterval(tick); busy = false; status.hidden = true; stopBtn.hidden = true;
      aiBtn.disabled = false; aiBtn.textContent = "AI 帮我写";
      if (!r) return;
      if (r.name && !name.value.trim()) name.value = r.name;
      anchor.value = r.anchor || anchor.value; outfit.value = r.outfit || outfit.value;
      toast(`已填好${T.aName}和${T.oName}，检查后点保存`, "success");
    } }, "AI 帮我写");
    const saveBtn = h("button", { class: "btn primary", onclick: async () => {
      if (!anchor.value.trim()) return toast(`先写${T.aName}（可以点“AI 帮我写”）`, "error");
      const r = await call(C().save({ id: cur && cur.id, type, name: name.value.trim(), anchor: anchor.value.trim(), outfit: outfit.value.trim() }), "已保存");
      if (!r) return;
      const firstSave = !cur;
      cur = r.character;
      if (firstSave && photoUrl) await C().addImage(cur.id, { dataUrl: photoUrl }, type === "scene" ? "wide" : "face", "原始照片").catch(() => {});
      await drawImages(); if (onDone) onDone();
    } }, "保存");
    const imgs = h("div", { class: "char-images" });
    const genBox = h("div", { class: "char-gen" });
    const delBtn = h("button", { class: "btn ghost danger", onclick: async () => {
      if (!cur || !await window.Shell.confirm(`删除${T.word}“${cur.name}”和它的所有图片吗？`)) return;
      if (await call(C().remove(cur.id), "已删除")) { m.close(); if (onDone) onDone(); }
    } }, "删除" + T.word);
    const m = modal(cur ? `${T.word}：${cur.name}` : "新建" + T.word,
      h("div", { class: "char-form" },
        h("label", {}, h("span", { class: "small-text" }, "名字"), name),
        h("div", { class: "row" }, desc, photoBtn, aiBtn, stopBtn, photo),
        status,
        h("label", {}, h("span", { class: "small-text" }, T.aLabel), anchor),
        h("label", {}, h("span", { class: "small-text" }, T.oLabel), outfit),
        window.AiRefine.box({ stackKey: cur || anchor, context: T.refineCtx, placeholder: T.refinePh,
          fields: () => [window.AiRefine.field("anchor", T.aName, anchor), window.AiRefine.field("outfit", T.oName, outfit)],
          flash: (k) => ({ anchor, outfit })[k] }),
        ),
      genBox, imgs);
    m.beforeClose = async () => {
      if (!busy) return true;
      if (!await window.Shell.confirm("AI 还在写，关闭弹窗会取消这次生成，确定关闭吗？")) return false;
      C().cancelDescribe().catch(() => {}); clearInterval(tick); return true;
    };
    // 0.6.49：保存/删除放到固定的底部按钮栏
    const foot = m.overlay.querySelector(".modal > .actions.end");
    if (foot) foot.prepend(delBtn, h("span", { class: "spacer" }), saveBtn);

    // 0.6.51：改图。先让 AI 把修改同步进外貌锚点/服装（保存），再以这张图为第一参考图重新生成
    async function editImage(im) {
      const picker = await modelPicker();
      const hasKey = picker.any();
      const ins = h("textarea", { class: "input", rows: 3, placeholder: T.editPh });
      const sync = h("input", { type: "checkbox", checked: true });
      const status = h("p", { class: "muted small-text" });
      const goBtn = h("button", { class: "btn primary", disabled: !hasKey, title: hasKey ? "" : "设置 → 人物生图 里保存 API Key 后可用" }, "改图");
      const webBtn = h("button", { class: "btn", title: "网页手动改：复制带修改要求的提示词，去即梦粘贴" }, "复制提示词");
      const imgBtn = h("button", { class: "btn", title: "复制这张图，去即梦当参考图粘贴", onclick: () => call(C().copyImage(cur.id, im.file), "这张图已复制") }, "复制这张图");
      const syncText = async (instruction) => {
        if (!sync.checked) return true;
        status.textContent = `同步${T.aName}/${T.oName}…`;
        const r = await window.app.video.ai.refine({ instruction: `${T.word}修改：` + instruction, context: T.refineCtx + "（只改和这次修改有关的部分，临时变化不写进去）",
          fields: [{ key: "anchor", label: T.aName, text: anchor.value }, { key: "outfit", label: T.oName, text: outfit.value }] }).catch((e) => ({ ok: false, error: e.message }));
        if (!r || !r.ok) { status.textContent = "同步描述失败：" + ((r && r.error) || "未知错误"); return false; }
        if (r.changed.length) {
          anchor.value = r.fields.anchor; outfit.value = r.fields.outfit;
          const s = await call(C().save({ id: cur.id, type, name: name.value.trim(), anchor: anchor.value.trim(), outfit: outfit.value.trim() }));
          if (!s) return false;
          cur = s.character;
        }
        return true;
      };
      goBtn.onclick = async () => {
        const instruction = ins.value.trim();
        if (!instruction) return toast("先写要怎么改");
        goBtn.disabled = true;
        if (!await syncText(instruction)) { goBtn.disabled = false; return; }
        status.textContent = "生成中…（约 20–60 秒）";
        const rs = await genMulti(cur.id, { kind: im.kind, baseFile: im.file, instruction, note: "修改：" + instruction.slice(0, 40) }, picker);
        goBtn.disabled = false;
        if (!rs.length) { status.textContent = ""; return; }
        if (rs.some((r) => r.refsIgnored)) toast("有模型不支持参考图，那张只按文字生成，不是在原图上改", "error", 6000);
        em.close(); await drawImages(); if (onDone) onDone();
      };
      webBtn.onclick = async () => {
        const instruction = ins.value.trim();
        if (!instruction) return toast("先写要怎么改");
        if (!await syncText(instruction)) return;
        const p = await call(C().prompt(cur.id, { kind: im.kind === "other" ? "frame" : im.kind }));
        if (!p) return;
        await copy(`${p.prompt}\n以参考图为基础修改：${instruction}。除此之外的人物长相、构图、光线、背景都保持和参考图一致。`, "提示词已复制，去即梦粘贴；再点“复制这张图”粘参考图");
        status.textContent = sync.checked ? "外貌/服装已同步，提示词已复制。" : "提示词已复制。";
      };
      const em = modal("改图",
        h("img", { class: "char-edit-preview", src: im.url || "", alt: "", title: "点击放大", onclick: () => window.ImageViewer.open([{ url: im.url, caption: KIND[im.kind] || "" }]) }),
        h("label", { class: "char-edit-field" }, h("span", { class: "small-text" }, "要怎么改"), ins),
        h("label", { class: "row" }, sync, h("span", { class: "small-text" }, T.syncLabel)),
        picker.el, status);
      const foot = em.overlay.querySelector(".modal > .actions.end");
      if (foot) foot.prepend(webBtn, imgBtn, h("span", { class: "spacer" }), goBtn);
      ins.focus();
    }
    async function drawImages() {
      genBox.textContent = ""; imgs.textContent = "";
      delBtn.hidden = !cur;
      if (!cur) { genBox.append(h("p", { class: "muted small-text" }, `保存后可以生成${T.gens.map((g) => g[1]).join("、")}，或导入已有图片。`)); return; }
      const fresh = ((await C().get(cur.id).catch(() => null)) || {}).character;
      if (fresh) cur = fresh;
      const picker = await modelPicker();
      const hasKey = picker.any();
      const genRow = (kind, label) => {
        const btn = h("button", { class: "btn small primary", disabled: !hasKey, title: hasKey ? "用上面勾选的模型生成（勾几个就同时出几张对比）" : "设置 → 人物生图 里选服务商、保存 API Key 后可用", onclick: async () => {
          btn.disabled = true; btn.textContent = "生成中…（约 20–60 秒）";
          const rs = await genMulti(cur.id, { kind }, picker);
          btn.disabled = false; btn.textContent = "API 生成";
          if (rs.length) await drawImages();
        } }, "API 生成");
        return h("div", { class: "char-gen-row" }, h("b", {}, label),
          h("button", { class: "btn small", onclick: async () => { const r = await call(C().prompt(cur.id, { kind })); if (r) copy(r.prompt, "提示词已复制"); } }, "复制提示词"),
          h("button", { class: "btn small", onclick: async () => { const r = await call(C().prompt(cur.id, { kind })); if (r) webFlow(cur.id, r.prompt); } }, "去即梦网页生成"),
          btn);
      };
      const up = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: true, hidden: true });
      const upKind = h("select", { class: "input small" }, ...kindOpts(type));
      upKind.value = cur.images.some((x) => x.kind === T.main) ? "other" : T.main;
      up.onchange = async () => {
        for (const f of [...(up.files || [])]) await call(C().addImage(cur.id, { dataUrl: await readFile(f) }, upKind.value));
        up.value = ""; await drawImages(); if (onDone) onDone();
      };
      genBox.append(h("h3", {}, T.genTitle), picker.el,
        ...T.gens.map(([k, l]) => genRow(k, l)),
        h("div", { class: "char-gen-row" }, h("b", {}, "导入图片"), upKind, h("button", { class: "btn small", onclick: () => up.click() }, "选择图片…"), up),
        h("p", { class: "muted small-text" }, T.genHint));
      imgs.append(h("h3", {}, `图片 ${cur.images.length}`));
      const grid = h("div", { class: "char-img-grid" });
      for (const im of cur.images) {
        const kindSel = h("select", { class: "input small", onchange: async (e) => { await call(C().update(cur.id, { imageKind: { file: im.file, kind: e.target.value } })); } },
          ...kindOpts(type));
        kindSel.value = im.kind;
        grid.append(h("div", { class: "char-img" + (cur.cover === im.file ? " cover" : "") },
          h("img", { src: im.url || "", alt: "", title: (im.note ? im.note + " · " : "") + "点击放大", onclick: () => viewImages(cur, cur.images, cur.images.indexOf(im)) }),
          h("div", { class: "char-img-foot" }, kindSel,
            h("button", { class: "btn small ghost", title: "设为封面", onclick: async () => { if (await call(C().update(cur.id, { cover: im.file }))) { await drawImages(); if (onDone) onDone(); } } }, "★"),
            h("button", { class: "btn small ghost", title: `改图：在这张图基础上修改，${T.aName}/${T.oName}同步`, onclick: () => editImage(im) }, "✎"),
            h("button", { class: "btn small ghost", title: "复制图片", onclick: () => call(C().copyImage(cur.id, im.file), "图片已复制") }, "⧉"),
            h("button", { class: "btn small ghost", title: "删除", onclick: async () => { if (await call(C().removeImage(cur.id, im.file))) { await drawImages(); if (onDone) onDone(); } } }, "✕")),
          im.note ? h("div", { class: "muted small-text one-line" }, im.note) : null));
      }
      imgs.append(cur.images.length ? grid : h("p", { class: "muted small-text" }, "还没有图片。"));
    }
    await drawImages();
  }

  // 0.6.52：同时用几个模型生图。勾选记在 localStorage；默认是设置里的服务商+模型
  const PICK_KEY = "charGenModels";
  async function modelPicker() {
    const r = await C().providers().catch(() => null);
    const opts = [];
    if (r && r.ok) for (const p of r.providers) if (p.hasKey) for (const m of p.modelInfo) opts.push({ provider: p.id, model: m.id, label: m.label.replace(/（(支持参考图|只文生图)）/g, ""), refs: m.refs, group: p.label.replace(/（.*?）/g, "") });
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(PICK_KEY) || "[]"); } catch { saved = []; }
    const keyOf = (o) => o.provider + "|" + o.model;
    let chosen = new Set(saved.filter((k) => opts.some((o) => keyOf(o) === k)));
    if (!chosen.size && r && r.ok && opts.some((o) => o.provider === r.current && o.model === r.model)) chosen.add(r.current + "|" + r.model);
    if (!chosen.size && opts[0]) chosen.add(keyOf(opts[0]));
    const box = h("div", { class: "model-pick" });
    const draw = () => {
      box.replaceChildren(h("span", { class: "small-text muted" }, "用哪些模型："),
        ...(opts.length ? opts.map((o) => {
          const cb = h("input", { type: "checkbox", checked: chosen.has(keyOf(o)), onchange: () => {
            if (cb.checked) { if (chosen.size >= 4) { cb.checked = false; return toast("最多同时 4 个模型"); } chosen.add(keyOf(o)); } else chosen.delete(keyOf(o));
            localStorage.setItem(PICK_KEY, JSON.stringify([...chosen]));
          } });
          return h("label", { class: "model-chip", title: `${o.group} · ${o.model}${o.refs ? "" : "（不支持参考图，只按文字生成，人物可能不像）"}` }, cb, o.label, o.refs ? "" : h("span", { class: "muted" }, " · 无参考图"));
        }) : [h("span", { class: "small-text muted" }, "还没有可用的生图 Key，去 设置 → 人物生图 保存")]));
    };
    draw();
    return { el: box, picks: () => opts.filter((o) => chosen.has(keyOf(o))), any: () => opts.length > 0 };
  }
  // 按勾选的模型并行生成；返回所有成功的结果，失败的逐个提示
  async function genMulti(id, opts, picker) {
    const picks = picker.picks();
    if (!picks.length) { toast("先勾一个模型"); return []; }
    const many = picks.length > 1;
    const rs = await Promise.all(picks.map((p) => C().generate(id, { ...opts, provider: p.provider, model: p.model, tagModel: many || undefined })
      .then((r) => ({ p, r })).catch((e) => ({ p, r: { ok: false, error: e.message } }))));
    const okOnes = [];
    for (const { p, r } of rs) {
      if (r && r.ok) okOnes.push(r);
      else toast(`${p.label} 生成失败：${(r && r.error) || "未知错误"}`, "error", 6000);
    }
    if (okOnes.length) toast(many ? `${okOnes.length}/${picks.length} 个模型生成好了` : "已生成", "success");
    return okOnes;
  }

  // 0.6.52：点图放大，左右翻同一角色的所有图
  function viewImages(c, images, index) {
    window.ImageViewer.open(images.map((im) => ({
      url: im.url, caption: `${c.name} · ${KIND[im.kind] || im.kind}${im.note ? " · " + im.note : ""}`,
      actions: [
        { label: "复制图片", onClick: () => call(C().copyImage(c.id, im.file), "图片已复制") },
        { label: "在文件夹中显示", onClick: () => C().reveal(c.id, im.file) },
      ],
    })), index);
  }

  // ---------- 镜头首帧图弹窗（合成导出每镜） ----------
  // opts: { projectId, label: "第 3 镜", shotPrompt, aspect, style }
  async function openFrame(opts = {}) {
    const all = await list(true);
    if (!all.length) {
      if (await window.Shell.confirm("还没有角色。现在新建一个吗？")) openEditor(null);
      return;
    }
    const sel = h("select", { class: "input" }, ...all.map((c) => h("option", { value: c.id }, c.name)));
    const bound = projectChar.get(opts.projectId);
    if (bound && all.some((c) => c.id === bound)) sel.value = bound;
    // 0.6.56：可选场景，背景保持同一个地方
    const scenes = await list(true, "scene");
    const sceneSel = h("select", { class: "input" }, h("option", { value: "" }, scenes.length ? "不用场景" : "还没有场景（作品库 → 场景 新建）"), ...scenes.map((c) => h("option", { value: c.id }, c.name)));
    const sceneKey = "render.scene." + (opts.projectId || "");
    const boundScene = localStorage.getItem(sceneKey) || "";
    if (boundScene && scenes.some((c) => c.id === boundScene)) sceneSel.value = boundScene;
    const ta = h("textarea", { class: "input", rows: 9 });
    const status = h("p", { class: "muted small-text" });
    const results = h("div", { class: "char-img-grid" });
    const fill = async () => {
      projectChar.set(opts.projectId, sel.value);
      if (sceneSel.value) localStorage.setItem(sceneKey, sceneSel.value); else localStorage.removeItem(sceneKey);
      const r = await call(C().prompt(sel.value, { kind: "frame", shotPrompt: opts.shotPrompt, aspect: opts.aspect, style: opts.style, sceneId: sceneSel.value }));
      if (r) {
        ta.value = r.prompt; status.textContent = r.refs ? `会带这 ${r.refs} 张参考图（人物在前、场景在后，点图放大）：` : "这个角色还没有参考图，只能靠文字，容易不像；建议先生成三视图";
        // 0.6.52：把参考图本身列出来，点开能放大看
        const id = sel.value;
        const items = [];
        for (const f of r.refFiles || []) { const im = await C().image(id, f).catch(() => null); if (im && im.ok) items.push({ url: im.url, caption: "人物参考图 · " + f }); }
        for (const f of r.sceneRefFiles || []) { const im = await C().image(sceneSel.value, f).catch(() => null); if (im && im.ok) items.push({ url: im.url, caption: "场景参考图 · " + f }); }
        refStrip.replaceChildren(...items.map((it, k) => h("img", { src: it.url, alt: "", title: "点击放大", onclick: () => window.ImageViewer.open(items, k) })));
      }
    };
    sel.onchange = fill; sceneSel.onchange = fill;
    const picker = await modelPicker();
    const hasKey = picker.any();
    const refStrip = h("div", { class: "ref-strip" });
    const showFile = async (file) => {
      const r = await C().image(sel.value, file).catch(() => null);
      results.append(h("div", { class: "char-img" },
        h("img", { src: r && r.ok ? r.url : "", alt: "", title: "点击放大", onclick: () => window.ImageViewer.open([{ url: r && r.ok ? r.url : "", caption: `${opts.label || ""} 首帧图`,
          actions: [{ label: "复制图片", onClick: () => call(C().copyImage(sel.value, file), "首帧图已复制") }, { label: "在文件夹中显示", onClick: () => C().reveal(sel.value, file) }] }]) }),
        h("div", { class: "char-img-foot" },
          h("button", { class: "btn small", onclick: () => call(C().copyImage(sel.value, file), "首帧图已复制，去生成网站粘贴做图生视频") }, "复制图片"),
          h("button", { class: "btn small ghost", onclick: () => C().reveal(sel.value, file) }, "文件夹"))));
    };
    const genBtn = h("button", { class: "btn primary", disabled: !hasKey, title: hasKey ? "用勾选的模型生成（勾几个就同时出几张对比）" : "设置 → 人物生图 里选服务商、保存 API Key 后可用", onclick: async () => {
      genBtn.disabled = true; genBtn.textContent = "生成中…（约 20–60 秒）";
      const rs = await genMulti(sel.value, { kind: "frame", prompt: ta.value, aspect: opts.aspect, note: opts.label || "", sceneId: sceneSel.value }, picker);
      genBtn.disabled = false; genBtn.textContent = "API 生成";
      for (const r of rs) for (const f of r.files) await showFile(f);
    } }, "API 生成");
    const up = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true, onchange: async () => {
      const f = up.files && up.files[0]; if (!f) return;
      const r = await call(C().addImage(sel.value, { dataUrl: await readFile(f) }, "frame", opts.label || ""), "已导入");
      up.value = ""; if (r) await showFile(r.file);
    } });
    modal(`${opts.label || "镜头"} · 首帧图`,
      h("div", { class: "frame-pick-row" }, h("label", { class: "char-edit-field" }, h("span", { class: "small-text" }, "角色"), sel), h("label", { class: "char-edit-field" }, h("span", { class: "small-text" }, "场景"), sceneSel)),
      h("label", { class: "char-edit-field" }, h("span", { class: "small-text" }, "提示词（可改）"), ta), status, refStrip, picker.el,
      window.AiRefine.box({ stackKey: ta, context: "镜头首帧图的生图提示词（人物外貌要和角色设定一致）",
        fields: () => [window.AiRefine.field("prompt", "首帧图提示词", ta)], flash: () => ta }),
      h("div", { class: "actions" },
        h("button", { class: "btn", onclick: () => copy(ta.value, "提示词已复制") }, "复制提示词"),
        h("button", { class: "btn", onclick: () => webFlow(sel.value, ta.value) }, "去即梦网页生成"),
        h("button", { class: "btn", onclick: () => up.click() }, "导入图片"), up,
        genBtn),
      h("p", { class: "muted small-text" }, "生成好的首帧图在即梦/可灵里选“图生视频”上传，再贴这镜的画面提示词，人物就会一直是同一个人。"),
      results);
    await fill();
  }

  window.Characters = { section, openEditor, openFrame, projectChar, list, whoText, sceneSection: (onChange) => section(onChange, "scene") };
})();
