# cyrvis/proactivity

归属分支：`xiangli` / `feat/proactivity`

职责：

- `policy.ts`（见上级 `proactivity.ts`）：任务事件主动播报、冷却、免打扰；
- `follow-up-service.ts`：启动/激活/解锁问候，带上次任务概况（**已关闭**沉默 10 秒闲置追问）；
- `travel/`：旅行攻略分层主动性（目的地时间 → 具体点位偏好 → 可执行 Day 方案 → 选定后再给预订链接）。

旅行流程约束：

- 自然问清目的地、出发地、大概日期（禁止「基础框架/立住」硬词）；
- 偏好用具体点位名试探（如故宫/三里屯），选定后立刻给可执行 Day 方案；
- 节奏约束只作备注，不当主体；不输出原始 JSON；
- 门票/酒店先报选项名，用户确认（选1/选项名）后再给该选项链接；禁止 GUI 代订；
- 换目的地会清空上一程的 aspects/预订确认，避免串台；
- `travel_finalize_plan` 在桌面生成并打开 **HTML** 计划页；
- 旅行规划默认走 `travel_*`，仅明确“打开订票网站操作”才 `start_gui_task`。

详见 `doc/roadmap.md` 第 4 节。
