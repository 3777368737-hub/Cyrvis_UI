# CYRVIS 语音架构（最终实现）

> 状态：Windows 旧链路于 2026-11-15 实测通过；2026-11-17 新增 macOS 连续 PCM 播放与默认外放保护，自动化验证通过，真实外放听感待复测。
>
> **macOS 更新（2026-11-17）**：下文 WAV 分段方案保留给 Windows/Linux；macOS 现在使用 `pcm-player.ts`，在同一个 AudioContext 时钟上连续调度 24 kHz PCM，首次缓冲约 120ms。保留所有待播样本，只有真正发生 underrun 才重新对齐时钟；不因队列超过几秒而丢弃/重叠播放。`response.done` 只表示生成结束，麦克风必须等最后一个音频源结束后再恢复。采集仍由独立隐藏窗口完成。
>
> **默认输出模式改为外放**：Mac 内置麦克风会收到扬声器声音，旧默认耳机模式在播放约 0.4 秒后误触发 barge-in，产生“没问题”→“没问”的自我转写循环。外放模式在播放及结束后 800ms 内丢弃麦克风输入；可用 Interrupt / Ctrl+Alt+X 中断。耳机用户可在右键菜单明确切换至耳机模式。输出设备跟随系统默认设备，不再尝试 Windows 专用的 Realtek 设备名。
>
> 验证：75 项单元测试（含外放回声不触发打断、完整播放尾部、长队列连续排程、取消、输出切换）；真实 Electron 静音 PCM 队列验证完整时长及旧播放器停止不会提前解锁新回复的麦克风。
> 目标：端到端实时语音对话 + 语音打断 + 语音控制 GUI Agent。
> 相关文档：[architecture.md](./architecture.md)（整体）、[roadmap.md](./roadmap.md)（后续）、
> [findings.md](./findings.md)（排障记录）、[archive/voice-implementation-v1.md](./archive/voice-implementation-v1.md)（历史清单）。

## 1. 结论先行

语音打断**不能在“同一个渲染进程里边播放边采集”**：在 Windows/Electron 下，Chrome 的 AEC 会把该渲染进程的麦克风采样归零（`avg=0`，轨道仍为 `live`）。
最终方案把**采集**和**播放**拆到两个渲染窗口：

- **隐藏采集窗口**：只 `getUserMedia`，不播放任何声音；
- **主窗口**：只负责 TTS 播放（WAV 分段）；
- **主进程**：接收采集 PCM，负责正常 ASR 转发 + 播报期间的打断检测。

拆分后播放期间采集电平正常（用户人声 3000–16726），打断日志实测 `barge-in avg=4110/4910`。

## 2. 拓扑

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ 主窗口 Renderer             │        │ 隐藏采集窗口 Renderer        │
│ - 语音条 UI                 │        │ - 仅 getUserMedia            │
│ - TTS 播放（WAV 分段）      │        │ - 不播放任何声音             │
│ - 不采集麦克风              │        │ - PCM → 本地 WebSocket       │
└──────────────┬──────────────┘        └──────────────┬───────────────┘
               │ IPC                                  │ ws://127.0.0.1:<port>/ws
               ▼                                      ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Electron Main                                                          │
│  VoiceService                                                          │
│   ├─ CaptureService：HTTP/WS + 隐藏窗口，PCM 回调                       │
│   ├─ 打断检测：能量阈值 1000 / 持续 150ms / 600ms 预录                  │
│   ├─ QwenOmniProvider：ASR + TTS + Function Calling + 本地 VAD          │
│   ├─ VoiceBrain：意图路由、主动播报、确定性暂停/取消                    │
│   └─ CyrvisController → ElectronGUIAdapter → UI-TARS GUIAgent           │
└───────────────────────────────────────────────────────────────────────┘
```

## 3. 采集链路

| 项 | 实现 |
|---|---|
| 容器 | `BrowserWindow({show:false, backgroundThrottling:false})` |
| 页面 | 主进程内置 HTTP 服务 `http://127.0.0.1:<随机端口>/capture` |
| 设备选择 | 先 `getUserMedia({audio:true})` 触发权限 → 枚举 → 选显式物理设备；**禁止** default/communications/ToDesk 虚拟麦 |
| 约束 | `echoCancellation:false`、`noiseSuppression:true`、`autoGainControl:true`、单声道 |
| 重采样 | 设备原生采样率 → 16 kHz（线性插值） |
| 分块 | 320 samples（20ms）Int16 → WebSocket 二进制 |
| 热插拔 | 主窗口监听 `devicechange`，800ms 防抖后调用 `cyrvis:voice:restart-capture` |
| 断连 | 采集 track `ended` → 上报 `capture-error`，语音条显示错误 |

关键文件：`apps/ui-tars/src/main/cyrvis/capture-service.ts`

## 4. 播放链路

| 项 | 实现 |
|---|---|
| 输入 | Qwen `response.audio.delta`（PCM16 / 24 kHz / 单声道） |
| 分段 | 每 0.75s（18000 samples）一个独立 **WAV Blob** |
| 播放 | 隐藏 `<audio>` 元素顺序播放，`ended` 后播下一段 |
| 输出 | 默认设备；可临时切到 Realtek 扬声器（见第 9 节） |
| 空闲 | 最后一段 `ended` → `notifyPlaybackIdle()` → 主进程开麦/结束打断窗口 |

为什么不用 Web Audio / MediaSource：两者都会触发 Chrome AEC 把采集归零；普通 WAV 文件（blob URL）不会。

关键文件：`apps/ui-tars/src/renderer/src/components/CyrvisVoice/wav-player.ts`（原 mp3-player，已重命名为 WAV 分段播放器）。

## 5. 打断链路

1. 主进程在 `onResponseStarted` 将 `assistantPlaybackActive = true`。
2. 采集 PCM 持续进入 `handleCapturePcm`：
   - 计算每 20ms 块的平均能量；
   - 维护最近 30 块（约 600ms）预录缓冲；
   - 播报中：能量 > **1000** 且持续 **150ms** → 触发；
   - 非播报：PCM 正常送 Provider（本地 VAD/ASR）。
3. 触发后：
   - `provider.bargeIn()`：`response.cancel` + 丢弃旧响应残留音频 + 清空输入缓冲 + 开麦；
   - 广播 `cyrvis:voice:response-stopped` → 主窗口停播；
   - 回灌预录 PCM 给 Provider，用户说的“停”不会被截掉；
   - `VoiceBrain` 收到转写后执行确定性控制。
4. 兜底：全局快捷键 `Ctrl+Alt+X` / 语音条 **Interrupt** 按钮。

关键阈值：

| 参数 | 值 | 说明 |
|---|---|---|
| 主 VAD 阈值 | 900 | AirPods 噪声底 700–900，人声 1700–4500 |
| 主 VAD 最短语音 | 300 ms | 过滤 20–160ms 噪声尖峰 |
| 端点静音 | 800 ms | 兼顾自然停顿与响应速度 |
| 打断阈值 | 1000 | 播报期间耳机漏音仅 0–10 |
| 打断持续 | 150 ms | 短促“停”也能触发 |
| 预录缓冲 | 600 ms | 保留句首 |
| 取消标志窗口 | 400 ms | 防止误杀打断后的新响应 |
| TTS 分段 | 750 ms | 听感已验证无明显卡顿 |

## 6. 对话与任务链路

```
用户语音
  → CaptureService PCM
  → QwenOmniProvider.sendAudio
  → 本地 VAD 提交（800ms 静音）
  → Qwen ASR / Function Calling
  → VoiceBrain.handleTranscript
      ├─ 唤醒/常开监听
      ├─ IntentGate：chat / task / control / ambiguous
      ├─ 确定性控制：停/取消/暂停 → Controller
      └─ start_gui_task → Controller → ElectronGUIAdapter → GUIAgent
  → Controller 事件 → ProactivityPolicy → Provider.speak
  → TTS → 主窗口 WAV 分段播放
```

确定性控制优先于模型工具调用，避免“模型说暂停了但 GUI 还在跑”。

## 7. 关键文件

| 文件 | 职责 |
|---|---|
| `main/cyrvis/capture-service.ts` | 隐藏采集窗口 + 本地 HTTP/WS + PCM 桥 |
| `main/cyrvis/voice-service.ts` | 单例服务、IPC、采集启动/热插拔、打断检测、快捷键 |
| `main/cyrvis/voice/qwen-omni.ts` | Qwen Realtime WebSocket、ASR/TTS/工具调用、本地 VAD、取消 |
| `main/cyrvis/voice-brain.ts` | 意图路由、唤醒、确定性控制、主动播报、完成声明拦截 |
| `main/cyrvis/controller.ts` | 单任务状态机、暂停/恢复/取消、事件总线 |
| `main/cyrvis/gui-adapter.ts` | 包装现有 `runAgent`/`GUIAgent`，映射任务状态 |
| `renderer/.../CyrvisVoice/useVoiceAudio.ts` | 语音条状态、播放器、外部采集状态 |
| `renderer/.../CyrvisVoice/wav-player.ts` | WAV 分段播放器 |

## 8. 排查入口

| 现象 | 看什么 |
|---|---|
| 没有语音输入 | `[cyrvis capture] ready/error`；设备是否被选为物理麦 |
| 播报中不能打断 | `[cyrvis capture] level` 播报时是否非 0；`barge-in` 是否出现 |
| 打断后没有新回复 | `transcript` 是否为空；`forceNextCommit` 是否生效 |
| TTS 无声 | `wav stream player created`、`wav player error`、`playback idle` |
| 任务停得慢 | `transcript` → `Request was aborted` / `user_stopped` 的时间差 |
| AirPods 断开 | `devicechange` → 自动 `restart-capture`；重新连上即可 |

## 9. 输出模式切换（耳机 / 外放）

语音条右侧有 **耳机 / 外放** 按钮，点击即可切换；外放模式自动半双工。

| 模式 | 输出 | 采集 | 语音打断 |
|---|---|---|---|
| 耳机 | AirPods / 默认耳机 | 无 AEC | **可用**（阈值 1000 / 150ms） |
| 外放 | 扬声器 / Realtek | AEC（尝试） | **不可用**，用 `Ctrl+Alt+X` / Interrupt |

外放模式是半双工：

- 播放期间**丢弃**采集 PCM；
- 播放结束后再丢弃 **800ms**，吸收房间混响；
- 避免“它听到自己的外放 → 一直你好”的反馈循环。

AEC 实测结论：隐藏采集窗口开启 `echoCancellation:true` 后，播放期间仍收到自己的外放（`barge-in avg=8640`）——因为该渲染进程没有主窗口播放的参考信号。因此外放模式保留 AEC 但**不启用语音打断**；要同时外放+语音打断，需要系统级回声参考/软件 AEC，或换带杆麦克风（见 roadmap/待验证方案）。

切回耳机模式后，语音打断立即恢复；两种模式可自由切换。

### 任意输出设备（调试）

需要指定 Realtek/NVIDIA/其他设备时，仍可用主进程广播的调试接口：

```js
// 切换输出并临时进入对应模式
await window.electron.voice.setOutput('扬声器 (Realtek');
await window.electron.voice.setOutput('F24G30Q Pro');
// 恢复默认输出（耳机）
await window.__cyrvisResetOutput();
```

主进程收到 `cyrvis:voice:set-output` 后广播，每个语音 Hook 枚举 `audiooutput`、匹配 label、调用 `HTMLMediaElement.setSinkId`；播放器每段音频都会重新应用 sink。设置只对当前会话有效，刷新/重启恢复默认。

## 10. 实测记录

| 时间 | 事件 | 值/结果 |
|---|---|---|
| 19:54:09 | 隐藏采集窗口就绪 | `label: 耳机 (cc ultimate) (Bluetooth)` |
| 19:54:22 | 播报中喊停 | `barge-in avg=4110`，立即 `playback idle` |
| 19:54:34 | 第二次打断 | `barge-in avg=4910`，转写“停呀。” |
| 19:56:54 | 取消任务语音 | 转写后 `cancel_gui_task`，任务在 19:58:32 以 `user_stopped` 结束 |
| 19:58:29 | 取消任务语音 | 转写“取消这个任务…”，GUI 请求在 19:58:32 被 abort |
| 播放期间 | 耳机漏音 | 采集电平 0–10，不误触发 |
| 用户说话 | 采集电平 | 3000–16726 |

## 11. 已知限制与后续

1. **任务停止延迟**：ASR 端点 + 转写约 1.5–2.5s；GUI 当前 VLM 请求需等 abort 生效，额外 1–3s。可考虑“播报中检测到打断即先暂停任务”，不必等转写。
2. **AirPods 自动断连**：Windows 蓝牙省电导致；已加 `devicechange` 自动重启采集，但仍建议 Demo 用 USB 耳机/有线麦。
3. **本地 WS 端口**：随机 127.0.0.1 端口；打包时需确认防火墙/端口策略。
4. **TTS 分段听感**：0.75s 已验证无明显卡顿；若换设备出现间隙，可增大到 1.5s。
5. **输出设备 UI**：已有“耳机/外放”按钮；更细的设备选择（显示器音箱等）仍可用调试函数。
6. **原生采集 sidecar**：若后续需要完全绕开 Chromium，可用 Python/PortAudio 或 Node 原生模块替换隐藏窗口采集。

### 待验证：外放 + 语音打断（游戏耳机 boom mic）

> 状态：2026-11-15 用户决定先搁置，记录方案，后续继续。

目标：用户戴耳机麦克风、声音从音箱外放给观众，同时保留“随时说停”的语音打断。

推荐路径（优先级从高到低）：

1. **换带杆游戏耳机麦克风**（boom mic，杆子伸到嘴边）：
   - 断开 AirPods，插 USB/3.5mm 游戏耳机；
   - 输出保持 Realtek 扬声器；
   - 测播放期间串音电平 vs 正常说“停”的电平；
   - 若人声明显高于串音，在外放模式重新启用语音打断，阈值取两者之间；
   - 需要给采集加“麦克风设备选择”（当前自动选第一个物理麦）。
2. **软件 AEC（用 TTS 做参考）**：主进程持有播放 PCM，与麦克风 PCM 做延迟对齐 + 自适应滤波；工程量大，不保证明天。
3. **兜底**：外放时用 `Ctrl+Alt+X` / Interrupt。

测试记录模板：

| 项 | 目标值 |
|---|---|
| 播放期间串音电平 | 越低越好 |
| 用户说“停”时的电平 | 明显高于串音 |
| 建议阈值 | 串音与人声之间，持续 150ms |
| 失败回退 | 外放半双工 + Ctrl+Alt+X |
