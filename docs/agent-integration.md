# Agent 接入指南

AyanamiTaskManager（ATM）把 Agent 的任务状态、进度、阻塞、记录和交接写入本机数据库。它不是聊天记录存档器；Agent 只在语义状态发生变化时写入。本文是 [ATM_AGENT_GUIDE](../ATM_AGENT_GUIDE.md) 的补充，讲协议与协作细节；两者冲突时以工具说明（`description`）为准。

## 一次性接入

桌面端进入“设置 → Agent 接入”，可直接安装 Codex、Claude Desktop、Claude Code 或 Kimi Code 配置。安装操作会最小合并现有配置，并在写入前创建备份。

四个客户端的落点互不相同，不能互相替代：

| 客户端         | MCP 注册                                      | 规则                     | 技能                  |
| -------------- | --------------------------------------------- | ------------------------ | --------------------- |
| Codex          | `~/.codex/config.toml`                        | `~/.codex/AGENTS.md`     | `~/.codex/skills`     |
| Claude Desktop | `%APPDATA%/Claude/claude_desktop_config.json` | `~/.claude/CLAUDE.md`    | `~/.claude/skills`    |
| Claude Code    | `~/.claude.json`（user scope）                | 同上，与 Desktop 共用    | 同上，与 Desktop 共用 |
| Kimi Code      | `~/.kimi-code/mcp.json`                       | `~/.kimi-code/AGENTS.md` | `~/.kimi-code/skills` |

Claude Code 的注册由 ATM 调用 `claude` CLI 完成，ATM 不直接改写 `~/.claude.json`：该文件由 Claude Code 持有并高频整体重写，第三方读-改-写会丢失对方更新。找不到 CLI 时安装会以 `CLAUDE_CODE_CLI_NOT_FOUND` 失败，不会退化成直接改文件。由于规则与技能同 Desktop 共用，卸载其中一个客户端时，只要另一个仍装着 MCP，共用的规则和技能会被保留。

已经接入过 ATM 的客户端，ATM 每次启动核对一次：2.x 写进去的旧入口（`--mcp-stdio`、`mcp-stdio.cjs`、`ayanami-task-manager-actions`、没有 `--profile` 的单入口、钉着旧版本目录的路径）改成 `atm-mcp.exe --profile core|memory`，缺的 Skill 补上；没接入过的客户端一个字节都不动，你自己改过的规则块和 Skill 也不动（要在设置里点「修复」才会换回 ATM 的版本）。Skill 的备份放在 skills 目录旁边的 `.atm-skill-backups\`（例如 `~/.codex/.atm-skill-backups`），每个 Skill 只留最近 5 份；2.x 留在 skills 目录里的 `atm-*.bak-*` 会被挪过去，免得 Agent 把旧备份当成又一个 Skill 加载。

ATM 改 Codex 的 `config.toml` 时只动 `[mcp_servers.ayanami-task-manager-*]` 这几段：你自己的 server 和其他设置原样保留，包括表头后面的注释、引号键、`[[数组表]]`、多行字符串和行尾（CRLF 也照旧）；ATM 段里你写的注释也会留下。ATM 的条目如果是你写成别的形式的（`[mcp_servers]` 下的行内表 `ayanami-task-manager-core = { … }`、点分键 `ayanami-task-manager-core.command = …`，或顶层的 `mcp_servers.ayanami-task-manager-core.…`），修复时会换成上面那种段，不会重复定义。如果文件里有 ATM 认不出的写法（例如表头没闭合、多行字符串没结束），安装、修复、卸载会报 `CODEX_CONFIG_INVALID_TOML`；如果整个 `mcp_servers` 写成了一张行内表（`mcp_servers = { … }`）或数组表（`[[mcp_servers]]`），ATM 没法往里加自己的段，会报 `CODEX_CONFIG_UNSUPPORTED`；卸载只在里面有 ATM 的条目时才会这样。哪些条目是 ATM 的，按 TOML 解码后的键判断（与 Codex 用同一个解析器），你自己 server 的参数、注释里提到 ATM 的名字不算；ATM 的条目写成数组表 `[[mcp_servers.ayanami-task-manager-core]]`、env 写成裸键或字面串，也都按解析出的内容判断是否需要修复。每次改写之后 ATM 会把结果再解析一遍，核对你的内容一个值都没变，核对不过就不写。这两种情况下这次操作什么都不写（配置、规则文件、Skills 都不动），启动时也不会去改配置；把文件改成 `[mcp_servers.<名字>]` 段的写法后，在设置里点「修复」即可。

只有正式安装、并且用的是默认数据目录时，ATM 启动才会自动修复：`ATM_DATA_DIR`、`AYANAMI_TASK_DATA_DIR`、`ATM3_DATA_DIR` 任何一个指到别处，或 `APPDATA`、`LOCALAPPDATA`、`USERPROFILE` 被改到别的位置时，都不会自动改你的 Agent 配置。设置里的「安装」「修复」「卸载」不受这条影响。

Kimi Code 的 VS Code 扩展与 CLI 共用 `~/.kimi-code`，装一次两边都生效。ATM 直接最小合并 `mcp.json`：只替换 ATM 自己的服务并写明 `"transport": "stdio"`，其他服务与顶层键原样保留；原来手工写在 `AGENTS.md` 里、没有 ATM 标记的规则文字不会被删，确认受管区块生效后可自行删掉那份手写副本。

本地服务只监听 `127.0.0.1`。正式桌面 daemon 每次启动都会生成新的 token 和端口，并原子发布 `%LOCALAPPDATA%\AyanamiTaskManager3\runtime\daemon.json`（设置了 `ATM3_DATA_DIR` 时在它下面）；旧 endpoint/token 不可复用。不要把 token 写进仓库、任务记录、日志、命令行参数或长期配置。完整威胁边界见 [security-model.md](./security-model.md)。

stdio MCP 由原生转发程序 `atm-mcp.exe` 承担：它每次请求都重新读 `daemon.json`，把每行 JSON-RPC 转发到本机服务，不需要任何环境变量。写进 Agent 配置的路径是版本无关链接 `%LOCALAPPDATA%\AyanamiTaskManager\current\resources\atm-mcp.exe`，升级后旧配置依然有效。参数只有 `--profile core|memory`（`actions` 是 core 的别名，只为旧配置保留）；不带 `--profile` 时以 `MCP_PROFILE_REQUIRED` 退出。服务未运行时它会唤醒一次同目录的桌面程序并等待发布。桌面 EXE 本身不是 stdio 程序，不要直接把它写进 Agent 配置。

桥还负责两件事：

- 写调用省略了 `session`、`project` 或 `op_id` 时，桥在发出前向服务问一次（`POST /mcp/resolve`），把这次调用的会话、项目和 `op_id` 定下来，之后的重试（连接被拒、服务重启、`STORE_BUSY`）都用同一份。发出了但拿不到结果时返回 `RESULT_UNKNOWN`，`fix.call` 是带完整上下文的原调用。
- 它把 MCP `initialize` 里的 `clientInfo.name` 和客户端进程身份一起报给服务（`X-ATM-Client`）。服务据此判断客户端进程是否还在（会话超时）以及是不是「一个连接一个对话」的客户端（默认会话）。

## 标准会话流程

1. 开工调用一次 `atm_begin(agent_id, cwd)`，直接使用返回的 brief。认不出项目时报 `PROJECT_REQUIRED`，`fix` 是带 `allow_project_create: true` 的同一次 begin。只有无法可靠确定项目名称、代码或目录时才请求用户确认。`atm_begin.surface_version`（当前为 6）是客户端检查缓存契约的锚点。
2. 根据 brief 按需调用 `atm_task_list`，只有需要单项完整上下文时才调用 `atm_task_get`。
3. 选择 `READY` 工作项后，`atm_task_patch(task_key, operation: "start")`：`start` 即领取并开工。
4. 只在阶段完成、进度显著变化、出现阻塞/等待或产生关键证据时调用 `atm_progress_add`；`summary` 最长 500 字，应写清结果与下一步而不是拆成多次短更新。
5. 决策、约束、事实、风险、参考和经验写入 `atm_record`；使用 ATM 时遇到产品问题写 `atm_record(kind: "ATM_FEEDBACK")`。
6. 完成任务时 `complete`（可同时带 `note`、`evidence`、`checklist`）；会话结束必须调用 `atm_end`。

正常开工不要在 `atm_begin` 后紧接 `atm_brief`。只有发生上下文压缩、长时间离开，或明确需要恢复 working set 时才调用 `atm_brief`；Claude Code、Codex 上它可以不带任何参数。需要增量时用 `atm_brief(since_seq)`。

`atm_begin` 默认返回 `brief="full"`。上下文预算紧张时可选 `minimal`，只建立会话时可选 `none`。`max_chars` 只约束可降级的 brief；`session`、`project`、`scope`、`surface_version` 属于不可截断回执。调用方应检查 `brief_truncated`，需要被省略的分节时再按需读取。

### begin 的幂等

经 `atm-mcp.exe` 调用时，桥为每次 begin 签发操作身份，响应丢失后的重试会得到同一个会话。自己编排的控制器要跨进程、冷启动重放时，显式传稳定的 `op_id` 并以完全相同的请求重试：ATM 返回同一个会话；那个会话已经不在线时，回执带 `session_state`。同一 `op_id` 携带不同的项目、cwd、agent、role 等身份时以 `IDEMPOTENCY_CONFLICT` 拒绝，不创建第二个会话。直接调 HTTP 且不传 `op_id` 的 begin 没有幂等保护。

### 会话的 Git 上下文

ATM 从 `cwd` 确定性采集 Git 上下文，使用只读查询得到 branch、HEAD、仓库根、worktree 根/common dir、detached、dirty 和可用性。调用方自报的 branch/head 只作提示，不能覆盖本机观察值。Git 目录不存在、命令失败或权限不足时，会话仍照常创建和推进；界面会显示不可用及 `git_error`，不会把失败降级误报成干净仓库。

上下文在 `atm_begin` 以及会话之后的 `atm_progress_add`、`verify`、`complete`、`atm_end` 时刷新；重放（同一 `op_id`）不刷新。用户可以在界面上立即重新观察。刷新结果持久化到会话，发生变化时追加 `agent.git_context.updated` 事件。

同一 `worktree` 或 branch 被多个在线会话使用时，ATM 只给出冲突警告供 Agent 协调；它不是锁，不会自动终止会话、撤销领取或阻止执行。

### 任务拆分

开始实现前先判断当前 WorkItem 是否可在一个独立工作阶段内完成。若任务包含多个独立交付物、多个验证阶段、明显跨模块，或预计需要较长连续开发，不要直接执行该大任务；先用 `atm_task_create` 拆成多个可独立完成和验收的子 WorkItem，再领取具体子任务执行。拆分应按“可交付结果 + 可验证验收”划分，而不是机械按文件拆分。

Objective / Milestone / EPIC 用于表达目标和范围，不应作为长期直接执行单元。

新项目不需要先建 Objective。项目还没有活动目标时，`atm_task_create` 会补一个以项目名命名、带「（自动补建）」后缀的目标和一个「执行」里程碑，之后按实际规划改写目标标题与验收，或另建目标后归档它。条目自带 `objective_id` 时不触发补建；需要在一个项目里再建目标或里程碑走 REST。

工作中发现新的独立事项时，用 `atm_task_create` 的 `discovered_from` 指向已有任务、同一批次的 `client_ref` 或序号。这是可追溯的发现关系，不会阻塞 ready queue，也不应替代 `depends_on`。

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

## 工具面

MCP 登记两个 Profile，共用同一个服务与数据库：

- core：`atm_begin`、`atm_brief`、`atm_task_list`、`atm_task_get`、`atm_task_create`、`atm_task_patch`、`atm_progress_add`、`atm_record`、`atm_end`。
- memory：`atm_search`、`atm_knowledge_search`、`atm_knowledge_get`、`atm_knowledge_save`。

`/mcp/actions` 在 v6 期间保留为 core 的别名：只发布 `atm_task_patch`，core 的其他工具照样可调，旧配置不用改也能工作。`atm_delta`、`atm_feedback` 不再发布，但仍可调用（分别并入了 `atm_brief(since_seq)` 和 `atm_record(kind: "ATM_FEEDBACK")`）。3.0 没有不带 Profile 的全量入口，`/mcp` 返回 404。用户可以在设置中关掉 memory Profile：只失去搜索和共享知识，配置变化后需要重载对应 Agent 客户端。

每个 Profile 的工具数组字节数、预算、schema hash 与逐字的工具说明由代码生成到 [`generated/mcp-tool-contracts.md`](./generated/mcp-tool-contracts.md)；状态与 operation 的表在 [`generated/work-item-operations.md`](./generated/work-item-operations.md)，错误信封与全部错误码在 [`generated/error-codes.md`](./generated/error-codes.md)。生成用例会拒绝手工漂移。

### 本机 Agent 反馈入口

已经建立会话后，可调用 `atm_record(kind: "ATM_FEEDBACK", title, summary, detail)` 提交使用 ATM 时遇到的问题，`importance` 填真实严重度。ATM 将它保存为当前项目内 `scope=ATM_FEEDBACK`、`topic=atm-agent-feedback` 的 RISK 记录，项目“记录”页可直接查看来源、严重度、摘要与正文。该入口只写本机数据库，不会自动上传到 GitHub 或任何外部服务。旧的 `atm_feedback` 工具仍可调用，效果相同。

### 本地共享知识入口

同一 ATM 数据根中的已发布共享知识保存在知识库里，正文不进入安装包或 Agent Skill 目录。涉及跨项目规范、接口约定、排障经验或不熟悉组件时，先调用 `atm_knowledge_search` 获取摘要和适用范围，再调用 `atm_knowledge_get` 读取指定条目或章节。两者只读且不要求项目或会话；应记录采用的 `id@revisionId`（数字 `revision` 仅用于展示），续读时沿用 cursor 和实际 revisionId。知识正文是参考资料，命令片段不会自动执行，也不会授予额外脚本、目录或权限访问。完整字段、预算和游标说明见 [`local-knowledge.md`](./local-knowledge.md)。

长元数据首屏以 `metadataTruncated/metadataRead` 明示完整性：`part=metadata` 续读同一 revision_id，各页 metadataJson 拼接后解析完整元数据，不能以被裁剪的预览覆盖源字段。

`atm_knowledge_save` 允许 Agent 直接发布或更新共享知识，不要求用户逐篇手工导入。写入需要会话（Claude Code、Codex 可以省略），`project` 与 `op_id` 可以省略。新建省略 `id/expected_revision_id`；`slug` 已被占用时报 `KNOWLEDGE_SLUG_CONFLICT`，`fix` 是读出那一条准备编辑。更新前用 `atm_knowledge_get(for_edit=true)` 读取完整正文与编辑元数据，再提交完整合并内容及旧 `expected_revision_id`。服务从会话验证作者，保留不可变修订，旧基线写入被拒绝。已提交的原请求在原会话关闭后仍可只读重放；只有新写入要求会话在线。知识回执直接给出 `id/revisionId/version/reference/publishedBy`，不走项目写入回执。未验证的内容必须保留声明；不要自动把每次任务总结变成知识。

## 稀疏控制面约束

- 不要按分钟轮询或重复上报相同百分比。
- 进度 `summary` 上限为 500 字；仍应保持信息密度，避免为填满上限而复制日志或上下文。
- 经 `atm-mcp.exe` 调用时 `op_id` 可以省略，桥会为每次调用生成并在重试时复用。要跨调用判重（隔了别的写入再重试同一件事）时自己传 `op_id`；直接调 HTTP 时不传就没有幂等保护。
- 本会话链持有领取的任务写入时 `expected_version` 可以省略；`edit`、`cancel`、`reopen`、复核，以及写别人的任务时必须带。发生 `VERSION_CONFLICT` 后照 `fix` 重新读取再决定，不要盲目覆盖。
- 别人领取着、租约未过期的任务，Agent 只能 `claim` / `start` / `release`，其余写入报 `CLAIM_NOT_OWNED`；接管过期领取必须显式使用 `takeover_stale`。
- 阻塞用 `block` 并填写原因；等待用户和等待 Agent 必须写清所需条件。
- 写入返回固定形状的短回执；需要新状态时再用 `atm_brief(since_seq)` 或单任务读取。
- `complete` 的门禁错误会一次返回检查项、证据、子任务、阻塞、依赖、验收和当前状态中的全部已知缺口；调用方应一次性处理全部 reasons，不要按第一条错误循环试探。

### 精确读取与长字段续读

`atm_search` 会先处理公开精确标识，再进入全文搜索：WorkItem/Record 使用公开 key；Progress 与 Session 使用 `progress:<ULID>`、`session:<ULID>`；写操作可用 `op_id` 并按 `session` 收窄。`field_mask` 只返回点名字段；响应给出 continuation cursor 时，后续请求必须保持相同项目、实体、类型和字段集合。cursor 的确定性 SHA-256 摘要绑定项目、实体、字段集合和字段内容，篡改、跨实体复用或内容变化都会 fail closed；它用于损坏检测与作用域绑定，不是认证签名或授权凭据。升级前拿到的旧游标报 `INVALID_CURSOR`（`reason: "FORMAT_RETIRED"`），去掉 cursor 从头读。

### MCP 与 REST 字段名

MCP 工具参数使用 `snake_case`，例如 `project`、`session`、`op_id`、`task_key`、`expected_version`、`field_mask`；常见的旧名与猜法（`project_code`、`session_id`、`key` 等）作为别名照收，回执里的 `normalized` 说明改成了哪个规范名。REST JSON 写 `camelCase`（`projectCode`、`sessionId`、`opId`、`taskKey`…）或 `snake_case` 都可以。

参数错误的信封里 `problems[].path` 沿用规范字段名，批量条目会包含数组下标；调用方应一次修复全部问题后再重试，能自动更正时 `fix.call` 就是改好的调用。

## 恢复与交接

begin 默认 `resume: "auto"`：

- Claude Code、Codex 在同一连接上再次 begin（例如上下文压缩之后），接回本连接的主会话（`outcome: "CURRENT"`）。要另起一个就传 `resume: false`。
- 上一个会话的客户端已经退出（或超时关闭、留有待确认交接）且只有一个这样的候选时，新开一个接续它的会话（`SUCCESSOR`），领取随之转过来。有多个候选时新建会话（`CREATED`）并给出 `resume_candidates`，要接哪个就显式传 `predecessor_session_id`。
- `resume: true` 时按 `agent_id`、`cwd`、`thread_id`、`role` 四项全等接回自己那条尚未关闭的会话（`RESUMED`）。候选多于一条时以 `SESSION_SUCCESSOR_AMBIGUOUS` 拒绝，`details.candidates` 列出全部候选 id。

计划换代时，前任会话用 `atm_end(outcome="retired")`，填写 `retirement_reason`、摘要和下一步。ATM 会为尚未完成且已领取的任务生成交接。后继用相同 `agent_id` 调用 `atm_begin(predecessor_session_id=...)`，确认交接后继续任务。正常 `completed` 的会话不是可接续的前任，这可以防止误把一次正常完成伪装成上下文换代。

`role` 属于身份的一部分：拿 `role=REVIEWER` 去接一条 `PRIMARY` 会话不会成功。不带 predecessor 时它直接另起一条；指名 predecessor 时以 `SESSION_SUCCESSOR_IDENTITY_MISMATCH` 拒绝。要换角色就新建会话。

`atm_end` 只能结束自己会话链上的会话；结束别人的会话要用户在界面强制关闭，Agent 得到 `403 USER_AUTHORIZATION_REQUIRED`。

## CLI 等价入口

```powershell
pnpm atm status
pnpm atm brief ATM
pnpm atm task list ATM --ready
pnpm atm task show ATM-T-0003 --view context
pnpm atm progress ATM-T-0003 --percent 50 --summary "文档已完成一半"
pnpm atm record ATM --kind FACT --summary "验收证据已生成"
```

CLI 写操作会创建短生命周期会话并在结束时关闭。需要持续领取、交接或多 Agent 协作时，应使用 MCP 或 REST 的正式会话。

## 多 Agent

主 Agent 使用 `PRIMARY`，子任务执行者使用 `SUBAGENT`，独立验证使用 `REVIEWER`。子代理和复核会话即使开在同一个客户端进程里，也不会顶替主会话成为默认会话，它们的写入要显式带自己的 `session`。每个 Agent 必须领取不同 WorkItem；不要用同一任务模拟并行。父子关系通过 `parent_session_id` 记录，交接通过 predecessor/handoff 记录。复核提交者的 `agent_id` 不能和发起请求的相同（`REVIEW_SELF_NOT_ALLOWED`），这只防同名自审，不能证明审查独立。UI 的 Agent 页可以显式关闭异常在线会话并释放领取。
