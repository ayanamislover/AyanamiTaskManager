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

`FpInput(family, author)` 由每个 operation 提供，返回业务字段（规范化后，不含定位字段与控制字段）。`None` 表示这个族表达不了这次请求（A3 的可比性检查），与该族的候选不匹配。canon-v2 必须总能表达。

| 候选的族     | 重建用的作者                                          |
| ------------ | ----------------------------------------------------- |
| canon-v2     | 候选的 `author_agent / author_session`                |
| kernel-v1    | 候选的 `actor_session_id`（2.x 0007 拆出的列）        |
| knowledge-v1 | 命中这条候选的那个 lineage 成员（旧键本身含 session） |

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

`complete` 一步带 `note` / `evidence` / `checklist`（R11 P1-1 第 4 条）要用检查项写入，随 W2d 的复合操作一起做。

### D01–D17 追溯（服务层部分；纯规则部分见 `domain/DOMAIN-NOTES.md`）

| 编号                                                   | 用例（`tests/work.rs`）                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01 状态机入口、同态、ready 无副作用                   | `w029_ready_has_no_side_effects`、`w020_verify_is_refused_on_closed_tasks`、`w021_check_order`                                                                                                                                                                                  |
| D02 等待保存 phase、reopen 目标                        | `w031_waiting_keeps_the_phase`、`w034_c04_c05_reopen`                                                                                                                                                                                                                           |
| D03 依赖必须 DONE                                      | `w024_c11_c29_dependencies_must_be_done`、`w075_discovered_from_is_searchable_but_not_blocking`                                                                                                                                                                                 |
| D04 占用、租约、takeover、successor reclaim、release   | `w025_r2_claims_belong_to_the_lineage`、`w026_successor_reclaim`、`w028_c06_c08_release`、`c09_r2_writes_renew_the_lease`                                                                                                                                                       |
| D05、D06 完成门                                        | `w032_c03_c24_complete`、`w030_c28_block`、`r11_p1_1_complete_auto_starts`                                                                                                                                                                                                      |
| D07 verify_and_complete                                | W2d                                                                                                                                                                                                                                                                             |
| D08 start / reopen 解除阻塞、completed_at、cancel 引用 | `w027_start_resolves_blockers_and_keeps_started_at`、`w034_c04_c05_reopen`、`w033_cancel`                                                                                                                                                                                       |
| D09 批量创建                                           | `c01_p1_5_create_defaults_to_ready_at_version_one`、`c17_public_create_refuses_other_states`、`w071_planning_root_is_provisioned_for_agents_only`、`w072_c18_objective_and_milestone_are_checked`、`w073_w076_batch_references_and_cycles`、`c01_c02_create_versions`、`w075_*` |
| D10 版本与安全合并                                     | `w041_batch_relay_and_rollback`、`w100_concurrent_writers_one_wins`、`w101_safe_merge`、`r11_version_is_optional_on_the_owner_path`                                                                                                                                             |
| D11、D12、D13～D16                                     | W2d                                                                                                                                                                                                                                                                             |
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
