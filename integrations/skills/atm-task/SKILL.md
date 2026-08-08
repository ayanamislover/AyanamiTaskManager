---
name: atm-task
description: 领取并完成一个 ATM READY 叶子 WorkItem，在有意义节点保存进度、证据与交接。
metadata:
  atm-integration-version: 1
---

# ATM Task

本 Skill 只执行一个具体叶子 WorkItem。

1. 从 brief 或 `atm_task_list` 找到 READY leaf；需要完整上下文时才 `atm_task_get`。
2. `atm_task_patch(claim)` 后 `atm_task_patch(start)`。
3. 执行实现；仅在阶段完成、显著变化、阻塞或关键证据出现时写 `atm_progress_add`。
4. 长期事实、决策、风险和参考写 `atm_record`。
5. 工作中发现独立事项时创建新 WorkItem，并传 `discovered_from`（已有任务键）或 `discovered_from_ref`（同批 `client_ref`）记录来源；不要把它误写成阻塞依赖，也不要顺手扩大范围。
6. 如果当前任务实际过大，停止继续塞入同一任务，回到 `atm-plan` 拆分剩余工作。
7. 按 acceptance 与 checklist 验收，随后 `verify`、`complete`。
8. Session 无论完成、暂停或阻塞都调用 `atm_end`。

不要把每条命令、日志或 token 消耗写入 ATM。完整规则见 `%LOCALAPPDATA%\AyanamiTaskManager\ATM_AGENT_GUIDE.md`。
