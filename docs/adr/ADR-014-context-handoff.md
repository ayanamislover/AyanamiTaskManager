# ADR-014：Agent 外置状态与 Session 交接

## 状态

已接受（2026-08-07）。本 ADR 是 v2 设计的增量约束，不推翻现有双库、事件、MCP 或 Session 架构。

## 决策

- ATM 只把当前工作集、有效约束和难以重建的事实送入恢复上下文；事件、旧进度和已取代记录仍永久保存，但默认不返回。
- `records` 记录 `source_type/source_actor_id/source_session_id/source_ref`，明确区分 USER、AGENT、SYSTEM 和 IMPORT。
- `atm_end(outcome="retired")` 表示 Session 生命周期结束而工作未完成；默认释放旧 claim，再由同一 `agent_id` 的 successor 显式重新领取。
- successor 复用现有 `atm_begin`，通过可选 `resume=true` 与 `predecessor_session_id` 建立关系；不增加第 12 个 MCP 工具。
- handoff 只保存短 `summary + next_action + checkpoint_sequence`，不建立第二套 Context Snapshot 事实源。
- resume brief 目标不超过 800 字符、硬上限 1200 字符；优先保留当前任务、状态/version、验收、阻塞、下一步、直接依赖和有效 USER 约束。
- `atm_task_list` 默认 10 项、最大 100 项。

## 后果

Agent 可以主动结束上下文退化的长 Session，并从结构化事实低成本恢复；恢复成本不随历史事件和已完成任务线性增长。历史仍可通过 `atm_search`、`atm_delta` 和定向 `atm_task_get` 查询。
