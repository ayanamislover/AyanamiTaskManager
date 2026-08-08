---
name: atm-plan
description: 将复杂受管开发目标拆成 ATM 中可执行、可验证、可恢复的 WorkItem 计划图。
metadata:
  atm-integration-version: 1
---

# ATM Plan

使用本 Skill 将宽泛目标外置为 ATM 计划结构；不要执行具体实现。

1. 调用一次 `atm_begin`，直接使用返回的 brief。正常开工不要紧接 `atm_brief`。
2. 按需读取现有任务，避免重复规划。
3. 判断当前工作是否可在一个独立阶段内完成。若包含多个交付物、实质阶段、模块、Session、Agent、真实依赖，或无法用一句 acceptance 验收，先拆成 2～8 个 WorkItem。
4. 按任务类型读取 `../_shared/planning-playbooks.md`，选择 BUGFIX、FEATURE、REVIEW、RELEASE 或 RESEARCH 骨架并按真实范围调整。
5. 按“可交付结果 + 可验证验收”拆分；不要按文件或命令机械拆分。
6. Objective、Milestone、EPIC 只表达目标与范围；实际执行领取 READY 的叶子 WorkItem。
7. 使用 `parent_ref`、`depends_on_refs` 和 acceptance 批量 `atm_task_create`。
8. 发现已有计划过粗时，在主要实现前把长期有价值的步骤同步到 ATM。
9. 规划完成后进入 `atm-task`。

小型文本修正、单一配置、明确原子 bug 或一个短阶段内可验收的修改可以保持为一个 leaf。

完整规则见 `%LOCALAPPDATA%\AyanamiTaskManager\ATM_AGENT_GUIDE.md`。
