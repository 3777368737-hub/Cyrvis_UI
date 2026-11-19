# cyrvis/proactivity

归属分支：`xiangli` / `feat/proactivity`

职责：

- `policy.ts`（见上级 `proactivity.ts`）：任务事件主动播报、冷却、免打扰；
- `follow-up-service.ts`：启动问候、继续上次任务、沉默约 10s 上下文提示；
- `travel/`：旅行攻略分层主动性（先基础框架 → 骨架 → 按方面展开 + 检索）。

旅行流程约束：

- 先收集基础框架；
- 框架齐后按目的地+月份/节日检索大类亮点（各 1 条）试探偏好；
- 选定偏好后过约束卡片（步行/早起/排队）；
- 再按偏好+约束展开，板块之间柔和衔接，过程写入旅行备忘；
- 计划敲定后 `travel_finalize_plan` 在桌面生成并打开 txt 摘要；
- 旅行规划默认走 `travel_*`，仅明确“打开订票网站操作”才 `start_gui_task`。

详见 `doc/roadmap.md` 第 4 节。
