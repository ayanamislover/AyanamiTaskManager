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

变异验红：`output/w2-evidence/mutations/mut-w2d.py`，44 条全部 RED，证据 `output/w2-evidence/w2d-mutation-evidence.json`。
任务书点名的三条（batch 比 item.version、跳过候选哈希、门失败后仍提交 VERIFYING）都在其中。
