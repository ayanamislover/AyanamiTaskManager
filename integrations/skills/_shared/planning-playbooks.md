# ATM Planning Playbooks

这些 Playbook 是 `atm-plan` 拆分复杂目标时使用的静态骨架，不是固定模板。先删掉无意义步骤、合并过细步骤，再补充项目真实需要的交付物；小任务不得为了套模板硬拆。

## BUGFIX

复现并建立失败基线 → 定位可证实的根因 → 实现最小修复 → 回归相关测试 → 在真实场景验收。

可验收叶子示例：`修复刷新后主题丢失`；acceptance：刷新后仍为用户选择的主题，浅色/暗色 E2E 均通过。

## FEATURE

明确 acceptance → 确认现有架构、边界与风险 → 按可交付切片实现 → 测试与集成 → 最终验收。

只有切片可被独立交付和验证时才拆成多个 WorkItem；共享代码文件不是依赖关系。

## REVIEW

理解变更范围 → 独立验证 → 形成带证据的 findings → 修复或回应 → re-review。

Review WorkItem 只表达一次可闭环的审查；发现的独立修复项用 `discovered_from` 关联，不塞回原审查范围。

## RELEASE

静态检查 → 单元/集成/E2E → build/package → packaged smoke → 发布证据。

仅为会影响后续判断的真实门禁建立依赖；发布证据至少包含版本/commit、产物、校验值和远端 CI 结果。

## RESEARCH

定义问题 → 收集可追溯证据 → 对比方案与约束 → 形成结论 → 记录 decision/risk/reference。

研究任务的 acceptance 应说明要回答的问题和证据标准，而不是要求预设结论。

## 调整规则

1. 每个叶子 WorkItem 用“可交付结果 + 可验证验收”命名和验收。
2. Objective、Milestone、EPIC 只表达目标与范围，不长期直接执行。
3. 删除无价值步骤，合并一个短阶段内可完成的步骤。
4. 只为真实先后约束使用 dependency；来源追踪使用 `DISCOVERED_FROM`。
5. 通常拆成 2～8 个叶子；超过时先按阶段或子目标分层。
