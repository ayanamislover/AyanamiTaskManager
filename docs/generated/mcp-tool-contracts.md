# MCP 工具契约

> 由 `atm-http` 的工具表（`tools::PROFILES`）生成，不要手改。重新生成：`ATM_DOCS_BLESS=1 cargo test -p atm-http --test docs`。

- Surface：`v6`
- MCP 协议版本（新的在前；客户端要的不在表里时回最新的）：`2025-11-25`、`2025-06-18`、`2025-03-26`、`2024-11-05`、`2024-10-07`
- 字节数是 `tools/list` 结果里 `tools` 数组的 JSON 字节数，不含外壳与 JSON-RPC 信封。
- 工具的 schema hash 是 `inputSchema` JSON 的 SHA-256 前 16 位，与 `tools/list` 里的 `_meta.schema_hash` 相同；profile 的 SHA-256 取整个 `tools` 数组。
- 「只收不发布」的工具不出现在 `tools/list` 里，`tools/call` 照常可用。

## Profile

| Profile | 发布 | 只收不发布 | 字节 | 预算 | 余量 | tools SHA-256 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `core` | 9 | 2 | 16,018 | 16,180 | 162 | `893c52592553e6fc02171b60d0a3609b22b9d80b6e3fff5ada5c20cac25dfe49` |
| `memory` | 4 | 2 | 4,280 | 9,728 | 5,448 | `27562ff43277e6af819ac1a18d5020bc1a90bb4e17570688e087017b99d6dfdf` |
| `actions` | 1 | 10 | 4,178 | 9,728 | 5,550 | `2321da0384e3ee0bb7c493b8686b2e7d07954b8315a7c068804cbcaf889986f9` |

## instructions

### `core`

> MCP surface v6 · core。ATM 是本机任务账本。流程：atm_begin(agent_id, cwd) 只调一次，直接用返回的 brief（next 与 nextTitles 是可以开工的任务及标题，own 是你已领取的任务，直接写、不用再 start）→ atm_task_patch(task_key, operation:"start") → 干活 → atm_task_patch(task_key, operation:"complete", note, evidence) → atm_end(summary)。在仓库里首次使用时 begin 加 allow_project_create:true。begin 之后可以省略 project，写操作还可以省略 op_id；Claude Code、Codex 读写都可以省略 session，其他客户端带上 begin 返回的 session。子代理和复核会话用 role 开自己的会话并显式传 session。只有 edit、cancel、reopen 和别人的任务需要 expected_version。出错时照 error.fix 执行。上下文压缩后调无参的 atm_brief()，不要重新 begin。

### `memory`

> MCP surface v6 · memory。全文搜索、写操作回查与本机共享知识。会话由 core 的 atm_begin 建立；进度与记录在 core（atm_progress_add、atm_record）。

### `actions`

> MCP surface v6 · actions 是 core 的别名，只为尚未更新的配置保留；atm_task_patch 已在 core 里，请改用 core profile。

## 工具

| Profile | 工具 | 只读 | destructive | schema hash |
| --- | --- | --- | --- | --- |
| `core` | `atm_begin` | false | false | `f1759c507b0316a3` |
| `core` | `atm_brief` | true | false | `5a022233884e0633` |
| `core` | `atm_task_list` | true | false | `bec8ff335f7c040b` |
| `core` | `atm_task_get` | true | false | `82c8e634a4e084a9` |
| `core` | `atm_task_create` | false | false | `2501824e6ed6fe88` |
| `core` | `atm_task_patch` | false | true | `a5d9b201ad79412d` |
| `core` | `atm_progress_add` | false | false | `ac2befed3341bdd8` |
| `core` | `atm_record` | false | false | `1ad851873902768d` |
| `core` | `atm_end` | false | false | `cc6d57ee8dda65bc` |
| `memory` | `atm_search` | true | false | `b3b9417da084c611` |
| `memory` | `atm_knowledge_search` | true | false | `b798d26d59d59ce9` |
| `memory` | `atm_knowledge_get` | true | false | `993fc40d68457c40` |
| `memory` | `atm_knowledge_save` | false | false | `130abddab77956e3` |
| `actions` | `atm_task_patch` | false | true | `a5d9b201ad79412d` |

只收不发布：

| Profile | 工具 |
| --- | --- |
| `core` | `atm_delta`、`atm_feedback` |
| `memory` | `atm_delta`、`atm_feedback` |
| `actions` | `atm_begin`、`atm_brief`、`atm_task_list`、`atm_task_get`、`atm_task_create`、`atm_progress_add`、`atm_record`、`atm_end`、`atm_delta`、`atm_feedback` |

## 工具说明

> 与 `tools/list` 里的 `description` 逐字相同。

### `atm_begin`

开始或接续会话并返回 brief。开工只调这一次，直接用返回的 brief；上下文压缩后改调无参的 atm_brief。在仓库里首次使用加 allow_project_create:true。resume 默认 auto：自动接上本 Agent 已退出的上一会话；要新会话传 resume:false。例：{agent_id:"claude-code", cwd:"D:/repo"} 必填：agent_id。 参数：agent_id≤128；project≤20；allow_project_create 默认 false；mode=auto|quick|project，默认 auto；role=PRIMARY|SUBAGENT|REVIEWER|OBSERVER，默认 PRIMARY；resume=true|false|auto，默认 auto；session≤128；predecessor_session_id≤128；parent_session_id≤128；title≤400；brief=none|minimal|full，默认 full；max_chars=400–5000，默认 1200；op_id≤128。

### `atm_brief`

重新取回 working set，参数全部可选（省略时按本连接的会话）。只在上下文压缩或长时间离开后调用。带 since_seq 时附带增量（取代 atm_delta）。 参数：project≤20；session≤128；task_key≤40；include 最多 11 项；include[]=objective|counts|own|next|records|current|handoff|progress|artifacts|task|delta；cursor≤4000；max_chars=300–5000，默认 1200。

### `atm_task_list`

分页列任务。status 写 open、closed、all 或具体状态（BACKLOG|READY|CLAIMED|IN_PROGRESS|BLOCKED|WAITING_AGENT|WAITING_USER|VERIFYING|DONE|CANCELLED）；mine:true 只列本会话持有的；view=reconcile 时只看 include_active、limit、cursor、field_mask。 参数：project≤20；session≤128；ready_only 默认 false；mine 默认 false；status≤100；owner≤128；parent_key≤40；milestone_id≤128；query≤500；view=core|context|full|reconcile，默认 core；include_active 默认 false；field_mask 最多 20 项；field_mask[]≤64；limit=1–100，默认 10；cursor≤4000；max_chars=500–50000，默认 12000。

### `atm_task_get`

读单个任务。field_mask 只在 view 已有的字段内过滤，越界的回显在 ignored_fields；last_progress=N 附带最近 N 条进度。 必填：task_key。 参数：task_key≤40；project≤20；view=core|context|full，默认 core；field_mask 最多 30 项；field_mask[]≤64；last_progress=1–10；cursor≤2000；max_chars=300–50000，默认 12000。

### `atm_task_create`

批量建任务，默认 READY（还没整理好的显式写 BACKLOG）。depends_on 与 parent 可以写已有任务 key，也可以写本批序号（"1" 起）或 client_ref。回执带 refs（client_ref→key）与检查项 id。例：{items:[{title:"A"},{title:"B",depends_on:["1"]}]} 必填：items。 参数：items 最多 50 项；items[] 每项必填 title；items[].title≤400；items[].client_ref≤100；items[].depends_on 最多 50 项；items[].depends_on[]≤100；items[].parent≤100；items[].status=BACKLOG|READY|CLAIMED|IN_PROGRESS|BLOCKED|WAITING_AGENT|WAITING_USER|VERIFYING|DONE|CANCELLED，默认 READY；items[].type=EPIC|TASK|SUBTASK|BUG|RESEARCH|REVIEW，默认 TASK；items[].priority=LOW|NORMAL|HIGH|CRITICAL，默认 NORMAL；items[].description≤50000；items[].acceptance 最多 100 项；items[].acceptance[]≤1000；items[].checklist 最多 100 项；items[].checklist[] 每项必填 title；items[].checklist[].title≤400；items[].checklist[].evidence_required 默认 false；items[].checklist[].weight=0.001–1000；items[].objective_id≤128；items[].milestone_id≤128；items[].discovered_from≤100；items[].weight=0.001–1000；items[].target_date≤10；items[].verification_required 默认 false；items[].assignee_agent_id≤128；project≤20；session≤128；op_id≤128。

### `atm_task_patch`

改任务状态。单条直接写 {task_key, operation, …}，多条放 items。complete、verify、block、wait_user、wait_agent 会自动先 start；本会话持有的任务不需要 expected_version，edit、cancel、reopen 和别人的任务需要。complete 可以同时带 note、evidence、checklist（item 写检查项 id、序号或标题）。block 填 blocked_reason，wait_* 填 waiting_for。例：{task_key:"ATM-T-1", operation:"complete", evidence:["cargo test 全绿"]} 参数：task_key≤40；operation=start|complete|verify|verify_and_complete|block|wait_user|wait_agent|ready|release|claim|cancel|reopen|edit|checklist|review_request|review_submit；takeover_stale 默认 false；note≤500；evidence 最多 100 项；evidence[] 是文本≤2000或对象；evidence[] 每项必填 kind、value；evidence[].kind=git_sha|atm_record|atm_task|test_result|url|file；evidence[].value≤2000；evidence[].note≤500；checklist 最多 100 项；checklist[] 每项必填 status；checklist[].item≤400；checklist[].status=TODO|DOING|DONE|SKIPPED；checklist[].evidence 最多 100 项；checklist[].evidence 每项同顶层 evidence；blocked_reason≤2000；waiting_for≤1000；cancel_reason≤2000；duplicate_of≤100；superseded_by≤100；title≤400；description≤50000；acceptance 最多 100 项；acceptance[]≤1000；target_date≤10；parent_key≤100；assignee_agent_id≤128；depends_on 最多 50 项；depends_on[]≤100；discovered_from≤100；expected_fields.title≤400；expected_fields.description≤50000；expected_fields.acceptance 最多 100 项；expected_fields.acceptance[]≤1000；expected_fields.target_date≤10；expected_fields.parent_key≤100；request_key≤128；verdict=APPROVED|CHANGES_REQUESTED；parent_checklist_id≤128；items 最多 50 项；items 每项字段与顶层相同，task_key、operation 必填；project≤20；session≤128；op_id≤128。

### `atm_progress_add`

写进度。带 task_key 就是任务进度，否则是项目进度；percent 只用于任务，health 只用于项目。任务还没开工时会自动先 start。要阻塞任务请用 atm_task_patch 的 block。 必填：summary。 参数：summary≤500；task_key≤40；scope=task|project；percent=0–100；evidence 最多 20 项；evidence[] 是文本≤2000或对象；evidence[] 每项必填 kind、value；evidence[].kind=git_sha|atm_record|atm_task|test_result|url|file；evidence[].value≤2000；evidence[].note≤500；next 最多 20 项；next[]≤500；completed 最多 20 项；completed[] 是文本≤500或对象；completed[] 每项必填 text；completed[].text≤500；completed[].task_key≤40；health=ON_TRACK|AT_RISK|OFF_TRACK|UNKNOWN；blocker≤1000；project≤20；session≤128；op_id≤128。

### `atm_record`

写长期记录（决策、约束、事实、风险、参考、教训）。summary 建议 300 字以内，超出部分自动移到 detail。kind=ATM_FEEDBACK 是给 ATM 本身的使用反馈（取代 atm_feedback）。 必填：kind、title、summary。 参数：kind=DECISION|CONSTRAINT|FACT|RISK|REFERENCE|LESSON|ATM_FEEDBACK；title≤400；detail≤100000；task_key≤40；importance=LOW|NORMAL|HIGH|CRITICAL，默认 NORMAL；supersedes≤128；topic≤200；subject_key≤200；scope≤100；project≤20；session≤128；op_id≤128。

### `atm_end`

结束会话并交接。outcome 省略时：还持有未完成的任务取 paused，否则 completed。 必填：summary。 参数：summary≤500；outcome=completed|paused|blocked|cancelled|error|retired；next 最多 20 项；next[]≤500；release_claims 默认 true；retirement_reason≤500；project≤20；session≤128；op_id≤128。

### `atm_delta`（只收不发布）

读增量变化（旧名，请改用 atm_brief 的 since_seq）。省略 since_seq 时返回最近 limit 条。 参数：project≤20；limit=1–100，默认 50；types 最多 50 项；types[]≤100；max_chars=1000–50000，默认 12000。

### `atm_feedback`（只收不发布）

提交仅存本机的 ATM 使用反馈（旧名，请改用 atm_record 的 kind=ATM_FEEDBACK）。 必填：summary。 参数：summary≤300；detail≤50000；severity=LOW|NORMAL|HIGH|CRITICAL，默认 NORMAL；tool≤128；task_key≤40；project≤20；session≤128；op_id≤128。

### `atm_search`

搜索事实。多个词须同时命中（最多 8 个），双引号括起为相邻短语；任务或记录 key 直接精确读取。op_id 回查一次写操作（可带 session）。list=records|sessions 列表模式，与 query、op_id 不同用。 参数：query≤500；op_id≤128；list=records|sessions；project≤20；session≤128；task_key≤40；field_mask 最多 20 项；field_mask[]≤64；limit=1–30，默认 20；max_chars=300–50000，默认 6000。

### `atm_knowledge_search`

搜索本地共享知识的摘要与适用范围。不需要 project 或 session。 参数：query≤500；tag≤80；include_archived 默认 false；limit=1–50，默认 5；max_chars=1–50000，默认 2400；cursor≤4000。

### `atm_knowledge_get`

读取一条知识的固定修订。要编辑就带 for_edit:true，沿 cursor 读完整再保存；metadataTruncated 时按 metadataRead 续读，各页 metadataJson 拼接后解析。 必填：id。 参数：id≤100；part=body|metadata，默认 body；for_edit 默认 false；revision_id≤26；section≤200；max_chars=1–50000，默认 6000；cursor≤4000。

### `atm_knowledge_save`

直接发布共享知识。先用 atm_knowledge_search 查重；更新要带 id 和 expected_revision_id 并提交完整内容，新建省略二者。source_refs 里 type=project_record 时还要 projectId、recordId、sourceVersion。 必填：slug、title、summary、body_markdown。 参数：slug≤160；title≤240；summary≤1000；body_markdown≤500000；use_when≤2000；tags 最多 30 项；tags[]≤80；aliases 最多 30 项；aliases[]≤160；applies_to 最多 30 项；applies_to[]≤200；source_refs 最多 30 项；source_refs[] 每项必填 type、reference；source_refs[].type=project_record|file|url|manual；source_refs[].reference≤2000；source_refs[].projectId≤100；source_refs[].recordId≤100；id≤100；expected_revision_id≤100；project≤100；session≤100；op_id≤200。
