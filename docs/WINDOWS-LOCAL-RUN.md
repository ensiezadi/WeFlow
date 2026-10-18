# Windows 本地运行与构建

## 可运行版本

```powershell
npm ci
npm run build:win:local
node scripts/verify-windows-package.cjs
```

构建产物位于 `release-local`：

- `*-x64-Setup.exe`：安装包，版本带 `local` 标识。
- `win-unpacked/WeFlow.exe`：可直接运行的解包版，包含界面、采集代理、本地 OCR 辅助脚本及原生依赖。
- `build-info.json`：源码提交、构建时间、文件大小和 SHA256。

直接运行解包版或安装后的软件即可，`Start-WeFlow.cmd` 仅为可选快捷入口。所有版本统一将记录保存到应用用户数据目录的 `device-diary-archive`，与程序文件分开，重启和升级后仍能读取。
解包版首次启动会查找程序附近旧的 `local-diary-archive`，将记录复制到软件数据目录，保留原件；不会导入旧的采集启用状态、代理程序或心跳。迁入完成后不会再次用旧归档覆盖补记。
日记页默认显示最近有记录的一天，并提供历史日期和「导入已有记录」入口。安装到其他位置时，可在软件内选择原归档目录完成一次导入；同名且内容不同的记录会提示冲突并保留原件。
用户数据不包含在安装包或 Git 提交中。旧源码模式可使用 `npm run build:app` 后运行同一启动脚本。

本地版本关闭上游自动更新检查。应用每次启动默认关闭采集，需在日记页面点「开启本次采集」。
停止采集或退出应用会停止代理，代理也会检查所属应用进程是否存在。安装和启动应用均不创建计划任务。
游戏与全屏保护仍然生效；全屏弹窗问题尚未在游戏中完成因果复现，启用采集前可先确认游戏不受干扰。
此前已经创建的 `WeFlow-LocalDeviceDiary` 任务需要在 Windows 任务计划程序中单独禁用或移除，不会由新安装程序重新启用。

验证脚本检查安装包中界面、代理入口、OCR 辅助文件和隐私数据排除，并使用关闭采集的独立临时目录验证代理启动。
它不读取实时屏幕。正常使用仍需选择本机微信数据目录并完成配置。

## 微信数据目录

Windows 常见目录包括 `%USERPROFILE%\xwechat_files` 和 `%USERPROFILE%\Documents\xwechat_files`。
配置完成后可导出 JSON，并关闭媒体和头像导出。

## 原生组件日期修复

归档的 Windows x64 `wcdb_api.dll` 在 `InitProtection` 和 `wcdb_init` 中分别检查 2026 年 9 月 30 日的截止日期。
日期超过后可能返回 `-101` 或 `-1000`，发生在数据库密钥校验之前。
本地 Windows 构建会运行哈希校验后的日期修复，将两处截止日期延长至 2037 年 9 月 30 日；不修改系统日期或微信数据库。

该脚本只接受 SHA256 为 `6397760da70de8062829fbe6a2ec01cf0616d6f2b334e6fe54873898f38f7ad7` 的原始组件及其已知修复版本。
原件备份在忽略提交的 `logs/native-backups`，未知版本会拒绝修改。

```powershell
# 仅修复构建使用的源码资源
node scripts/repair-windows-wcdb-expiry.cjs --source-only
# 修复旧的 release/win-unpacked 目录中的组件
node scripts/repair-windows-wcdb-expiry.cjs --packaged-only
```
