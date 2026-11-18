# cyrvis/memory

当前实现位于 `../memory.ts` 和 `../memory-context.ts`。

- `memory.ts`：持久化最近对话、长期事实和 Activity 到
  `%APPDATA%\ui-tars-desktop\cyrvis-memory.json`；
- `memory-context.ts`：构造注入 Qwen Realtime 的跨会话上下文；
- 敏感信息模式（API Key、密码、密钥）不会写入记忆；
- 用户明确要求记住偏好时，模型通过 `remember_fact` 工具写入长期记忆。

文件路径使用 Electron `app.getPath('userData')`，因此开发版和打包版会按各自
应用名称落在对应的用户数据目录。
