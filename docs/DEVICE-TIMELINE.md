# 本地工作流记忆（当前启用方案）

记录前台应用、窗口标题和画面文字，把连续活动按时间与共同关键词初步归为工作片段。
每个片段可展开核对原始 OCR 文字、来源、时间与代表截图，也可改名、拆分、合并。
归组使用本地规则；片段标题默认来自窗口标题，不推断任务已经完成。

## 采集规则

- 前台窗口或标题变化后，稳定 3 秒再采集；短暂切换取消等待。
- 持续使用时，每 15 秒检查前台窗口画面。画面变化才运行本地 Windows OCR；同一画面至少每 60 秒重新识别，补捉小幅文字变化。
- 使用 Windows 自带 OCR，本机已验证 en-US 和 zh-Hans-CN 语言包。中文引擎可识别混合英文；识别文字可能出现错字或标点变化。
- 连续相同的标题与文字合并为同一条证据，更新时间范围；新增内容保存文字增量。切换来源后保留活动顺序。
- 锁屏、休眠、闲置超过 5 分钟、关闭采集时跳过；窗口或设置在识别过程中变化时，丢弃该次结果。
- 游戏与全屏保护：跳过 DarkSoulsIII.exe、Steam 游戏目录内的程序、Windows 报告的 Direct3D 全屏/演示状态，以及无边框全屏窗口。离开游戏后缓冲 1 分钟再允许采集；暂停时释放 OCR 子进程。这些规则不保证识别所有游戏，未验证兼容前可保持全局关闭。
- 从显示器画面裁出前台窗口的可见区域；跨屏窗口选择可见面积最大的显示器，并按物理坐标和图像比例裁切。窗口标识仅用于内存中的匹配；持久化来源为应用可执行文件名及窗口标题。
- 默认排除 1Password、Bitwarden、KeePass 等应用，以及标题包含 InPrivate、Incognito、无痕、隐私浏览的窗口。可在界面修改应用和标题排除列表。标题规则只能匹配应用公开的标题，不保证识别所有私密窗口。

## 文字和图片分别管理

- 文字连续记录不受每天 20 张图片额度影响。每条 OCR 最多 6000 字符；当天文字日志最多 8 MB，总文字日志最多 100 MB。达到上限后停止新增文字，不删除原记录。
- 代表图片自动保存至少间隔 10 分钟，相似画面跳过；每天最多 20 张，主动记录同样计入上限。
- JPEG 最长边不超过 1600 像素，单张最多 200 KB；图片总量上限 200 MB。达到图片上限时继续记录文字。
- 日期按 Asia/Shanghai 划分；自动截图间隔跨午夜仍有效。
- 标题、文字、图片、编辑和补记均保存在本地。Windows OCR 在本机处理图片。识别使用的临时 PNG 在请求结束后清理，进程重启时清理中断遗留的 OCR 临时图。
- 旧版截图保留，可继续查看和补记。旧 ActivityWatch 采集保持停用，已有应用时间线文件保留。

## 使用

进入 WeFlow 左侧「聊天日记」，可查看监听/OCR 状态、日期、工作片段、文字搜索、代表图片与占用空间。
每次打开应用默认关闭采集，点击「开启本次采集」后才启动代理；「停止采集」会关闭代理及 OCR 子进程。
「采集设置」内可单独关闭工作流自动采集、编辑排除规则。
工作片段可保存标题、与上一片段合并；展开证据后可从任意中间证据拆开。
编辑只修改归组与标题，原始窗口标题和 OCR 文字仍保留。

「现在记一张」或开启采集后的 Ctrl + Alt + F8 可主动记录前台窗口；关闭采集时不占用该快捷键。
手动请求交给同一个代理串行处理，等待实际结果；也遵守暂停、应用排除与图片配额规则。

安装和启动应用不创建计划任务，也不会自动恢复上次的采集开关。应用退出后代理检查所属应用进程并退出；暂停开关由独立定时器检查，避免 OCR 队列阻塞停止。
关闭主窗口至托盘仍属于应用运行；从托盘退出应用会停止代理。原来的 WeFlow-LocalDeviceDiary 属于旧开发部署，现已停用，且已移除每 5 分钟的保活触发。
代理每秒检查采集状态，每 5 秒更新心跳；图片/OCR 请求串行执行，不堆积并发采集。
重新登录后的完整周期尚未实测；未登录、休眠或关机时不采集。

## 本地文件

```text
local-diary-archive/snapshots/
  settings.json                  全局开关、工作流开关、应用和标题排除列表
  agent-status.json              监听心跳、OCR 状态、最近上下文结果
  last-check.json                最近主动截图检查或启动信息
  context/YYYY-MM-DD.jsonl       文字证据及相同内容的连续观测
  context/YYYY-MM-DD.edits.json  自定义标题、拆分点、合并点
  YYYY-MM-DD/<uuid>.jpg          代表截图或旧截图
  YYYY-MM-DD/<uuid>.json         图片元数据、原因、补记、对比特征
  agent-runtime/                 Electron 运行数据与短暂的 OCR 临时文件
```

读取日志时忽略最后未写完的一行；代理启动写入前会清理未完成的尾行。
原始文字证据与用户编辑分别存储。OCR 的结果作为观察证据，不等同于任务结论。

## 启动、停止与开发

```powershell
# 构建代理，并复制 Windows OCR 辅助脚本
node scripts/build-snapshot-agent.cjs
# 应用内采集由按钮控制，以下仅为开发调试：
# 当前终端运行常驻监听（需自行明确开启本地 settings.json 中的 enabled）
./scripts/Capture-DeviceDiary.ps1 -Watch
# 单次自动截图检查（保留间隔、去重和配额）
./scripts/Capture-DeviceDiary.ps1
# 暂停采集并停止当前监听，保留设置与记录
./scripts/Stop-DeviceDiary.ps1
# 移除计划任务并停止当前监听
./scripts/Install-DeviceDiaryTask.ps1 -Remove
```

实现：workflowArchive.ts 负责文字去重、容量、归组和编辑；workflowSampling.ts 负责稳定窗口与采样间隔；
snapshot-foreground.ts 通过 koffi 读取前台窗口及来源；Read-WorkflowOcr.ps1 调用 Windows.Media.Ocr；
workflow-ocr.ts 管理隐藏的持久 OCR 子进程；capture-diary-snapshot.ts 串行处理采集与主动请求。
SnapshotPanel.tsx 和 WorkflowPanel.tsx 展示记录。代理位于忽略提交的 local-tools/diary-snapshot-agent.cjs。
安装包包含独立代理和 OCR 辅助脚本，通过同一个 GUI 可执行文件的代理入口启动，不再依赖启动 PowerShell 计划任务。
源码代理日志位于 logs/device-diary；归档目录由界面「打开归档目录」查看。旧计划任务安装脚本默认拒绝启用，只有显式指定 -EnableLegacyBackground 才允许开发部署。

测试：

```powershell
node --test tests/snapshots.test.mjs tests/workflow.test.mjs
node --test tests/workflowNative.test.mjs
node --test tests/snapshotAgent.test.mjs
node --test tests/workflowGameGuard.test.mjs
```

Windows OCR 测试仅识别生成的中文、英文和代码图样；窗口事件/并发请求测试关闭采样。

参考：[Windows OCR](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine)、[Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer/)。
