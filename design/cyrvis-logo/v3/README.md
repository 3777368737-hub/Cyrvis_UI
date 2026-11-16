# CYRVIS · Segmented C

根据参考图的蓝色圆形底、分段白色符号、圆角和负空间重设计。保留 C 形识别，拆成上、左、下三块弧片；共用圆心与内外半径，分割处留出 12° 空隙。

层次来自三块不同明度、统一方向渐变和 6/512 高度的下沿暗边。图形本身没有相互覆盖，留白保持清晰。

## 交付

- `cyrvis-badge.svg` / `.png`：蓝色圆底、冷白三段 C；最接近参考图的构成。
- `cyrvis-mark.svg` / `.png`：透明底、蓝色分层 C，适合浅背景。
- `cyrvis-mark-mono.svg` / `cyrvis-mark-white.svg`：无渐变和厚度的单色版。
- `cyrvis-app-icon.svg` / `.png`：圆角方形应用图标设计；已转换为应用资源中的 ICNS/ICO。
- `cyrvis-lockup.svg`：蓝色符号加深色字标。
- `cyrvis-mark-{16,32,64,128,256}.png`：对应尺寸。16px 使用单色版，保证分割缝清楚。
- `cyrvis-identity-board.svg` / `.png`：设计总览和缩放示意。

主要 PNG 为 1024 × 1024，总览为 1600 × 1120。字标复用 v2 已转路径的轮廓，无运行时字体依赖。

重建：在仓库根目录运行 `node design/cyrvis-logo/v3/build.mjs`，使用现有 sharp。

v3 已用于当前 Cyrvis 桌面应用，v1/v2 作为历史设计保留。

同步应用资源：在仓库根目录运行 `node scripts/cyrvis/sync-logo.mjs`。此命令生成
`apps/ui-tars/resources/` 中的界面 Logo、深色背景字标、favicon、macOS 托盘模板和
PNG/ICNS/ICO 应用图标。深色背景字标仅将 v3 字标颜色改为白色，图形保持原样。
修改设计后先运行本目录的 `build.mjs`，再执行同步命令。
