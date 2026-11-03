"use strict";
// 0.6.52：图片放大预览。window.ImageViewer.open(items, index)
// items: [{ url, caption, actions: [{ label, onClick }] }]；← → 翻页，Esc / 点空白关闭
(function () {
  function open(items, index = 0) {
    const { h } = window.Shell;
    items = (items || []).filter((x) => x && x.url);
    if (!items.length) return;
    let i = Math.max(0, Math.min(index, items.length - 1));
    const img = h("img", { class: "iv-img", alt: "" });
    const cap = h("div", { class: "iv-cap" });
    const acts = h("div", { class: "iv-acts" });
    const prev = h("button", { class: "iv-nav iv-prev", title: "上一张（←）", onclick: (e) => { e.stopPropagation(); go(-1); } }, "‹");
    const next = h("button", { class: "iv-nav iv-next", title: "下一张（→）", onclick: (e) => { e.stopPropagation(); go(1); } }, "›");
    const close = () => { ov.remove(); document.removeEventListener("keydown", onKey, true); };
    const closeBtn = h("button", { class: "btn small iv-close", onclick: close }, "关闭");
    const show = () => {
      const it = items[i];
      img.src = it.url;
      cap.textContent = (items.length > 1 ? `${i + 1} / ${items.length}  ` : "") + (it.caption || "");
      acts.replaceChildren(...(it.actions || []).map((a) => h("button", { class: "btn small", onclick: (e) => { e.stopPropagation(); a.onClick(); } }, a.label)), closeBtn);
      prev.hidden = next.hidden = items.length < 2;
    };
    const go = (d) => { i = (i + d + items.length) % items.length; show(); };
    const onKey = (e) => {
      if (!document.body.contains(ov)) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); e.stopImmediatePropagation(); go(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); e.stopImmediatePropagation(); go(1); }
    };
    const ov = h("div", { class: "modal-overlay iv-overlay", onclick: (e) => { if (e.target === ov || e.target.classList.contains("iv-stage")) close(); } },
      h("div", { class: "iv-stage" }, prev, img, next),
      h("div", { class: "iv-bar", onclick: (e) => e.stopPropagation() }, cap, acts));
    document.addEventListener("keydown", onKey, true);
    document.body.append(ov);
    show();
  }
  window.ImageViewer = { open };
})();
