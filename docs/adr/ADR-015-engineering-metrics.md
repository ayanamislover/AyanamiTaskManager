# ADR-015：轻量工程规模与代码增长统计

## 状态

已实施（2026-08-08）。95% Closeout 增补覆盖了原先“仅设计”的阶段边界，轻量 v1 已进入主线。

## 决策

- 统计由后端自动计算，不要求 Agent 上报，不进入 Agent context，也不增加 MCP 工具。
- 优先使用 `git ls-files` 和 `git diff --numstat <baseline>..<head>`；无法可靠归因给 Agent 时只归因到 Project 或 WorkItem。
- 项目快照包含 Source/Test LOC、文件分类、直接依赖、7/30 日净变化、最大文件和高 churn 文件。
- WorkItem 在开始时保存 Git baseline，在完成、handoff 或 retirement 时保存变更摘要：修改/新增/删除文件数、added/deleted/net、source/test added 和新增依赖。
- 排除 `node_modules`、构建目录、生成文件和 vendored 内容；lockfile 单独分类，不计入 Source/Test LOC。
- 只在项目建立、任务开始/完成、handoff/retirement、Git HEAD 去抖变化、每日首次空闲和手动刷新时采样；禁止按文件修改轮询。
- UI 只显示可解释的绝对量和趋势。异常规模使用软提醒，不产生伪精确质量评分，不硬阻断任务。
- 只保存必要快照和聚合结果，不保存逐文件高频遥测、token、推理或工具调用历史；不引入 AST 平台或 SonarQube 类重型依赖。

## 后续实现边界

后续在不改变双库职责的前提下，将项目/任务指标快照存入对应 Project DB，Registry 只保留总览所需摘要。采样器必须由应用服务触发并去抖；发布前另立定向测试，不扩大当前 Session 交接测试范围。
