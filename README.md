<p align="center">
  <img src="app.jpg" alt="WeFlow 应用预览" width="90%">
</p>

<h1 align="center">WeFlow (本地 fork)</h1>

<p align="center">
  本仓库是 <a href="https://github.com/hicccc77/WeFlow">hicccc77/WeFlow</a> 的本地 fork，遵循上游 CC BY-NC-SA 4.0 协议。
  原作者：<a href="mailto:yccccccy@proton.me">yccccccy@proton.me</a>。
  上游仓库已被 DMCA 清空，本 fork 用于保留可构建的源码与本地定制修改。
</p>

> [!IMPORTANT]
> 本仓库是 <https://github.com/hicccc77/WeFlow> 的**公开归档 fork**。
> 用于保留可构建的源码与本地定制修改。Windows 本地版本可按下方命令构建，测试安装包通过本仓库的构建产物提供。
> 二改不应改动 `package.json` 中的 `name`、`author`、仓库地址等归属字段。
> 协议：CC BY-NC-SA 4.0（继承自上游）。

## 本 fork 与上游的差异

- **cache 目录 fallback 修复**：`ensureCacheDir` 在外置卷未挂载时不再崩溃，自动降级到 `app.getPath('userData')/cache`。
- **SnsService 缓存目录 fallback**：朋友圈/表情缓存目录同样在 `cachePath` 不可写时降级。
- **安全加固**：`uncaughtException` / `unhandledRejection` 全局兜底；release notes 不再用 `dangerouslySetInnerHTML` 渲染。
- **本地工作流日记**：前台窗口 OCR、文字证据与片段编辑；默认关闭、每次运行需手动开启，停止采集或退出应用后停止代理。游戏与全屏保护参见[说明](docs/DEVICE-TIMELINE.md)。
- **Windows 本地构建**：安装包包含采集代理和 OCR 辅助脚本，不依赖源码目录或后台计划任务。
- 后续本地修改会持续追加到本节。

## 原始功能（来自上游）

WeFlow 是一个**完全本地**的微信**实时**聊天记录查看、分析与导出工具。

- 本地实时查看聊天记录
- 朋友圈图片、视频、实况的预览和解密
- 统计分析与群聊画像
- 年度报告与可视化概览
- 导出聊天记录为 HTML 等格式
- HTTP API 接口（面向开发者）

## 构建

```bash
npm install      # 首次或依赖变化时
npm run build    # 清理 + tsc + vite + electron-builder
```

Windows x64 本地版本：

```bash
npm ci
npm run build:win:local
node scripts/verify-windows-package.cjs
```

- `release-local/*-x64-Setup.exe`：Windows 安装包，带 `local` 版本标识。
- `release-local/win-unpacked/WeFlow.exe`：无需安装，可直接运行。
- `release-local/build-info.json`：源码提交、构建时间和安装包 SHA256。
- 仓库根目录的 `Start-WeFlow.cmd` 优先打开此解包版，并使用已有的本地日记归档。

本地测试版本不会自动检查上游更新，也不会创建后台采集计划任务。
详见 [Windows 本地运行与构建](docs/WINDOWS-LOCAL-RUN.md)。

> 同步上游请用 `git remote add upstream <url>` 后 `git fetch upstream`。
> 上游 `hicccc77/WeFlow` 已被 DMCA 清空，无法再 fetch；本仓库为最后一版可构建源码。

## 致谢

- 上游（已 DMCA）：<https://github.com/hicccc77/WeFlow>
- 基础框架：[密语 CipherTalk](https://github.com/ILoveBingLu/miyu)
- 视频解密参考：[WeChat-Channels-Video-File-Decryption](https://github.com/Evil0ctal/WeChat-Channels-Video-File-Decryption)
