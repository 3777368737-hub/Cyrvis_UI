# CYRVIS 开发计划（当前阶段）

> 最后更新：2026-11-16
> 当前阶段：语音 Demo 已跑通，进入 **GUI 加速、UI、眼动、主动性/记忆** 并行开发。

## 文档索引

| 文档 | 内容 |
|---|---|
| [README.md](./README.md) | 文档总索引与代码地图 |
| [architecture.md](./architecture.md) | 整体框架与可行性分析 |
| [voice-architecture.md](./voice-architecture.md) | 当前语音实现（权威） |
| [roadmap.md](./roadmap.md) | 后续重点、模块边界、分支 ownership |
| [gui-acceleration-plan.md](./gui-acceleration-plan.md) | GUI 加速 benchmark：固定任务、指标、实验变量、ShowUI-2B 方案（不含 MCP） |
| [development.md](./development.md) | 环境、启动、测试、日志、密钥 |
| [progress.md](./progress.md) / [findings.md](./findings.md) | 实时进度与排障结论 |
| [archive/](./archive/) | 历史方案（product vision v1、voice plan v1） |

## 目标

在 UI-TARS Desktop 基座上构建 **Voice + Gaze + GUI Control** 桌面助手：
语音负责对话/决策，Controller 负责任务权威，GUI Agent 负责执行，眼动负责指代，主动性/记忆负责长期协作。

不重写 GUI Agent 基座；CYRVIS 作为外层交互协调层。

## 基座

- 仓库：`rain2create/CYRVIS`（基于 UI-TARS-desktop fork；GitHub 改名后旧地址会重定向）
- 本地：`CYRVIS/UI-TARS-desktop`
- 基线 commit：`3ac2cb8d946d78d5ff92ad17b318eaafa18c178c`（release 0.3.1）
- 组件：Electron `apps/ui-tars` + `packages/ui-tars/sdk`（GUIAgent）+ nut-js operator

## 已完成（P0–P2）

- [x] 基座启动、GUI VLM 配置、真实点击/输入；
- [x] Controller 单任务状态机、暂停/恢复/取消；
- [x] VoiceBrain 意图路由、唤醒、确定性控制；
- [x] Qwen Realtime 端到端语音、Function Calling、主动播报；
- [x] 语音打断（耳机模式）、双输出模式（耳机/外放）；
- [x] 采集/播放分进程、物理麦校验、断连恢复；
- [x] 57 个 CYRVIS 单测通过。

## 进行中/下一步（按 roadmap）

| 方向 | 下一步 | 分支 |
|---|---|---|
| GUI 加速 | 按 [gui-acceleration-plan.md](./gui-acceleration-plan.md) 跑固定任务 benchmark；先做 loop/截图历史/像素/ShowUI-2B，MCP 暂缓 | `feat/gui-accel` |
| UI 升级 | 工作台、任务时间线、设备选择、引导 | `feat/ui` |
| 眼动 | 校准、注视点、gaze+voice 融合 | `feat/gaze` |
| 主动性/记忆 | 记忆 schema、触发器、主动 check-in | `feat/proactivity` |

## 约束

1. 任务权威在 Controller；Voice/Gaze 只发结构化事件，不泄漏模型 SDK 类型。
2. 任何影响语音采集/播放/打断的改动，必须跑 `voice-architecture.md` 验收。
3. 共享类型 `types.ts` 只加不改语义；跨模块接口先对齐再实现。
4. 不提交密钥/日志/临时文件；提交前按 `development.md` 检查。

## 当前配置备忘

- 语音：Qwen3.8-Omni-Flash-Realtime（DashScope，本地 `.env`）。
- GUI VLM：火山方舟 Plan 接口 `https://ark.cn-beijing.volces.com/api/plan/v3`，模型 `doubao-seed-2.1-lite`。
- 外放模式：半双工，语音打断关闭，`Ctrl+Alt+X` 兜底；耳机模式语音打断可用。
- 换带杆游戏耳机 + 外放的“语音打断”方案已记录，待验证（见 voice-architecture.md）。
