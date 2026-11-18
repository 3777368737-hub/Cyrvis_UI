# CYRVIS 本地停词模型

外放模式下的“停 / 停一下 / 别说了 / 赛维斯停止”由本地 sherpa-onnx KWS 识别，不经过云端 ASR。

## 1. 模型

```text
models/kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/
```

下载：

```bash
mkdir -p models/kws
curl -L -o models/kws/kws.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2
tar -xjf models/kws/kws.tar.bz2 -C models/kws
```

应用默认使用 `encoder/decoder/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx`。

## 2. 停词表

应用读取 `apps/ui-tars/resources/cyrvis/kws/keywords.txt`。格式是拼音 token + `@中文标签`：

```text
t íng @停
t íng y ī x i à @停一下
b ié sh uō l e @别说了
```

新增词时，token 必须存在于模型的 `tokens.txt` 中。

## 3. 声纹

```text
models/voiceprint/3dspeaker_eres2net_base.onnx
models/voiceprint/user_embedding.f32
```

录入：

```bash
# 1) 启动 sidecar
powershell -ExecutionPolicy Bypass -File scripts/cyrvis/voiceprint-server/run-voiceprint.ps1

# 2) 录 8 秒干净人声并自动 POST /enroll（脚本会写 enroll.wav 并注册）
python scripts/cyrvis/voiceprint-server/record_voiceprint.py

# 可选：注册后立刻验证
python scripts/cyrvis/voiceprint-server/record_voiceprint.py --verify
```

`/enroll` 会写 `user_embedding.npy`（Python）和 `user_embedding.f32`（Electron 直接读取）。

## 4. 调参

| 变量 | 默认 | 说明 |
|---|---:|---|
| `CYRVIS_KWS_VOICEPRINT_THRESHOLD` | 0.35 | 外放混合音频的声纹阈值；过高会漏“停”，过低会误收助手 TTS |
| `CYRVIS_KWS_COOLDOWN_MS` | 800 | 同一句话内重复命中的抑制窗口 |
| `CYRVIS_KWS_MODEL_DIR` | 自动查找 | KWS 模型目录 |
| `CYRVIS_KWS_KEYWORDS` | 应用 resources | 停词表路径 |
| `CYRVIS_VOICEPRINT_MODEL` | 自动查找 | ERes2Net ONNX |
| `CYRVIS_VOICEPRINT_EMBEDDING` | 自动查找 | `user_embedding.f32` |

## 5. 验证

```bash
cd apps/ui-tars
npx vitest run src/main/cyrvis/keyword-gate.test.ts
```

测试会用真实双讲录音 `models/voiceprint/doubletalk.wav` 走完整的 KWS + 声纹门控，验证三个停词都能触发。模型或录音缺失时测试自动跳过。
