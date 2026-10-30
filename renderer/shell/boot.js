"use strict";
// 所有页面脚本加载完后启动外壳
window.Shell.start().catch((err) => {
  window.Shell.reportError(err);
  document.getElementById("main").textContent = "界面启动失败：" + err.message;
});
