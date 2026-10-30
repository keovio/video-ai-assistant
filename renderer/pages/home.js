"use strict";
// 首页：新应用的入口说明，指向项目与分镜编辑。
(function () {
  const { h } = window.Shell;

  window.Shell.registerPage({
    id: "home",
    title: "首页",
    icon: "home",
    order: 5,
    render(root, ctx) {
      const { card, modules } = window.Shell;
      root.classList.add("page-wide");
      root.append(
        h("header", { class: "page-head" },
          h("div", {}, h("h1", {}, `欢迎使用 ${ctx.productName}`), h("p", { class: "sub" }, "口播视频自动化：先写好脚本和分镜，再配音、配画面、合成导出。"))),
        modules(
          card({ title: "开始", icon: "note" },
            h("p", {}, "M1 已有：项目与分镜的存储、编辑、保存与重开。配音（M2）、画面与合成导出（M3）还没做，编辑页里的对应按钮是置灰的。"),
            h("div", { class: "actions" },
              h("button", { class: "btn primary", onclick: () => window.Shell.navigate("projects") }, "去项目列表"),
              h("button", { class: "btn", onclick: () => {
                if (window.VideoApp.currentProjectId()) window.Shell.navigate("editor");
                else window.Shell.navigate("projects");
              } }, "打开分镜编辑"))),
          card({ title: "怎么做一条视频", icon: "star" },
            h("ol", { class: "steps" },
              h("li", {}, h("b", {}, "新建项目"), h("span", { class: "muted" }, " — 默认 6 个镜头，可增删")),
              h("li", {}, h("b", {}, "写分镜"), h("span", { class: "muted" }, " — 每镜写口播和画面描述，保存后重开还在")),
              h("li", {}, h("b", {}, "配音与画面"), h("span", { class: "muted" }, " — M2/M3")),
              h("li", {}, h("b", {}, "合成导出"), h("span", { class: "muted" }, " — M3，导出 MP4"))))));
    },
  });
})();
