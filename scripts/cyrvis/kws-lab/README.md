# KWS / 打断实验台

## 1. 离线扫参

```bash
cd UI-TARS-desktop
node scripts/cyrvis/kws-lab/sweep-kws.cjs
# 或指定失败样本
node scripts/cyrvis/kws-lab/sweep-kws.cjs --files doc/kws-lab/failed-*.wav
```

扫描维度：

| 参数 | 当前值 |
|---|---|
| `keywordsThreshold` | 0.05 / 0.1 / 0.15 / 0.2 |
| `keywordsScore` | 1.0 |
| `numTrailingBlanks` | 0 / 1 / 2 |
| chunk | 1600 samples（100ms） |

输出 `doc/kws-lab/sweep-results.json`，每个命中带 KWS 时间、关键词和声纹分数，便于区分：

- KWS 没检出；
- KWS 检出但声纹拒绝；
- KWS + 声纹都通过。

也可以把 `doc/kws-lab/failed-*.wav` 作为输入，直接复现真实失败样本。

## 2. 失败样本自动落盘

App 的 `.env`：

```text
CYRVIS_KWS_DUMP_FAILURES=1
```

当 KWS 被声纹拒绝，或 300ms 能量兜底被拒绝时，会把最近 3 秒原始 PCM 写到 `doc/kws-lab/failed-*.wav`。每秒最多一个文件。

## 3. 蓝牙麦克风稳定性

先关闭 CYRVIS，运行：

```bash
python scripts/cyrvis/audio/record-long.py --seconds 600 --device "cc ultimate"
```

观察输出：

- `lag` 持续增长或 `GAP` 出现 → 麦克风/驱动/蓝牙问题；
- 只有 CYRVIS 断、录音机不断 → 再查隐藏采集窗和重复开流。

对照组合：

| 场景 | 目的 |
|---|---|
| Windows 录音机 / `record-long.py`，App 关闭 | 判断硬件/驱动 |
| CYRVIS 只采集、不播放 | 判断采集窗口 |
| CYRVIS 外放播放中采集 | 判断 A2DP/HFP 切换 |

## 4. App 内 A/B

| 模式 | 切换 | 日志 |
|---|---|---|
| 纯能量 1500/180ms | 默认由 `CYRVIS_EXTERNAL_ENERGY_BARGE` 决定；`Ctrl+Alt+E` 运行时切换 | `barge-in { mode: 'energy-only' }` |
| KWS + 声纹 | 同上关闭 | `kws detected → voiceprint gate → keyword barge-in` |

完整延迟看 `[cyrvis barge trace]`：

```text
onsetToDetect / detectToVerify / detectToBarge / bargeToStop /
onsetToStop / responseToStop / queuedMs
```
