# Cyrvis · Arcade C

当前正式 Logo，采用用户选定的第三款像素街机设计：阶梯形 C、右侧张嘴、方形眼睛。保留已确认概念的轮廓与比例。

- 橙色：`#FF751F`；近黑底色：`#101112`。
- `cyrvis-mark.svg` / `.png`：黑色圆角底、橙色标志，用于首页与侧边栏。
- `cyrvis-app-icon.svg` / `.png`：相同设计的应用图标，PNG 为 1024 × 1024，圆角外透明。
- `cyrvis-mark-{16,32,64,128,256}.png`：小尺寸导出，保持相同轮廓。
- `cyrvis-mark-mono.svg` / `cyrvis-mark-white.svg`：透明底单色版本，眼睛保留透明镂空；黑色版本用于 macOS 托盘模板，由系统适配菜单栏颜色。
- `cyrvis-lockup.svg`：黑橙图形与现有路径字标组合，不依赖本机字体；同步脚本另生成白色字标版本。
- `wordmark-paths.json`：沿用原有品牌字标轮廓。

在仓库根目录重建并同步：

```sh
node design/cyrvis-logo/v4/build.mjs
node scripts/cyrvis/sync-logo.mjs
```

同步范围包括界面 Logo、favicon、macOS 托盘模板以及 PNG / ICNS / ICO 应用图标。旧版设计保留供历史参考。已安装的应用需要重新打包安装后才会使用新的系统应用图标。
