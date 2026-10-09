# ATM Agent 快速入门

> MCP surface `v6`。`atm_begin` 回执里的 `surface_version` 与此不同时，说明客户端缓存的工具表或本文档过期了：重载 MCP。

## 最短流程

1. `atm_begin(agent_id, cwd)`：开工只调这一次，直接用返回的 brief。在仓库里第一次用时加 `allow_project_create: true`。
2. 没有现成任务就 `atm_task_create(items: [{title, acceptance}])`，新任务默认 `READY`。
3. `atm_task_patch(task_key, operation: "start")`：`start` 就是领取并开工，不需要先 `claim`。
4. 干活。阶段性结果写 `atm_progress_add(task_key, summary)`；决策、事实、风险写 `atm_record(kind, title, summary)`。
5. `atm_task_patch(task_key, operation: "complete", note, evidence)`：没 `start` 过的会自动先 `start`。
6. `atm_end(summary)`。

- **可以省略**：begin 之后省略 `project`，写操作还可以省略 `op_id`；Claude Code、Codex 读写都可以省略 `session`，其他客户端带上 begin 返回的 `session`。本会话持有的任务不需要 `expected_version`，只有 `edit`、`cancel`、`reopen` 和别人的任务需要。
- **出错时**：照错误里的 `fix` 执行（见附录「错误信封」）。`fix.call` 是参数已经补齐的完整调用，可以原样执行。
- **读 brief**：`next` 与 `nextTitles` 是可以开工的任务及标题，`ready`、`open` 是 READY 与未完成的任务数，`own` 是你已经领取的任务（直接写，不用再 `start`）。
- **上下文压缩后**：调无参的 `atm_brief()`，不要重新 begin。
- **子代理、复核**：`atm_begin(role: "SUBAGENT" | "REVIEWER")` 开自己的会话，之后显式传 `session`；它们不会顶替主会话。

## ATM 是什么

AyanamiTaskManager（ATM）是本机 Agent 项目的任务账本：统一保存目标、任务、会话、进度、证据、阻塞和交接。它不是聊天记录或日志仓库；只在工作状态有实际变化时写入。

## 服务怎么找到

MCP 客户端经 `atm-mcp.exe` 接入时不需要做任何发现：桥每次请求都重新读服务描述文件，服务重启后自动跟上；服务没在运行时，桥会唤醒桌面应用。

直接调 HTTP 时读 `%LOCALAPPDATA%\AyanamiTaskManager3\runtime\daemon.json`（设置了 `ATM3_DATA_DIR` 时以它为数据根），拿到 `endpoint`、`token`、`pid`、`instanceId`、`version`、`startedAt`。服务只监听 `127.0.0.1`，`Host` 头必须是 `127.0.0.1:<端口>`。正式桌面 daemon 每次启动都会生成新的 token 和端口，旧的 endpoint / token 不能复用。不要猜端口，也不要把 token 写入仓库、日志、对话或 ATM 记录。

这个 token 是 Agent 凭证。恢复、移入垃圾箱、归档项目，批准恢复请求，新建或恢复备份，导出，改设置，改动保存的视图，经 REST 改共享知识，强制关闭会话，以及同步和派单的配置：这些「用户的决定」对 Agent 一律返回 `403 USER_AUTHORIZATION_REQUIRED`。只能请用户在 ATM 界面里操作，不要重试，也不要找别的入口。完整边界见 `%LOCALAPPDATA%\AyanamiTaskManager\docs\security-model.md`。

## 服务没在运行

启动 AyanamiTaskManager 桌面应用；窗口关到托盘后服务照常运行。`daemon.json` 指向已经退出的进程时，先完全退出应用再重新启动，不要复用过期的 endpoint / token。

## 接入各个客户端

ATM 登记两个 MCP Profile，两者共用同一个服务和数据库：

| Profile                       | 工具                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ayanami-task-manager-core`   | `atm_begin`、`atm_brief`、`atm_task_list`、`atm_task_get`、`atm_task_create`、`atm_task_patch`、`atm_progress_add`、`atm_record`、`atm_end` |
| `ayanami-task-manager-memory` | `atm_search`、`atm_knowledge_search`、`atm_knowledge_get`、`atm_knowledge_save`                                                             |

- 旧配置里的 `ayanami-task-manager-actions` 照常可用：它是 core 的别名，只发布 `atm_task_patch`，core 的其他工具照样能调。之后 ATM 会把它从配置里去掉。
- `atm_delta`、`atm_feedback` 已经并入 `atm_brief(since_seq)` 与 `atm_record(kind: "ATM_FEEDBACK")`。旧名仍可调用，只是不再出现在工具列表里。
- 设置里关掉 memory Profile 是主动的降级：只失去搜索和共享知识，任务、进度、记录都在 core 里。改完要重载 Agent 客户端。

stdio 命令是 `%LOCALAPPDATA%\AyanamiTaskManager\current\resources\atm-mcp.exe`，参数只有 `--profile core` 或 `--profile memory`，不需要环境变量。不带 `--profile` 时它报 `MCP_PROFILE_REQUIRED` 退出。不要把桌面应用的 GUI EXE 当作 stdio 命令。用 stdio 而不是 streamable-http：后者要把 endpoint 和 token 写进配置，而两者每次启动都会变。

- **Codex**：「设置 → Agent 接入 → 安装 Codex 配置」。ATM 会备份并最小合并 `%USERPROFILE%\.codex\config.toml`，然后让 Codex 重新加载 MCP。
- **Claude Desktop**：「安装 Claude 配置」。ATM 会备份并最小合并 `%APPDATA%\Claude\claude_desktop_config.json`，然后重启 Claude Desktop。
- **Kimi Code**：在 Kimi Code 一栏点「安装」。ATM 会备份并最小合并 `%USERPROFILE%\.kimi-code\mcp.json`（只替换 ATM 自己的条目，写明 `"transport": "stdio"`），在 `%USERPROFILE%\.kimi-code\AGENTS.md` 写入受管规则区块，并把 `atm-plan`、`atm-task`、`atm-knowledge` 装到 `%USERPROFILE%\.kimi-code\skills`。以前手写在 `AGENTS.md` 里的 ATM 规则不会被删，重复的那段请自行删掉。
- **Claude Code**：它从不读 `claude_desktop_config.json`，MCP 注册在 `%USERPROFILE%\.claude.json`（user scope）；规则 `~/.claude/CLAUDE.md` 与技能 `~/.claude/skills` 和 Claude Desktop 共用。「安装 Claude Code 配置」一律经 `claude` CLI 完成，找不到 CLI 时明确报错，不会直接改那个文件（它由 Claude Code 高频整体重写）。等价的手工命令：

```powershell
claude mcp add-json ayanami-task-manager-core '{"command":"<atm-mcp.exe>","args":["--profile","core"]}' --scope user
claude mcp add-json ayanami-task-manager-memory '{"command":"<atm-mcp.exe>","args":["--profile","memory"]}' --scope user
```

`<atm-mcp.exe>` 是 `%LOCALAPPDATA%\AyanamiTaskManager\current\resources\atm-mcp.exe` 的完整展开（JSON 里反斜杠写成 `\\`）。

项目规则应包含：

> 执行项目前先访问 ATM 工具，并阅读 %LOCALAPPDATA%\AyanamiTaskManager\ATM_AGENT_GUIDE.md；后续所有任务执行均依赖 ATM。

## 参数怎么写

工具说明（`description`）里写全了每个工具的必填项、枚举和上限，以它为准。有的客户端会把 schema 里的 `enum`、`required`、`default` 渲染丢，所以不要以眼前渲染出来的 schema 为准。

- **省略与默认值**：
  - begin 之后省略 `project` 时从 `session` 推出。
  - 省略 `op_id` 时由 `atm-mcp.exe` 为这次调用生成，网络或服务重启导致的重试复用同一个，所以响应丢了也只执行一次。要跨调用判重（例如你自己隔了别的写入再重试），自己传 `op_id`；直接调 HTTP 时不传 `op_id` 就没有幂等保护。
  - 省略 `session`：只有 Claude Code、Codex 这类「一个连接一个对话」的客户端有默认会话，取的是本连接最近活跃的主会话（PRIMARY）。其他客户端省略时报 `SESSION_REQUIRED`，`fix` 是补上 `session` 再调同一个工具。
- **别名**：`project_code` → `project`，`session_id` → `session`，`key` / `task` / `work_item_key` → `task_key`，`op` → `operation`，`checklist_items` → `checklist`；`description` 也收 `detail`、`details`、`body`，进度与结束的 `summary` 也收 `content`、`body`，记录的 `detail` 也收 `details`、`content`、`body`。用了别名时回执里有 `normalized`，下次直接用规范名。
- **宽松解析**：字段名和枚举都不分大小写；显式 `null` 视同省略；`"true"`、数字字符串照收；只给一个值的列表可以不包数组；未知字段报 `INVALID_ARGUMENT`，带 `did_you_mean`。
- **单条 patch** 直接把字段写在顶层：`{task_key, operation, …}`；多条才放 `items`。
- **建任务**：`client_ref` 可选，默认是本批序号（`"1"` 起）；`depends_on`、`parent`、`discovered_from` 可以写已有任务 key、本批 `client_ref` 或序号。回执里 `refs` 给出序号和 `client_ref` 到任务 key 的对照，`checklist` 给出新检查项的 id。项目还没有活动目标时，ATM 自动补一个「项目名（自动补建）」目标和一个「执行」里程碑，之后按实际规划改写或另建目标。
- **推断**：`atm_progress_add` 有 `task_key` 就是任务进度，否则是项目进度；不带 `percent` 时保留原来的进度。`atm_end` 不带 `outcome` 时，本会话链还持有未完成的领取就是 `paused`，否则 `completed`。
- **长 summary**：`atm_record` 的 `summary` 超过 300 个字符时，服务端截断它，全文移进 `detail`，回执里给出 `adjusted`。进度与结束的 `summary` 上限 500。
- **搜索**：`atm_search` 的 `query` 按空白拆词，每个词都要命中，最多 8 个词，超出直接报错；双引号括起的一段按相邻短语匹配；任务或记录 key 直接精确读取。写回执的 `details_cursor` 就是一次 `atm_search` 调用。
- **REST** 用同一个 endpoint 和 token，JSON 字段写 `camelCase` 或 `snake_case` 都行。

编排工具结果时只输出一份业务载荷：`result.structuredContent ?? result.content`。

## 会话

- **begin 的结果**（`outcome`）：
  - `CURRENT`：接回本连接已有的主会话（上下文压缩后又调了一次 begin 也是这样，想要新会话就传 `resume: false`）。
  - `RESUMED`：接回一个还没关闭的会话。
  - `SUCCESSOR`：上一个会话的客户端已经退出，新开一个接续它的会话，它的领取转过来。
  - `CREATED`：全新的会话。有多个可接续的旧会话时也是 `CREATED`，同时给出 `resume_candidates`，要接哪个就显式传 `predecessor_session_id`，不要猜。
  - `QUICK`：`mode: "quick"` 且没认出项目时开的临时任务。
- `mode` 默认 `auto`：认不出项目时报 `PROJECT_REQUIRED`，`fix` 是带 `allow_project_create: true` 的同一次 begin；不会悄悄建临时任务。cwd 绑定的项目在垃圾箱里时报 `PROJECT_DB_UNAVAILABLE`，只有用户能在「项目 → 垃圾箱」恢复。
- **超时按客户端进程判断**：客户端进程退出，会话立即关闭；进程还在时 120 分钟没有任何调用才关闭；识别不出客户端进程时 5 分钟。安静写代码不会丢会话。
- **领取租约** 10 分钟。本会话的写入，以及本会话的 `atm_brief`、`atm_task_list`、`atm_task_get` 都会续租。
- **`atm_end`** 只能结束自己会话链上的会话；结束别人的会话要用户在界面里强制关闭（Agent 得到 `403 USER_AUTHORIZATION_REQUIRED`）。`release_claims` 默认 `true`；`paused`、`retired` 会给未完成的领取写交接。会话已经超时关闭时，`atm_end` 只认它已有的接续会话，没有就报 `SESSION_CLOSED`。
- 回执或 brief 里出现 `session_state` 时，说明这个会话已经不是在线状态（例如按 `op_id` 重放到了一个已关闭的会话）。

## 领取与版本

- **领取归属**：别人领取着、租约还没过期的任务，Agent 只能 `claim`、`start`、`release`，其余写入（含进度、检查项）报 `CLAIM_NOT_OWNED`，`fix` 指向 READY 的任务列表。同一会话链（前序和后继）算同一个领取者。用户的领取没有会话，对 Agent 不构成排他锁。过期领取的接手要显式 `takeover_stale: true`，不要抢占活着的领取者。
- **版本号**：用上一次回执里 `entities[].version`，不要自己加一。父任务的版本只在汇总进度真的变了时才变，子任务的写入一般不会让父任务的版本过期。什么时候必须带 `expected_version` 见附录的表。

## 检查项与完成

- `complete` 可以同时带 `note`、`evidence` 和 `checklist`。`checklist[].item` 写检查项 id、从 1 开始的序号或标题（标题重名时报 `VALIDATION_ERROR` 并列出候选）。
- 单独改检查项用 `operation: "checklist"`：只有一条且没带 `expected_version` 时按单条处理，单条的版本参数叫 `expected_checklist_version`，比的是检查项自己的版本；多条时 `expected_version` 比的是任务版本，整批要么都成功要么都不写。旧名 `checklist_single`、`checklist_batch` 照收，回执里的 `deprecations` 会说明该换成什么。
- 多条检查项只有版本问题时报 `VERSION_CONFLICT`（可重试）；还有别的问题时报 `COMPLETION_GATE_FAILED`，汇总全部原因。
- 验收已经完成时，一次 `verify_and_complete` 就够，不必拆成 `verify`、`complete` 两次；它照样过完成闸门。

### 完成闸门

`complete` 一次检查全部条件，不通过时在一个 `COMPLETION_GATE_FAILED` 里返回所有原因（`details.reasons[].code`）。先一次处理完全部原因，不要只修第一条就重试。

| `code`                  | 含义与出路                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `CHECKLIST_INCOMPLETE`  | 还有检查项停在 TODO / DOING。置为 `DONE`，或者确实不做就 `SKIPPED`。                                          |
| `EVIDENCE_MISSING`      | 该检查项要求证据。挂上真实证据，或者置 `SKIPPED`（跳过的不再要求证据）。不要为了打勾编证据。                  |
| `CHILD_INCOMPLETE`      | 还有子任务不在 DONE / CANCELLED。                                                                             |
| `BLOCKER_ACTIVE`        | 还有生效的阻塞记录（`blocker_key`）。`start`、`release`、`reopen`，或从 BLOCKED 转成等待，都会解除它。        |
| `DEPENDENCY_INCOMPLETE` | 前置任务还没 DONE。                                                                                           |
| `VERIFICATION_REQUIRED` | 任务要求验收：先 `verify` 再 `complete`，或者用 `verify_and_complete`。                                       |
| `CURRENT_STATE_INVALID` | 当前状态不能完成（闸门只认 `IN_PROGRESS` 与 `VERIFYING`）。原因里的 `legal_operations` 是当前真正可用的操作。 |

## 阻塞与等待

- 推荐用 `atm_task_patch(operation: "block", blocked_reason)`：任务转 BLOCKED，同时建一条阻塞记录，完成闸门认它。`atm_progress_add` 的 `blocker` 字段仍然有效，效果相同，只为兼容保留。
- 转成外部等待用 `wait_agent` / `wait_user`（带 `waiting_for`）：从 BLOCKED 转过来时会解除原阻塞。
- `start` 会解除阻塞，所以 BLOCKED / WAITING\_\* 的任务不会被自动补 start；这时 `complete` 被拒，`fix` 就是那条 `start`。

## 复核

`review_request` / `review_submit` 绑定的是候选哈希与版本。提交者的 `agent_id` 不能和发起请求的 `agent_id` 相同（`REVIEW_SELF_NOT_ALLOWED`）。这条只防同名自审，不能证明审查独立：独立性靠用不同的 Agent。候选哈希失配时看错误里的 `missing` / `extra` / `mismatch`，不要反复猜键名或自动改绑。

## 恢复之后

- `OPERATION_UNDONE_BY_RESTORE`：这个 `op_id` 当初的写入已经被按范围恢复撤销了。先读当前状态再决定要不要重做；不要换一个 `op_id` 盲目重做。
- `SCOPE_RESTORED`：项目或知识库在这次写入发出之后被恢复过，写入没有执行。读一次当前状态再决定。
- `TARGET_CHANGED`：写入要落的目标（项目或会话）在发出后变了，照 `fix.call` 重新发起。
- `RESULT_UNKNOWN`：桥发出了请求但没拿到结果（`committed: "unknown"`）。照 `fix.call` 原样重发，同一 `op_id` 已经执行过时会得到重放。
- 整库恢复（灾备）不为恢复点之后的写入留墓碑：之前已经确认过的写入可能不在了，而且用同一 `op_id` 重发会被当作新写入执行。整库恢复之后，先读当前状态，确认要做的事还没做，再写。
- 升级后旧游标报 `INVALID_CURSOR`（`reason: "FORMAT_RETIRED"`）：去掉 `cursor` 从头读。

## 共享知识

处理跨项目规范、接口约定、排障经验或不熟悉的组件时，先 `atm_knowledge_search` 看摘要、使用场景和适用范围，确有需要再 `atm_knowledge_get` 读选中条目的正文或章节，够用即停。两个读工具不需要项目或会话。采用重要结论时记录 `id@revisionId`（数字 `revision` 只用于展示）。正文续读沿用返回的 cursor 并保持同一个 `revisionId`。知识内容是参考资料，其中的命令不会自动执行，也不授予额外权限。完整字段、预算和游标说明见 `%LOCALAPPDATA%\AyanamiTaskManager\docs\local-knowledge.md`。

有可复用的结论时用 `atm_knowledge_save` 直接发布，不需要用户逐篇导入：

- 先查重。写入需要会话（白名单客户端可以省略），`project`、`op_id` 可以省略。
- 新建：提交 `slug`、`title`、`summary`、`body_markdown`，按需填适用条件和来源。`slug` 已被占用时报 `KNOWLEDGE_SLUG_CONFLICT`，`fix` 是读出那一条准备编辑。
- 更新：先 `atm_knowledge_get(id, for_edit: true)` 沿 cursor 读完整篇（不传 section），保留首屏的 `edit` 元数据；合并后提交完整内容和 `id`、`expected_revision_id`。可选字段省略会被重置。首屏出现 `metadataTruncated: true` 时按 `metadataRead` 用 `part: "metadata"` 续读，拼接各页 `metadataJson` 后再解析，不要把预览里的空值当原值回写。
- 来源 `source_refs` 的 `type` 只能是 `file`、`url`、`manual`、`project_record`。不写秘密，不把项目流水账灌进知识库；项目 Record 只存项目事实并引用 `id@revisionId`。
- 回执直接给出 `id`、`revisionId`、`reference`；它是知识库自己的事务回执，不走项目写入回执。

## 遇到 ATM 的问题时反馈

`atm_record(kind: "ATM_FEEDBACK", title, summary, detail)`：存成当前项目里 topic 为 `atm-agent-feedback` 的一条 RISK 记录，在项目「记录」页可以看到。反馈只写本机 ATM 数据库，不会自动上传到 GitHub 或任何外部服务。`importance` 填真实严重度。

## REST

MCP 之外，Agent 令牌还能用这些 REST 入口：项目列表与详情、新建项目、brief、目标与里程碑的新建（`POST /api/v1/projects/{code}/objectives`、`.../milestones`，里程碑要 `objective_id`）、任务的列出 / 新建 / 读取 / 批量变更、进度、记录、搜索、事件、会话的开启与关闭、临时任务及其晋升、备份列表与 agenttask 导入预览。写操作同样需要会话；要幂等就自己传 `op_id`（不传时服务端每次生成新的）。`/ui/*` 等以用户身份落账的路由不对 Agent 开放。方法用错时返回 `405 METHOD_NOT_ALLOWED`，路径不存在才是 404，不要因为 404 去猜别的路径名。

## 任务拆分

开始实现前先判断当前任务能不能在一个独立工作阶段内完成。包含多个独立交付物、多个验证阶段、明显跨模块，或预计需要较长连续开发时，先用 `atm_task_create` 拆成可以独立完成和验收的子任务，再领取具体的子任务。按「可交付结果 + 可验证验收」拆，不要机械按文件拆。Objective / Milestone / EPIC 表达目标和范围，不作为长期直接执行的单元。工作中发现的独立事项另建任务并传 `discovered_from`，不要误写成阻塞依赖。

## 附录：自动生成的契约

以下各节由代码生成（`apps/desktop/native/http/tests/docs.rs`），与运行中的服务逐字一致。

<!-- WORK_ITEM_OPERATIONS:BEGIN -->

<!-- prettier-ignore-start -->

### 状态与操作（自动生成）

> 由 `atm_domain::work` 的状态机生成。这里只有状态机这一层；依赖、领取、完成门等前置条件另行判定，被拒时照错误里的 `fix` 执行。

| 状态 | 可用操作 → 之后的状态 |
| --- | --- |
| `BACKLOG` | `claim` → `CLAIMED`、`start` → `IN_PROGRESS`、`ready` → `READY`、`complete` → `DONE`、`cancel` → `CANCELLED`、`edit` → `BACKLOG` |
| `READY` | `claim` → `CLAIMED`、`start` → `IN_PROGRESS`、`ready` → `READY`、`complete` → `DONE`、`cancel` → `CANCELLED`、`edit` → `READY` |
| `CLAIMED` | `claim` → `CLAIMED`、`start` → `IN_PROGRESS`、`release` → `READY`、`block` → `BLOCKED`、`complete` → `DONE`、`cancel` → `CANCELLED`、`edit` → `CLAIMED` |
| `IN_PROGRESS` | `start` → `IN_PROGRESS`、`release` → `READY`、`block` → `BLOCKED`、`wait_agent` → `WAITING_AGENT`、`wait_user` → `WAITING_USER`、`verify` → `VERIFYING`、`complete` → `DONE`、`cancel` → `CANCELLED`、`edit` → `IN_PROGRESS` |
| `BLOCKED` | `start` → `IN_PROGRESS`、`release` → `READY`、`block` → `BLOCKED`、`wait_agent` → `WAITING_AGENT`、`wait_user` → `WAITING_USER`、`complete` → `DONE`、`cancel` → `CANCELLED`、`reopen` → `IN_PROGRESS`、`edit` → `BLOCKED` |
| `WAITING_AGENT` | `start` → `IN_PROGRESS`、`release` → `READY`、`block` → `BLOCKED`、`wait_agent` → `WAITING_AGENT`、`verify` → `VERIFYING`、`complete` → `DONE`、`cancel` → `CANCELLED`、`reopen` → `IN_PROGRESS`、`edit` → `WAITING_AGENT` |
| `WAITING_USER` | `start` → `IN_PROGRESS`、`release` → `READY`、`block` → `BLOCKED`、`wait_user` → `WAITING_USER`、`verify` → `VERIFYING`、`complete` → `DONE`、`cancel` → `CANCELLED`、`reopen` → `IN_PROGRESS`、`edit` → `WAITING_USER` |
| `VERIFYING` | `start` → `IN_PROGRESS`、`release` → `READY`、`block` → `BLOCKED`、`wait_agent` → `WAITING_AGENT`、`wait_user` → `WAITING_USER`、`verify` → `VERIFYING`、`complete` → `DONE`、`cancel` → `CANCELLED`、`reopen` → `IN_PROGRESS`、`edit` → `VERIFYING` |
| `DONE` | `reopen` → `IN_PROGRESS`、`edit` → `DONE` |
| `CANCELLED` | `reopen` → `BACKLOG`、`edit` → `CANCELLED` |

`IN_PROGRESS` 上的 `claim` 只在同一条会话链的后继会话接回领取时成立，上表没有列出。

| 操作 | 可以从这些状态发起 | 任务被别人领取时拒绝 |
| --- | --- | --- |
| `claim` | `BACKLOG`、`READY`、`CLAIMED`、`IN_PROGRESS` | 否 |
| `start` | `BACKLOG`、`READY`、`CLAIMED`、`IN_PROGRESS`、`BLOCKED`、`WAITING_AGENT`、`WAITING_USER`、`VERIFYING` | 否 |
| `release` | `CLAIMED`、`IN_PROGRESS`、`BLOCKED`、`WAITING_AGENT`、`WAITING_USER`、`VERIFYING` | 否 |
| `ready` | `BACKLOG`、`READY` | 是 |
| `block` | `CLAIMED`、`IN_PROGRESS`、`BLOCKED`、`WAITING_AGENT`、`WAITING_USER`、`VERIFYING` | 是 |
| `wait_agent` | `IN_PROGRESS`、`BLOCKED`、`WAITING_AGENT`、`VERIFYING` | 是 |
| `wait_user` | `IN_PROGRESS`、`BLOCKED`、`WAITING_USER`、`VERIFYING` | 是 |
| `verify` | `IN_PROGRESS`、`WAITING_AGENT`、`WAITING_USER`、`VERIFYING` | 是 |
| `complete` | `BACKLOG`、`READY`、`CLAIMED`、`IN_PROGRESS`、`BLOCKED`、`WAITING_AGENT`、`WAITING_USER`、`VERIFYING` | 是 |
| `cancel` | `BACKLOG`、`READY`、`CLAIMED`、`IN_PROGRESS`、`BLOCKED`、`WAITING_AGENT`、`WAITING_USER`、`VERIFYING` | 是 |
| `reopen` | `BLOCKED`、`WAITING_AGENT`、`WAITING_USER`、`VERIFYING`、`DONE`、`CANCELLED` | 是 |
| `edit` | `BACKLOG`、`READY`、`CLAIMED`、`IN_PROGRESS`、`BLOCKED`、`WAITING_AGENT`、`WAITING_USER`、`VERIFYING`、`DONE`、`CANCELLED` | 是 |

`claim`、`start`、`release` 本身就是领取规则：能不能接手由领取是否过期、是否同一条会话链决定。

#### 自动补 start

下列写入遇到还没开工的任务时，在同一事务里先 `start` 再执行（调用方能领取时）；遇到 `BLOCKED` / `WAITING_*` 不补（`start` 会解除阻塞），被拒时 `fix` 就是那条 `start`。

| 写入 | `BACKLOG` | `READY` | `CLAIMED` | `IN_PROGRESS` | `BLOCKED` | `WAITING_AGENT` | `WAITING_USER` | `VERIFYING` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `block` | 先 start | 先 start | 先 start | — | — | — | — | — |
| `wait_agent` | 先 start | 先 start | 先 start | — | — | — | 拒绝，fix 给 start | — |
| `wait_user` | 先 start | 先 start | 先 start | — | — | 拒绝，fix 给 start | — | — |
| `verify` | 先 start | 先 start | 先 start | — | 拒绝，fix 给 start | — | — | — |
| `complete` | 先 start | 先 start | 先 start | — | 拒绝，fix 给 start | 拒绝，fix 给 start | 拒绝，fix 给 start | — |
| `verify_and_complete` | 先 start | 先 start | 先 start | — | 拒绝，fix 给 start | — | — | — |
| `atm_progress_add（任务进度）` | 先 start | 先 start | 先 start | — | — | — | — | — |

「—」：不涉及自动 start，按上面的状态表处理。

任务进度的 start 是尽力而为：前置没完成或领不到时不补、不报错，进度照记，任务保持原状态；带 `blocker` 时补上 start 再阻塞，补不上就按原状态判定（`READY` 上不能阻塞）。

#### 什么时候要带 `expected_version`

| 写入 | 本会话链持有领取 | 没有持有（别人的任务、未领取） |
| --- | --- | --- |
| `claim` | 可省略 | 必填 |
| `start` | 可省略 | 必填 |
| `release` | 可省略 | 必填 |
| `ready` | 可省略 | 必填 |
| `block` | 可省略 | 必填 |
| `wait_agent` | 可省略 | 必填 |
| `wait_user` | 可省略 | 必填 |
| `verify` | 可省略 | 必填 |
| `complete` | 可省略 | 必填 |
| `cancel` | 必填 | 必填 |
| `reopen` | 必填 | 必填 |
| `edit` | 必填 | 必填 |
| `verify_and_complete` | 可省略 | 必填 |
| `checklist`（1 条） | 可省略 | 必填 |
| `checklist`（多条） | 可省略 | 必填 |
| `review_request` | 必填 | 必填 |
| `review_submit` | 必填 | 必填 |

「持有领取」以执行那一刻为准，包括这次 `claim` / `start` / 自动 start 刚拿到的领取。版本号用上一次回执里的 `entities[].version`，不要自己加一。

<!-- prettier-ignore-end -->

<!-- WORK_ITEM_OPERATIONS:END -->

<!-- TASK_PATCH_COMPOSITE:BEGIN -->

<!-- prettier-ignore-start -->

### task_patch 的操作与字段（自动生成）

> 由 `atm-http` 的 task_patch 映射生成（`write::COMMON`、`write::operation_fields`、`write::COMPOSITE`）。

单条直接把字段写在顶层：`{task_key, operation, …}`；多条放进 `items`，每条同形，两种写法不能混用。每条都能写的字段：`task_key`、`operation`、`expected_version`、`takeover_stale`。

| operation | 额外字段（粗体必填） | 只能单条 |
| --- | --- | --- |
| `start` | — |  |
| `complete` | `note`、`evidence`、`checklist` |  |
| `verify` | — |  |
| `verify_and_complete` | — | 是 |
| `block` | **`blocked_reason`** |  |
| `wait_user` | **`waiting_for`** |  |
| `wait_agent` | **`waiting_for`** |  |
| `ready` | — |  |
| `release` | — |  |
| `claim` | — |  |
| `cancel` | `cancel_reason`、`duplicate_of`、`superseded_by` |  |
| `reopen` | — |  |
| `edit` | `title`、`description`、`acceptance`、`target_date`、`parent_key`、`assignee_agent_id`、`depends_on`、`discovered_from`、`expected_fields` |  |
| `checklist` | `checklist`、`evidence` | 是 |
| `review_request` | **`parent_checklist_id`**、**`expected_parent_checklist_version`**、**`candidate_hashes`** | 是 |
| `review_submit` | **`request_key`**、**`verdict`**、**`candidate_hashes`**、**`evidence`** | 是 |

只能单条的操作不放进多条的 `items`，也不收 `takeover_stale`。旧名 `checklist_single`、`checklist_batch` 照收，等同于 `checklist`（按条数分派）。

<!-- prettier-ignore-end -->

<!-- TASK_PATCH_COMPOSITE:END -->

<!-- MUTATION_ACK_CONTRACT:BEGIN -->

<!-- prettier-ignore-start -->

### 写入回执（自动生成）

`atm_task_create`、`atm_task_patch`、`atm_progress_add`、`atm_record`、`atm_end` 等项目写入都返回同一形状的回执；`atm_knowledge_save` 写的是共享知识库，回执另有形状，不适用本节。

| 字段 | 出现 | 含义 |
| --- | --- | --- |
| `ok` | 总有 | 恒为 `true`。写入失败时返回的是错误信封（见下一节），不是 `ok:false` 的回执。 |
| `op_id` | 总有 | 这次写入的幂等键。省略时由 ATM 生成；同一写入要自己重试时，带上这个值，结果是重放而不是再执行一次。 |
| `project` | 总有 | 规范化后的项目代码。 |
| `session` | 总有 | 回执所属的会话：会话被接续时是后继会话，重放时是当初写下回执的那个会话。 |
| `session_rebound` | 总有 | 原会话已经失效、ATM 把这次写入接到了同一条会话链的后继会话上时为 `true`。 |
| `replayed` | 总有 | 同一 `op_id` 的重放：这次没有再执行，返回的是当初的结果。 |
| `entities` | 总有 | 受影响实体的有界预览。每项有 `entity_type`、`key`、`version`；任务还有 `status`、`waiting_on`、`claimed_by_session_id`、`claim_lease_until`。版本是这次写入之后的版本，下一次写同一实体直接用它，不要自己加一。 |
| `entity_count` | 总有 | 受影响实体的总数，不受预览截断影响。 |
| `entities_truncated` | 总有 | 预览被截断时为 `true`；这时原样执行 `details_cursor` 取全部实体。 |
| `details_cursor` | 总有 | 可以原样执行的 `atm_search` 调用，回查这次写入的全部实体。 |
| `normalized` | 按需 | 参数里用了别名或非规范写法时出现：`[{from, to}]`，说明改成了哪个规范名。下次直接用规范名。 |
| `auto_applied` | 按需 | 自动补了 `start` 时出现：`[{task_key, operations}]`。 |
| `refs` | 按需 | `atm_task_create`：本批序号（`"1"` 起）与 `client_ref` 到任务 key 的对照。 |
| `checklist` | 按需 | `atm_task_create`：每个新任务的检查项 id，按任务 key 分组。 |
| `adjusted` | 按需 | 服务端调整了参数时出现，例如 summary 太长被截断、全文移到 detail：`[{field, action, moved_to}]`。 |
| `deprecations` | 按需 | 用了仍然照收的旧写法时出现，说明该换成什么。 |
| `merges` | 按需 | `edit` 带 `expected_fields` 时，与并发修改安全合并的字段。 |

下例是一次真实的 `atm_task_patch` 回执：用了别名 `key`，任务还没开工所以先自动 `start` 再 `verify`。会话 id 与租约时间换成了占位符。

```json
{
  "ok": true,
  "op_id": "op-example",
  "project": "AYT-0001",
  "session": "<session>",
  "session_rebound": false,
  "replayed": false,
  "entities": [
    {
      "entity_type": "WORK_ITEM",
      "key": "AYT-0001-T-0001",
      "version": 3,
      "status": "VERIFYING",
      "waiting_on": null,
      "claimed_by_session_id": "<session>",
      "claim_lease_until": "<lease>"
    }
  ],
  "entity_count": 1,
  "entities_truncated": false,
  "details_cursor": {
    "name": "atm_search",
    "arguments": {
      "project": "AYT-0001",
      "op_id": "op-example",
      "session": "<session>",
      "field_mask": [
        "op_id",
        "entities"
      ],
      "max_chars": 50000
    }
  },
  "auto_applied": [
    {
      "task_key": "AYT-0001-T-0001",
      "operations": [
        "start"
      ]
    }
  ],
  "normalized": [
    {
      "from": "key",
      "to": "task_key"
    }
  ]
}
```

<!-- prettier-ignore-end -->

<!-- MUTATION_ACK_CONTRACT:END -->

<!-- ERROR_ENVELOPE:BEGIN -->

<!-- prettier-ignore-start -->

### 错误信封（自动生成）

工具调用出错时 `isError: true`，`structuredContent` 是下面的信封。照 `fix` 执行就是下一步，不需要读文档。

| 字段 | 出现 | 含义 |
| --- | --- | --- |
| `ok` | 总有 | 恒为 `false`。 |
| `code` | 总有 | 错误码，全表见 `docs/generated/error-codes.md`。 |
| `message` | 总有 | 给人看的说明。 |
| `retryable` | 总有 | 原样重试同一调用有没有可能成功（等待后）。 |
| `committed` | 总有 | 这次写入有没有落库：`false` 没有，`true` 已经落库（不要重试，按 fix 往下走），`"unknown"` 不确定（按 fix 原样重试，同一 `op_id` 会得到重放）。 |
| `fix` | 总有 | 下一步怎么做，`kind` 见下表。带 `call` 的可以原样执行：参数已经补齐并通过 schema。 |
| `problems` | 参数错误 | `INVALID_ARGUMENT` 的逐项问题：`path`、`problem`，以及按需的 `got`、`allowed`、`did_you_mean`。 |
| `state` | 按需 | 与错误有关的当前状态（例如任务现在的状态与版本），先读再决定时不必再查一次。 |
| `details` | 按需 | 其余结构化细节。 |

| `fix.kind` | 怎么做 |
| --- | --- |
| `call` | 执行 `fix.call`：改正后的同一调用，或者先做的那一步（例如 `start`）。 |
| `reread` | 先执行 `fix.call` 读一次当前状态，再决定下一步。 |
| `ask_user` | 把 `fix.message` 转告用户，由用户处理。 |
| `wait` | 等 `fix.retry_after_ms` 毫秒后重试；有 `fix.call` 时执行它。 |
| `add_param` | 补上 `fix.param` 再调 `fix.tool`（例如带上 `atm_begin` 返回的 session）。 |
| `none` | 内部错误，或者 Agent 碰不到的错误；不要重试，告诉用户。 |

下例是一次真实的出错调用：`operation` 写成了 `complet`。`fix.call` 是改正后的完整调用，可以原样执行。会话 id 换成了占位符。

```json
{
  "ok": false,
  "code": "INVALID_ARGUMENT",
  "message": "参数不合法：operation",
  "retryable": false,
  "committed": false,
  "fix": {
    "kind": "call",
    "call": {
      "name": "atm_task_patch",
      "arguments": {
        "project": "AYT-0001",
        "session": "<session>",
        "task_key": "AYT-0001-T-0001",
        "operation": "complete",
        "op_id": "op-typo"
      }
    },
    "why": "按 problems 更正后的同一调用（did_you_mean 已代入，不起作用的参数已去掉）"
  },
  "problems": [
    {
      "path": "operation",
      "problem": "enum",
      "got": "complet",
      "did_you_mean": "complete",
      "allowed": [
        "start",
        "complete",
        "verify",
        "verify_and_complete",
        "block",
        "wait_user",
        "wait_agent",
        "ready",
        "release",
        "claim",
        "cancel",
        "reopen",
        "edit",
        "checklist",
        "review_request",
        "review_submit"
      ]
    }
  ]
}
```

<!-- prettier-ignore-end -->

<!-- ERROR_ENVELOPE:END -->

## 完整文档在哪

- Agent 协议与协作细节：`%LOCALAPPDATA%\AyanamiTaskManager\docs\agent-integration.md`
- 用户操作：`%LOCALAPPDATA%\AyanamiTaskManager\docs\user-guide.md`
- 故障排查：`%LOCALAPPDATA%\AyanamiTaskManager\docs\troubleshooting.md`
- 架构与数据边界：`%LOCALAPPDATA%\AyanamiTaskManager\docs\architecture.md`、`%LOCALAPPDATA%\AyanamiTaskManager\docs\data-model.md`
- 本地认证、cursor、路径与事务安全边界：`%LOCALAPPDATA%\AyanamiTaskManager\docs\security-model.md`
- MCP 工具契约与 Profile hash：`%LOCALAPPDATA%\AyanamiTaskManager\docs\generated\mcp-tool-contracts.md`
- 任务状态与操作表：`%LOCALAPPDATA%\AyanamiTaskManager\docs\generated\work-item-operations.md`
- 写入回执：`%LOCALAPPDATA%\AyanamiTaskManager\docs\generated\mutation-acknowledgement.md`
- 错误信封与全部错误码：`%LOCALAPPDATA%\AyanamiTaskManager\docs\generated\error-codes.md`
- 最新在线版本：`https://github.com/ayanamislover/AyanamiTaskManager`
