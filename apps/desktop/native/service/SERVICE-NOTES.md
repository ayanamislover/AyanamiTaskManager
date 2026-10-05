# atm-service 实现说明

只记规格（`output/atm3-spec/`）没有写死、由实现定下的取舍，以及与规格的对应关系。

## 写入流水线（`src/write.rs`，W2b）

落点固定的 operation 都走 `Service::write`，顺序定死：

1. `capability::require`（03 P-004）。被拒绝的调用不读库、不查回执、不入队：存储已关闭时，越权调用照样得到能力错误，读计数不变（用例 `a_refused_capability_writes_nothing_and_never_reaches_the_store`）。User 提交过的 op_id，Agent 拿来也换不到重放。
2. 不碰存储的入参判定：op_id 非空；只有 Agent 能带 session；需要 session 的能力缺 session 报 `SESSION_REQUIRED`，消息里直接告诉 Agent 先调 `atm_begin`。
3. 入队世代（R4）：调用方给了 `expected_generation` 就用它，否则经读连接取当前值。
4. 写事务内：命名空间与 lineage → R3′ 查找裁决 → 只有新写入过世代屏障 → 业务动作 → 写 canon-v2 回执。任何一步 `Err` 都整体回滚。

错误映射：`WriteError::Busy` → `STORE_BUSY`，`Closed` → `SERVICE_UNAVAILABLE`，超预算 / panic / SQLite → `INTERNAL_ERROR`（都已回滚）。

### 命名空间

| 主体              | 命名空间                                                  |
| ----------------- | --------------------------------------------------------- |
| Agent，带 session | `(SESSION, session_id)`，lineage 其他成员作为候选命名空间 |
| Agent，无 session | `(ACTOR, "AGENT:" + (actor 或 "AGENT_ANON"))`             |
| User              | `(ACTOR, "USER")`                                         |
| System            | `(ACTOR, "SYSTEM")`                                       |
| Phone             | `(ACTOR, "PHONE:" + device)`                              |

无 session 的 Agent 加 `AGENT:` 前缀是本实现定的：`actor` 是客户端自报的归属标签，不加前缀的话 Agent 报 `actor: "USER"` 就能落进 User 的命名空间、重放 User 的回执。R7‴ 转换来的 2.x 行只有 SESSION、`USER`、2.x 常量三种形状，没有无 session 的 Agent 行，所以加前缀不影响兼容。

### 旧格式键的探测

- 项目范围：转换器已经按 R7‴ 给可命中的行补了新键，不需要旧键探测。BEGIN 行只走调用索引。
- 知识库，Agent：lineage 每个 session 各一个 `agent:sha256([project, session, op_id])`，自己的那个算精确键。
- 知识库，User：op_id 原值。其他主体不探测原值键。

### 指纹重建的作者

`FpInput(tx, family, author)` 由每个 operation 提供，返回业务字段（规范化后，不含定位字段与控制字段）。事务参数只用于只读的规范化：证据里的 atm_record / atm_task 引用改写成规范 key（W-012），失败时整组退回原样，让指纹对不上、由业务动作报准确的错误（02 §3.3，与 2.x 的 session 闸门一致）。`None` 表示这个族表达不了这次请求（A3 的可比性检查），与该族的候选不匹配。canon-v2 必须总能表达。

| 候选的族     | 重建用的作者                                          |
| ------------ | ----------------------------------------------------- |
| canon-v2     | 候选的 `author_agent / author_session`                |
| kernel-v1    | 候选的 `actor_session_id`（2.x 0007 拆出的列）        |
| knowledge-v1 | 命中这条候选的那个 lineage 成员（旧键本身含 session） |

### 兼容请求与重放前校验

02 §3.3 只有一处兼容请求：`checklist.update` 带 taskKey 时，不带 taskKey 的 2.x 旧形状也算同一请求。`WriteRequest.compat_v1` 给出 kernel-v1 下的第二个形状，候选命中任一即可（`Rebuilt::AnyOf`）；`replay_guard` 在重放之前再跑一次 W-053 第 2、3 步，检查项不属于请求给的任务时报 `CHECKLIST_TASK_MISMATCH`，不重放。

### 裁决的一个边角

R3′ 说「请求方自己的新键或 legacy 键精确命中，只看这一条」。如果自己的新键和自己的旧键恰好命中两条不同的行，实现把这两条当作多候选，按状态表裁决（不会挑其中一条忽略另一条）。

### 世代

世代读取复用 `atm_store::restore::current_generation`，与恢复写入的是同一个定义。范围在入队时不存在（`None`）就不设屏障，由业务动作报不存在；入队时存在、执行时世代不同，报 `SCOPE_RESTORED`，details 带 `expected_generation` 与 `current_generation`。

## 调用索引（`src/receipts.rs`）

`find_call` / `decide_call` 实现 A3 的 L/N 裁决表，`insert` 支持 CALL 行（四列原值，`ns_id = call_principal_id`）。begin、`project.create`、无目标 `quick.promote` 的目标判定（EXISTING / CREATE / NONE、`TARGET_CHANGED`）随这三个 operation 在后续阶段实现，届时直接调用这两个函数。

## 验收与变异

- `tests/write.rs`：零写入一律按整库逐表逐行快照比对。
- 变异验红：`output/w2-evidence/mutations/mut-w2b.py`，证据 `output/w2-evidence/w2b-mutation-evidence.json`。

## 工作项（`src/work/`，W2c）

入口：`Service::create_work_items`、`Service::patch_work_items`，都经上面的写入流水线。operation 名沿用 2.x（`work.create.batch`、`work.patch.batch`），转换来的旧回执才能按 kernel-v1 比对。

### 规格没写死、由实现定下的

| 位置                          | 做法                                                                                                                                                                                | 理由                                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单条 patch 的检查顺序         | key → **领取归属（R1）** → 版本 → 自动补 start → 状态机 → 前置条件                                                                                                                  | W-021 把版本放第二步；R1 只要求「写入之前」。非领取者无论带不带版本都过不去，先报 `CLAIM_NOT_OWNED`，省掉一次「补版本 → 再被拒」的往返（R11 原则）。用例 `w021_check_order` 固定这一点 |
| 批次回执的 `items`            | 每条都是**提交时**该任务的最终视图                                                                                                                                                  | 末尾统一重算一次进度（C-21），逐条快照会给出过期的进度值；Agent 下一次写用的就是这个版本                                                                                               |
| 末尾重算的版本                | 派生值确实变化（C-02）、且本事务没直接写过这个任务，才加一                                                                                                                          | 被直接写过的任务版本已随那次写入变化，派生值是同一次写的一部分；新任务固定 v1（C-01）                                                                                                  |
| 自动补 start 的前置条件不满足 | 报 start 自己的错（`DEPENDENCY_NOT_READY` / `TASK_ALREADY_CLAIMED`）                                                                                                                | 比笼统的完成门或 `INVALID_TRANSITION` 更能直接行动                                                                                                                                     |
| 「下一步」                    | 错误的 `details.next` 写要做的操作和要带的值（如 `{operation:"start", task_key}`、`{expected_version: 当前}`、`{takeover_stale:true}`、`{operation:"task_list", ready_only:true}`） | 服务层不知道工具名与参数名；W4 把它翻译成 `fix.call`                                                                                                                                   |
| block 的阻塞记录（C-28）      | 每次 block 新建一条 ACTIVE 记录；start、release（C-06）、reopen、从 BLOCKED 进入等待时全部解除                                                                                      | 与进度上报的 blocker 同形，完成门只看 ACTIVE 记录                                                                                                                                      |
| edit 事件（C-13）             | `fields` 列出给了的字段；`title` 是新标题，另带 `previousTitle`；事件类型优先级照 2.x（moved > relations_changed > updated）                                                        |                                                                                                                                                                                        |
| edit 的搜索刷新（C-14）       | 自己、旧 / 新来源；改标题时连同所有 DISCOVERED_FROM 邻居                                                                                                                            | 邻居的正文里带着这个标题                                                                                                                                                               |
| 规划根（W-071）               | 只给 Agent；User、Phone、System 缺 objective 报 `OBJECTIVE_REQUIRED`。补建的 objective / milestone 版本从 0 起                                                                      | C-01 只说任务                                                                                                                                                                          |
| id 生成                       | 事务内单调的 ULID                                                                                                                                                                   | 同一毫秒内 ULID 随机部分无序；检查项按 (created_at, id) 排序时要等于写入顺序                                                                                                           |
| 创建入参                      | `client_ref` 省略取序号；`status` 省略取 READY；`type` / `priority` 不区分大小写                                                                                                    | R11 P1-4、P1-5                                                                                                                                                                         |
| kernel-v1 重建                | 照 2.x zod 解析后的 camelCase 形状；省略 `expected_version`、`client_ref` 或 `status` 的请求在 2.x 里没有对应形状，与旧候选不是同一请求                                             | A3 可比性检查；fail closed                                                                                                                                                             |

`complete` 一步带 `note` / `evidence` / `checklist`（R11 P1-1 第 4 条）见下面的 W2d。

### D01–D17 追溯（服务层部分；纯规则部分见 `domain/DOMAIN-NOTES.md`）

| 编号                                                   | 用例（`tests/work.rs`）                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01 状态机入口、同态、ready 无副作用                   | `w029_ready_has_no_side_effects`、`w020_verify_is_refused_on_closed_tasks`、`w021_check_order`                                                                                                                                                                                  |
| D02 等待保存 phase、reopen 目标                        | `w031_waiting_keeps_the_phase`、`w034_c04_c05_reopen`                                                                                                                                                                                                                           |
| D03 依赖必须 DONE                                      | `w024_c11_c29_dependencies_must_be_done`、`w075_discovered_from_is_searchable_but_not_blocking`                                                                                                                                                                                 |
| D04 占用、租约、takeover、successor reclaim、release   | `w025_r2_claims_belong_to_the_lineage`、`w026_successor_reclaim`、`w028_c06_c08_release`、`c09_r2_writes_renew_the_lease`                                                                                                                                                       |
| D05、D06 完成门                                        | `w032_c03_c24_complete`、`w030_c28_block`、`r11_p1_1_complete_auto_starts`                                                                                                                                                                                                      |
| D07 verify_and_complete                                | `tests/composite.rs` 的 `w052_*`                                                                                                                                                                                                                                                |
| D08 start / reopen 解除阻塞、completed_at、cancel 引用 | `w027_start_resolves_blockers_and_keeps_started_at`、`w034_c04_c05_reopen`、`w033_cancel`                                                                                                                                                                                       |
| D09 批量创建                                           | `c01_p1_5_create_defaults_to_ready_at_version_one`、`c17_public_create_refuses_other_states`、`w071_planning_root_is_provisioned_for_agents_only`、`w072_c18_objective_and_milestone_are_checked`、`w073_w076_batch_references_and_cycles`、`c01_c02_create_versions`、`w075_*` |
| D10 版本与安全合并                                     | `w041_batch_relay_and_rollback`、`w100_concurrent_writers_one_wins`、`w101_safe_merge`、`r11_version_is_optional_on_the_owner_path`                                                                                                                                             |
| D11、D12、D13～D16                                     | `tests/composite.rs`（见下）                                                                                                                                                                                                                                                    |
| D17 key 与证据                                         | `w037_relations`（key 大小写）、`agents_need_a_session_and_users_cannot_impersonate_one`（别的项目的 key）                                                                                                                                                                      |
| 00 C-01、C-02、C-21                                    | `c01_c02_create_versions`、`c02_parent_version_moves_only_when_progress_moves`、`w034_c04_c05_reopen`                                                                                                                                                                           |
| 00 C-03、C-24                                          | `w032_c03_c24_complete`、`w033_cancel`                                                                                                                                                                                                                                          |
| 00 C-04、C-05                                          | `w034_c04_c05_reopen`                                                                                                                                                                                                                                                           |
| 00 C-06、C-08                                          | `w028_c06_c08_release`                                                                                                                                                                                                                                                          |
| 00 C-07 / 10 R1                                        | `r1_others_cannot_modify_a_claimed_task`、`w021_check_order`                                                                                                                                                                                                                    |
| 00 C-09 / 10 R2                                        | `c09_r2_writes_renew_the_lease`、`w025_r2_claims_belong_to_the_lineage`                                                                                                                                                                                                         |
| 00 C-11、C-29                                          | `w024_c11_c29_dependencies_must_be_done`                                                                                                                                                                                                                                        |
| 00 C-13、C-14                                          | `w035_c13_c14_edit`、`w075_*`                                                                                                                                                                                                                                                   |
| 00 C-15                                                | `w037_relations`、`w033_cancel`                                                                                                                                                                                                                                                 |
| 00 C-17、C-18                                          | `c17_public_create_refuses_other_states`、`w072_c18_objective_and_milestone_are_checked`                                                                                                                                                                                        |
| 00 C-28                                                | `w030_c28_block`                                                                                                                                                                                                                                                                |
| 10 R11 P1-1                                            | `r11_p1_1_complete_auto_starts`、`r11_version_is_optional_on_the_owner_path`、`w041_batch_relay_and_rollback`                                                                                                                                                                   |
| 10 R11 P1-5                                            | `c01_p1_5_create_defaults_to_ready_at_version_one`                                                                                                                                                                                                                              |
| W-038 会话效果                                         | `w023_claim_holds_without_starting`、`w038_session_effects`、`w028_*`                                                                                                                                                                                                           |
| W-063 重放                                             | `replay_adds_nothing`、`a_converted_2x_patch_receipt_replays`                                                                                                                                                                                                                   |

变异验红：`output/w2-evidence/mutations/mut-w2c.py`，30 条全部 RED，证据 `output/w2-evidence/w2c-mutation-evidence.json`。

## 复合操作（`src/work/{patch,checklist,review}.rs`，W2d）

入口：`Service::verify_and_complete`、`update_checklist`、`update_checklist_batch`、`request_review`、`submit_review`。
operation 名 `work.verify-and-complete`、`checklist.update`、`checklist.update.batch`、`review.request.create`、`review.submit`。
每个复合操作是一个写事务，任何失败都整体回滚（W-062），计数器也不前进。复合操作各有入口，结构上不能和别的操作同批；
W-050 的「混批 → INVALID_ARGUMENT」与 `takeoverStale` 只能是 false 都在 W4 的入参层做。

### 检查顺序

| 操作                | 顺序                                                                                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| verify_and_complete | key → R1 → 任务版本（owner 路径可省）→ 自动补 start → verify（不在 VERIFYING 时）→ complete 的状态机 → 在 VERIFYING 上求完成门 → DONE                                                                                             |
| checklist_single    | 证据规范化 → 检查项存在 → 属于 task_key → R1 → C-27 终态只读 → **检查项**版本（owner 路径可省）→ 必证                                                                                                                             |
| checklist_batch     | 入参（1–100、id 不重复）→ 证据规范化 → 任务 → R1 → C-27 → 汇总（任务版本 + 逐条 NOT_FOUND / TASK_MISMATCH / EVIDENCE_REQUIRED）→ 一次拒绝                                                                                         |
| review_request      | session → Review 任务、类型 → R1 → Review 任务版本 → 未关闭 → 检查项与它的版本 → 绑定（父 = 检查项所属）→ 检查项未关闭 → 没有已有请求                                                                                             |
| review_submit       | 证据规范化 → session → ONLINE 的同 agent REVIEWER → 请求、未提交 → 绑定的 Review 任务、task_key 一致 → C-26 不自审 → Review 任务版本 → 领取身份（lineage）→ 哈希 → 绑定仍成立 → 父检查项版本 = 绑定版本 → complete 状态机与完成门 |

### 规格没写死、由实现定下的

| 位置                                  | 做法                                                                                                                                                                                                              | 理由                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 检查项更新对所属任务的版本            | 任务 version 恒 +1（W-056），祖先按 C-02 只在派生进度变化时 +1                                                                                                                                                    | 检查项是任务自己的数据，属于直接写入；C-02 针对的是子孙写入让父任务版本过期                                     |
| W-060 父任务的版本                    | APPROVED：父检查项写入让父任务 +1（同上），Review 任务完成引起的重算不再加；CHANGES_REQUESTED：只在派生进度变化时 +1                                                                                              | 2.x 的「APPROVED +2 / CHANGES_REQUESTED +1」来自逐次重算；C-21 只重算一次、C-02 只在变化时推                    |
| CHANGES_REQUESTED 的 last_evidence_at | 照 W-060 第 5 步推进父任务的 last_evidence_at，不推版本                                                                                                                                                           | 不算对父任务内容的修改                                                                                          |
| Review 任务完成后的领取               | 清掉（C-03）                                                                                                                                                                                                      | W-060 写的「不清领取」是 2.x 现状，C-03 统一了终态                                                              |
| review_submit 的身份                  | 领取者在提交者 session 的 lineage 里、assignee 是提交者的 agent；不看租约                                                                                                                                         | 10 R2 改写的 D14。R1 对 Review 任务的 may_modify 被这条蕴含                                                     |
| C-26 的位置                           | 请求解析之后、版本之前                                                                                                                                                                                            | 不可重试的身份问题先报，免得 Agent 先去补版本                                                                   |
| review 的版本参数                     | Review 任务版本省略时报 `EXPECTED_VERSION_REQUIRED`（带当前版本），不是 INVALID_ARGUMENT                                                                                                                          | 绑定版本是语义，不能省（R11）；带上当前值省一次读                                                               |
| checklist_batch 只有版本问题          | `VERSION_CONFLICT`（可重试），details 是任务的 W-104 快照，另带 `reasons`；传的是检查项版本时加 `hint: CHECKLIST_VERSION_PASSED`                                                                                  | 00 C-10                                                                                                         |
| C-12 旧参数名                         | `ChecklistSingle.legacy_version_name`：回执带 `deprecations[{field, use, message}]`；不进指纹                                                                                                                     | 同一请求换个参数名仍是同一请求                                                                                  |
| complete 一步写全                     | 顺序：自动 start → 检查项（规则同 batch，没有版本问题；`checklist.batch_updated` 带 `operation:"complete"`）→ 门 → 进度（note，或只给 evidence 时摘要「完成」，不单独推版本）→ DONE。版本：检查项 +1、complete +1 | 等同于同一事务里先 checklist_batch 再 complete；note 是这次完成的说明，不是一次独立的进度上报                   |
| complete 的检查项引用                 | 序号从 1 开始、按创建顺序；字符串先当 id，再按标题全文（trim）匹配；标题重名报 `VALIDATION_ERROR ambiguous_title` 并列出候选 id；本任务之外的 id 报 TASK_MISMATCH                                                 | R11 P1-1 第 4 条                                                                                                |
| 错误 details 的字段顺序               | 工作区的 serde_json 开 `preserve_order`，details 按插入顺序输出                                                                                                                                                   | W-059 第 7 步要求 CANDIDATE_HASH_MISMATCH 的字段顺序（MCP 截断时先留可操作的差异）；也更接近 2.x 的 JS 对象顺序 |

### 追溯（`tests/composite.rs`）

| 规则                            | 用例                                                                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W-052（D07）、W-062             | `w052_from_in_progress_two_transitions`、`w052_from_verifying_one_transition`、`w052_w062_gate_failure_commits_nothing`、`w052_blocked_is_an_invalid_verify`、`r11_verify_and_complete_auto_starts_without_a_version` |
| W-051、W-053、W-056（D11、D12） | `w053_w056_single_bumps_the_task_version`、`w053_task_version_passed_hint`、`w053_ownership_is_checked_before_the_version`                                                                                            |
| W-054、00 C-10                  | `w054_batch_bumps_the_task_once`、`w054_c10_all_reasons_at_once`、`w054_c10_version_only_is_a_version_conflict`、`w054_duplicate_ids_are_refused`                                                                     |
| W-055                           | `w055_evidence_retention_and_requirement`                                                                                                                                                                             |
| W-012（D17）                    | `w012_evidence_references_are_normalized`                                                                                                                                                                             |
| 00 C-12、C-27                   | `c12_the_old_parameter_name_is_accepted_with_a_hint`、`c27_terminal_task_checklist_is_read_only`                                                                                                                      |
| 10 R1、R11 P1-1 第 2 条         | `r1_verify_and_complete_on_another_claim_is_refused`、`r1_p1_1_checklist_ownership_and_optional_version`、`w060_approved_submission`（reviewer 改父检查项，阳性对照）                                                 |
| R11 P1-1 第 4 条                | `p1_1_4_complete_writes_checklist_note_and_evidence`、`p1_1_4_complete_checklist_failures_roll_back`                                                                                                                  |
| W-057（D13）                    | `w057_request_binds_without_touching_anything`、`w057_request_refusals`                                                                                                                                               |
| W-058、10 R2、00 C-26（D14）    | `w058_c26_submitter_identity`、`r2_a_reviewer_successor_may_submit`                                                                                                                                                   |
| W-059（D15、D16）               | `w059_candidate_hash_mismatch`、`w059_d16_the_checklist_moved_after_the_request`、`w059_w062_the_review_task_must_pass_its_gate`                                                                                      |
| W-060、00 C-21                  | `w060_approved_submission`、`w060_changes_requested_leaves_the_checklist`                                                                                                                                             |
| W-063、02 §3.3 兼容请求         | `w063_verify_and_complete_replays`、`w063_review_submit_replays`、`w063_checklist_compat_replay_checks_ownership_first`                                                                                               |

W-061（不提供独立性保证）没有可测的行为：实现只校验 role / agent / session / 领取 / 哈希 / 版本，代码与文档都不声称独立。

变异验红：`output/w2-evidence/mutations/mut-w2d.py`，43 条全部 RED，证据 `output/w2-evidence/w2d-mutation-evidence.json`。
任务书点名的三条（batch 比 item.version、跳过候选哈希、门失败后仍提交 VERIFYING）都在其中。
（原有 44 条；「submit 不查 ONLINE」在 W2e 之后由管线的 SESSION_CLOSED 先拦下，那段代码不再可达，删去。）

## Session 生命周期与进度、记录（`src/{session,rebind,memory}.rs`，W2e）

入口：`Service::begin`、`end_session`、`force_close_session`（User）、`sweep_sessions`（System `StartupRecover`）、
`refresh_git_context`（User）、`add_progress`、`create_record`、`feedback`。operation 名 `session.recover-or-begin`
（调用索引，A3）、`session.end`、`session.force-close`、`work.progress`、`project-update.publish`、`record.create`
（反馈同名）。

### 写入流水线的新步骤

R3′ 判定为新写入之后（S-036：已关闭 session 上成功过的请求照样 REPLAY），`rebind::effective_session` 看 session：
ONLINE 用它本身；`HEARTBEAT_TIMEOUT` / `CLIENT_EXITED` 关闭的接到唯一一条身份（agent、thread、parent、role）一致的
ONLINE successor，没有就在**同一个写事务**里新建（发 `agent.joined`，`rebind:true`；写入失败一起回滚）；其他关闭原因
`SESSION_CLOSED`，`details.next` 是带 predecessor 的 begin。`atm_end` 用 `Rebind::ExistingOnly`：只认已有 successor。
action 成功后 `rebind::heartbeat` 刷新心跳（不推 session 版本），session 仍 ONLINE 时给它持有的未终态领取续租。

### 规格没写死、由实现定下的

| 位置                          | 做法                                                                                                                                                                                                                                       | 理由                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| begin 的客户端身份            | 取 `Principal::client_group()`（连接所属的进程组），不信请求里的字段                                                                                                                                                                       | A1 的「同一连接组」只能由传输层认定；请求可伪造  |
| begin 不带 resume             | 默认 `auto`（R11 P1-3）：只接续 `CLIENT_EXITED` / `HEARTBEAT_TIMEOUT` 关闭、或有给本 agent 待确认交接、且还没被接续过的 session；永远不接回 ONLINE；多个候选时新建并在 `resumeCandidates` 列出带 predecessor 的 begin                      | 不阻塞开工；Agent 想接哪个自己指名               |
| 显式 `session`（A1 优先级 1） | 同项目、同 agent、同 role、未关闭 → `CURRENT`；已关闭报 `SESSION_CLOSED`，next 是带 predecessor 的 begin；与 `predecessor_session_id` 同时给出报 `INVALID_ARGUMENT`。它是业务字段，进 canon-v2 指纹                                        | 接回与接续是两件事，混在一起就猜不出意图         |
| begin 的 `resume` 省略        | 按 `auto` 执行；与 2.x 旧回执比较时按 2.x 的缺省值 false 重建；显式 `auto`、显式 `session` 在 kernel-v1 里无法表达，与旧行不可比                                                                                                           | R11 A3「缺省值按各候选自己的版本重建」           |
| A1 接回                       | 只对白名单客户端（`single_conversation`）、PRIMARY、resume 不是 false、没指名 predecessor；同一连接组、同 agent、同 cwd 的唯一 ONLINE PRIMARY → `CURRENT`                                                                                  | 同一进程里可能跑多个对话的客户端不能共用 session |
| 指名 predecessor              | ONLINE：四元组全等才接回（`RESUMED`）；已关闭：只校验 agent 与 role（C-07），有待确认交接或退役原因才接续，否则 `SESSION_NOT_RETIRED`；resume:false：同 agent、同 role（C-14 / R3），不确认交接                                            | 02 §2.3 的判定表                                 |
| begin 的幂等                  | 调用索引 `(AGENT, agent_id, session.recover-or-begin, op_id)`，不按项目划分；2.x 旧键 `session-begin:<op>` 作为 legacy 探测；重放时补 `sessionState`（C-17）；auto resume 在 kernel-v1 里没有对应形状                                      | A3；git 探测结果不进指纹（每次都可能变）         |
| TRASHED 项目的 begin          | 登记或累加恢复请求并**提交**，再报 `PROJECT_DB_UNAVAILABLE`（`retryable:false`、`recovery`、`quick:do_not_bypass`）                                                                                                                        | 请求要留下来给用户看到；重试只是累加计数         |
| 没认出项目                    | 暂时一律 `PROJECT_REQUIRED`（带 `next.allow_project_create`）；A3 的 ③④（quick、建项目）随 W2g 接入                                                                                                                                        | 项目生命周期在 W2g                               |
| schema                        | `agent_sessions.client_identity` 列、`close_reason` 加 `CLIENT_EXITED`、索引 `ix_agent_sessions_client` 直接改在 `0001_schema_v1.sql` 里                                                                                                   | 3.0 schema 尚未发布，没有需要迁移的库            |
| 超时扫描                      | 只扫 ACTIVE 项目；客户端已退出 → `CLIENT_EXITED`；客户端仍存活按 120 分钟兜底，查不到身份按设置的超时（默认 5，夹到 [1, 1440]）；读快照之后心跳前进过的跳过；不释放领取，记 `last_session_closed_at`；`agent.recovered_stale` 由 SYSTEM 发 | 00 02 C-08、R11 P1-3、S-012                      |
| end 的交接与释放              | paused / retired 给未终态领取写交接，与 `release_claims` 互相独立；释放只把 CLAIMED 变回 READY 并清 assignee（C-06），其余状态保留、只清领取；每个被释放的任务 version +1                                                                  | S-013、S-014                                     |
| 强制关闭                      | 已关闭的也照样执行，覆盖 close_reason 为 `FORCE_CLOSE`（之后不能 rebind）                                                                                                                                                                  | 用户的意图是「这个 session 不要再用了」          |
| 任务进度的版本                | 任务行直接写入 +1，事务末尾的重算按 C-02 / C-21 不再加                                                                                                                                                                                     | 02 S-083 的「至少 +2」是逐次重算的 2.x 现状      |
| 进度的 noop                   | 同任务最近一条：同桶、同摘要哈希、没有证据、没有（trim 后非空的）blocker → 不写行、不推版本，回执带 `noop:true` 和那条的 id                                                                                                                | S-081；纯空白 blocker 按 C-13 视为没有           |
| 进度的领取                    | 不论带不带 blocker、percent，都按 R1 校验；写入后按 R2 把领取转到当前 session                                                                                                                                                              | 10 R1、R2                                        |
| 项目进度                      | completed 里的任务 key 必须存在并改写成规范 key；health 默认 UNKNOWN，带 blocker 时 AT_RISK；from = 上次发布的 to                                                                                                                          | 02 §5.6、C-02                                    |
| 记录 summary 超长             | 超过 300 个 code point：截成 299 个加「…」，全文放到 detail 开头（原 detail 接在空行之后），回执带 `summaryTruncated:true`                                                                                                                 | R11 P2-1：不让 Agent 因为摘要写长了被拒          |
| 反馈                          | 固定形状的 RISK 记录：scope `ATM_FEEDBACK`、topic `atm-agent-feedback`、detail 开头注明只存本机                                                                                                                                            | 02 §1.8                                          |

### 追溯（`tests/session.rs`、`tests/memory.rs`）

| 规则                                  | 用例                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| S-001、S-004、00 02 C-17              | `s001_s004_atomic_begin`                                                                    |
| R11 A3                                | `a3_begin_op_id_is_shared_across_projects`、`a3_omitted_resume_matches_a_2x_begin_receipt`  |
| S-003、04 L-008                       | `s003_l008_trashed_and_archived_projects`                                                   |
| 04 L-010                              | `l010_project_is_found_by_path_marker_or_common_dir`                                        |
| S-006、S-011                          | `s006_s011_resume_reattaches_the_open_session`                                              |
| S-007、S-013、S-016、R4′              | `s007_s013_s016_resume_through_a_pending_handoff`、`s007_two_handoff_sources_are_ambiguous` |
| S-008、S-009、00 02 C-07、C-14、10 R3 | `s008_s009_c07_named_predecessor`                                                           |
| S-010                                 | `s010_plain_begin_acknowledges_nothing`                                                     |
| R11 P1-3                              | `p1_3_auto_resume`、`s012_c08_p1_3_sweep`                                                   |
| R11 A1                                | `a1_single_conversation_reattach`、`a1_explicit_session_reattach`                           |
| S-012、00 02 C-08                     | `s012_c08_p1_3_sweep`                                                                       |
| S-014、00 02 C-06                     | `s014_c06_end_releases_claims`                                                              |
| S-017                                 | `s017_force_close`                                                                          |
| S-018、S-036                          | `s018_s036_closed_sessions_replay_but_do_not_write`                                         |
| S-019、S-020                          | `s019_s020_rebind_on_heartbeat_timeout`、`s019_rebind_refusals`                             |
| S-021                                 | `s021_end_does_not_create_a_successor`                                                      |
| 03 P-006                              | `p006_the_session_must_belong_to_the_project`                                               |
| 00 02 C-08、10 R2 心跳与续租          | `c08_r2_writes_refresh_heartbeat_and_renew_leases`                                          |
| S-022                                 | `s022_git_context`                                                                          |
| S-080、S-083、00 02 C-23              | `s080_bucket`、`s080_s083_c23_task_progress`                                                |
| S-081、00 02 C-13                     | `s081_c13_duplicate_progress_is_a_noop`                                                     |
| S-082                                 | `s082_blocker_blocks_the_task`                                                              |
| 10 R1、R2                             | `r1_r2_progress_respects_the_claim`                                                         |
| S-084                                 | `s084_progress_validation`                                                                  |
| S-085、S-086                          | `s085_s086_project_progress`                                                                |
| S-030、S-031、02 §3.3                 | `s030_progress_idempotency_and_v1_receipts`、`s031_record_idempotency`                      |
| 02 §1.6 记录                          | `s090_records`、`s091_supersede`、`s092_related_records`、`s094_user_records`               |
| R11 P2-1                              | `p2_1_long_summaries_are_truncated`                                                         |
| 02 §1.8 反馈                          | `s093_feedback`                                                                             |

变异验红：`output/w2-evidence/mutations/mut-w2e.py`，100 条全部 RED，证据 `output/w2-evidence/w2e-mutation-evidence.json`。

## 读模型（`src/read/`，W2f）

入口：`Service::brief`、`begin_brief`、`delta`、`task_list`、`task_get`、`record_list`、`session_list`、`search`、
`mutation_ack`。全部在一个只读事务里完成，SQL 一律带 `project_id`（S-070）。输出形状照 surface v5 的 MCP 回执：
brief 是 camelCase 载荷，列表、搜索、精确读取是 snake_case；W4 的 MCP 适配层只做参数映射。预算是
`JSON.stringify(x).length`（UTF-16 码元），serde_json 的整数值 f64 先经 `codec::jsify` 改成整数，两边文本一致。

### 游标

| 前缀  | 用途                       | 绑定                                                                                       |
| ----- | -------------------------- | ------------------------------------------------------------------------------------------ |
| `b4`  | brief 记录续读（点分格式） | 世代、目标哈希（项目、session、include、task_key、since_seq）、冻结记录版本、30 分钟桶过期 |
| `tl2` | 任务列表                   | 项目、世代、选择集哈希、keyset 位置                                                        |
| `rl2` | 记录列表                   | 同上                                                                                       |
| `sl2` | session 列表               | 同上，选择集含 task_key（C-15）                                                            |
| `s2`  | 全文搜索                   | 项目（全局搜索为 `*`）、世代、查询哈希、doc_id 与 quick rowid 快照、keyset 位置            |
| `f3`  | 字段续读                   | 项目、世代、实体、类型、mask 哈希、实体版本、字段哈希、偏移、7 天桶过期                    |

签名是 `app_meta.cursor_key`（建库时随机生成）对 `<前缀>.<载荷>` 的 HMAC-SHA256 前 16 字节。2.x 的前缀
（`b3`、`tl1`、`rc1`、`rl1`、`sl1`、`s1`、`f2`）一律 `INVALID_CURSOR FORMAT_RETIRED`（Q-01）；别的项目的游标、改过的
游标是 `INVALID_OR_TAMPERED`；按范围恢复之后（`projects.scope_gen` 变了）是 `SCOPE_RESTORED`。三者的恢复都是
`{action:"restart_read", omit_cursor:true}`。参数与首页不同是 `CONTINUATION_CONFLICT TARGET_MISMATCH`（保留游标重试），
冻结的内容变了是 `CONTINUATION_CONFLICT STALE`。

### 规格没写死、由实现定下的

| 位置                   | 做法                                                                                                    | 理由                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| brief 的 milestone     | 活动 objective 下按 sort_key、local_no 取第一个活动 milestone                                           | 00 02 C-10                                      |
| brief 的「自己的」任务 | own 与 currentTask 按 session 的 lineage 判断                                                           | 10 R2：领取属于 lineage                         |
| brief 的交接           | 唯一同四元组的已关闭来源（2.x），加上 lineage 里其他 session 发出、仍待确认的交接                       | 10 R4′：指名 predecessor 之后祖先的交接不能消失 |
| 冻结记录的版本         | 紧凑记录去掉 related_records 后的 sha256 前 6 字节                                                      | 00 02 C-12：同 topic 新增记录不该让续读失效     |
| brief 的身份放不下     | `RESULT_TOO_LARGE`（recovery 提高 max_chars）；begin 例外，始终返回身份                                 | 00 02 C-16                                      |
| brief 的 session 状态  | session 不是 ONLINE 时身份里带 `session_state`                                                          | 00 02 C-17                                      |
| delta 续读             | `continuation.arguments` 带上原请求的 types                                                             | 00 02 C-04                                      |
| ACK 的 session         | 回执所属的 session（author_session → SESSION 命名空间 → actor_session_id）；rebind 时是后继             | 00 02 C-05：details_cursor 原样调用总能查到     |
| ACK 的投影             | 不再有 `projection`；加 `replayed`                                                                      | 00 02 Q-05：单库没有异步投影                    |
| 搜索的 `truncated`     | 只表示预算截断；首页一条都放不下时 `next_cursor` 是起点游标                                             | 00 02 C-09                                      |
| 字段续读的偏移         | 按 UTF-16 计，但只落在 code point 边界上                                                                | 00 02 C-19                                      |
| 全局搜索               | 只看 ACTIVE / ARCHIVED 项目，带上 quick task（`project:null`）                                          | 03 F-05                                         |
| TRASHED 项目的读       | `PROJECT_DB_UNAVAILABLE`（`retryable:false`、recovery `restore_project`）                               | 04 §1.3                                         |
| task_list              | `status` 接受 `open` / `closed` / `all` / 具体状态；`mine_session` 只列该 session 的 lineage 持有的任务 | R11 P2-5                                        |
| 查询与选择集的哈希     | 不做 NFC 规范化（没有可用的 crate）；2.x 也只在少数入口做                                               | 差异只影响「换了写法的同一查询」能否续读        |
| 推迟到 W4              | owner 读时续租、reconcile 视图                                                                          | 需要 MCP 会话上下文                             |

### 追溯（`tests/read.rs`）

| 规则                      | 用例                                                         |
| ------------------------- | ------------------------------------------------------------ |
| S-050                     | `s050_brief_selects_records`                                 |
| S-051、10 R2、R4′         | `s051_r4_handoffs_by_identity`、`r2_own_follows_the_lineage` |
| S-052、00 02 C-10         | `s052_c10_include_and_sections`                              |
| S-053、S-054              | `s053_s054_budget_and_continuation`                          |
| S-055～S-059、A3          | `s055_s059_continuation_rules`                               |
| 00 02 C-12                | `c12_related_records_do_not_stale_the_cursor`                |
| S-060、00 02 C-16         | `s060_c16_begin_brief_modes`                                 |
| 00 02 C-17                | `c17_brief_flags_a_closed_session`                           |
| S-061～S-063、00 02 C-04  | `s061_s063_c04_delta`、`delta_types_filter`                  |
| S-064                     | `s064_oversized_event`                                       |
| S-065、R11 P2-5           | `s065_task_list_paging`                                      |
| 02 §4.5 视图与 field_mask | `task_views_and_masks`                                       |
| 00 02 C-19                | `c19_field_continuation`、`field_cursor_expires`             |
| S-066、S-067、00 02 C-15  | `s066_s067_c15_record_and_session_lists`                     |
| S-068、00 02 C-09         | `s068_c09_search`                                            |
| 03 F-05、04 §1.3          | `f05_global_search_and_trashed_projects`                     |
| 02 §4.5 精确读取          | `exact_reads`                                                |
| S-069、00 02 C-05、Q-05   | `s069_c05_q05_ack_and_trace`、`ack_preview_is_bounded`       |
| S-070、00 02 Q-01、A3     | `q01_retired_cursors_and_generations`                        |

变异验红：`output/w2-evidence/mutations/mut-w2f.py`，93 条全部 RED，证据 `output/w2-evidence/w2f-mutation-evidence.json`。
「ACK 忽略 rebind 后继」是等价变异，未列入：有回执时回执的 `author_session` 已经是后继，`rebound_to` 只在没有回执时兜底。

## 项目生命周期、路径与 begin ③④⑤（`src/project.rs`、`src/quick.rs`，W2g1）

入口：`Service::create_project`（User / Agent，调用索引 `project.create`）、`attach_path`（User）、`set_lifecycle`
（User：archive / unarchive / trash / untrash）、`decide_restore_request`（User）、`project_info`、`trash`；begin 没有
匹配到项目时的 ③④⑤。

### 规格没写死、由实现定下的

| 位置                  | 做法                                                                                                                                                                                                                                            | 理由                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 路径唯一键            | `project_paths.path_key`（`atm_store::paths::path_key`：去掉末尾分隔符、Unicode 小写；盘符根保留一个分隔符），`canonical_path` 原样留作显示；begin 的选择器、建项目、登记路径都用这一个函数                                                     | 04 C-L09；所有入口一个函数，键才不会对不上          |
| 转换                  | 2.x 的 project_paths 逐行算 path_key 再插入；两个项目撞同一个键时唯一约束让转换失败；`projects.archived_at` 删除，原值进 `legacy_json.archivedAt`，VERIFY 照旧逐列比对                                                                          | 04 C-L15、L-009                                     |
| 建项目                | 一个写事务：新世代（`allocate_generation`，reason CREATED）、projects、7 个计数器、primary 路径、全局事件 `project.created`；路径已被任何项目（含垃圾箱里的）经 path_key 或 git common dir 认领 → `PROJECT_ALREADY_EXISTS`                      | 04 L-001、L-009                                     |
| marker 与 git exclude | 回执给出 `marker {directory, file, content, gitExclude}`，由调用方提交之后写并报告 `markerWritten`                                                                                                                                              | 04 C-L03：文件 IO 不进写事务                        |
| 项目代码              | 照搬 2.x `allocateProjectCode`（驼峰拆词、短尾词、首字母、单词前 6 位、数字后缀到 9999、兜底 `AYT-nnnn`）；显式代码先转大写再校验                                                                                                               | 04 L-012                                            |
| project.create 的幂等 | 调用索引 `(USER 或 AGENT, principal, project.create, op_id)`，回执落在新项目范围、带它的初始世代；没有 op_id 不幂等                                                                                                                             | 10 A3                                               |
| 生命周期迁移表        | archive：ACTIVE→ARCHIVED，ARCHIVED 幂等，TRASHED 冲突；unarchive：ARCHIVED→ACTIVE，ACTIVE 幂等，TRASHED 冲突（用 untrash）；trash：ACTIVE / ARCHIVED→TRASHED，TRASHED 幂等；untrash：TRASHED→ACTIVE，ACTIVE 幂等，ARCHIVED 冲突（用 unarchive） | 04 L-002；冲突是 409 而不是 2.x 碰巧的 503（LF-04） |
| PRE\_\* 备份          | 先读当前生命周期，确实要迁移才备份（整库，`create_backup`），在写事务之外；备份失败 `INTERNAL_ERROR`（`backup_kind`），生命周期不变；已在目标上的请求不备份                                                                                     | 04 L-002：备份失败不改状态                          |
| 生命周期事件          | 沿用 2.x 的全局事件名：`project.archived`、`project.trashed`、回到 ACTIVE 一律 `project.restored`；`projects.version` +1                                                                                                                        | 2.x `setProjectLifecycle`                           |
| 恢复请求              | 续上时累加次数并把 requested_by / source_cwd 改成最后一次的值；只有第一次登记记 `project.restore_requested`；决定记 `project.restore_approved` / `_rejected`；untrash 与批准都结掉 PENDING                                                      | 04 L-004～L-006                                     |
| 垃圾箱项目的写入      | 写入流水线在重放判定之后、session 检查之前查生命周期，TRASHED 报 `PROJECT_DB_UNAVAILABLE`（retryable:false，recovery `restore_project`）；生命周期操作与恢复请求的决定自己判定                                                                  | 04 L-008；已提交的请求照样拿回原回执                |
| begin ③               | 显式 `mode:"quick"`（不论 allow_project_create）建 quick task，回执 `{scope:"quick", quick, session:null, outcome:"QUICK"}` 落在 GLOBAL、没有世代；begin 的 brief 只回身份与 quick                                                              | 10 A3；03 C-11：带 op_id 重试拿回同一个 Q 键        |
| begin ④               | 同一写事务里建项目（名字取 title，否则目录名，否则「未命名项目」；路径取选择器的 canonical_path，否则 cwd），之后照常建 session；回执带 `projectCreated`、`sourcePath`、`marker`，落在新项目范围；`expected_generation` 对新项目不比较          | 10 A3：CREATE 没有可比的世代                        |
| begin ⑤ 与 mode       | 不 quick、不允许建项目 → `PROJECT_REQUIRED`（带 next），零写入；mode 只认 auto / project / quick                                                                                                                                                | 10 R11 P1-5                                         |
| 没有匹配时的重放      | 调用索引全局共享：先查重放，再按分支执行                                                                                                                                                                                                        | 10 A3                                               |

### 追溯（`tests/project.rs`）

| 规则                 | 用例                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| 04 L-001             | `l001_create_project_in_one_transaction`                                                              |
| 04 L-012             | `l012_project_codes`                                                                                  |
| 10 A3 project.create | `a3_create_project_is_idempotent_by_op_id`                                                            |
| 04 L-009、C-L09      | `l009_canonical_paths_are_unique`                                                                     |
| 04 L-010             | `l010_attach_path`（另见 `tests/session.rs` 的 `l010_project_is_found_by_path_marker_or_common_dir`） |
| 04 L-002、D31        | `l002_archive_and_unarchive`、`l002_refusals`                                                         |
| 04 L-006、L-007      | `l006_l007_trash_and_untrash`                                                                         |
| 04 L-003、L-004、D32 | `l003_l004_trashed_begin_registers_a_restore_request`                                                 |
| 04 L-005             | `l005_restore_requests_are_decided_once`                                                              |
| 04 L-008、D33        | `l008_what_each_state_allows`                                                                         |
| 10 A3 ③④⑤、03 C-11   | `a3_begin_quick_branch`、`a3_begin_create_branch`、`a3_begin_without_a_project`                       |

L-011（范围恢复不改生命周期）由存储层的恢复保证（`store/src/restore.rs` 不写 lifecycle），服务层的恢复入口随 W5 的
备份界面接入时补用例。

变异验红：`output/w2-evidence/mutations/mut-w2g1.py`，40 条全部 RED，证据 `output/w2-evidence/w2g1-mutation-evidence.json`。
其中「写入流水线不拦垃圾箱项目」起初存活：工作项层的 `Work::open` 也拦，掩盖了流水线这一道；l008 补了不经过工作项层的
写入（垃圾箱里 `atm_end`）后变红。

## quick task、保存视图、设置（`src/quick.rs`、`src/views.rs`、`src/settings.rs`，W2g2）

入口：`Service::quick_create`、`quick_update`、`quick_promote`、`quick_get`（User / Agent）；`create_saved_view`、
`update_saved_view`、`delete_saved_view`、`list_saved_views`（User）；`set_setting`、`set_notification_mode`、
`set_backup_policy`、`get_setting`、`list_settings`（User）。

### 规格没写死、由实现定下的

| 位置                    | 做法                                                                                                                                                                                                                                                                                                                                                                                                               | 理由                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| quick 的回执范围        | create / update 落在 GLOBAL（quick registry 不随范围恢复回退）；带目标的晋升落在目标项目；不带目标的晋升走调用索引，回执落在新建的项目（已晋升时落在 GLOBAL）                                                                                                                                                                                                                                                      | 10 A3：落点固定的走流水线，CREATE 走调用索引 |
| quick 的 actor          | User 恒为 `USER`；Agent 必须自报，去空白、不分大小写地拒绝 `USER`、`SYSTEM`、`PHONE:*`，报 `USER_AUTHORIZATION_REQUIRED`（`field:"actor"`）；自报的 actor 同时是 ACTOR 命名空间 `AGENT:<actor>`                                                                                                                                                                                                                    | 03 C-12、§3 表中「403 + NS」                 |
| quick.update 的 schema  | status 只认 OPEN / IN_PROGRESS / BLOCKED / DONE / CANCELLED（大小写不敏感）；percent 0～100 或清空；title 1～400；note ≤ 5000；due_date `YYYY-MM-DD` 或清空；summary ≤ 500，去空白；越界报 `VALIDATION_ERROR` 带 `field`                                                                                                                                                                                           | 03 C-13；summary 上限与 2.x 的 progress 一致 |
| quick.update 的其余行为 | 照 2.x：没有可改字段时原样返回（`changed:false`），不加版本；DONE 写 completed_at、percent 设为 100；非空 summary 追加 `quick_task_updates`；已晋升的 quick 也能改（2.x 如此，晋升的绑定不受影响）                                                                                                                                                                                                                 | 04 §4.1；未确认的变更保持 2.0                |
| 晋升的事务              | 带目标：写入流水线（TRASHED 目标由 L-008 闸门拒绝，ARCHIVED 允许）里做「已晋升判定 → 版本 → 采用或新建工作项 → PROMOTED 标记」；不带目标：同一个写事务里建项目（名字取 quick 标题，creation_reason 记来源）再做同样的事；任何一步失败整体回滚                                                                                                                                                                      | 04 L-015、C-L05                              |
| 已晋升                  | 已经 PROMOTED：同一目标原样返回（`alreadyPromoted:true`，不查版本）；别的目标 `IDEMPOTENCY_CONFLICT`（带 `promoted_project_id`）；不带目标的请求一律原样返回，不建项目                                                                                                                                                                                                                                             | 04 §4.1、L-015                               |
| 采用与新建              | 目标项目里已有 `source_quick_id` 指向它的工作项就采用（`adopted:true`），否则按 `Internal{source:"quick.promote"}` 新建一个：quick 为 IN_PROGRESS 时落 IN_PROGRESS，否则 READY；description 取 note；需要时补规划根                                                                                                                                                                                                | 10 R5；04 §4.1                               |
| R5 双重绑定             | 标记同时写 `promoted_work_item_key` 与 `promoted_work_item_id`；读时核对 id，对不上（工作项被按范围恢复撤销）给 `promotionUndone:true`                                                                                                                                                                                                                                                                             | 10 R5                                        |
| 保存视图                | scope 精确匹配 GLOBAL / PROJECT（否则 `VALIDATION_ERROR`）；PROJECT 不带项目 `PROJECT_REQUIRED`；name 去空白后非空；query / sort 必须是对象，省略为 `{}`；改和删必须带 expected_version；事件 `saved_view.created/updated/deleted`，actor `USER`，回执落在 GLOBAL                                                                                                                                                  | 04 L-016                                     |
| 设置的通用写入          | key 先按 2.x 规则校验形状（`SETTING_KEY_INVALID`，不带 reason）；带语义的 key（`notification.mode`、`notification.enabled`、`backup.policy`、`mcp.memory-profile-enabled`）报 `SETTING_KEY_INVALID`，`reason:"DEDICATED_CAPABILITY"`、`use` 指向专用入口；白名单只有 `projects.order`（`{"ids":[非空字符串…]}`，最多 10000 个）与 `recovery.sessionTimeoutMinutes`（1～1440 的整数），其余 `reason:"NOT_WRITABLE"` | 04 L-017、03 C-06                            |
| 设置的版本              | 照 2.x：不存在的 key 读出 -1；带 expected_version 就 CAS（不存在时只接受 -1）；不带是 last-write-wins；事件 `setting.updated`、actor `USER`、payload `{}`                                                                                                                                                                                                                                                          | 04 §4.3                                      |
| 通知方式与备份策略      | `set_notification_mode` 只认 ALL / CRITICAL / OFF（`NOTIFICATION_MODE_INVALID`），不再同步写 `notification.enabled`；`set_backup_policy` 校验 daily 1～90、weekly 1～52、other 1～20，存 2.x 的 camelCase 形状；能力表没有单列的 backup.policy_set，沿用 settings.write                                                                                                                                            | 04 L-017；旧 key 的读回落留给读侧            |

### 追溯（`tests/quick.rs`、`tests/settings.rs`）

| 规则            | 用例                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| 04 L-013        | `l013_create_and_update_carry_versions`、`l013_c13_update_refusals`                                           |
| 03 C-12         | `c12_agent_actor_is_normalized`                                                                               |
| 03 C-13         | `l013_c13_update_refusals`                                                                                    |
| 04 L-015、C-L05 | `l015_promote_to_an_existing_project`、`l015_promote_refusals`、`l015_untargeted_promote_creates_one_project` |
| 10 R5           | `r5_adopts_and_flags_undone_promotions`                                                                       |
| 04 L-016        | `l016_saved_view_lifecycle`、`l016_refusals`                                                                  |
| 04 L-017、C-L10 | `l017_whitelisted_settings`、`l017_refusals`                                                                  |
| 03 C-06         | `c06_dedicated_settings`                                                                                      |
| ACK 实体        | `read::ack::tests::quick_operations_name_their_entities`                                                      |

L-014（begin 的 quick 分支幂等）在 W2g1 的 `a3_begin_quick_branch` 里。

变异验红：`output/w2-evidence/mutations/mut-w2g2.py`，67 条全部 RED，证据 `output/w2-evidence/w2g2-mutation-evidence.json`。
日期的长度检查起初是等价变异：`Timestamp::parse` 按固定位置校验，长度不对的日期本来就过不去，于是删掉了这道检查。
