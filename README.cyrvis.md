# CYRVIS

**Voice-first desktop agent built on UI-TARS.**

CYRVIS 在 UI-TARS Desktop 之上增加语音大脑与控制器，让用户通过自然语音与桌面 GUI Agent 协作。目标形态：

```
Voice Agent (Qwen Realtime) ↔ VoiceBrain ↔ CyrvisController ↔ ElectronGUIAdapter ↔ UI-TARS GUIAgent
                                      ↑
                              Gaze / Proactivity / Memory（规划中）
```

## 当前能力

- **端到端实时语音**：Qwen3.8-Omni-Flash-Realtime，WebSocket，非 ASR→LLM→TTS 级联；
- **语音大脑**：区分聊天与 GUI 任务，只有明确任务才调用 `start_gui_task`；
- **语音打断**：播报中直接说“停 / 停一下 / 别说了 / 赛维斯停止”即可打断；外放模式用本地 KWS + 声纹门控过滤助手自身回声；
- **双输出模式**：耳机（耳机麦 + 耳机扬声器）/ 外放（耳机麦 + 主机扬声器）；`Ctrl+Alt+X` 始终可用；
- **GUI 任务**：Controller 单任务状态机、暂停/恢复/取消、stall 监测；
- **主动性基础**：任务开始/完成/失败/取消的语音反馈；
- **可靠性细节**：物理麦克风校验、虚拟麦禁用、断连自动恢复、单实例、关闭到托盘。

> 语音实现（采集/播放分进程、打断阈值、双模式）见
> [doc/voice-architecture.md](./doc/voice-architecture.md)。

## 快速开始

```bash
# 1. 安装
PUPPETEER_SKIP_DOWNLOAD=1 pnpm install

# 2. 配置语音 Key（不要提交）
cp apps/ui-tars/.env.example apps/ui-tars/.env
# 编辑 apps/ui-tars/.env，填入 QWEN_API_KEY

# 3. 启动
pnpm run dev:ui-tars
# Windows 也可运行 scripts/cyrvis/start-dev.cmd
```

首次启动：

1. 允许麦克风权限；
2. 在设置页配置 GUI VLM（火山方舟 Doubao / UI-TARS 等）；
3. 确认 Windows 默认输入是物理麦克风（应用会拒绝 ToDesk 虚拟麦）。

### 本地停词与声纹（外放打断）

外放时的“停”不依赖云端 ASR，使用本地 sherpa-onnx：

```text
models/kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/
models/voiceprint/3dspeaker_eres2net_base.onnx
models/voiceprint/user_embedding.f32
```

- KWS 模型：`scripts/cyrvis/kws/README.md`；
- 声纹录入：运行 `scripts/cyrvis/voiceprint-server/record_voiceprint.py`，再启动 sidecar 并 `POST /enroll`；enrollment 会同时写 `.npy` 和 Node 使用的 `.f32`；
- 默认路径从 `apps/ui-tars` 向上查找 `models/`；可用 `.env` 中的 `CYRVIS_KWS_MODEL_DIR`、`CYRVIS_VOICEPRINT_MODEL`、`CYRVIS_VOICEPRINT_EMBEDDING` 覆盖；
- 阈值默认 `0.35`（混合音频），用 `CYRVIS_KWS_VOICEPRINT_THRESHOLD` 调整；
- 依赖 `sherpa-onnx-node@2.0.1`，已加入 `apps/ui-tars/package.json`。

VLM 接口类型容易混淆：

- 普通按量：`https://ark.cn-beijing.volces.com/api/v3`
- Coding/Agent Plan：`https://ark.cn-beijing.volces.com/api/plan/v3`
- 用错会 401；账户欠费会 403。详见 [doc/development.md](./doc/development.md)。

## 文档

| 文档                                                     | 内容                                |
| -------------------------------------------------------- | ----------------------------------- |
| [doc/README.md](./doc/README.md)                         | 文档索引与代码地图                  |
| [doc/architecture.md](./doc/architecture.md)             | 整体分层、状态机、接口              |
| [doc/voice-architecture.md](./doc/voice-architecture.md) | 语音实现权威说明                    |
| [doc/roadmap.md](./doc/roadmap.md)                       | GUI 加速/MCP、UI、眼动、主动性/记忆 |
| [doc/development.md](./doc/development.md)               | 环境、启动、测试、日志、故障        |
| [doc/progress.md](./doc/progress.md)                     | 实时进度                            |
| [doc/findings.md](./doc/findings.md)                     | 排障结论                            |

## 目录

```
apps/ui-tars/src/main/cyrvis/       # Controller、VoiceBrain、Voice、Capture
apps/ui-tars/src/main/cyrvis/voice/  # Qwen Realtime Provider
apps/ui-tars/src/renderer/src/components/CyrvisVoice/
doc/                                 # CYRVIS 文档（docs/ 是上游 UI-TARS 文档）
scripts/cyrvis/                      # 启动脚本
```

后续模块规划：`main/cyrvis/gui/`（Task Router + MCP + 加速）、`gaze/`、`proactivity/`、`memory/`。

## 分支协作

- `feat/gui-accel`：GUI 加速、Action Batching、模型路由；
- `feat/mcp-tools`：MCP client、工具权限、简单任务直连；
- `feat/ui`：工作台、任务时间线、设备选择；
- `feat/gaze`：眼动校准与 gaze/voice 融合；
- `feat/proactivity`：记忆、主动问询、反馈；
- `feat/voice`：语音链路、打断、采集/播放。

模块边界与共享文件规则见 [doc/roadmap.md](./doc/roadmap.md)。

## 安全

- 严禁提交 `.env`、日志、electron-store、真实 API Key/Token；
- 日志可能包含模型配置，**不要提交 `*.log`**；
- 提交前按 [doc/development.md](./doc/development.md) 第 9 节检查。

## 上游与许可

基于 [UI-TARS Desktop](https://github.com/bytedance/UI-TARS-desktop)（Apache-2.0）。
本仓库保留上游 LICENSE 与版权声明；CYRVIS 新增代码同样遵循 Apache-2.0。
