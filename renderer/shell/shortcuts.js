"use strict";
// 0.6.49：全局快捷键。捕获阶段处理，优先于各页面自己的监听。
// Esc 关最上层弹窗；⌘/Ctrl+1…9 切导航；⌘/Ctrl+, 设置；⌘/Ctrl+F 搜索；⌘/Ctrl+←/→ 项目流程上一步/下一步；
// 分镜编辑 ↑/↓ 切镜头；? 显示快捷键列表。⌘/Ctrl+S 保存、⌘/Ctrl+B 侧栏、⌘/Ctrl+L 日志由各自模块处理。
(function () {
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent || "");
  const MOD = isMac ? "⌘" : "Ctrl";
  const LIST = [
    ["Esc", "关闭弹窗 / 清空搜索框"],
    [`${MOD} + 1…7`, "切换左侧导航（首页、项目、视频分析、作品库…）"],
    [`${MOD} + ,`, "打开设置"],
    [`${MOD} + F`, "聚焦当前页的搜索框（项目、作品库）"],
    [`${MOD} + S`, "保存（分镜编辑）"],
    [`${MOD} + ← / →`, "项目流程：上一步 / 下一步（分镜编辑 ⇄ 合成导出）"],
    ["↑ / ↓", "分镜编辑：上一个 / 下一个镜头（不在输入框里时）"],
    [`${MOD} + B`, "收起 / 展开左侧栏"],
    [`${MOD} + L`, "打开 / 关闭日志面板"],
    ["?", "显示这张快捷键表"],
  ];
  const inField = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const visible = (el) => !!el && el.offsetParent !== null;
  const CLOSE_RE = /^(关闭|取消|不用了|否|稍后|知道了|好的?)$/;

  function topOverlay() {
    const all = [...document.querySelectorAll(".modal-overlay")];
    return all[all.length - 1] || null;
  }
  function closeOverlay(ov) {
    const btns = [...ov.querySelectorAll("button")];
    const btn = btns.reverse().find((b) => CLOSE_RE.test(b.textContent.trim()) && !b.disabled);
    if (btn) btn.click(); else ov.remove();
  }
  function showHelp() {
    const { h } = window.Shell;
    if (document.querySelector(".modal-shortcuts")) return;
    const close = () => ov.remove();
    const ov = h("div", { class: "modal-overlay", onclick: (e) => { if (e.target === ov) close(); } },
      h("div", { class: "modal modal-form modal-shortcuts", role: "dialog" },
        h("h2", {}, "快捷键"),
        h("dl", { class: "kbd-list" }, ...LIST.flatMap(([k, d]) => [h("dt", {}, h("kbd", {}, k)), h("dd", {}, d)])),
        h("div", { class: "actions end" }, h("button", { class: "btn", onclick: close }, "关闭"))));
    document.body.append(ov);
  }
  const STEPS = ["editor", "render"];

  window.addEventListener("keydown", (e) => {
    const S = window.Shell;
    if (!S) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const cur = S.current;
    // Esc：先关弹窗
    if (e.key === "Escape") {
      const ov = topOverlay();
      if (ov) { e.preventDefault(); e.stopImmediatePropagation(); closeOverlay(ov); return; }
      if (inField(e.target) && e.target.type !== "search") e.target.blur();
      return;
    }
    if (topOverlay()) return; // 弹窗开着时不处理其他全局键
    if (mod && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
      const items = [...document.querySelectorAll("#nav .nav-item")];
      const it = items[Number(e.key) - 1];
      if (it) { e.preventDefault(); it.click(); }
      return;
    }
    if (mod && !e.altKey && e.key === ",") { e.preventDefault(); S.navigate("settings"); return; }
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
      const page = document.getElementById("page-" + cur);
      const box = page && [...page.querySelectorAll("input[type=search], .lib-search")].find(visible);
      if (box) { e.preventDefault(); e.stopImmediatePropagation(); box.focus(); box.select(); }
      return;
    }
    if (mod && !e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && STEPS.includes(cur) && !inField(e.target)) {
      const next = STEPS[STEPS.indexOf(cur) + (e.key === "ArrowRight" ? 1 : -1)];
      if (next) { e.preventDefault(); S.navigate(next); }
      return;
    }
    if (inField(e.target) || mod || e.altKey) return;
    if (e.key === "?") { e.preventDefault(); showHelp(); return; }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && cur === "editor") {
      const root = document.getElementById("page-editor");
      if (root && root._moveShot) { e.preventDefault(); root._moveShot(e.key === "ArrowDown" ? 1 : -1); }
    }
  }, true);

  window.Shortcuts = { show: showHelp, list: LIST };
})();
