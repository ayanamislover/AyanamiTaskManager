# Agent 接入指南

AyanamiTaskManager（ATM）把 Agent 的任务状态、进度、阻塞、记录和交接写入项目独立数据库。它不是聊天记录存档器；Agent 只在语义状态发生变化时写入。

## 一次性接入

桌面端进入“设置 → Agent 接入”，可直接安装 Codex 或 Claude 配置，也可复制 streamable HTTP、stdio 或通用 JSON 配置。安装操作会最小合并现有配置，并在写入前创建备份。

本地服务只监听 `127.0.0.1`，每次启动生成或加载本地 token。运行时发现文件位于数据目录的 `runtime/daemon.json`。不要把 token 写进仓库、任务记录或日志。

便携包的 stdio MCP 通过随包的 `resources/mcp-stdio.cjs` 启动；Windows GUI EXE 本身没有可用 stdin，因此不要把桌面 EXE 直接当 stdio 程序。

## 标准 Session 流程

1. 开工只调用一次 `atm_begin`，显式传入 `project_code`；受管开发任务未注册时应自动创建；只有无法可靠确定项目名称、代码或目录时才请求用户确认。
2. 直接使用 `atm_begin` 返回的 brief；根据 brief 按需调用 `atm_task_list`，只有需要单项完整上下文时才调用 `atm_task_get`。
3. 选择 `READY` 工作项后，以 `atm_task_patch` 执行 `claim` 和 `start`。
4. 只在阶段完成、进度显著变化、出现阻塞/等待或产生关键证据时调用 `atm_progress_add`；`summary` 最长 500 字，应写清结果与下一步而不是拆成多次短更新。
5. 决策、约束、事实、风险、参考和经验写入 `atm_record`；长历史不要反复塞回上下文。
6. 增量同步优先 `atm_delta`，需要精确详情时才调用 `atm_task_get`。
7. 完成任务后执行 `complete`；Session 结束必须调用 `atm_end`。

正常开工不要在 `atm_begin` 后紧接 `atm_brief`。只有发生上下文压缩（compaction）、长时间离开，或明确需要恢复 working set 时才调用 `atm_brief`。

### Session Git Context

ATM 从 `cwd` 确定性采集 Git 上下文，使用只读查询得到 branch、HEAD、仓库根、worktree 根/common dir、detached、dirty 和可用性。调用方自报的 branch/head 只作提示，不能覆盖本机观察值。Git 目录不存在、命令失败或权限不足时，Session 仍照常创建和推进；界面会显示不可用及 `git_error`，不会把失败降级误报成干净仓库。

上下文自动刷新仅发生在以下边界：`atm_begin`、有意义的 `atm_progress_add`（含项目更新）、`verify`、`complete`、`atm_end`。需要立即重新观察时，用户可调用 `POST /api/v1/projects/:code/sessions/:id/git-context/refresh`；普通列表读取不会触发刷新。刷新结果会持久化到 Session，并在发生变化时追加 `agent.git_context.updated` 事件。

同一 `worktree` 或 branch 被多个在线 Session 使用时，ATM 只给出冲突警告供 Agent 协调；它不是锁，不会自动终止 Session、撤销领取或阻止执行。请结合实际协作约定决定是否继续。

### 任务拆分

开始实现前先判断当前 WorkItem 是否可在一个独立工作阶段内完成。
若任务包含多个独立交付物、多个验证阶段、明显跨模块，或预计需要较长连续开发，不要直接执行该大任务；先用 `atm_task_create` 拆成多个可独立完成和验收的子 WorkItem，再领取具体子任务执行。

Objective / Milestone / EPIC 用于表达目标和范围，不应作为长期直接执行单元。
拆分应按“可交付结果 + 可验证验收”划分，而不是机械按文件拆分。

可用的 11 个 MCP 工具为：`atm_begin`、`atm_brief`、`atm_task_list`、`atm_task_get`、`atm_task_create`、`atm_task_patch`、`atm_progress_add`、`atm_record`、`atm_search`、`atm_delta`、`atm_end`。

工作中发现新的独立事项时，用 `atm_task_create` 的 `discovered_from` 指向已有任务，或用 `discovered_from_ref` 指向同一批次的 `client_ref`。这是可追溯的发现关系，不会阻塞 ready queue，也不应替代 `depends_on`。

## 稀疏控制面约束

- 不要按分钟轮询或重复上报相同百分比。
- 进度 `summary` 上限为 500 字；仍应保持信息密度，避免为填满上限而复制日志或上下文。
- 写操作必须提供新的 `op_id`；重试同一请求时复用原 `op_id`。
- 更新任务必须带 `expected_version`。发生 `VERSION_CONFLICT` 后重新读取任务再决定，不要盲目覆盖。
- `claim` 只领取依赖已满足的任务；接管过期领取必须显式使用 `takeover_stale`。
- 阻塞必须填写原因；等待用户和等待 Agent 必须写清所需条件。
- mutation 返回短 ACK；需要新状态时再用 `atm_delta` 或单任务读取。

## 恢复与交接

计划换代时，前任 Session 用 `atm_end(outcome="retired")`，填写 `retirement_reason`、摘要和下一步。ATM 会为尚未完成且已领取的任务生成 handoff。后继用相同 `agent_id` 调用 `atm_begin(resume=true, predecessor_session_id=...)`，确认 handoff 后重新领取或继续任务。

普通 `completed` Session 不是可恢复前任；只有显式退休且已关闭的 Session 可作为 predecessor。这可以防止误把一次正常完成伪装成上下文换代。

## CLI 等价入口

```powershell
pnpm atm status
pnpm atm brief ATM
pnpm atm task list ATM --ready
pnpm atm task show ATM-T-0003 --view context
pnpm atm progress ATM-T-0003 --percent 50 --summary "文档已完成一半"
pnpm atm record ATM --kind FACT --summary "验收证据已生成"
```

CLI 写操作会创建短生命周期 Session 并在结束时关闭。需要持续领取、handoff 或多 Agent 协作时，应使用 MCP 或 REST 的正式 Session。

## 多 Agent

主 Agent 使用 `PRIMARY`，子任务执行者使用 `SUBAGENT`，独立验证使用 `REVIEWER`。每个 Agent 必须领取不同 WorkItem；不要用同一任务模拟并行。父子关系通过 `parent_session_id` 记录，交接通过 predecessor/handoff 记录。UI 的 Agent 页可以显式关闭异常在线 Session 并释放领取。
