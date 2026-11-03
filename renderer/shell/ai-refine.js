"use strict";
// 0.6.51：通用“AI 调整”条。写一句怎么改 → AI 联动修改相关字段 → 标出改了哪些 → 可撤销、可继续调整。
// window.AiRefine.box({ fields: () => [{ key, label, get, set }], context, placeholder, onApplied, stackKey })
(function () {
  const stacks = new WeakMap(); // stackKey（对象）→ 撤销栈；界面重绘后还能撤销
  const textStacks = new Map();
  const stackOf = (k) => {
    if (k && typeof k === "object") { if (!stacks.has(k)) stacks.set(k, []); return stacks.get(k); }
    const key = String(k || "_"); if (!textStacks.has(key)) textStacks.set(key, []); return textStacks.get(key);
  };
  const HINTS = ["更口语一点", "整体缩短三成", "情绪更强烈", "换成夜景雨天", "人物换成短发", "镜头更有电影感"];

  function box(opts = {}) {
    const { h, toast } = window.Shell;
    const stack = stackOf(opts.stackKey || {});
    const input = h("input", { class: "input grow", maxlength: 500, placeholder: opts.placeholder || `告诉 AI 怎么改，如：${HINTS[Math.floor(Math.random() * HINTS.length)]}（相关内容会一起改）` });
    const runBtn = h("button", { class: "btn small primary" }, "AI 调整");
    const undoBtn = h("button", { class: "btn small", hidden: !stack.length, title: "撤销上一次 AI 调整" }, "撤销");
    const msg = h("div", { class: "muted small-text refine-msg" });
    const run = async () => {
      const instruction = input.value.trim();
      if (!instruction) { input.focus(); return toast("先写一句要怎么改"); }
      const list = (opts.fields() || []).filter((f) => f && f.key);
      if (!list.length) return toast("没有可调整的内容", "error");
      runBtn.disabled = true; runBtn.textContent = "调整中…"; msg.textContent = "";
      const t0 = Date.now();
      const r = await window.app.video.ai.refine({ instruction, context: opts.context || "", fields: list.map((f) => ({ key: f.key, label: f.label, text: String(f.get() || "") })) })
        .catch((e) => ({ ok: false, error: e.message }));
      runBtn.disabled = false; runBtn.textContent = "AI 调整";
      if (!r || !r.ok) { msg.textContent = "调整失败：" + ((r && r.error) || "未知错误"); msg.classList.add("err-text"); return; }
      msg.classList.remove("err-text");
      if (!r.changed.length) { msg.textContent = "AI 觉得不用改，内容没变。换个说法试试。"; return; }
      const before = {};
      for (const f of list) if (r.changed.includes(f.key)) { before[f.key] = String(f.get() || ""); f.set(r.fields[f.key]); }
      stack.push({ list: list.filter((f) => f.key in before), before, instruction });
      const names = list.filter((f) => f.key in before).map((f) => f.label || f.key);
      const shown = names.length > 6 ? names.slice(0, 6).join("、") + ` 等 ${names.length} 项` : names.join("、");
      msg.textContent = `已改 ${shown}（${((Date.now() - t0) / 1000).toFixed(0)} 秒）${r.note ? "：" + r.note : ""}。不满意可以撤销或接着说。`;
      input.value = "";
      undoBtn.hidden = false;
      if (opts.onApplied) opts.onApplied(r.changed);
      markChanged(r.changed);
    };
    const markChanged = (keys) => {
      if (!opts.flash) return;
      for (const k of keys) { const el = opts.flash(k); if (el) { el.classList.remove("refine-flash"); void el.offsetWidth; el.classList.add("refine-flash"); } }
    };
    runBtn.onclick = run;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); run(); } });
    undoBtn.onclick = () => {
      const last = stack.pop();
      if (!last) return;
      for (const f of last.list) f.set(last.before[f.key]);
      msg.textContent = `已撤销“${last.instruction}”`;
      undoBtn.hidden = !stack.length;
      if (opts.onApplied) opts.onApplied(Object.keys(last.before));
    };
    return h("div", { class: "refine-box" }, h("div", { class: "row" }, h("span", { class: "refine-icon", title: "AI 调整" }, "✦"), input, runBtn, undoBtn), msg);
  }

  // 给 textarea/input 做 field：get/set 同时更新元素和数据
  function field(key, label, el, onSet) {
    return { key, label, get: () => el.value, set: (v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); if (onSet) onSet(v); } };
  }

  window.AiRefine = { box, field };
})();
