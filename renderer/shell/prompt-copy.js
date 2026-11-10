// 0.6.62：“全部复制”画面提示词的统一格式（作品库分析弹窗、合成导出页共用）
// 开头：人物锚点（有绑定角色时）、整体风格（有 skill 时）；然后一镜一段“第 N 镜（X 秒）：提示词”。
(function () {
  const secs = (n) => `${Math.round(Number(n || 0) * 10) / 10} 秒`;
  function all({ shots = [], who = "", whoName = "", style = "" } = {}) {
    const lines = shots.map((s, i) => {
      const p = String((s && s.prompt) || "").trim();
      return p ? `第 ${i + 1} 镜（${secs(s.seconds)}）：${p}` : "";
    }).filter(Boolean);
    const head = [];
    if (who) head.push(`人物${whoName ? `（${whoName}，全片同一人）` : ""}：${who}`);
    if (style) head.push(`整体风格：${style}`);
    return { text: lines.length ? [...(head.length ? [head.join("\n")] : []), ...lines].join("\n\n") : "", count: lines.length };
  }
  const api = { all };
  if (typeof window !== "undefined") window.PromptCopy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
