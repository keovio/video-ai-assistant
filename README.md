# 视频 AI 助手（video-ai-assistant）

口播视频自动化：脚本加分镜、配音、画面、合成导出。基于 electron-app-template（Electron 44），本地运行，数据存在本机。

## 现在能做什么（M1，0.1.0）

- 项目管理：新建、打开、复制、删除项目；项目下挂一串镜头。
- 分镜编辑：编辑标题和标签；逐镜改口播、画面描述、生图提示词；增删镜头、上移/下移排序；显示每镜估算时长和项目预估总时长（约 4.5 字/秒）；保存后关闭重开，数据还在。
- 视频默认值设置：画面比例、新建镜头数、默认时长（设置页“视频”分组）。
- 模板自带：增量更新与坏版本回滚、设置与外观、后台任务、运行日志。

## 还没做（M2/M3/M4）

- M2：TTS 配音、按实际音频时长重排时间、单镜头试听。
- M3：AI 生图、ffmpeg 合成、字幕、导出 MP4。
- M4：渲染队列、按镜头重试、成本护栏、预览、辅助发布。
- 编辑页里的“生成配音 / 生成画面 / 合成导出”按钮目前是置灰的，不会假装能用。

## 本地运行

```sh
npm ci
npm test
npm start
```

打包（只生成目录版，不发完整安装包）：

```sh
npm run pack
```

冒烟测试（需要先打包）：

```sh
xvfb-run -a npm run smoke   # Linux 无桌面环境时
```

## 数据存在哪

设置与项目数据存在应用数据目录（`APP_DATA_DIR` 可覆盖）：

- `settings.json`：设置（含视频默认值）
- `data/video/projects.json`、`shots.json`、`assets.json`、`renders.json`：项目、镜头、资产记录、渲染记录
- 资产文件（以后）：`projects/<项目 id>/assets/`，记录里只存相对路径

## 开发说明

- 主进程：`main.js`，视频 IPC 在 `lib/video-ipc.js`，存储在 `lib/video-store.js`，纯数据模型在 `lib/video-model.js`。
- 页面：`renderer/pages/projects.js`（项目列表）、`renderer/pages/editor.js`（分镜编辑），沿用模板的 Shell 页面写法，不引入新框架。
- 检查与测试：`npm run check`（全部 JS 语法检查）、`npm test`（`node --test`）。
