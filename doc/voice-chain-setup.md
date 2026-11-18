# CYRVIS 级联语音与音色配置

本文说明 UI-tars `ASR + LLM + TTS` 语音链路迁移到 CYRVIS 后的配置方式，重点补充 CYRVIS 原项目没有的云端音色克隆流程。

## 1. 链路概览

```text
Renderer 麦克风采集
  -> RMS/VAD/打断检测
  -> 流式 ASR
  -> 文本 LLM + CYRVIS 工具调用
  -> Qwen/Breeze 流式 TTS
  -> Renderer AudioContext 播放
```

语音采集、VAD、打断和 TTS 播放均由主 Renderer 负责。主进程负责 ASR、LLM、TTS 会话管理和工具调用。

## 2. 推荐配置入口

启动应用后打开：

```text
Settings -> Voice Settings
```

可以配置：

- Conversation LLM 的 Base URL、API Key 和模型。
- ASR Provider、地址、API Key 和模型。
- TTS Provider（Qwen Cloud TTS 或 Local Breeze TTS）。
- 唤醒词、语言和端点静音时间。
- Qwen Voice ID、参考音频和克隆名称前缀。

修改 Provider、ASR 地址或模型后建议重启应用。

也可以参考 [apps/ui-tars/.env.example](../apps/ui-tars/.env.example) 使用环境变量。不要提交真实的 `.env` 文件。

## 3. 必需 API

### Conversation LLM

需要一个 OpenAI Chat Completions 兼容接口：

```env
CONVERSATION_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
CONVERSATION_API_KEY=YOUR_API_KEY
CONVERSATION_MODEL_NAME=qwen-plus
```

### 流式 ASR

默认使用 Qwen DashScope 流式识别：

```env
VOICE_STT_PROVIDER=qwen-dashscope-streaming
VOICE_STT_BASE_URL=wss://dashscope.aliyuncs.com/api-ws/v1/inference
VOICE_STT_API_KEY=YOUR_API_KEY
VOICE_STT_MODEL=qwen-audio-3.1-asr-flash-streaming
```

也支持 OpenAI-compatible ASR 和 Tenlai 异步 ASR。

### TTS

二选一：

- `qwen-tts-realtime`：云端 TTS，支持系统音色和音色克隆。
- `breeze-local`：本地 Breeze 运行，需要本地 runtime 和 GGUF 模型，不需要云端 TTS API Key。

## 4. Qwen 音色克隆操作

### 4.1 准备 API

在 DashScope / Model Studio 创建 API Key，并确认账号可以使用：

```text
qwen-audio-3.1-tts-flash
```

该模型支持 Voice ID 和音色克隆。系统音色模型 `qwen3-tts-flash-realtime` 不支持克隆音色。

### 4.2 准备参考音频

要求：

- WAV、MP3 或 M4A。
- 时长 5 到 60 秒。
- 文件不超过 10 MB。
- 单人、连续、清晰、低噪声语音。
- 推荐 10 到 20 秒。

示例路径：

```text
D:\voices\reference.wav
```

### 4.3 在设置中创建音色

1. 打开 `Settings -> Voice Settings`。
2. 在 TTS 路径中选择 `Qwen Cloud TTS`。
3. 填写 Qwen TTS API Key。
4. 将 Qwen TTS model 选择为 `qwen-audio-3.1-tts-flash`。
5. 填写参考音频路径。
6. 可选填写音色名称前缀，例如 `cyrvis`。
7. 点击 `Create Qwen voice`。
8. 等待状态变为可用，应用会保存返回的 Voice ID 和绑定模型。

首次克隆可能需要等待云端部署。后续会复用已保存的 Voice ID，不会每轮重新克隆。

### 4.4 使用已有 Voice ID

如果已经有 Qwen 克隆音色：

1. 选择 `qwen-audio-3.1-tts-flash`。
2. 将 Voice ID 填入 Qwen Voice ID。
3. 确认 Voice ID 的绑定模型与当前 TTS 模型一致。
4. 保存并重启应用。

如果 Voice ID 绑定了其他模型，应用会明确报错，不会静默切换成其他音色。

### 4.5 使用系统音色

不克隆音色时：

1. 选择 `qwen3-tts-flash-realtime`。
2. Voice 填写系统音色，例如 `Cherry`。

系统音色模式不支持参考音频克隆。

## 5. 本地 Breeze TTS

默认查找：

```text
.runtime/breeze-tts-2/runtime-v0.1.7/breeze-tts-2-v0.1.7-windows-x64-vulkan/breeze-server.exe
.runtime/breeze-tts-2/breeze-tts-2-q8_0.gguf
```

路径不同时可在设置里填写：

```env
BREEZE_TTS_RUNTIME_DIR=D:\path\to\breeze-runtime
BREEZE_TTS_MODEL_PATH=D:\path\to\breeze-tts-2-q8_0.gguf
```

本地 Breeze 不需要 TTS API Key。

## 6. 打断参数

当前默认对齐 UI-tars Renderer VAD：

- 使用原始麦克风采样计算 RMS。
- 初始噪声底 `0.006`。
- TTS 播放期间打断阈值 `0.055`。
- 连续 3 帧确认。
- 保留 8 帧打断预录音频。
- 打断后的新指令使用 400 ms 端点静音。

快捷键 `Ctrl+Alt+X` 和界面 Interrupt 按钮仍作为确定性兜底。

## 7. 安全要求

- 不要提交 `.env`、Electron Store、日志或包含 API Key 的配置备份。
- README、PR 描述和截图中不要出现真实 API Key、Voice ID 或参考音频路径。
- 如果 API Key 曾进入 Git 历史，应立即在服务商控制台撤销并重新生成。
