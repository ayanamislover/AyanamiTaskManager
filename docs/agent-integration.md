# Agent 接入指南

AyanamiTaskManager（ATM）把 Agent 的任务状态、进度、阻塞、记录和交接写入项目独立数据库。它不是聊天记录存档器；Agent 只在语义状态发生变化时写入。

## 一次性接入

桌面端进入“设置 → Agent 接入”，可直接安装 Codex、Claude Desktop 或 Claude Code 配置，也可复制 streamable HTTP、stdio 或通用 JSON 配置。安装操作会最小合并现有配置，并在写入前创建备份。

三个客户端的落点互不相同，不能互相替代：

| 客户端         | MCP 注册                                      | 规则                  | 技能                  |
| -------------- | --------------------------------------------- | --------------------- | --------------------- |
| Codex          | `~/.codex/config.toml`                        | `~/.codex/AGENTS.md`  | `~/.codex/skills`     |
| Claude Desktop | `%APPDATA%/Claude/claude_desktop_config.json` | `~/.claude/CLAUDE.md` | `~/.claude/skills`    |
| Claude Code    | `~/.claude.json`（user scope）                | 同上，与 Desktop 共用 | 同上，与 Desktop 共用 |

Claude Code 的注册由 ATM 调用 `claude` CLI 完成，ATM 不直接改写 `~/.claude.json`：该文件由 Claude Code 持有并高频整体重写，第三方读-改-写会丢失对方更新。找不到 CLI 时安装会以 `CLAUDE_CODE_CLI_NOT_FOUND` 失败，不会退化成直接改文件。由于规则与技能同 Desktop 共用，卸载其中一个客户端时，只要另一个仍装着 MCP，共用的规则和技能会被保留。

本地服务只监听 `127.0.0.1`，每次启动生成或加载本地 token。运行时发现文件位于数据目录的 `runtime/daemon.json`。不要把 token 写进仓库、任务记录或日志。

便携包的 stdio MCP 通过随包的 `resources/mcp-stdio.cjs` 启动；Windows GUI EXE 本身没有可用 stdin，因此不要把桌面 EXE 直接当 stdio 程序。

## 标准 Session 流程

1. 开工调用 `atm_begin`，显式传入 `project_code`。普通交互式开工可在受管开发任务未注册时自动创建；需要崩溃重放的自动化控制器必须先注册项目，并携带稳定 `op_id`，不能把项目创建和 Session 原子恢复混为一次调用。只有无法可靠确定项目名称、代码或目录时才请求用户确认。
2. 直接使用 `atm_begin` 返回的 brief；根据 brief 按需调用 `atm_task_list`，只有需要单项完整上下文时才调用 `atm_task_get`。MCP 工具面当前为 v3，`atm_begin.surface_version` 是客户端检查缓存契约的锚点。
3. 选择 `READY` 工作项后，以 `atm_task_patch` 执行 `claim` 和 `start`。
4. 只在阶段完成、进度显著变化、出现阻塞/等待或产生关键证据时调用 `atm_progress_add`；`summary` 最长 500 字，应写清结果与下一步而不是拆成多次短更新。
5. 决策、约束、事实、风险、参考和经验写入 `atm_record`；长历史不要反复塞回上下文。
6. 增量同步优先 `atm_delta`，需要精确详情时才调用 `atm_task_get`。
7. 完成任务后执行 `complete`；Session 结束必须调用 `atm_end`。

正常开工不要在 `atm_begin` 后紧接 `atm_brief`。只有发生上下文压缩（compaction）、长时间离开，或明确需要恢复 working set 时才调用 `atm_brief`。

`atm_begin` 默认返回 `brief="full"`。上下文预算紧张时可选 `minimal`，只建立 Session 时可选 `none`。`max_chars` 只约束可降级的 brief；`session`、`project`、`scope`、`surface_version` 和 `atomicBegin` 属于不可截断回执，即使项目摘要很大也必须返回。调用方应检查 `brief_truncated`，需要被省略的分节时再按需读取。

### 原子 Session recover-or-begin

`atm_begin` 的可选 `op_id` 为调用方提供项目内的 at-most-once Session 创建语义。调用方必须在首次请求、超时重试、响应丢失后的冷启动和凭据轮换后复用同一个 `op_id` 与完全相同的请求身份；ATM 会返回同一 Session，并在 `atomicBegin` 回执中原样绑定规范化后的 operation ID，首次为 `CREATED`、重放为 `RECOVERED`。自动化调用方必须验证该回执，不能因旧服务忽略未知 `op_id` 而假定原子性。相同 `op_id` 携带不同 project/cwd/agent/client/role/thread/parent/resume 等身份时，ATM 以 `IDEMPOTENCY_CONFLICT` 拒绝，不创建第二个 Session。

该保证的键空间是 `(project, op_id)`，事务边界是已经存在且能确定解析的 project SQLite。携带 `op_id` 时，quick task 和 `allow_project_create` 不在该事务边界内，因此项目不存在会在任何 Quick Task、Project 或 Session 写入前以 `ATOMIC_BEGIN_REQUIRES_EXISTING_PROJECT` 拒绝。同一个 `op_id` 可以在两个不同项目中各自创建一个 Session；调用方不得把它当成跨项目全局 ID。

原子事务同时提交 Agent/Session、`agent.joined` 事件、outbox 和幂等响应。服务重启或访问凭据轮换不改变幂等身份。重放时 Session ID 与创建序列保持不变，但 brief 与 scope score 会从当前持久状态重新计算，因此它不是整个 HTTP/MCP 响应字节的缓存。

### Session Git Context

ATM 从 `cwd` 确定性采集 Git 上下文，使用只读查询得到 branch、HEAD、仓库根、worktree 根/common dir、detached、dirty 和可用性。调用方自报的 branch/head 只作提示，不能覆盖本机观察值。Git 目录不存在、命令失败或权限不足时，Session 仍照常创建和推进；界面会显示不可用及 `git_error`，不会把失败降级误报成干净仓库。

上下文自动刷新仅发生在以下边界：`atm_begin`、有意义的 `atm_progress_add`（含项目更新）、`verify`、`complete`、`atm_end`。需要立即重新观察时，用户可调用 `POST /api/v1/projects/:code/sessions/:id/git-context/refresh`；普通列表读取不会触发刷新。刷新结果会持久化到 Session，并在发生变化时追加 `agent.git_context.updated` 事件。

同一 `worktree` 或 branch 被多个在线 Session 使用时，ATM 只给出冲突警告供 Agent 协调；它不是锁，不会自动终止 Session、撤销领取或阻止执行。请结合实际协作约定决定是否继续。

### 任务拆分

开始实现前先判断当前 WorkItem 是否可在一个独立工作阶段内完成。
若任务包含多个独立交付物、多个验证阶段、明显跨模块，或预计需要较长连续开发，不要直接执行该大任务；先用 `atm_task_create` 拆成多个可独立完成和验收的子 WorkItem，再领取具体子任务执行。

Objective / Milestone / EPIC 用于表达目标和范围，不应作为长期直接执行单元。

新项目不需要先建 Objective。项目还没有活动目标时，`atm_task_create` 会补一个以项目名命名、带「（自动补建）」后缀的目标和一个「执行」里程碑，并在回执里返回 `planning_root: "PROVISIONED"`。这是机器代替人做出的规划决策，因此它是显式回执而不是静默行为：拿到它就应按实际规划改写目标标题与验收，或另建目标后归档它。条目自带 `objective_id` 时不触发补建；需要在一个项目里再建目标或里程碑仍走 REST。
拆分应按“可交付结果 + 可验证验收”划分，而不是机械按文件拆分。

MCP 使用两个默认同时登记、工具名不重叠的静态 Profile：

- core：`atm_begin`、`atm_brief`、`atm_task_list`、`atm_task_get`、`atm_task_create`、`atm_end`。
- memory：`atm_task_patch`、`atm_progress_add`、`atm_record`、`atm_search`、`atm_delta`。

两者共享同一 ATM 数据库。memory 默认启用；用户可在设置中主动关闭以减少每个客户端的一条 bridge 进程，但这会进入降级模式，无法修改任务、写进度/Record、搜索或增量同步，且配置变化后需要重载对应 Agent 客户端。检查项操作已经并入 `atm_task_patch` 的 `checklist_single` / `checklist_batch`，不再存在独立 checklist 工具。

不带 `--profile` 的 legacy 工具面只用于迁移旧客户端，不会由当前安装器写入，也不应作为新客户端入口。它逐字节发布 v1.0.18 commit `410969b7fed5f1837078f6731271bf6c18381faf` 的 11,064-byte compatibility artifact（SHA-256 `8fab5e1eff857b3e7d0265d417c0da195194431e0cee37fdc95e4b1a3337a6d7`），超过正式 Profile 的 7,680-byte 可用预算；这是有意保留的过渡例外，并由 size + hash 非增长守卫约束。core 与 memory 的新 descriptor 则从同一 Tool Registry 生成，各自严格执行 7,680-byte 预算；legacy 后续只允许缩小或移除，不允许重新生成或抬高 ceiling。

升级前已被 Agent 缓存在内存里的无 Profile 单入口会继续访问 `/mcp`。该 legacy 入口仅作为迁移窗口保留完整 11 工具，避免旧会话在升级中途静默丢失 memory 能力；它不会写入任何新配置。ATM 启动后仍会把磁盘上的旧配置迁移为显式 core / memory，Agent 客户端重启后即回到拆分工具面。

正式 Profile 的 descriptor bytes、Profile hash、逐工具安全注解与 schema hash 由 registry 生成到 `docs/generated/mcp-tool-contracts.md`；文档一致性测试会拒绝手工漂移。

工作中发现新的独立事项时，用 `atm_task_create` 的 `discovered_from` 指向已有任务，或用 `discovered_from_ref` 指向同一批次的 `client_ref`。这是可追溯的发现关系，不会阻塞 ready queue，也不应替代 `depends_on`。

## 稀疏控制面约束

- 不要按分钟轮询或重复上报相同百分比。
- 进度 `summary` 上限为 500 字；仍应保持信息密度，避免为填满上限而复制日志或上下文。
- 写操作必须提供新的 `op_id`；重试同一请求时复用原 `op_id`。
- 更新任务必须带 `expected_version`。发生 `VERSION_CONFLICT` 后重新读取任务再决定，不要盲目覆盖。
- `claim` 只领取依赖已满足的任务；接管过期领取必须显式使用 `takeover_stale`。
- 阻塞必须填写原因；等待用户和等待 Agent 必须写清所需条件。
- mutation 返回短 ACK；需要新状态时再用 `atm_delta` 或单任务读取。
- `complete` 的门禁错误会一次返回检查项、证据、子任务、阻塞、依赖、验收和当前状态中的全部已知缺口；调用方应一次性处理全部 reasons，不要按第一条错误循环试探。

### 精确读取与长字段续读

`atm_search` 会先处理公开精确标识，再进入全文搜索：WorkItem/Record 使用公开 key；Progress 与 Session 使用 `progress:<ULID>`、`session:<ULID>`；写操作可用 `op_id` 并按 `session` 收窄。`field_mask` 只返回点名字段；响应给出 continuation cursor 时，后续请求必须保持相同项目、实体、类型和字段集合。cursor 经过签名并绑定字段内容，篡改、跨实体复用或内容变化都会 fail closed，不能通过改 token 猜测续页。

### MCP 与 REST 字段名

MCP 工具参数统一使用 `snake_case`，例如 `project_code`、`session_id`、`op_id`、`task_key`、`expected_version`、`field_mask`。REST JSON 统一使用 `camelCase`，对应为 `projectCode`、`sessionId`、`opId`、`taskKey`、`expectedVersion`、`fieldMask`。两套入口语义相同但不会混收命名；从 MCP 示例切到 REST 时必须按此规则转换，不能把一次参数拒绝当作端点不存在。

错误响应中的 `path` 始终沿用当前入口的公开字段名，批量条目会包含数组下标；调用方应一次修复 `issues` 中列出的全部字段后再重试。

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
