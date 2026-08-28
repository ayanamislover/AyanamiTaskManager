# ATM Agent 快速入门

> 契约锚点：MCP Surface `v3`，2026-08-27 校验。`atm_begin.surface_version` 可用于检测客户端缓存或文档是否过期。

## ATM 是什么

AyanamiTaskManager（ATM）是本机 Agent 项目的任务控制面：统一保存目标、任务、Session、进度、证据、阻塞和交接。它不是聊天记录或日志仓库；只在工作状态有实际变化时写入。

## ATM 服务如何发现

正式数据默认位于 `%LOCALAPPDATA%\AyanamiTaskManager`；显式设置 `ATM_DATA_DIR` 时以该目录为准。读取 `<数据目录>\runtime\daemon.json` 获得 `endpoint`、`token`、`pid` 和启动时间。服务只监听 `127.0.0.1`；不要猜端口，也不要把 token 写入仓库、日志、对话或 ATM 记录。`output/` 下的数据只用于测试。

## ATM 未运行怎么办

已安装环境直接启动 AyanamiTaskManager 桌面应用；窗口关闭到托盘后服务仍运行。源码环境在仓库根目录执行 `pnpm dev`。随后用 `pnpm atm status` 或 `pnpm atm doctor` 验证。若 runtime 指向已退出进程，先“完全退出”旧应用再重新启动，不要复用过期 endpoint/token。

## Codex 怎么接入

在 ATM 的“设置 → Agent 接入”选择“安装 Codex 配置”，ATM 会备份并最小合并 `%USERPROFILE%\.codex\config.toml`。配置变化后让 Codex 重新加载 MCP。项目规则应包含：

> 执行项目前先访问 ATM 工具，并阅读 %LOCALAPPDATA%\AyanamiTaskManager\ATM_AGENT_GUIDE.md；后续所有任务执行均依赖 ATM。

ATM 默认登记 `ayanami-task-manager-core`、`ayanami-task-manager-memory` 与 `ayanami-task-manager-actions` 三个静态 Profile。三者共享同一数据库，但各自保持固定、受预算约束的工具列表。设置中关闭“完整工具面”是主动的低内存降级：memory 与 actions 会一起关闭，只保留 core，因此会失去任务修改、进度、Record、搜索和 delta，且修改后需要重载 Agent 客户端。

## Claude Desktop 怎么接入

在“设置 → Agent 接入”选择“安装 Claude 配置”，ATM 会备份并最小合并 `%APPDATA%\Claude\claude_desktop_config.json`，然后重启 Claude Desktop。打包版 stdio 使用 `resources/mcp-stdio.cjs`；不要把 Windows GUI EXE 直接当作 stdio 命令。

## Claude Code 怎么接入

Claude Code 与 Claude Desktop 是两条不同的路径：它**从不读** `claude_desktop_config.json`，MCP 注册在 `%USERPROFILE%\.claude.json`（user scope）。规则 `~/.claude/CLAUDE.md` 与技能 `~/.claude/skills` 两者共用，装一次即可。

在“设置 → Agent 接入”选择“安装 Claude Code 配置”。ATM 不会自己改写 `~/.claude.json`——该文件由 Claude Code 持有并高频整体重写，第三方读-改-写会吞掉对方的更新；安装一律通过调用 `claude` CLI 完成，找不到 CLI 时明确报错而不是退化成直接改文件。等价的手工命令：

```powershell
claude mcp add-json ayanami-task-manager-core '{"command":"<ATM.exe>","args":["<resources\\mcp-stdio.cjs>","--profile","core"],"env":{"ELECTRON_RUN_AS_NODE":"1"}}' --scope user
claude mcp add-json ayanami-task-manager-memory '{"command":"<ATM.exe>","args":["<resources\\mcp-stdio.cjs>","--profile","memory"],"env":{"ELECTRON_RUN_AS_NODE":"1"}}' --scope user
claude mcp add-json ayanami-task-manager-actions '{"command":"<ATM.exe>","args":["<resources\\mcp-stdio.cjs>","--profile","actions"],"env":{"ELECTRON_RUN_AS_NODE":"1"}}' --scope user
```

用 stdio 而不是 streamable-http：后者要把 endpoint 和 token 写进配置，而两者每次 daemon 重启都会变，配置随即失效。

## atm\_\* 工具地图

| Profile | 目的                           | 工具                                               |
| ------- | ------------------------------ | -------------------------------------------------- |
| core    | 开始、恢复 working set、结束   | `atm_begin`、`atm_brief`、`atm_end`                |
| core    | 查找与创建任务                 | `atm_task_list`、`atm_task_get`、`atm_task_create` |
| actions | 领取、启动、检查项、验证、完成 | `atm_task_patch`                                   |
| memory  | 写阶段进度、长期事实与证据     | `atm_progress_add`、`atm_record`                   |
| memory  | 精确读取、搜索历史与增量同步   | `atm_search`、`atm_delta`                          |

三个 Profile 联合为 11 个工具且名称不重叠。检查项已经合并进 `atm_task_patch`：单项使用 `operation="checklist_single"`，批量使用 `operation="checklist_batch"`，内容放在 `checklist_items`。

正式 core / memory / actions 工具的单行说明、安全注解和 schema hash 全部由同一 Tool Registry 生成；完整可核对表见 `%LOCALAPPDATA%\AyanamiTaskManager\docs\generated\mcp-tool-contracts.md`。无 Profile 的 legacy 入口只发布冻结的 v1.0.18 兼容 artifact，当前安装器不会新增该入口。

所有写操作使用唯一 `op_id`；重试同一写请求时复用原 `op_id`。任务变更携带最新 `expected_version`，发生版本冲突后先重新读取。进度摘要上限 500 字，应一次写清结果、证据和下一步，不贴原始日志。

MCP 参数使用 `snake_case`；直接调用 REST 时 JSON 字段改用 `camelCase`。不要把两套命名混用。

精确读取优先复用 `atm_search`：WorkItem/Record 直接传公开 key，Progress/Session 使用 `progress:<ULID>`、`session:<ULID>`，写回执可用 `op_id` 并按 `session` 收窄。长字段按响应给出的 cursor 续读；后续请求必须保持相同项目、实体和 `field_mask`，篡改、跨实体复用或内容变化会被拒绝。

## 最短工作流

<!-- WORK_ITEM_OPERATIONS:BEGIN -->

### 状态与操作（自动生成）

> 本表由 canonical `WorkItemOperations` registry 生成；不要手工维护状态机副本。

<!-- prettier-ignore -->
| 状态 | 显示名 | 合法操作 |
| --- | --- | --- |
| `BACKLOG` | 待整理 | `claim`, `start`, `complete`, `cancel`, `edit` |
| `READY` | 可开始 | `claim`, `start`, `complete`, `cancel`, `edit` |
| `CLAIMED` | 已领取 | `claim`, `start`, `release`, `block`, `complete`, `cancel`, `edit` |
| `IN_PROGRESS` | 进行中 | `start`, `release`, `block`, `wait_agent`, `wait_user`, `verify`, `complete`, `cancel`, `edit` |
| `BLOCKED` | 已阻塞 | `start`, `release`, `block`, `complete`, `cancel`, `reopen`, `edit` |
| `WAITING_USER` | 等待用户 | `start`, `release`, `block`, `wait_user`, `verify`, `complete`, `cancel`, `reopen`, `edit` |
| `WAITING_AGENT` | 等待 Agent | `start`, `release`, `block`, `wait_agent`, `verify`, `complete`, `cancel`, `reopen`, `edit` |
| `VERIFYING` | 验收中 | `start`, `release`, `block`, `wait_agent`, `wait_user`, `verify`, `complete`, `cancel`, `reopen`, `edit` |
| `DONE` | 已完成 | `reopen`, `edit` |
| `CANCELLED` | 已取消 | `reopen`, `edit` |

<!-- prettier-ignore -->
| 操作 | 显示名 | 可进入的当前状态 | 前置条件 |
| --- | --- | --- | --- |
| `claim` | 领取 | `BACKLOG`, `READY`, `CLAIMED`, `IN_PROGRESS` | DEPENDENCIES_READY, CLAIM_AVAILABLE, SAME_ASSIGNEE_WHEN_RUNNING |
| `start` | 开始 | `BACKLOG`, `READY`, `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING` | DEPENDENCIES_READY, CLAIM_AVAILABLE |
| `release` | 释放过期领取 | `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING` | CLAIM_OWNER |
| `block` | 阻塞 | `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING` | BLOCKED_REASON |
| `wait_agent` | 等待 Agent | `IN_PROGRESS`, `VERIFYING`, `WAITING_AGENT` | WAITING_FOR |
| `wait_user` | 等待用户 | `IN_PROGRESS`, `VERIFYING`, `WAITING_USER` | WAITING_FOR |
| `verify` | 提交验收 | `IN_PROGRESS`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING` | - |
| `complete` | 完成 | `BACKLOG`, `READY`, `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING` | COMPLETION_GATE |
| `cancel` | 取消 | `BACKLOG`, `READY`, `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING` | CANCEL_REFERENCES |
| `reopen` | 重新打开 | `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING`, `DONE`, `CANCELLED` | - |
| `edit` | 编辑 | `BACKLOG`, `READY`, `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING`, `DONE`, `CANCELLED` | - |

<!-- WORK_ITEM_OPERATIONS:END -->

1. `atm_begin(project_code, agent_id, role)`，正常开工只发起一个语义请求，并直接使用返回的 brief。默认 `brief="full"`；低上下文客户端可用 `minimal`，只要 Session 回执则用 `none`。`max_chars` 只裁剪 brief，不会丢失 `session`、`project`、`scope` 或原子回执。需要崩溃恢复的控制器必须额外传稳定 `op_id`；响应未知或冷启动时以完全相同的请求重试，ATM 会在现有项目内返回同一 Session。
2. 根据 brief 按需调用 `atm_task_list`；只有需要单项完整上下文时才调用 `atm_task_get`。
3. 开始实现前按下方“任务拆分”规则确认 WorkItem 粒度，再领取具体任务。
4. `atm_task_patch(claim)` → `atm_task_patch(start)`；并行 Agent 各领不同任务。
5. 完成一个有意义阶段后写 `atm_progress_add`；事实、决策、风险写 `atm_record`。
6. 验收后 `atm_task_patch(verify)` → `atm_task_patch(complete)`；满足条件时也可用 `verify_and_complete` 原子完成。
7. 无论成功、暂停或阻塞，最后都调用 `atm_end`；计划换代使用 `retired` 和 predecessor/handoff。

正常开工不要在 `atm_begin` 后紧接 `atm_brief`。只有发生上下文压缩（compaction）、长时间离开，或明确需要恢复 working set 时才调用 `atm_brief`。

<!-- MUTATION_ACK_CONTRACT:BEGIN -->

### 固定 mutation ACK

所有 mutation 工具只返回同一组有界字段；不要依赖操作特有的顶层字段。

| 字段                 | 语义                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ok`                 | 写操作是否被 ATM 接受。                                                                                                                                            |
| `op_id`              | 调用方提交的幂等操作 ID；重试必须复用。                                                                                                                            |
| `project`            | 规范化后的项目代码。                                                                                                                                               |
| `session`            | 实际承载写操作的 Session。                                                                                                                                         |
| `session_rebound`    | Session 过期并由 ATM 安全接续时为 `true`。                                                                                                                         |
| `projection`         | Registry 投影持久回执；含 `status`、`source_seq`、`projected_seq`、`retry_scheduled`、`last_error` 与累计 `retry_count`。`DEFERRED` 表示权威写已成功且后台会重试。 |
| `entities`           | 受影响实体的有界预览，每项含 `entity_type`、`key`、`version`。                                                                                                     |
| `entity_count`       | 完整受影响实体数量，不受预览截断影响。                                                                                                                             |
| `entities_truncated` | 实体预览是否被条数或字符预算截断。                                                                                                                                 |
| `details_cursor`     | 可直接作为 MCP 工具调用执行的有界 durable 实体回查描述符。                                                                                                         |

`entities` 最多预览 12 项且不超过 1800 个 JSON 字符。以 `entity_count` 判断精确总数；`entities_truncated=true` 时可直接执行返回的 `details_cursor` 做一次最多 50000 字符的 durable 回查：

```json
{
  "name": "atm_search",
  "arguments": {
    "project": "ATM",
    "op_id": "<same-op-id>",
    "session": "<returned-session>",
    "field_mask": ["op_id", "entities"],
    "max_chars": 50000
  }
}
```

需要操作特有结果时，仍以同一 `project`、`op_id` 和返回的 `session` 精确读取 durable operation receipt，只把 `field_mask` 改为下例；不要重新执行 mutation：

```json
{
  "name": "atm_search",
  "arguments": {
    "project": "ATM",
    "op_id": "<same-op-id>",
    "session": "<returned-session>",
    "field_mask": ["op_id", "mutations"],
    "max_chars": 50000
  }
}
```

例如自动补建规划根的事实位于 `operation.mutations[].response.planningRootProvisioned`；mutation ACK 顶层不再返回 `planning_root`。字段读取若返回 `done=false`，把 `next_cursor` 作为 `cursor` 加回同一个 `atm_search` 调用继续读，直到 `done=true`。

<!-- MUTATION_ACK_CONTRACT:END -->

`atm_begin(op_id=...)` 的原子键作用域是 `(project, op_id)`。它要求项目已经存在且可解析；不得把 quick task 或自动创建项目混入这次原子恢复。调用方必须验证返回的 `atomicBegin.operationId` 及 `CREATED|RECOVERED` disposition；缺失回执表示服务端没有证明原子能力。同一 `op_id` 的请求身份发生变化会得到 `IDEMPOTENCY_CONFLICT`，不能改 key 或退化为枚举 Session 后猜测。

### 完成闸门

`complete` 会同时检查：检查项、证据、子任务、阻塞、依赖、验收和当前状态。不通过时会在一个 `COMPLETION_GATE_FAILED` 响应中返回全部已知缺口；先一次性处理返回的所有 reasons，不要只修第一条后循环重试。各类缺口的出路：

| 报错                                     | 含义与出路                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checklist incomplete`                   | 还有检查项停在 TODO/DOING。用 `atm_task_patch(operation="checklist_single")` 逐条置 `DONE` 或 `SKIPPED`；多项可用 `checklist_batch`。单项的 `expected_version` 是**检查项自己**的版本；批量只收任务的一个起始版本并整批回滚。                                                          |
| `evidence required` / `evidence missing` | 该检查项标了「需要证据」。要么带 `evidence` 挂上真证据，要么置 `SKIPPED`——跳过的必证项不再要求证据。不要为了打勾而编证据。                                                                                                                                                             |
| `child incomplete`                       | 还有子 WorkItem 不在 DONE/CANCELLED。                                                                                                                                                                                                                                                  |
| `blocker active`                         | 这条来自**独立的 blocker 记录**，由带非空 `blocker` 的 `atm_progress_add` 写入，和任务行上的 `blocked_reason` 不是一回事。`blocker: null` 只表示「这次不新写」，不会关掉已有的那条。用 `atm_task_patch(reopen)`，或对已在进行中的任务再 `start` 一次——「接着做」即意味着阻塞不再成立。 |
| `dependency not ready`                   | 有 BLOCKS 关系的前置任务尚未 DONE。                                                                                                                                                                                                                                                    |
| `verification required`                  | 任务要求验收，先 `verify` 再 `complete`。                                                                                                                                                                                                                                              |

### MCP 没有的能力走 REST

少数能力目前只有 REST 入口，例如**再建一个** Objective / Milestone（`POST /api/v1/projects/{code}/objectives`、`.../milestones`）。REST 与 MCP 用同一个 `endpoint` 和 token（见「ATM 服务如何发现」），写操作同样需要 `session` 与唯一 `op_id`。

新项目**不需要**先建 Objective：项目还没有活动目标时，`atm_task_create` 会自动补一个以项目名命名、带「（自动补建）」后缀的目标和一个「执行」里程碑。这个规划决策保存在 durable operation receipt；按上方固定 mutation ACK 说明精确回查后，应按实际规划改写目标标题与验收，或另建目标后归档它。条目自带 `objective_id` 时不会触发补建。

方法用错会返回 **405** 并在 `allow` 头和错误信息里列出该路径接受的方法——看到 405 是「方法不对」，看到 404 才是「路径不存在」，不要因为 404 就去猜别的路径名。

### 任务拆分

开始实现前先判断当前 WorkItem 是否可在一个独立工作阶段内完成。
若任务包含多个独立交付物、多个验证阶段、明显跨模块，或预计需要较长连续开发，不要直接执行该大任务；先用 `atm_task_create` 拆成多个可独立完成和验收的子 WorkItem，再领取具体子任务执行。

Objective / Milestone / EPIC 用于表达目标和范围，不应作为长期直接执行单元。
拆分应按“可交付结果 + 可验证验收”划分，而不是机械按文件拆分。

## 完整文档在哪

- Agent 协议与协作细节：`%LOCALAPPDATA%\AyanamiTaskManager\docs\agent-integration.md`
- 用户操作：`%LOCALAPPDATA%\AyanamiTaskManager\docs\user-guide.md`
- 故障排查：`%LOCALAPPDATA%\AyanamiTaskManager\docs\troubleshooting.md`
- 架构与数据边界：`%LOCALAPPDATA%\AyanamiTaskManager\docs\architecture.md`、`%LOCALAPPDATA%\AyanamiTaskManager\docs\data-model.md`
- 发布验收：`%LOCALAPPDATA%\AyanamiTaskManager\docs\release-checklist.md`
- ATM Feedback 逐项闭环矩阵：`%LOCALAPPDATA%\AyanamiTaskManager\docs\feedback-closeout.md`
- MCP 工具契约与 Profile hash：`%LOCALAPPDATA%\AyanamiTaskManager\docs\generated\mcp-tool-contracts.md`
- Mutation 固定回执契约：`%LOCALAPPDATA%\AyanamiTaskManager\docs\generated\mutation-acknowledgement.md`
- WorkItem 状态与操作表：`%LOCALAPPDATA%\AyanamiTaskManager\docs\generated\work-item-operations.md`
- 最新在线版本：`https://github.com/ayanamislover/AyanamiTaskManager`
