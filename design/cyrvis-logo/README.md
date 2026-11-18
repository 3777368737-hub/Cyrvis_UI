# CYRVIS — 感知核心 / Perception Core

为 Jarvis 式 personal agent 设计的原创几何标志。开放的 C 形外轨道对应 CYRVIS；内轨道表达感知；中央菱形代表智能核心；向右的信号表达响应与执行。冰蓝与冷白强调清晰、冷静的科幻感。

## 文件

| 文件 | 用途 |
| --- | --- |
| `cyrvis-identity-board.png` / `.svg` | 完整视觉提案与应用预览 |
| `cyrvis-mark.svg` / `.png` | 透明底渐变主标志；PNG 为 1024 × 1024 |
| `cyrvis-app-icon.svg` / `.png` | 深空色圆角应用图标；PNG 为 1024 × 1024，外缘透明 |
| `cyrvis-lockup.svg` | 图形与 CYRVIS 字标的横版组合，适用于深色背景 |
| `cyrvis-mark-mono.svg` | 深色单色标志，适用于浅色背景 |
| `cyrvis-mark-white.svg` | 白色标志，适用于深色背景 |
| `cyrvis-mark-small.svg` | 小尺寸简化版，移除细内轨道 |
| `cyrvis-mark-{16,32,64,128,256}.png` | 按像素导出的透明图标 |

字标全部为矢量路径，不依赖安装字体。展示板中的说明文字使用系统字体，标语仅为展示文案。

## 使用建议

- 32 px 及以下优先使用简化版。
- 标志主要轮廓周围至少保留约外圈厚度的留白；导出画布已包含留白。
- 深色背景使用渐变或白色版；浅色背景使用深色单色版。
- 发光只用于展示板；正式标志不依赖发光效果。
- 色板：冷白 `#E9FDFF`、冰蓝 `#76E7FF`、电蓝 `#348BFA`、深空 `#080F1C`。

本次交付为独立设计资产，尚未替换应用当前引用的资源。

## 重新导出

在项目根目录运行：

```sh
node design/cyrvis-logo/build.mjs
```

使用项目现有的 `sharp` 将手绘 SVG 导出为 PNG，无图片生成 API 调用。
