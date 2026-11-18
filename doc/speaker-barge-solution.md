# CYRVIS 外放语音打断解决方案

> 2026-11-17。本文评估现有实现、外部开源方案，并给出可分阶段验收的工程方案。

## 1. 结论

当前外放打断失败的根因是**声学混合**，不是语音模型或阈值：

```text
麦克风 = 用户人声 + 助手外放回声 + 环境噪声
```

实测外放回声 3933–13183，用户人声 3000–4500，回声经常比人声还大。声纹干净自检 0.7446、TTS 原始音频 0.11–0.17，但播放中只有 0.02–0.30。**声纹不能分离混合信号，只能判断干净音频是谁。**

因此暂停继续调声纹/能量阈值，改为：

1. **AEC 回声消除**：先从混合音频中分离出近端人声；
2. **本地 KWS**：识别“停/停一下/别说了”；
3. **流式 ASR**：识别“直接说新任务”；
4. **Interrupt Controller**：统一控制 TTS、播放队列、GUI 任务和旧响应丢弃；
5. 声纹只作为 AEC 后的可选第二道门，不作为第一道门。

## 2. 对现有外部建议的评估

| 建议 | 评估 | 处理 |
|---|---|---|
| Windows 自带 AEC（IAcousticEchoCancellationControl） | 值得先检查，但蓝牙 HFP 麦克风通常不提供该控制；不能作为主方案 | 10 分钟探针验证 |
| XMic（WebRTC AEC3 + RNNoise，虚拟声卡） | 真实存在，适合**快速验证**；依赖 VB-CABLE，使用系统回环而非我们的 TTS 参考，不适合直接产品化 | 仅做设备组合验证 |
| pywebrtc-audio（WebRTC APM Python bindings） | 有 Windows x86_64 预编译 wheel，含 AEC3/NS/AGC/VAD，`stream_delay_ms` 可对齐；适合做本地 sidecar | **首选集成方案** |
| sherpa-onnx 中文 KWS | 已有 sherpa-onnx 环境；`sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01` 支持自定义关键词，160/320ms 分块 | **首选停词识别** |
| WASAPI Loopback 作为参考 | 可行，但会混入全部系统声音；我们已有实际 TTS 播放参考 PCM，更干净 | 暂不采用 |
| 声纹继续判混合音频 | 已实测失败 | 停止投入 |
| 只做 Ducking + ASR | 可作为兜底，但无 AEC 时 Ducking 触发本身会被回声污染 | 作为 AEC 后的软打断层 |
| 换带杆/指向性麦克风 | 最可靠的硬件方案 | 演示兜底 |

## 3. 目标行为

| 用户行为 | 系统动作 |
|---|---|
| “停” | KWS 高置信度 → 立即停止 TTS + 清空播放队列 + 取消旧响应 + 暂停 GUI 任务 |
| “停一下” | KWS → 停止 TTS + 暂停 GUI 任务（可恢复） |
| “赛维斯停止” / “别说了” | KWS 备用长口令，降低单字“停”漏检 |
| 直接说新任务 | ASR 转写 → 取消旧 TTS/旧回复 → 新任务交给 Controller |
| 环境噪声 / 助手回声 | AEC + VAD/声纹 → 忽略，继续播放 |

“停”和“新任务”必须是**不同策略**：

- “停”不等完整 ASR，KWS 直接触发硬打断；
- 新任务需要流式 ASR + 意图确认，先取消旧回复，再交给 GUI Agent。

## 4. 推荐架构

```text
                     ┌──────────────────────────────┐
TTS PCM（24k）───────┤ 参考重采样/时间戳/环形缓冲      │
                     └──────────────┬───────────────┘
                                    │ far-end
麦克风 PCM（16k）────────────────────┼───────────────┐
                                    ▼               │
                          ┌──────────────────┐       │
                          │ AEC sidecar      │       │
                          │ WebRTC AEC3      │       │
                          │ NS + AGC + VAD   │       │
                          └────────┬─────────┘       │
                                   │ near-end clean  │
                    ┌──────────────┼──────────────┐  │
                    ▼              ▼              ▼  │
              ┌──────────┐  ┌──────────┐  ┌──────────────┐
              │ 本地 KWS │  │ VAD      │  │ 流式 ASR     │
              │ 停/停一下│  │ 近端检测 │  │ 新任务/指令  │
              └────┬─────┘  └────┬─────┘  └──────┬───────┘
                   │             │               │
                   └─────────────┼───────────────┘
                                 ▼
                     ┌─────────────────────────┐
                     │ Interrupt Controller    │
                     │ turn_id / 软打断 / 硬打断│
                     └───────┬─────────┬───────┘
                             │         │
                    ┌────────▼───┐ ┌───▼────────────┐
                    │ TTS/播放器 │ │ GUI Controller │
                    │ 停止/清空  │ │ pause/cancel   │
                    └────────────┘ └────────────────┘
```

原则：

1. AEC 是核心，必须使用**实际播放的 TTS PCM**作为 far-end 参考；
2. KWS 与 ASR 并行，不串行等待；
3. 软打断只降低音量，硬打断才清空队列；
4. 所有取消都带 `turn_id`，旧 turn 的迟到音频/文本必须丢弃；
5. `Ctrl+Alt+X` 和界面按钮保留。

## 5. 音频链路细节

### 5.1 采样率与帧

- 麦克风：16kHz mono PCM16（现有隐藏采集窗口）；
- TTS：24kHz PCM16，重采样到 16kHz 作为 AEC far-end；
- AEC/NS/AGC/VAD：10ms 帧（160 samples @16k）；
- KWS：sherpa-onnx 流式模型，建议 16k，chunk 16/32（160/320ms）；
- ASR：16k PCM，复用 Qwen 流式 ASR 或独立 ASR 会话。

### 5.2 时间对齐

- 渲染端在**实际播放前**发送完整 TTS 参考 PCM + 计划开始时间；
- 主进程维护 far-end 环形缓冲；
- 用 pywebrtc-audio 的 `stream_delay_ms` 粗对齐，再用互相关在 ±300ms 内微调；
- 蓝牙时钟漂移：每 10–30s 重新估计延迟；必要时对 far-end 做微重采样；
- 任何时刻如果参考不可用，AEC 标记为不可信，KWS/ASR 不作为硬打断依据。

### 5.3 双讲（Double-talk）

目标不是“完全消掉 AI 声音”，而是用户和 AI 同时说话时，近端语音仍然可识别：

- AEC3 原生支持双讲检测；
- 双讲期间不要重置滤波器，不要清空近端缓冲；
- 软打断可将 TTS 音量降到 20–30%，但**不要暂停**，避免用户以为已经停止；
- 硬打断只在 KWS 高置信度或 ASR 明确任务时执行。

## 6. Interrupt Controller

### 6.1 状态

```text
idle
listening
assistant_speaking
soft_barge (ducked)
hard_barge_pending
cancelling
```

### 6.2 turn_id

每个助手回复分配 `turn_id`：

- TTS 音频块携带 `turn_id`；
- 播放器只接受当前 `turn_id` 的块；
- 取消时递增 `turn_id`，旧块直接丢弃；
- ASR/工具调用的迟到响应同样按 `turn_id` 丢弃。

### 6.3 软打断

触发条件：AEC 后 VAD 检测到近端语音概率高，且持续 150–250ms。

动作：

1. TTS gain 在 50ms 内降到 0.25；
2. 继续收集近端音频，交给 KWS/ASR；
3. 300–600ms 内确认：
   - KWS 命中 → 硬打断；
   - ASR 识别出新任务 → 硬打断 + 新任务；
   - 误触发 → gain 恢复到 1.0，继续播放。

### 6.4 硬打断

动作顺序：

1. 停止播放器并清空未播放队列；
2. `provider.cancelResponse()`，递增 `turn_id`；
3. `controller.pauseTask()`（“停”）或 `cancelTask()`（明确取消）；
4. 麦克风静音 900ms，等 TTS 尾音衰减；
5. 2s 内抑制模型确认语；
6. 广播 `response-stopped`，UI 状态同步。

## 7. 分阶段实施

### Phase 0：环境探针（0.5 天）

- 检查 Windows `IAcousticEchoCancellationControl` 是否对 `cc ultimate` 可用；
- 录制 3 组 WAV：AI 单独外放、用户单独说话、双讲；
- 作为后续 AEC 对比基线。

验收：有可重复的 near/far WAV 对。

### Phase 1：离线 AEC 验证（1 天）

- 安装 `pywebrtc-audio`，写离线脚本读取 near/far WAV；
- 用 `EchoCanceller`/`AudioProcessor` 处理；
- 对比处理前后：
  - 回声残留（ERLE）；
  - 双讲时用户语音可懂度；
  - 再用声纹/ASR 检查近端是否恢复。

验收：双讲场景 ERLE ≥ 10–15dB，用户语音可被 ASR 正确转写。

### Phase 2：实时 AEC sidecar（1–2 天）

- 本地 HTTP/WebSocket sidecar，接收 near/far 10ms 帧；
- 参考环形缓冲 + 延迟对齐；
- 输出 near-end clean PCM；
- 先不影响现有 KWS/ASR，只记录处理前后波形/指标。

验收：实时因子 > 20x，端到端额外延迟 < 50ms。

### Phase 3：KWS 停词（1 天）

- 下载 `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`；
- 关键词：`停`、`停一下`、`别说了`、`赛维斯停止`；
- 在 AEC 输出上跑 KWS；
- 调整阈值，统计漏检/误触发。

验收：安静/外放/双讲三种场景各 20–30 次，停词召回 ≥ 95%，误触发 ≤ 1 次/10 分钟。

### Phase 4：流式 ASR + 新任务（1–2 天）

- AEC 输出进入流式 ASR；
- 识别到任务意图 → Interrupt Controller 取消旧回复 → Controller 执行；
- 复用现有 VoiceBrain/IntentGate，不重建语音 Agent。

验收：新任务前 3 个字不丢，ASR 完整率 ≥ 90%。

### Phase 5：软打断与打磨（1 天）

- VAD → duck TTS；
- KWS/ASR 确认后硬打断；
- 误触发恢复音量；
- 全链路延迟/状态测试。

## 8. 测试矩阵与指标

每组 20–30 次：

| 场景 | 观察 |
|---|---|
| AI 单独外放 | 不应打断；AEC 后近端接近静音 |
| 外放中说“停” | 打断成功率、延迟 |
| 外放中说“停一下” | 暂停任务成功率 |
| 外放中说新任务 | ASR 完整率、任务启动 |
| 双讲（用户与 AI 同时说） | 用户语音可懂度、KWS/ASR 是否命中 |
| 环境噪声/键盘声 | 误触发率 |
| 蓝牙耳机 vs Realtek 输出 | 延迟漂移/卡顿 |

指标：

| 指标 | 目标 |
|---|---|
| “停”打断延迟 | < 500ms |
| 错误打断率 | ≤ 1 次/10 分钟 |
| 双讲 ERLE | ≥ 15dB |
| KWS 召回 | ≥ 95% |
| 新任务 ASR 完整率 | ≥ 90% |
| 旧 turn 音频泄漏 | 0 |

## 9. 风险与决策点

| 风险 | 说明 | 缓解 |
|---|---|---|
| 蓝牙时钟漂移 | 两个设备时钟不同步，AEC 延迟漂移 | 定期重估延迟/微重采样 |
| 蓝牙 HFP/A2DP | 麦克风与高质量输出共存可能降码率 | 外放用 Realtek；麦克风尽量 USB/有线 |
| Windows AEC 不可用 | 蓝牙麦通常不支持 IAcousticEchoCancellationControl | 用 pywebrtc-audio 软件 AEC |
| 双讲残留 | AEC 不能完全消除混响 | 声纹/ASR 第二道门；软打断 |
| 单字“停”太短 | KWS 可能漏检 | 备用长口令“赛维斯停止/停一下” |
| 虚拟声卡 | XMic 依赖 VB-CABLE，App 当前拒绝虚拟麦 | 仅用于验证，不用于生产 |

## 10. 现有代码可复用部分

| 模块 | 现状 | 方案中的角色 |
|---|---|---|
| 隐藏采集窗口 + 主窗口播放 | 已实现 | 保留，解决麦克风归零 |
| WebAudio 连续播放 | 已实现 | 保留；增加 duck gain |
| TTS 参考 PCM + 时间戳 | 已实现 | AEC far-end 输入 |
| VAD 400ms | 已实现 | 端点判断，不单独决定打断 |
| bare-stop 静音/暂停任务 | 已实现 | 硬打断最终动作 |
| 声纹 sidecar | 已验证干净音频 | AEC 后可选第二道门 |
| 单抽头回声减法 | 离线有效、在线不足 | 可保留为 AEC 失效时的降级 |
| GUI Action Batching 关闭/坐标修复 | 已完成 | 与本方案独立，不要回退 |

## 11. 最终建议

**短期验证顺序：**

1. Windows AEC 探针；
2. XMic / pywebrtc-audio 离线对比；
3. 确认 AEC 有效后，再接 KWS；
4. 最后接 ASR + Interrupt Controller。

**不建议：**

- 继续在混合音频上调声纹/能量阈值；
- 为了打断重写整个语音 Agent；
- 在没有 AEC 验证前直接大规模改播放/ASR 架构。

**演示兜底：**

- 外放 + `Ctrl+Alt+X` / 界面“打断”；
- 或换带杆/指向性麦克风；
- 耳机模式语音打断已可用。

## 12. 参考

- XMic: https://github.com/mengshouer/XMic
- pywebrtc-audio: https://github.com/strands-labs/pywebrtc-audio
- sherpa-onnx KWS: https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html
- sherpa-onnx KWS model: https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2
- Windows AEC control: https://learn.microsoft.com/windows/win32/api/audioclient/
- Hugging Face speech-to-speech: https://github.com/huggingface/speech-to-speech

## 13. Phase 1 实测补充（2026-11-17）

使用真实录音：

- 外放：Realtek `tts-probe.wav`（Qwen TTS，约 9s）；
- 麦克风：`cc ultimate`，44.1k 录制后转 16k；
- 参考：同一段 TTS 16k。

结果：

| 测试 | 结果 |
|---|---|
| 纯回声 AEC | ERLE **42.6dB**，AEC 后接近静音 |
| 用户单独说话 + 远端 TTS 活跃 | AEC 对人声衰减 **-8.2dB**（`EchoCanceller` 与 `AudioProcessor` 相同） |
| 双讲（回声+用户）声纹 | 混合 0.643 → AEC 后 0.344–0.419 |
| ASR：混合音频 | “你好，我叫徐世华，本科长春师范大学…” 基本可转写 |
| ASR：AEC 后 | “徐志华，我是武汉大学毕业…” 出现丢字/改词 |

结论：

1. AEC3 消回声有效，但默认的 near-end suppression/双讲处理会压人声；
2. 对语音识别来说，AEC 输出不一定优于原始混合音频；
3. 不能把“AEC 后直接接声纹/ASR”当成必然正确，需要：
   - 关闭/降低 NS、调整 AEC 双讲策略；
   - 或使用 **Soft barge：AEC 检测到近端后先压低 TTS，再对原始/混合音频做 ASR**；
   - 或对 AEC 输出与原始 near 做可调混合（保留人声，牺牲部分回声）。

因此 Phase 2 不应直接上线实时 AEC，而应先做 **AEC 参数/双讲对照实验**：

- AEC only、AEC+NS、AEC+NS+AGC；
- AEC 输出与 raw near 的混合比例 0/25/50/75%；
- 真实双讲录音（用户实际说“停”“新任务”），而不是合成叠加；
- 以 KWS/ASR 结果为准，不以声纹分数单独判定。

## 14. 真实双讲验证与方案修正（2026-11-17）

### 14.1 录音

- 时长 13.6s；TTS 远端参考约 1.2–9.4s；
- 麦克风：`cc ultimate`；外放：Realtek；
- 用户在实际播放中重复说了“停一下 / 别说了”。

### 14.2 KWS 结果（真实双讲）

| 输入 | 检测结果 |
|---|---|
| 原始麦克风混合信号 | 3.1s `别说了`；5.6s `停一下`；6.9s `别说了` |
| AEC3（far 前移 0ms） | 3.1s `别说了`；6.9s `别说了`；9.5s 尾部误报 `停` |
| AEC3（far 前移 200ms，ERLE 较好） | 6.9s `别说了`；9.5s 尾部误报 `停` |
| AEC3（far 延迟提示 300ms） | 无检测 |

结论：**本样本中，AEC3 输出反而不如原始混合信号**。AEC3 在 2.0–3.0s 把用户人声当成回声压掉了 33.6dB（该窗口原始声纹 0.594，AEC 后 0.114），这是典型的双讲近端抑制问题。

### 14.3 声纹门控（原始混合信号）

| 时间窗 | 内容 | 声纹分数 |
|---|---|---:|
| 1.2–2.0s | 基本只有 TTS 回声 | 0.131 |
| 2.0–3.0s | 用户说“别说了”前后 | 0.594 |
| 3.0–4.0s | 用户语音 + 回声 | 0.472 |
| 5.0–7.5s | 用户说“停一下/别说了” | 0.504 |
| 7.5–9.5s | 主要是 TTS 尾音 | 0.310 |

KWS 命中点附近取最近约 1s：
- 3.1s 命中：0.508；
- 5.6s 命中：0.394；
- 6.9s 命中：0.500。

因此当前实现采用：

```text
原始麦克风 PCM
  └─> 本地 KWS（停/停一下/别说了/赛维斯停止）
        └─> 声纹（最近 ~1s，阈值 0.35）
              ├─ 通过：立即硬打断
              └─ 不通过：视为助手自身 TTS 或他人，忽略并抑制旧能量路径 600ms
```

Node 侧验证：`sherpa-onnx-node` 的 ERes2Net 与 Python 分数一致，单次 embedding 15–44ms；KWS 3.3M 模型可在 Electron ABI 下加载。

### 14.4 架构修正

原方案把 AEC 放在 KWS 之前；真实数据表明这会伤害短停词识别。修正为：

1. **停词路径不经过 AEC**：KWS 直接吃原始麦克风信号，声纹只做“是不是用户”的第二道门；
2. **AEC 仅用于新任务 ASR**（Phase 4），并且必须先解决双讲近端抑制，不能默认上线；
3. **声纹使用 KWS 精确命中窗口**，不再对任意混合音频做声纹——这是此前 0.02–0.30 失败与现在 0.39–0.59 成功的关键差异；
4. 保留旧能量/相关性路径作为兜底，但 KWS 拒绝后 600ms 内不再让旧路径触发，避免“声纹说不是用户、能量却打断”的自相矛盾。

### 14.5 当前代码

- `apps/ui-tars/src/main/cyrvis/keyword-gate.ts`：KWS + 声纹门控；
- `apps/ui-tars/src/main/cyrvis/voice-service.ts`：播放中每 20ms 送入 KWS，命中后走统一 `triggerBargeIn`；
- `apps/ui-tars/resources/cyrvis/kws/keywords.txt`：停词表；
- 依赖：`sherpa-onnx-node@2.0.1`；
- 模型目录：`D:\Desktop\project\CYRVIS\models\kws\...`、`models\voiceprint\...`；
- 声纹 enrollment 现在同时写 `user_embedding.npy` 与 `user_embedding.f32`。

### 14.6 自回声拒绝验证

用 Windows SAPI（Huihui zh-CN）生成一段助手话术：

> “好的，已暂停当前任务，要停止吗？”

KWS 在 2.1s / 3.7s 两次命中 `停`；声纹分数分别为 **0.106 / 0.123**，均低于阈值 0.35，因此被拒绝，不会自打断。对应用户真实双讲命中窗口的分数是 **0.39–0.59**，可以被接受。

自动化测试：

```bash
cd apps/ui-tars
npx vitest run src/main/cyrvis/keyword-gate.test.ts
```

- `accepts the user stop words in speaker mode`：真实双讲 → 3 次触发、0 次拒绝；
- `rejects the assistant saying 暂停/停止 through the speaker path`：TTS 自回声 → 0 次触发、2 次拒绝。

这验证了“KWS 原始麦 + 声纹门控”在当前硬件/话术下的可行边界。

### 14.7 真机声纹分数与阈值修正（2026-11-17 11:27）

真机外放（Realtek + `cc ultimate`）在 11:27:45 首次拿到完整链路日志：

```text
[cyrvis kws] detected { keyword: '别说了', speakerMode: true, playing: true }
[cyrvis kws] voiceprint gate { score: 0.2696, threshold: 0.35, accepted: false }
```

离线同一句“别说了”在 3.0s 窗口是 0.562、6.9s 窗口是 0.409；真机只有 0.2696。差异来自：
- Chromium 采集默认开了 `noiseSuppression: true` + `autoGainControl: true`；
- 真机 1s 窗口里助手外放回声占比更高。

修正：
1. 隐藏采集窗关闭 Chromium NS/AGC，保留原始 PCM；
2. 多字停词阈值 0.20，单字“停”0.25，声纹默认 0.22；
3. 新增 300ms 能量 + 声纹快速兜底（阈值 0.22），用于 KWS 漏掉单字“停”；
4. KWS 可用时禁用旧 `direct interrupt` 路径（实测最慢 13s）。

11:31:20 能量兜底在助手自身外放上得分 0.0681，被正确拒绝，说明该兜底不会自打断。

### 14.8 真机外放打断成功（2026-11-17 11:34）

同一轮长诗播报中：

```text
11:34:24.009  detected '别说了'  score 0.0611  threshold 0.20  accepted false
11:34:26.288  detected '别说了'  score 0.2931  threshold 0.20  accepted true
11:34:26.312  keyword barge-in
```

第二次命中到执行打断 **24ms**。第一次分数 0.0611 更像助手 TTS 回声或用户刚开口的碎片，因此拒绝；用户重复一次后通过。旧阈值 0.35 会把第二次 0.2931 也拒掉，这是此前“听到了但不停”的直接原因。

当前真机结论：
- 多字停词（别说了/停一下）已验证可打断；
- 单字“停”由 KWS 0.1 阈值 + 300ms 能量/声纹兜底覆盖，待单独复测；
- 唤醒词被误判为回声的问题已修（Hello/service/savage 不再被丢）。

### 14.9 A/B 实测结论：外放不能走纯能量（2026-11-17 11:55）

外放模式 + `Ctrl+Alt+E` 开启纯能量后，助手刚开始说 “Hello” 就被连续自打断：

```text
11:55:28.666  barge-in { avg: 2693, mode: 'energy-only' }
11:55:37.616  barge-in { avg: 4310, mode: 'energy-only' }
11:55:47.356  barge-in { avg: 1956, mode: 'energy-only' }
```

这些能量全部来自 Realtek 外放回声，不是用户人声。结论：11:00 “好用”的时期是 **耳机语音模式 + Realtek 输出**（回声小），不是真正 speaker 模式；真正外放必须用 KWS + 声纹或能量+声纹。

默认已改为 `CYRVIS_EXTERNAL_ENERGY_BARGE=0`；`Ctrl+Alt+E` 仍可用于现场复现对比。

## 15. 双级打断与完整延迟测量（2026-11-17 13:10）

### 15.1 强/弱关键词

| 类型 | 关键词 | 策略 |
|---|---|---|
| 强 | 赛维斯停止 / 停一下 / 停一停 / 别说了 / 不要说了 | KWS 命中直接打断；仅当助手当前 TTS 文本也含停词时要求声纹 |
| 弱 | 停 / 停下 / 停住 / 停啊 / 停了 | KWS + 声纹；TTS 文本含停词时阈值 0.25，否则 0.10 |

强关键词的自回声测试：Huihui TTS “好的，别说了，我马上停止” 会命中强词，但 `ttsContainsStop=true` 时仍走声纹并被拒绝。

### 15.2 完整延迟 trace

主进程记录：
`speechOnsetAt → detectedAt → verifiedAt → bargeAt`；渲染端在 `response-stopped` 停止 WebAudio 后回传 `queuedMs` 和 `stoppedAt`。

日志字段：

```text
[cyrvis barge trace] {
  keyword, score, accepted,
  onsetToDetect, detectToVerify, detectToBarge,
  bargeToStop, onsetToStop, responseToStop, queuedMs
}
```

注意：`speechOnsetAt` 用 1800 能量阈值近似，可能包含回声起点；后续可换本地 VAD。

### 15.3 失败样本落盘

`CYRVIS_KWS_DUMP_FAILURES=1` 时，KWS 被声纹拒绝或能量兜底被拒绝，会把最近 3 秒原始 PCM 写到 `doc/kws-lab/failed-*.wav`，用于离线扫参。

### 15.4 暂缓

- Soft barge（12–18dB 快速 duck）留到 trace 数据出来后做，避免盲目改播放链路；
- AEC3 与声纹阈值继续暂停；
- P0 蓝牙稳定性由 Windows 录音机对照测试先定位。

### 15.5 基线扫参结果（2026-11-17 13:16）

`node scripts/cyrvis/kws-lab/sweep-kws.cjs`：

| 文件 | threshold | blanks | 命中 |
|---|---:|---:|---|
| 真实双讲 | 0.05–0.10 | 0–1 | 3.1s 别说了 (0.527)、5.3s 停 (0.350)、6.9s 别说了 (0.450) |
| 真实双讲 | 0.15 | 0–1 | 5.3s 变 5.6s 停下 (0.435) |
| 真实双讲 | 0.20 | 0–1 | 丢掉 5.3–5.6s 的“停/停下” |
| TTS “已暂停/要停止吗” | 任意 | 任意 | 仅 2.1s/3.7s “停”，声纹 0.095/0.131 |
| TTS “别说了，我马上停止” | 任意 | 0–1 | 2.1s 别说了 (0.039)、3.7s 停 (0.117) |

结论：
- `keywordsThreshold=0.1`、`numTrailingBlanks=1` 是当前召回/延迟的平衡点；
- `blanks=2` 会把 3.1s 命中推迟到 3.4s，并丢掉弱“停”；
- 强词 TTS 自回声声纹只有 0.039/0.117，`ttsContainsStop` 门控可以安全拦截。

## 16. 相对声纹：外放“任意说话即打断”（2026-11-18）

绝对声纹分数在真机上有重叠（用户 0.0678–0.2725，TTS 回声 0.0265–0.0754）。改为同时比较：

```text
candidate = 最近 1s 麦克风混合音频的 embedding
userScore = cosine(candidate, enrolled user)
ttsScore  = cosine(candidate, 当前对齐的 TTS 播放参考)
margin    = userScore - ttsScore
```

离线双讲样本：

| 片段 | userScore | ttsScore | margin |
|---|---:|---:|---:|
| TTS-only 1.2–2.0s | 0.131 | 0.216 | -0.085 |
| 用户 2.0–3.0s | 0.594 | 0.013 | +0.581 |
| 用户 3.0–4.0s | 0.472 | -0.006 | +0.479 |
| 用户 5.0–7.5s | 0.504 | 0.305 | +0.199 |
| TTS 尾音 7.5–9.5s | 0.310 | 0.437 | -0.127 |

实现：
- `SpeakerEchoDetector.analyze` 返回对齐的 playback reference；
- 主进程维护 `referencePreroll`（约 1s）；
- 能量兜底改为 200ms / avg 1200；`margin > 0.05 && userScore > 0.04` 即打断；
- KWS 命中时也用相对声纹复核（TTS 文本含停词时）。

这使外放模式接近耳机模式的“正常说话就打断”，但用 TTS 参考而不是纯能量区分回声。

### 16.1 长回复参考失效与修复（2026-11-18 00:26）

真机长回复里 `relativeAvailable` 长期为 `false`，相对声纹整段失效。两个叠加原因：

1. 渲染端 `WebAudioStreamPlayer.pump()` 把当时全部待播 PCM 拼成**一个** `AudioBuffer`，整段只上报一次 `onSegmentStart(startedAt)`。`SpeakerEchoDetector.prune()` 以段开始时间计龄，`MAX_REFERENCE_AGE_MS=5s`，播放超过 5s 后唯一参考段被删除，之后 `reference=null`。
2. 改为 1s 分块后仍有第二层问题：队列会把几十秒的块**一次性**排到未来，每次 `addReference()` 如果用最新（未来）块的 `startedAt` 做 prune，会立刻删掉正在播放的近端参考。

修复：

| 位置 | 修改 |
|---|---|
| `webaudio-player.ts` | 待播 PCM 按 1s 分块调度，每块独立 `startedAt` / `onSegmentStart`，参考在整个长回复期间保持对齐 |
| `speaker-barge.ts` | `addReference()` 用最近一次 `analyze()` 的采集时钟 prune，保留未来已排队段；`analyze()` 跳过尚未开始的段，只淘汰播放超过 5s 的参考 |
| `speaker-barge.test.ts` | 新增“长回复排队时保留近端参考”用例 |

验证：`typecheck:node` / `typecheck:web` 通过，cyrvis 单测 79/79 通过（speaker-barge 6/6）。真机外放“任意说话”复测待执行。
