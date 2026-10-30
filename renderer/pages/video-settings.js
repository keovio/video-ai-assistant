"use strict";
// 设置分组：视频默认值（新建项目时用）。设置项已在 main.js 的 schema 里声明。
// 注意：本文件在 shell/pages/settings.js 之前加载，registerSettingsSection
// 要等外壳启动（onStart）时再注册，否则当时还不存在。
(function () {
  function register() {
    const { settingsUI } = window.Shell;
    const { row, select, range } = settingsUI;
    window.Shell.registerSettingsSection({
      id: "video",
      title: "视频",
      order: 15,
      tag: "M1",
      render(box) {
        box.append(
          row("画面比例", "新建项目的默认比例", select("videoAspect", [["9:16", "9:16 竖屏"], ["16:9", "16:9 横屏"], ["1:1", "1:1 方形"]])),
          row("新建项目镜头数", "新建项目时默认创建的空镜头数", range("videoDefaultShotCount", { min: 1, max: 12, step: 1, format: (v) => v + " 个" })),
          row("默认时长（参考）", "仅作新建时的参考值，实际时长按口播字数估算", range("videoDefaultDuration", { min: 10, max: 300, step: 5, format: (v) => v + " 秒" })));
      },
    });
  }
  if (typeof window.Shell.registerSettingsSection === "function") register();
  else window.Shell.onStart(register);
})();
