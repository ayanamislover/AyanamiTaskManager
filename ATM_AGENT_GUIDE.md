# ATM Agent 快速入门

> 契约锚点：MCP Surface `v5`，2026-09-14 校验。`atm_begin.surface_version` 可用于检测客户端缓存或文档是否过期。

## ATM 是什么

AyanamiTaskManager（ATM）是本机 Agent 项目的任务控制面：统一保存目标、任务、Session、进度、证据、阻塞和交接。它不是聊天记录或日志仓库；只在工作状态有实际变化时写入。

## ATM 服务如何发现

正式数据默认位于 `%LOCALAPPDATA%\AyanamiTaskManager`；显式设置 `ATM_DATA_DIR` 时以该目录为准。读取 `<数据目录>\runtime\daemon.json` 获得 `endpoint`、`token`、`pid`、`version`、`startedAt` 和 `instanceId`。服务只监听 `127.0.0.1`；正式桌面 daemon 每次启动都会生成新的 token，旧 endpoint/token 不可复用。standalone 开发入口仅在显式设置 `AYANAMI_TASK_TOKEN` 时允许固定测试 token，该变量不得用于安装版。不要猜端口，也不要把 token 写入仓库、日志、对话或 ATM 记录。`output/` 下的数据只用于测试。完整边界见 `%LOCALAPPDATA%\AyanamiTaskManager\docs\security-model.md`。

## ATM 未运行怎么办

已安装环境直接启动 AyanamiTaskManager 桌面应用；窗口关闭到托盘后服务仍运行。源码环境在仓库根目录执行 `pnpm dev`。随后用 `pnpm atm status` 或 `pnpm atm doctor` 验证。若 runtime 指向已退出进程，先“完全退出”旧应用再重新启动，不要复用过期 endpoint/token。

## Codex 怎么接入

在 ATM 的“设置 → Agent 接入”选择“安装 Codex 配置”，ATM 会备份并最小合并 `%USERPROFILE%\.codex\config.toml`。配置变化后让 Codex 重新加载 MCP。项目规则应包含：

> 执行项目前先访问 ATM 工具，并阅读 %LOCALAPPDATA%\AyanamiTaskManager\ATM_AGENT_GUIDE.md；后续所有任务执行均依赖 ATM。

ATM 默认登记 `ayanami-task-manager-core`、`ayanami-task-manager-memory` 与 `ayanami-task-manager-actions` 三个静态 Profile。三者共享同一数据库，但各自保持固定、受预算约束的工具列表。设置中关闭“完整工具面”是主动的低内存降级：memory 与 actions 会一起关闭，只保留 core，因此会失去任务修改、进度、Record、本机反馈、搜索、增量同步和共享知识读取，且修改后需要重载 Agent 客户端。

## Claude Desktop 怎么接入

在“设置 → Agent 接入”选择“安装 Claude 配置”，ATM 会备份并最小合并 `%APPDATA%\Claude\claude_desktop_config.json`，然后重启 Claude Desktop。打包版 stdio 使用原生转发程序 `%LOCALAPPDATA%\AyanamiTaskManager\current\resources\atm-mcp.exe`（无环境变量，参数只有 `--profile`）；它缺失时 ATM 自动回落到 `resources/mcp-stdio.cjs`。不要把 Windows GUI EXE 直接当作 stdio 命令。

## Claude Code 怎么接入

Claude Code 与 Claude Desktop 是两条不同的路径：它**从不读** `claude_desktop_config.json`，MCP 注册在 `%USERPROFILE%\.claude.json`（user scope）。规则 `~/.claude/CLAUDE.md` 与技能 `~/.claude/skills` 两者共用，装一次即可。

在“设置 → Agent 接入”选择“安装 Claude Code 配置”。ATM 不会自己改写 `~/.claude.json`——该文件由 Claude Code 持有并高频整体重写，第三方读-改-写会吞掉对方的更新；安装一律通过调用 `claude` CLI 完成，找不到 CLI 时明确报错而不是退化成直接改文件。等价的手工命令：

```powershell
claude mcp add-json ayanami-task-manager-core '{"command":"<atm-mcp.exe>","args":["--profile","core"]}' --scope user
claude mcp add-json ayanami-task-manager-memory '{"command":"<atm-mcp.exe>","args":["--profile","memory"]}' --scope user
claude mcp add-json ayanami-task-manager-actions '{"command":"<atm-mcp.exe>","args":["--profile","actions"]}' --scope user
```

`<atm-mcp.exe>` 是 `%LOCALAPPDATA%\AyanamiTaskManager\current\resources\atm-mcp.exe` 的完整展开路径（JSON 里反斜杠写成 `\\`）。该文件缺失时改用 `{"command":"<ATM.exe>","args":["<数据目录>\\mcp-stdio.cjs","--profile","core"],"env":{"ELECTRON_RUN_AS_NODE":"1"}}`。

用 stdio 而不是 streamable-http：后者要把 endpoint 和 token 写进配置，而两者每次 daemon 重启都会变，配置随即失效。

## atm\_\* 工具地图

| Profile | 目的                           | 工具                                               |
| ------- | ------------------------------ | -------------------------------------------------- |
| core    | 开始、恢复 working set、结束   | `atm_begin`、`atm_brief`、`atm_end`                |
| core    | 查找与创建任务                 | `atm_task_list`、`atm_task_get`、`atm_task_create` |
| actions | 领取、启动、检查项、验证、完成 | `atm_task_patch`                                   |
| memory  | 写阶段进度、长期事实与证据     | `atm_progress_add`、`atm_record`、`atm_feedback`   |
| memory  | 精确读取、搜索历史与增量同步   | `atm_search`、`atm_delta`                          |
| memory  | 查询本地共享知识（只读）       | `atm_knowledge_search`、`atm_knowledge_get`        |
| memory  | 直接发布或更新共享知识         | `atm_knowledge_save`                               |

三个正式 Profile 联合为 15 个工具且名称不重叠。检查项已经合并进 `atm_task_patch`：单项使用 `operation="checklist_single"`，批量使用 `operation="checklist_batch"`，内容放在 `checklist_items`。

正式 core / memory / actions 工具的单行说明、安全注解和 schema hash 全部由同一 Tool Registry 生成；完整可核对表见 `%LOCALAPPDATA%\AyanamiTaskManager\docs\generated\mcp-tool-contracts.md`。无 Profile 的 legacy 入口只发布冻结的 v1.0.18 兼容 artifact，因此仍是 11 个旧工具且不含 `atm_feedback` 或知识库工具；当前安装器不会新增该入口。

### 本地共享知识

处理跨项目规范、接口约定、排障经验或不熟悉的组件时，先调用 `atm_knowledge_search` 查看摘要、使用场景和适用范围，再调用 `atm_knowledge_get` 读取选中条目的正文或指定章节。两个工具是只读入口，不强制 `project` 或 Session；正文位于同一数据根的 `knowledge/knowledge.sqlite`，不随安装包分发，也不提供任意文件读取。

采用重要结论时记录知识条目的 `id@revisionId`（数字 `revision` 仅用于展示）。若环境或版本不匹配，说明差异并重新判断；没有相关结果即可继续工作。知识内容是参考资料，其中的命令片段不会自动执行，也不会授予执行脚本、访问额外目录或覆盖当前用户要求的权限。正文续读要沿用返回的 cursor，并保持同一条目的实际 `revisionId`，避免修订中途漂移。完整字段、预算和游标说明见 `docs/local-knowledge.md`。

共享知识写入使用 `atm_knowledge_save`，无需用户逐篇手动导入或发布：先查重，携带活动会话 `project/session/op_id`。新建提交 `slug/title/summary/body_markdown` 与适用条件、来源等；更新前 `atm_knowledge_get(id, for_edit=true)` 读取完整正文（沿 cursor 续读，不传 section），保留首屏 `edit` 元数据，合并后提交完整内容及 `id/expected_revision_id`。可选字段省略会重置。重试复用原 op_id 和内容；冲突重读合并。回执直接给出 `id/revisionId/version/reference/publishedBy`，这是知识库独立事务的回执，不走项目 mutation ACK 或 atm_search 的 op_id 回查。来源内部键用 `type/reference/sourceVersion/projectId/recordId`；type 为 `file/url/manual/project_record`。保留未经验证的声明，不写入秘密，不把项目流水账灌入知识库。详细流程见 `docs/local-knowledge.md`。

知识首屏出现 `metadataTruncated=true` 时，按 `metadataRead` 使用同一个 get 工具的 `part=metadata`；沿元数据 cursor 收集并拼接 `metadataJson`，JSON.parse 后得到完整字段。不得把预览中的空来源/适用范围当成原值回写。正文和元数据页均保持同一 revision_id，cursor 不能混用。知识原写请求的 project/session/op_id 与完整内容不变时，即使原 Session 已关闭也能只读回放，不复活会话；新写入才需活动 Session。

### 遇到 ATM 问题时反馈

已通过 `atm_begin` 建立 Session 后，可调用 `atm_feedback(project, session, op_id, summary, detail, severity, tool, task_key)`。它把问题保存为当前项目内 topic 固定为 `atm-agent-feedback` 的 Agent Record，便于在项目“记录”页直接查看、检索和关联任务。反馈只写本机 ATM 项目数据库，不会自动上传到 GitHub 或任何外部服务；相同请求重试必须复用原 `op_id`。`tool` 与 `task_key` 均为可选上下文。`severity` 填 `CRITICAL` 也不会进入 brief——`ATM_FEEDBACK` 讲的是 ATM 这个产品，不是所在项目的事实，所以按需填写真实严重度，不必担心占用后续 Session 的上下文。

所有写操作使用唯一 `op_id`；重试同一写请求时复用原 `op_id`。任务变更携带最新 `expected_version`，发生版本冲突后先重新读取。进度摘要应一次写清结果、证据和下一步，不贴原始日志。

进度、检查项、子任务聚合与 `atm_end` 都可能改变任务版本。下一次写入使用本次 ACK 的 `version`，不自行加一。验收已经完成时优先单独一批 `verify_and_complete`，不需要为了流程拆成 verify、complete 两次；该操作仍检查证据和完成条件。

task 进度的非空 `blocker` 是状态操作：转为 BLOCKED 并清除原等待对象，普通补充说明请放 `summary`。明确将阻塞重新归类为外部等待时，可直接 `wait_agent` / `wait_user`，它会解除原阻塞并记录等待，不制造开始事件。任务 context/full 和有状态快照的写回执包含 claim owner/lease；重开不代表已释放旧 claim，过期接手仍须明确 `takeover_stale:true`，不得抢占活 owner。

编排工具结果时只输出一份业务载荷：`result.structuredContent ?? result.content`。MCP 同时保留两种载荷是为兼容不同客户端，不要把整个对象重复展开；失败时也必须保留错误正文。写回执是该次操作的快照，重放旧 `op_id` 不等于查询当前状态。

候选哈希失配时检查错误中的 `missing` / `extra` / `mismatch`，不要反复猜 commit/tree/base 键或自动改绑。完整绑定可按 `request_lookup` 的只读 REST 路径获取，仍使用 runtime 发现的本次令牌。cwd 若绑定到垃圾箱项目，`quick` 不会自动绕过；先由用户在项目管理中恢复，重复 `begin` 不会修复生命周期。

### 字段约束速查

**以本节为准，不要以眼前渲染出来的 schema 为准。** ATM 发出的 `tools/list` 字节里这些约束都在（实测过安装版的 wire JSON），但到调用方眼前会被中间某一层删短：`enum` / `oneOf` / `maxLength` 丢成 `{}`，`required` 也会被删得只剩几项（实测：`atm_record` 发布的 `required` 是 `project` / `session` / `op_id` / `kind` / `title` / `summary` 六项，渲染到调用方眼前只剩 `kind`）。能稳定传到调用方眼前的只有 description 和属性名。反方向也有：有客户端的校验器把带 `default` 的字段当成必填（实测：`atm_record.scope` 有 `default: "PROJECT"`，服务端不传照样接受，却在到达 ATM 之前就被拦下）。两头都对不上时，**照本节把该传的一次传全**，包括那些本来有默认值的字段。撞上限的代价不对称：被拒之后整个请求要原样重发，而 `detail` 这类正文可能有好几 KB。**先写 detail，`summary` 最后写，提交前量一遍。**

<!-- prettier-ignore -->
| 工具 | 约束 |
| --- | --- |
| 全部写操作 | `project`、`session`、`op_id` 三项均必填（渲染出来的 `required` 可能看不到它们，以本表为准）；`op_id` 须唯一，重试同一请求时复用原值。`atm_record` 另需 `kind`、`title`、`summary`。 |
| `atm_record` | `summary` ≤ 300 个 Unicode code point（中文按字数算）；`title` ≤ 400；`detail` ≤ 100,000，长内容放这里。`kind=DECISION\|CONSTRAINT\|FACT\|RISK\|REFERENCE\|LESSON`，`importance=LOW\|NORMAL\|HIGH\|CRITICAL`。 |
| `atm_progress_add` | `summary` ≤ 500 code point；`completed` / `evidence` / `next` 各 ≤ 20 项。`scope=task\|project`（`health` 只用于 project，`percent` 只用于 task）。 |
| `atm_end` | `summary` ≤ 500 code point。`outcome=completed\|paused\|blocked\|cancelled\|error\|retired`——**全小写**。大小写没有通用规律（同一张表里 `kind` / `importance` 是大写，`scope` / `view` / `operation` 是小写），逐个字段照本表写，不要从上一个调用类推。 |
| `atm_task_patch` | `items` 1–50 条；composite 操作（`verify_and_complete`、`review_request`、`review_submit`、`checklist_single`、`checklist_batch`）不可与其他操作同批，`items` 只允许一条。 |
| `atm_task_get` / `atm_task_list` | `field_mask` 是「在 `view` 已有的字段内过滤」，不是「我要这些字段」；越界字段会回显在 `ignored_fields`。`field_mask` 在 `atm_task_get` ≤ 30 项、`atm_task_list` ≤ 20 项，每项 ≤ 64 字符。`view=core\|context\|full`（`atm_task_list` 多一个 `reconcile`）。 |
| `atm_search` | `session` 只能与 `op_id` 精确回查一起传。 |

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
| `BLOCKED` | 已阻塞 | `start`, `release`, `block`, `wait_agent`, `wait_user`, `complete`, `cancel`, `reopen`, `edit` |
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
| `wait_agent` | 等待 Agent | `IN_PROGRESS`, `VERIFYING`, `BLOCKED`, `WAITING_AGENT` | WAITING_FOR |
| `wait_user` | 等待用户 | `IN_PROGRESS`, `VERIFYING`, `BLOCKED`, `WAITING_USER` | WAITING_FOR |
| `verify` | 提交验收 | `IN_PROGRESS`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING` | - |
| `complete` | 完成 | `BACKLOG`, `READY`, `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING` | COMPLETION_GATE |
| `cancel` | 取消 | `BACKLOG`, `READY`, `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING` | CANCEL_REFERENCES |
| `reopen` | 重新打开 | `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING`, `DONE`, `CANCELLED` | - |
| `edit` | 编辑 | `BACKLOG`, `READY`, `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `WAITING_AGENT`, `WAITING_USER`, `VERIFYING`, `DONE`, `CANCELLED` | - |

> `COMPLETION_GATE` 在上表之外还要求当前状态属于 `IN_PROGRESS` 或 `VERIFYING`：没开工过的任务不能直接 `complete`，先 `start`。

<!-- WORK_ITEM_OPERATIONS:END -->

<!-- TASK_PATCH_COMPOSITE:BEGIN -->

### composite 任务操作（自动生成）

上一张表只列状态机操作。`atm_task_patch` 还接受下列 composite 操作，它们**不可与其他操作同批**：
`items` 只允许一个元素。

所有条目共用 `task_key` + `expected_version` 骨架。**`expected_version` 的语义按操作而异**：
`checklist_single` 比的是那条检查项自己的版本，其余操作都比任务版本。字段名相同不代表语义相同。

#### `verify_and_complete`

一次调用完成 verify 与 complete，省掉中间那次版本读取。

```json
{
  "operation": "verify_and_complete",
  "task_key": "ATM-T-0001",
  "expected_version": 7
}
```

#### `checklist_single`

改一条检查项。`checklist_items` 必须恰好一个元素，不是把 id 放到条目顶层。**`expected_version` 是检查项自己的版本，不是任务版本**（`atm_task_get(view="full")` 的 `checklist[].version`）。`task_key` 会校验归属，检查项不属于它就报 `CHECKLIST_TASK_MISMATCH`。

```json
{
  "operation": "checklist_single",
  "task_key": "ATM-T-0001",
  "expected_version": 0,
  "checklist_items": [
    {
      "id": "01M0W8440REDVKEFXQ9TW54HQX",
      "status": "DONE",
      "evidence": [
        {
          "kind": "test_result",
          "value": "186 passed",
          "note": "聚焦回归"
        }
      ]
    }
  ]
}
```

#### `checklist_batch`

整批改检查项，任一条失败则整批回滚。`expected_version` 是**任务**的版本，并会校验每条检查项确实属于该任务，否则报 `TASK_MISMATCH`。

```json
{
  "operation": "checklist_batch",
  "task_key": "ATM-T-0001",
  "expected_version": 7,
  "checklist_items": [
    {
      "id": "01M0W8440REDVKEFXQ9TW54HQX",
      "status": "DONE",
      "evidence": ["docs/report.md"]
    },
    {
      "id": "01M0W8440REDVKEFXQ9TW54HQY",
      "status": "SKIPPED"
    }
  ]
}
```

#### `review_request`

对 REVIEW 任务发起复核请求，并钉住候选哈希。

```json
{
  "operation": "review_request",
  "task_key": "ATM-T-0002",
  "expected_version": 3,
  "parent_checklist_id": "01M0W8440REDVKEFXQ9TW54HQX",
  "expected_parent_checklist_version": 0,
  "candidate_hashes": {
    "source": "695feabb8d32f02c"
  }
}
```

#### `review_submit`

提交复核结论；`evidence` 至少一条。

```json
{
  "operation": "review_submit",
  "task_key": "ATM-T-0002",
  "expected_version": 4,
  "request_key": "ATM-RR-0001",
  "verdict": "APPROVED",
  "candidate_hashes": {
    "source": "695feabb8d32f02c"
  },
  "evidence": [
    {
      "kind": "git_sha",
      "value": "695feabb8d32f02c",
      "note": "复核基线"
    }
  ]
}
```

<!-- TASK_PATCH_COMPOSITE:END -->

1. `atm_begin(project_code, agent_id, role)`，正常开工只发起一个语义请求，并直接使用返回的 brief。默认 `brief="full"`；低上下文客户端可用 `minimal`，只要 Session 回执则用 `none`。`max_chars` 只裁剪 brief，不会丢失 `session`、`project`、`scope` 或原子回执。需要崩溃恢复的控制器必须额外传稳定 `op_id`；响应未知或冷启动时以完全相同的请求重试，ATM 会在现有项目内返回同一 Session。
2. 根据 brief 按需调用 `atm_task_list`；只有需要单项完整上下文时才调用 `atm_task_get`。
3. 开始实现前按下方“任务拆分”规则确认 WorkItem 粒度，再领取具体任务。
4. `atm_task_patch(claim)` → `atm_task_patch(start)`；并行 Agent 各领不同任务。
5. 完成一个有意义阶段后写 `atm_progress_add`；事实、决策、风险写 `atm_record`；使用 ATM 时遇到产品问题写 `atm_feedback`。
6. 验收后 `atm_task_patch(verify)` → `atm_task_patch(complete)`；满足条件时也可用 `verify_and_complete` 原子完成。
7. 无论成功、暂停或阻塞，最后都调用 `atm_end`；计划换代使用 `retired` 和 predecessor/handoff。`paused` / `retired` 都会保存未完成任务的交接，是否释放领取由 `release_claims` 决定（默认释放）。

恢复时使用 `atm_begin(resume=true)`，保持 `agent_id` / `cwd` / `thread_id` / `role` 一致；存在多个前驱时显式传 `predecessor_session_id`，不要猜。普通开工未传 `resume` 也可只读看到唯一同身份前驱的待确认交接，但不会确认交接或接管旧 claim；多个前驱或身份不一致时不展示未绑定交接。看到 summary/next 不等于已经领取任务，仍按版本与租约规则操作。

正常开工不要在 `atm_begin` 后紧接 `atm_brief`。只有发生上下文压缩（compaction）、长时间离开，或明确需要恢复 working set 时才调用 `atm_brief`。

<!-- MUTATION_ACK_CONTRACT:BEGIN -->

### 固定 mutation ACK

项目 mutation 工具只返回同一组有界字段；不要依赖操作特有的顶层字段。共享知识的 atm_knowledge_save 使用独立知识库事务与引用回执，不适用本表。

| 字段                 | 语义                                                                                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                 | 写操作是否被 ATM 接受。                                                                                                                                                                                                                                                                             |
| `op_id`              | 调用方提交的幂等操作 ID；重试必须复用。                                                                                                                                                                                                                                                             |
| `project`            | 规范化后的项目代码。                                                                                                                                                                                                                                                                                |
| `session`            | 实际承载写操作的 Session。                                                                                                                                                                                                                                                                          |
| `session_rebound`    | Session 过期并由 ATM 安全接续时为 `true`。                                                                                                                                                                                                                                                          |
| `projection`         | Registry 投影持久回执；含 `status`、`source_seq`、`projected_seq`、`retry_scheduled`、`last_error` 与累计 `retry_count`。`DEFERRED` 表示权威写已成功且后台会重试。                                                                                                                                  |
| `entities`           | 受影响实体的有界预览，每项含 `entity_type`、`key`、`version`。任务写入有状态快照时还含 `status`、`waiting_on`、`claimed_by_session_id`、`claim_lease_until`；旧回执可能无这些字段。它们是该次写入的结果，幂等重放不是当前状态查询。下一次写同一实体使用返回版本，不要自行加一；并发变更仍可能冲突。 |
| `entity_count`       | 完整受影响实体数量，不受预览截断影响。                                                                                                                                                                                                                                                              |
| `entities_truncated` | 实体预览是否被条数或字符预算截断。                                                                                                                                                                                                                                                                  |
| `details_cursor`     | 可直接作为 MCP 工具调用执行的有界 durable 实体回查描述符。                                                                                                                                                                                                                                          |

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

| 报错                                     | 含义与出路                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checklist incomplete`                   | 还有检查项停在 TODO/DOING。用 `atm_task_patch(operation="checklist_single")` 逐条置 `DONE` 或 `SKIPPED`；多项可用 `checklist_batch`。两者的 `expected_version` 语义不同：单项比的是**检查项自己**的版本，批量比的是**任务**的版本并整批回滚。字段名相同不代表语义相同，取版本前先确认走的是哪条。两者都校验检查项归属：单项报 `CHECKLIST_TASK_MISMATCH`，批量报 `TASK_MISMATCH`。 |
| `evidence required` / `evidence missing` | 该检查项标了「需要证据」。要么带 `evidence` 挂上真证据，要么置 `SKIPPED`——跳过的必证项不再要求证据。不要为了打勾而编证据。                                                                                                                                                                                                                                                        |
| `child incomplete`                       | 还有子 WorkItem 不在 DONE/CANCELLED。                                                                                                                                                                                                                                                                                                                                             |
| `blocker active`                         | 这条来自**独立的 blocker 记录**，由带非空 `blocker` 的 `atm_progress_add` 写入，和任务行上的 `blocked_reason` 不是一回事。`blocker: null` 只表示「这次不新写」，不会关掉已有的那条。用 `atm_task_patch(reopen)`，或对已在进行中的任务再 `start` 一次——「接着做」即意味着阻塞不再成立。                                                                                            |
| `dependency not ready`                   | 有 BLOCKS 关系的前置任务尚未 DONE。                                                                                                                                                                                                                                                                                                                                               |
| `verification required`                  | 任务要求验收，先 `verify` 再 `complete`。                                                                                                                                                                                                                                                                                                                                         |
| `current state invalid`                  | 任务还没开工。闸门只认 `IN_PROGRESS` 与 `VERIFYING`（reason 里的 `required_status` 写着），BACKLOG / READY / CLAIMED / BLOCKED / WAITING\_\* 都要先 `atm_task_patch(start)` 再 `complete`。reason 里的 `legal_operations` 是当前状态下真正可用的操作，照着挑一个；上面那张状态表列的是状态机允许尝试的操作，闸门在那之后还要再拦一道。                                            |

### MCP 没有的能力走 REST

少数能力目前只有 REST 入口，例如**再建一个** Objective / Milestone（`POST /api/v1/projects/{code}/objectives`、`.../milestones`）。REST 与 MCP 用同一个 `endpoint` 和 token（见「ATM 服务如何发现」），写操作同样需要 `session` 与唯一 `op_id`。

新项目**不需要**先建 Objective：项目还没有活动目标时，`atm_task_create` 会自动补一个以项目名命名、带「（自动补建）」后缀的目标和一个「执行」里程碑。这个规划决策保存在 durable operation receipt；按上方固定 mutation ACK 说明精确回查后，应按实际规划改写目标标题与验收，或另建目标后归档它。条目自带 `objective_id` 时不会触发补建。

方法用错会返回 **405** 并在 `allow` 头和错误信息里列出该路径接受的方法——看到 405 是「方法不对」，看到 404 才是「路径不存在」，不要因为 404 就去猜别的路径名。

### 任务拆分

开始实现前先判断当前 WorkItem 是否可在一个独立工作阶段内完成。
若任务包含多个独立交付物、多个验证阶段、明显跨模块，或预计需要较长连续开发，不要直接执行该大任务；先用 `atm_task_create` 拆成多个可独立完成和验收的子 WorkItem，再领取具体子任务执行。

Objective / Milestone / EPIC 用于表达目标和范围，不应作为长期直接执行单元。
拆分应按“可交付结果 + 可验证验收”划分，而不是机械按文件拆分。

### 知识与记录的效率

知识首先供 Agent 决策：先看候选摘要，确需细节才按固定 `revision_id` 读正文/章节，够用即停，不注入整库。摘要优先结论和适用条件；正文保留最短操作、验证、失败边界与必要来源，不写执行流水账。先查重，同主题更新修订；项目 Record 只保存项目事实并引用 `id@revisionId`，不要复制整篇知识。不机械压字数，不能省掉影响正确性的前提。

## 完整文档在哪

- Agent 协议与协作细节：`%LOCALAPPDATA%\AyanamiTaskManager\docs\agent-integration.md`
- 用户操作：`%LOCALAPPDATA%\AyanamiTaskManager\docs\user-guide.md`
- 故障排查：`%LOCALAPPDATA%\AyanamiTaskManager\docs\troubleshooting.md`
- 架构与数据边界：`%LOCALAPPDATA%\AyanamiTaskManager\docs\architecture.md`、`%LOCALAPPDATA%\AyanamiTaskManager\docs\data-model.md`
- 本地认证、cursor、路径与事务安全边界：`%LOCALAPPDATA%\AyanamiTaskManager\docs\security-model.md`
- 发布验收：`%LOCALAPPDATA%\AyanamiTaskManager\docs\release-checklist.md`
- ATM Feedback 逐项闭环矩阵：`%LOCALAPPDATA%\AyanamiTaskManager\docs\feedback-closeout.md`
- MCP 工具契约与 Profile hash：`%LOCALAPPDATA%\AyanamiTaskManager\docs\generated\mcp-tool-contracts.md`
- Mutation 固定回执契约：`%LOCALAPPDATA%\AyanamiTaskManager\docs\generated\mutation-acknowledgement.md`
- WorkItem 状态与操作表：`%LOCALAPPDATA%\AyanamiTaskManager\docs\generated\work-item-operations.md`
- 最新在线版本：`https://github.com/ayanamislover/AyanamiTaskManager`
