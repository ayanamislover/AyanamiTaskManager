# Agent 使用 ATM

执行项目前先访问 AyanamiTaskManager（ATM）工具；后续计划、分工、进度、证据、阻塞和交接都以 ATM 为准。正式数据默认在 `%LOCALAPPDATA%\AyanamiTaskManager`，不要把 `output/playwright/data` 等测试目录当成生产数据。

1. 开工调用一次 `atm_begin`，指定 `project_code`、`agent_id` 和角色；返回值已含简要上下文。
2. 领取 `READY` 任务并 `start`；并行 Agent 必须领取不同 WorkItem，子线程填写 `parent_session_id`。
3. 只在阶段完成、状态变化、阻塞或产生关键证据时写 `atm_progress_add`；摘要可在需要时写到 500 字，但不要贴日志。
4. 决策、事实、风险和经验写 `atm_record`；写操作使用新的 `op_id`，版本冲突时重新读取。
5. 完成任务后 `verify/complete`；结束必须调用 `atm_end`。计划换代用 `retired`，后继凭 `predecessor_session_id` 恢复。

运行时从正式数据目录的 `runtime/daemon.json` 发现 endpoint，并读取同目录 token；token 不得写进仓库、日志或任务记录。详细工具说明见 `docs/agent-integration.md`。
