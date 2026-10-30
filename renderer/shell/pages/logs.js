"use strict";
// 内置页面：日志。实时显示主进程和页面写的日志，可按级别 / 关键字筛选、暂停自动滚动、复制、打开日志文件夹。
// 右侧还有一个随时可开的「运行日志」面板（Ctrl/⌘ + L），两者共用 Shell.createLogView。
// 页面里写日志：window.app.logs.write("info", "消息", "模块名")
(function () {
  const { h } = window.Shell;
  const api = window.app;

  window.Shell.registerPage({
    id: "logs", title: "日志", icon: "logs", section: "system", order: 20,
    render(root) {
      const view = window.Shell.createLogView();
      root.classList.add("page-fill");
      root.append(
        h("header", { class: "page-head" },
          h("div", {}, h("h1", {}, "日志"), h("p", { class: "sub" }, "排查问题时把这里的内容复制给开发者")),
          h("div", { class: "actions" },
            h("button", { class: "btn", onclick: () => window.Shell.toggleLogDock(true) }, "在右侧面板打开"),
            h("button", { class: "btn", onclick: () => view.copy() }, "复制"),
            h("button", { class: "btn", onclick: () => api.logs.openDir() }, "打开日志文件夹"),
            h("button", { class: "btn ghost", onclick: () => view.clear() }, "清空"))),
        view.toolbar,
        view.list);
      window.Shell.onSettings((c, s) => { if ("logFontSize" in c) view.setFontSize(s.logFontSize); });

      let unseenErrors = 0;
      api.logs.onEntries((batch) => {
        if (window.Shell.current === "logs") return;
        unseenErrors += batch.filter((e) => e.level === "error").length;
        window.Shell.setBadge("logs", unseenErrors ? "!" : "");
      });
      this._clearBadge = () => { unseenErrors = 0; window.Shell.setBadge("logs", ""); };
    },
    onShow() { if (this._clearBadge) this._clearBadge(); },
  });
})();
