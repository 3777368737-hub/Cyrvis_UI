# 2026-11-19 最新版眼动整合

基线：origin/main 的 d919f5f8（2026-11-19 12:19:22 +0800）。
整合分支：codex/gaze-integration-20261119。
原本地眼动版本已保存于 codex/eye-tracking-exploration 的 a7b701e5，方便回溯。

## 保留的新版本功能

- 新版工作台、桌面伴侣和 VoiceRuntime，不重新挂载旧语音条。
- 快捷工具、统一导航、动态工具发现、长期记忆、外放打断和播放状态处理。
- 实时语音及 ASR→LLM→TTS 级联语音；眼动问题的确定性路由返回 consumed=true，避免级联重复调用或重复回答。

## 眼动功能

- 主工作台右上角“眼动”→“快速体验AI看屏”，九点自动采样后直接开始演示。
- 完整校准、独立偏移补偿、验证误差及自适应平滑继续保留。
- 独立透明桌面光标可用于桌面及其他应用，支持校准过的主屏幕。
- 隐藏工作台后看向目标，按 Cmd/Ctrl+Alt+I；语音唤醒后也可说“我在看什么”。
- 截取注视区域，使用 Settings 中配置的视觉模型读取内容，并支持语音回答。
- 摄像头在本地处理，只有显式提问才发送区域截图；关闭 AI 看屏会取消请求并清空预览。
- “停止任务”仅停止桌面操作，不停止眼动；任务小窗和桌面伴侣窗口不持有眼动组件。
- 缩放/恢复工作台不会结束已经进入追踪状态的摄像头。校准阶段改变窗口尺寸仍需重做校准。

## 兼容处理

- 保留旧本机 QWEN_ENDPOINT 配置作为新版 QWEN_REALTIME_URL 的后备，不修改本机密钥。
- 现有 Token Plan 实时语音端点使用平铺 PCM 初始会话格式，之后仍沿用新版局部 context/tools 更新。
- 修复开发者扩展安装器 CJS/ESM 导出兼容。
- 路径策略将允许根目录与目标路径同时 canonicalize，修复 Mac /var 与 /private/var 指向同一临时目录却被误判的问题；敏感目录与敏感文件规则保留。
- 回归测试的临时路径使用真实路径；Windows 专用 app.close 能力测试在 Mac 上明确跳过；旧搜索测试按新版 Google 默认值更新。

## 验证与启动

在仓库根目录运行：

```sh
./start-cyrvis.command
```

该脚本使用此工作区已有的 .runtime Node/pnpm。自行部署时按仓库文档安装依赖，并配置自己的语音与视觉模型。

验证命令：

```sh
pnpm exec vitest run --workspace vitest.cyrvis.workspace.ts
pnpm --filter ui-tars-desktop exec tsc --noEmit -p tsconfig.node.json --composite false
pnpm --filter ui-tars-desktop exec tsc --noEmit -p tsconfig.web.json --composite false
pnpm --filter ui-tars-desktop build:dist
```

当前合并回归：250 项通过，7 项明确跳过（含 Windows 专用及原有可选测试）；前后端类型检查与发行构建通过。
系统状态测试读取 os.uptime 等本机信息，受限制的沙箱可能返回 EPERM；应在普通本机开发权限下执行。
新增覆盖包括：主窗口/任务小窗/桌面伴侣的摄像头所有权隔离、停止任务后继续看屏、级联 consumed 返回值、Token Plan 初始格式及看屏工具暴露。

自动化测试不代表摄像头眼动精度已达标；实际注视位置和麦克风交互仍需真人体验。整合本身没有改为每步 GUI 裁剪或实现新的推理加速方案。
