"use strict";
// 0.6.44：角色库（固定人物形象）。不是独立导航页，给作品库（角色 tab）和合成导出（每镜首帧图）用。
// window.Characters = { section(), openEditor(id), openFrame(opts), projectChar: { get, set }, list(), whoText(c) }
(function () {
  const { h } = window.Shell;
  const api = window.app;
  const C = () => api.video.chars;
  const JIMENG = "https://jimeng.jianying.com";
  const KIND = { sheet: "三视图", face: "面部特写", frame: "镜头首帧", other: "参考图" };
  const toast = (m, t) => window.Shell.toast(m, t);
  const call = async (p, okMsg) => {
    const r = await p.catch((e) => ({ ok: false, error: e.message }));
    if (r && r.ok) { if (okMsg) toast(okMsg, "success"); return r; }
    toast((r && r.error) || "操作失败", "error");
    return null;
  };
  const copy = async (text, msg) => { try { await navigator.clipboard.writeText(text); toast(msg, "success"); } catch (e) { toast("复制失败：" + e.message, "error"); } };
  const readFile = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
  const whoText = (c) => (c ? [c.anchor && `外貌：${c.anchor}`, c.outfit && `服装：${c.outfit}`].filter(Boolean).join("；") : "");
  const projectChar = {
    get: (pid) => (pid ? localStorage.getItem("render.char." + pid) || "" : ""),
    set: (pid, id) => { if (!pid) return; if (id) localStorage.setItem("render.char." + pid, id); else localStorage.removeItem("render.char." + pid); },
  };
  let cache = null;
  async function list(fresh) {
    if (!cache || fresh) { const r = await C().list().catch(() => null); cache = (r && r.ok && r.characters) || []; }
    return cache;
  }
  function modal(title, ...children) {
    const close = () => overlay.remove();
    const overlay = h("div", { class: "modal-overlay", onclick: (e) => { if (e.target === overlay) close(); } },
      h("div", { class: "modal modal-form modal-wide modal-char", role: "dialog" }, h("h2", {}, title), ...children,
        h("div", { class: "actions end" }, h("button", { class: "btn", onclick: close }, "关闭"))));
    document.body.append(overlay);
    return { overlay, close };
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
  function section(onChange) {
    const grid = h("div", { class: "lib-grid lib-grid-chars" });
    const box = h("section", { class: "lib-section" },
      h("div", { class: "lib-section-head" }, h("h2", {}, "角色"),
        h("button", { class: "btn small primary", onclick: () => openEditor(null, refresh) }, "＋ 新建角色")),
      grid);
    async function refresh() {
      const all = await list(true);
      grid.textContent = "";
      if (!all.length) grid.append(h("p", { class: "muted small-text" }, "还没有角色。新建一个，写下外貌、生成三视图，之后每镜首帧图都会是同一个人。"));
      for (const c of all) {
        grid.append(h("div", { class: "lib-card lib-char", onclick: () => openEditor(c.id, refresh) },
          h("div", { class: "lib-thumb" }, c.coverUrl ? h("img", { src: c.coverUrl, alt: "" }) : h("span", { class: "lib-thumb-ph" }, "👤")),
          h("div", { class: "lib-card-body" },
            h("div", { class: "lib-card-title" }, c.name),
            h("div", { class: "lib-card-meta" },
              h("span", { class: "chip" }, `${c.images.length} 张图`),
              c.images.some((x) => x.kind === "sheet") ? h("span", { class: "chip ok" }, "有三视图") : h("span", { class: "chip warn" }, "缺三视图")),
            h("div", { class: "muted small-text two-line", title: c.anchor }, c.anchor || "还没写外貌"))));
      }
      if (onChange) onChange(all.length);
    }
    refresh();
    return box;
  }

  // ---------- 角色编辑弹窗 ----------
  async function openEditor(id, onDone) {
    let cur = id ? ((await C().get(id).catch(() => null)) || {}).character || null : null;
    const name = h("input", { class: "input", placeholder: "角色名，如 小鹿", value: cur ? cur.name : "" });
    const anchor = h("textarea", { class: "input", rows: 4, placeholder: "外貌锚点：性别年龄感、脸型、眉眼、鼻唇、肤色、发型发色、身材、标志特征（不写服装）" }, cur ? cur.anchor : "");
    const outfit = h("textarea", { class: "input", rows: 2, placeholder: "服装：款式、颜色、材质、配饰、头饰" }, cur ? cur.outfit : "");
    // AI 帮写
    const desc = h("input", { class: "input grow", placeholder: "一句话描述，如：20岁女生，粉色双丸子头，古风cos服" });
    const photo = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
    let photoUrl = "";
    const photoBtn = h("button", { class: "btn small", onclick: () => photo.click() }, "选照片");
    photo.onchange = async () => { const f = photo.files && photo.files[0]; if (!f) return; photoUrl = await readFile(f); photoBtn.textContent = "已选照片 ✓"; };
    const aiBtn = h("button", { class: "btn small", onclick: async () => {
      aiBtn.disabled = true; aiBtn.textContent = "AI 写中…";
      const r = await call(C().describe({ text: desc.value.trim(), image: photoUrl }));
      aiBtn.disabled = false; aiBtn.textContent = "AI 帮我写";
      if (!r) return;
      if (r.name && !name.value.trim()) name.value = r.name;
      anchor.value = r.anchor || anchor.value; outfit.value = r.outfit || outfit.value;
      toast("已填好外貌和服装，检查后点保存", "success");
    } }, "AI 帮我写");
    const saveBtn = h("button", { class: "btn primary", onclick: async () => {
      if (!anchor.value.trim()) return toast("先写外貌锚点（可以点“AI 帮我写”）", "error");
      const r = await call(C().save({ id: cur && cur.id, name: name.value.trim(), anchor: anchor.value.trim(), outfit: outfit.value.trim() }), "已保存");
      if (!r) return;
      const firstSave = !cur;
      cur = r.character;
      if (firstSave && photoUrl) await C().addImage(cur.id, { dataUrl: photoUrl }, "face", "原始照片").catch(() => {});
      await drawImages(); if (onDone) onDone();
    } }, "保存");
    const imgs = h("div", { class: "char-images" });
    const genBox = h("div", { class: "char-gen" });
    const delBtn = h("button", { class: "btn ghost danger", onclick: async () => {
      if (!cur || !await window.Shell.confirm(`删除角色“${cur.name}”和它的所有图片吗？`)) return;
      if (await call(C().remove(cur.id), "已删除")) { m.close(); if (onDone) onDone(); }
    } }, "删除角色");
    const m = modal(cur ? `角色：${cur.name}` : "新建角色",
      h("div", { class: "char-form" },
        h("label", {}, h("span", { class: "small-text" }, "名字"), name),
        h("div", { class: "row" }, desc, photoBtn, aiBtn, photo),
        h("label", {}, h("span", { class: "small-text" }, "外貌锚点（每次生图都会带上，保证是同一个人）"), anchor),
        h("label", {}, h("span", { class: "small-text" }, "服装"), outfit),
        window.AiRefine.box({ stackKey: cur || anchor, context: "AI 生图用的固定角色设定（外貌锚点只写不随镜头变的特征）",
          placeholder: "告诉 AI 怎么改，如：改成短发、年龄小一点、换成白衬衫（外貌和服装会一起对上）",
          fields: () => [window.AiRefine.field("anchor", "外貌锚点", anchor), window.AiRefine.field("outfit", "服装", outfit)],
          flash: (k) => ({ anchor, outfit })[k] }),
        ),
      genBox, imgs);
    // 0.6.49：保存/删除放到固定的底部按钮栏
    const foot = m.overlay.querySelector(".modal > .actions.end");
    if (foot) foot.prepend(delBtn, h("span", { class: "spacer" }), saveBtn);

    // 0.6.51：改图。先让 AI 把修改同步进外貌锚点/服装（保存），再以这张图为第一参考图重新生成
    async function editImage(im) {
      const keyR = await C().keyStatus().catch(() => null);
      const hasKey = !!(keyR && keyR.set);
      const ins = h("textarea", { class: "input", rows: 3, placeholder: "要怎么改，如：头发改成齐肩短发；衣服换成白色衬衫；表情更开心" });
      const sync = h("input", { type: "checkbox", checked: true });
      const status = h("p", { class: "muted small-text" });
      const goBtn = h("button", { class: "btn primary", disabled: !hasKey, title: hasKey ? "" : "设置 → 人物生图 里保存 API Key 后可用" }, "改图");
      const webBtn = h("button", { class: "btn", title: "网页手动改：复制带修改要求的提示词，去即梦粘贴" }, "复制提示词");
      const imgBtn = h("button", { class: "btn", title: "复制这张图，去即梦当参考图粘贴", onclick: () => call(C().copyImage(cur.id, im.file), "这张图已复制") }, "复制这张图");
      const syncText = async (instruction) => {
        if (!sync.checked) return true;
        status.textContent = "同步外貌/服装描述…";
        const r = await window.app.video.ai.refine({ instruction: "角色形象修改：" + instruction, context: "AI 生图用的固定角色设定（只改和这次修改有关的部分，表情动作这类临时变化不写进外貌锚点）",
          fields: [{ key: "anchor", label: "外貌锚点", text: anchor.value }, { key: "outfit", label: "服装", text: outfit.value }] }).catch((e) => ({ ok: false, error: e.message }));
        if (!r || !r.ok) { status.textContent = "同步描述失败：" + ((r && r.error) || "未知错误"); return false; }
        if (r.changed.length) {
          anchor.value = r.fields.anchor; outfit.value = r.fields.outfit;
          const s = await call(C().save({ id: cur.id, name: name.value.trim(), anchor: anchor.value.trim(), outfit: outfit.value.trim() }));
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
        const r = await call(C().generate(cur.id, { kind: im.kind, baseFile: im.file, instruction, note: "修改：" + instruction.slice(0, 40) }), "改好了，新图在最前面");
        goBtn.disabled = false;
        if (!r) { status.textContent = ""; return; }
        if (r.refsIgnored) toast("当前模型不支持参考图，这张只按文字生成；要在原图上改，换火山方舟 Seedream 4.x 或 gpt-image-1", "error");
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
        h("img", { class: "char-edit-preview", src: im.url || "", alt: "" }),
        h("label", { class: "char-edit-field" }, h("span", { class: "small-text" }, "要怎么改"), ins),
        h("label", { class: "row" }, sync, h("span", { class: "small-text" }, "同时更新外貌锚点/服装（长期特征改了就勾上，后面生图都会跟着变）")),
        status);
      const foot = em.overlay.querySelector(".modal > .actions.end");
      if (foot) foot.prepend(webBtn, imgBtn, h("span", { class: "spacer" }), goBtn);
      ins.focus();
    }
    async function drawImages() {
      genBox.textContent = ""; imgs.textContent = "";
      delBtn.hidden = !cur;
      if (!cur) { genBox.append(h("p", { class: "muted small-text" }, "保存后可以生成三视图、面部特写，或导入已有图片。")); return; }
      const fresh = ((await C().get(cur.id).catch(() => null)) || {}).character;
      if (fresh) cur = fresh;
      const keyR = await C().keyStatus().catch(() => null);
      const hasKey = !!(keyR && keyR.set);
      const genRow = (kind, label) => {
        const btn = h("button", { class: "btn small primary", disabled: !hasKey, title: hasKey ? "用设置 → 人物生图 里选的服务商和模型生成" : "设置 → 人物生图 里选服务商、保存 API Key 后可用", onclick: async () => {
          btn.disabled = true; btn.textContent = "生成中…（约 20–60 秒）";
          const r = await call(C().generate(cur.id, { kind }), `${label}已生成`);
          btn.disabled = false; btn.textContent = "API 生成";
          if (r && r.refsIgnored) toast("当前模型不支持参考图，这张只按文字生成；要更像同一个人，换火山方舟 Seedream 4.x 或 gpt-image-1", "error");
          if (r) await drawImages();
        } }, "API 生成");
        return h("div", { class: "char-gen-row" }, h("b", {}, label),
          h("button", { class: "btn small", onclick: async () => { const r = await call(C().prompt(cur.id, { kind })); if (r) copy(r.prompt, "提示词已复制"); } }, "复制提示词"),
          h("button", { class: "btn small", onclick: async () => { const r = await call(C().prompt(cur.id, { kind })); if (r) webFlow(cur.id, r.prompt); } }, "去即梦网页生成"),
          btn);
      };
      const up = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: true, hidden: true });
      const upKind = h("select", { class: "input small" }, ...Object.entries(KIND).map(([v, l]) => h("option", { value: v }, l)));
      upKind.value = cur.images.some((x) => x.kind === "sheet") ? "other" : "sheet";
      up.onchange = async () => {
        for (const f of [...(up.files || [])]) await call(C().addImage(cur.id, { dataUrl: await readFile(f) }, upKind.value));
        up.value = ""; await drawImages(); if (onDone) onDone();
      };
      genBox.append(h("h3", {}, "生成形象图"),
        genRow("sheet", "三视图"), genRow("face", "面部特写"),
        h("div", { class: "char-gen-row" }, h("b", {}, "导入图片"), upKind, h("button", { class: "btn small", onclick: () => up.click() }, "选择图片…"), up),
        h("p", { class: "muted small-text" }, "网页生成：会复制提示词和参考图并打开即梦，生成后下载，再用“导入图片”放回来（选对类型）。三视图 + 面部特写都有时，首帧图最稳。"));
      imgs.append(h("h3", {}, `图片 ${cur.images.length}`));
      const grid = h("div", { class: "char-img-grid" });
      for (const im of cur.images) {
        const kindSel = h("select", { class: "input small", onchange: async (e) => { await call(C().update(cur.id, { imageKind: { file: im.file, kind: e.target.value } })); } },
          ...Object.entries(KIND).map(([v, l]) => h("option", { value: v }, l)));
        kindSel.value = im.kind;
        grid.append(h("div", { class: "char-img" + (cur.cover === im.file ? " cover" : "") },
          h("img", { src: im.url || "", alt: "", title: im.note || "", onclick: () => C().reveal(cur.id, im.file) }),
          h("div", { class: "char-img-foot" }, kindSel,
            h("button", { class: "btn small ghost", title: "设为封面", onclick: async () => { if (await call(C().update(cur.id, { cover: im.file }))) { await drawImages(); if (onDone) onDone(); } } }, "★"),
            h("button", { class: "btn small ghost", title: "改图：在这张图基础上修改，外貌/服装描述同步", onclick: () => editImage(im) }, "✎"),
            h("button", { class: "btn small ghost", title: "复制图片", onclick: () => call(C().copyImage(cur.id, im.file), "图片已复制") }, "⧉"),
            h("button", { class: "btn small ghost", title: "删除", onclick: async () => { if (await call(C().removeImage(cur.id, im.file))) { await drawImages(); if (onDone) onDone(); } } }, "✕")),
          im.note ? h("div", { class: "muted small-text one-line" }, im.note) : null));
      }
      imgs.append(cur.images.length ? grid : h("p", { class: "muted small-text" }, "还没有图片。"));
    }
    await drawImages();
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
    const ta = h("textarea", { class: "input", rows: 9 });
    const status = h("p", { class: "muted small-text" });
    const results = h("div", { class: "char-img-grid" });
    const fill = async () => {
      projectChar.set(opts.projectId, sel.value);
      const r = await call(C().prompt(sel.value, { kind: "frame", shotPrompt: opts.shotPrompt, aspect: opts.aspect, style: opts.style }));
      if (r) { ta.value = r.prompt; status.textContent = r.refs ? `会带 ${r.refs} 张参考图（三视图/面部特写优先）` : "这个角色还没有参考图，只能靠文字，容易不像；建议先生成三视图"; }
    };
    sel.onchange = fill;
    const keyR = await C().keyStatus().catch(() => null);
    const hasKey = !!(keyR && keyR.set);
    const showFile = async (file) => {
      const r = await C().image(sel.value, file).catch(() => null);
      results.append(h("div", { class: "char-img" },
        h("img", { src: r && r.ok ? r.url : "", alt: "", onclick: () => C().reveal(sel.value, file) }),
        h("div", { class: "char-img-foot" },
          h("button", { class: "btn small", onclick: () => call(C().copyImage(sel.value, file), "首帧图已复制，去生成网站粘贴做图生视频") }, "复制图片"),
          h("button", { class: "btn small ghost", onclick: () => C().reveal(sel.value, file) }, "文件夹"))));
    };
    const genBtn = h("button", { class: "btn primary", disabled: !hasKey, title: hasKey ? "用设置 → 人物生图 里选的服务商和模型生成" : "设置 → 人物生图 里选服务商、保存 API Key 后可用", onclick: async () => {
      genBtn.disabled = true; genBtn.textContent = "生成中…（约 20–60 秒）";
      const r = await call(C().generate(sel.value, { kind: "frame", prompt: ta.value, aspect: opts.aspect, note: opts.label || "" }), "首帧图已生成");
      genBtn.disabled = false; genBtn.textContent = "API 生成";
      if (r && r.refsIgnored) toast("当前模型不支持参考图，这张只按文字生成；要更像同一个人，换火山方舟 Seedream 4.x 或 gpt-image-1", "error");
      if (r) for (const f of r.files) await showFile(f);
    } }, "API 生成");
    const up = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true, onchange: async () => {
      const f = up.files && up.files[0]; if (!f) return;
      const r = await call(C().addImage(sel.value, { dataUrl: await readFile(f) }, "frame", opts.label || ""), "已导入");
      up.value = ""; if (r) await showFile(r.file);
    } });
    modal(`${opts.label || "镜头"} · 首帧图`,
      h("label", {}, h("span", { class: "small-text" }, "角色"), sel),
      h("label", {}, h("span", { class: "small-text" }, "提示词（可改）"), ta), status,
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

  window.Characters = { section, openEditor, openFrame, projectChar, list, whoText };
})();
