# 服务层权限矩阵（W2h1）

依据：03 §3 能力目录、§4 入口矩阵、§5 Agent 拒绝用例。能力表本身在 `domain/src/capability.rs`（W1，一处定义）；
这里列出每项能力在**服务层**的入口与验证它的用例。HTTP、MCP、宿主桥这些入口的接线在 W4 完成，届时再补 L3 的入口用例。

判定顺序：每个服务入口的第一步都是 `capability::require`，先于读库、回执重放和任何副作用（P-004）。被拒时：

- Agent 调用 U-only 能力：`USER_AUTHORIZATION_REQUIRED`，details 带 `principal`、`capability`；
- 其他主体调用未授权能力：`PRINCIPAL_CAPABILITY_DENIED`。

拒绝时的无副作用检查（03 §5.1）：

- `tests/permissions.rs` 对每个 U-only 入口比对整库逐表（NS-1、NS-2：所有表，含 FTS 影子表、回执、事件、计数器、世代），
  再比对数据根下除库文件外的全部文件（NS-3、NS-4：含 `backups/`，所以没有 PRE\_\* 备份，也没有修剪）；
- 阳性对照：同一组调用换成 User，16 个写入口各自留下可见变化，3 个读入口返回内容；
- NS-5～NS-9（子进程、网络、Agent 配置、宿主状态、内存队列）在服务层没有通道，随对应能力在 W4、W5 落地时验。

## U-only 写能力（服务层已实现）

| 能力                                                  | 服务入口                                                             | Agent 拒绝 + NS                                                                                                                      | User 阳性                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `session.force_close`                                 | `force_close_session`                                                | `p005_agents_are_refused_every_user_only_capability_without_side_effects`                                                            | `p005_the_same_calls_succeed_for_the_user`；`tests/session.rs` S-017 |
| `session.git_refresh`                                 | `refresh_git_context`                                                | 同上                                                                                                                                 | 同上；`tests/session.rs`                                             |
| `project.path_attach`                                 | `attach_path`                                                        | 同上                                                                                                                                 | 同上；`tests/project.rs` `l010_attach_path`                          |
| `project.archive` / `unarchive` / `trash` / `untrash` | `set_lifecycle`                                                      | 同上（四条，各自无 PRE\_\* 备份）                                                                                                    | 同上；`l002_*`、`l006_l007_*`                                        |
| `project.restore_request.decide`                      | `decide_restore_request`，列表 `trash`                               | 同上（两条）                                                                                                                         | 同上；`l005_restore_requests_are_decided_once`                       |
| `knowledge.user_edit`                                 | `knowledge_save`                                                     | 同上；另见 `tests/knowledge.rs` `l103`                                                                                               | 同上                                                                 |
| `knowledge.archive`                                   | `knowledge_archive`                                                  | 同上；另见 `l104`                                                                                                                    | 同上                                                                 |
| `saved_view.manage`                                   | `create_saved_view` / `update_saved_view` / `delete_saved_view`      | 同上（三条）；另见 `l016_refusals`                                                                                                   | 同上                                                                 |
| `settings.write`                                      | `set_setting`、`set_backup_policy`                                   | 同上（两条）；另见 `l017_refusals`、`c06_dedicated_settings`                                                                         | 同上                                                                 |
| `notification.mode_set`                               | `set_notification_mode`                                              | 同上；另见 `c06_dedicated_settings`                                                                                                  | 同上                                                                 |
| `agents.profile_switch`                               | `set_memory_profile`（W6d：只记偏好，客户端同步与回滚在 atm-agents） | 同上；另见 `c06_dedicated_settings`、atm-agents `tests/agents.rs`                                                                    | 同上                                                                 |
| `project_update.draft` / `project_update.publish`     | `draft_project_update` / `publish_project_update`                    | 同上（两条）；另见 `tests/planning.rs` `project_updates_are_user_only`                                                               | 同上；`project_update_draft_then_publish`                            |
| `import.apply`                                        | `apply_import`、`import_source`（W6c：项目包与 2.x 备份）            | 同上；另见 `tests/import.rs` `preview_is_read_only_and_apply_is_user_only`、ui-bridge `tests/exchange.rs`                            | 同上；`apply_imports_everything_at_once`、store `tests/package.rs`   |
| `export.create`                                       | `export_project`（W6c；00 C-07 v6：只有 User，不建备份、不修剪）     | ui-bridge `tests/exchange.rs` `a_project_exports_and_imports_back_as_a_new_project`；Agent HTTP 的 #27 拒绝桩见 http `tests/rest.rs` | store `tests/package.rs`                                             |
| `backup.create_manual`                                | `create_manual_backup`                                               | 同上；另见 `tests/backups.rs`                                                                                                        | 同上；`backups_are_listed_and_made_by_the_user`                      |
| `backup.restore_scope`                                | `restore_scope`                                                      | 同上；另见 `tests/backups.rs`                                                                                                        | 同上；`restore_scope_is_user_only_and_restores_one_project`          |

U-only 读能力 `saved_view.read`（`list_saved_views`）、`settings.read`（`get_setting` / `list_settings`）、`knowledge.preview_record`（`preview_record`）同样在上面两条用例里（共 25 个入口：21 写、4 读）。

变异验红：`output/w2-evidence/mutations/mut-w2h1.py` 把能力表里每项上述能力的 `A false` 逐个改成 `A true`，
`p005_agents_are_refused_*` 必须变红：15 条全部 RED，证据 `output/w2-evidence/w2h1-mutation-evidence.json`。

## Agent 专属能力（User 被拒）

| 能力                               | 服务入口                             | 用例                                                                                   |
| ---------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------- |
| `session.begin`                    | `begin`                              | `p004_users_are_denied_agent_only_capabilities`                                        |
| `session.end`                      | `end_session`                        | `p004_users_are_denied_agent_only_capabilities`；谱系限制见 `tests/session.rs`（C-04） |
| `knowledge.agent_save`             | `knowledge_save_agent`               | `p004_users_are_denied_agent_only_capabilities`                                        |
| `progress.add`                     | `add_progress`                       | 同上                                                                                   |
| `record.feedback`                  | `feedback`                           | 同上                                                                                   |
| `review.request` / `review.submit` | `request_review` / `submit_review`   | `tests/composite.rs`（W2d，C-10 User 不能评审）                                        |
| `project.restore_request.create`   | 只经 `begin` 撞上 TRASHED 时隐式触发 | `l003_l004_trashed_begin_registers_a_restore_request`                                  |

## User 与 Agent 都可用（服务层已实现）

| 能力                                                                       | 服务入口                                                                                                      | 用例所在                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `project.create`                                                           | `create_project`、`begin` ④                                                                                   | `tests/project.rs`                                                    |
| `work.create` / `work.patch` / `work.verify_complete` / `checklist.update` | `create_work_items`、`patch_work_items`、`verify_and_complete`、`update_checklist` / `update_checklist_batch` | `tests/work.rs`、`tests/composite.rs`（W2c、W2d）                     |
| `record.create`                                                            | `create_record`                                                                                               | `tests/memory.rs`                                                     |
| `quick.create` / `quick.update` / `quick.promote`                          | `quick_create`、`quick_update`、`quick_promote`                                                               | `tests/quick.rs`（C-12：Agent 不能以 USER / SYSTEM / PHONE 为 actor） |
| `work.plan`                                                                | `create_objective`、`create_milestone`（Agent 要 session 与 op_id，00 02 C-11）                               | `tests/planning.rs`                                                   |
| `import.preview`                                                           | `preview_import`（只解析，不落账）；`import_sources`、`preview_import_source`（W6c，只读，不写任何文件）      | `tests/import.rs`；ui-bridge `tests/exchange.rs`                      |
| `backup.list`                                                              | `list_backups`                                                                                                | `tests/backups.rs`                                                    |
| `metrics.read`                                                             | `metrics_read`（只读已存指标，不调 git、不刷新；C-08）                                                        | `tests/metrics.rs`                                                    |
| `*.read`、`quick.read`、`knowledge.read`                                   | 读模型与 `quick_get`、`knowledge_search` / `knowledge_get` / `knowledge_history`                              | `tests/read.rs`、`tests/knowledge_read.rs`                            |

## System 作业

| 能力                    | 允许的 job        | 服务入口         | 用例                 |
| ----------------------- | ----------------- | ---------------- | -------------------- |
| `session.recover_stale` | `startup.recover` | `sweep_sessions` | `tests/session.rs`   |
| 读快照                  | `sync.loop`       | 读模型           | 能力表单元测试（W1） |

## 不在 W2 的能力（归属阶段，peer W2 r1 P1-05 之后的边界）

W2 交付全部**只依赖库与服务**的业务。下面这些要么依赖另一个子系统，要么本身就是宿主或后台作业，随那个子系统落地；
边界写进了方案 `output/core-rust-plan.md` §11 的 W2 一行（ATM 记录）。

| 能力                                                                                                                    | 主体                  | 归属与理由                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `backup.create_scheduled` / `backup.prune_retention`                                                                    | System（maintenance） | W5：维护作业的调度与保留期（跳过 `pinned_until` 未到的备份）；机制已在 W1，手动备份与按范围恢复已在本层                        |
| `metrics.refresh` / `metrics.capture`                                                                                   | 见能力表              | W5：采集要调 git、在提交之后异步做（03 §2 metrics.capture），属于合进程后的观察者；`metrics.read` 已在本层（W2 peer r2 P1-03） |
| `sync.*`（W7c 已落地，见下节）、`dispatch.*`                                                                            | 见能力表              | W7：atm-sync 与派单子系统；派单在 W7d                                                                                          |
| `agents.*`、`update.*`、`shell.*`、`system.status`                                                                      | U（宿主）             | W4 / W6：宿主方法；`agents.*` 的入口在 atm-agents `integrations.rs`（W6d，拒绝用例在它的 `tests/agents.rs`）                   |
| `store.cleanup`、`store.maintain`、`notify.send`、`sync.run`、`dispatch.track`、`agents.docs_install`、`memory.release` | System                | W5 / W6 / W7：各自的后台作业                                                                                                   |

这些能力落地时，各自的 Agent 拒绝用例按 03 §5.3 补齐（含 NS-5～NS-9），并加入 `mut-w2h1.py` 同类的变异。

## 手机同步（W7c，atm-sync）

设置页的五个入口都在 `sync/src/connector.rs`，第一步是 `capability::require`（经 `Service::sync_ledger` / `save_sync_ledger`
或在入口处直接检查），Agent 一律 `USER_AUTHORIZATION_REQUIRED`：

| 入口             | 能力                  | Agent 拒绝 + NS                                                                          | User 阳性                                                               |
| ---------------- | --------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `status`         | `sync.status`         | `sync/tests/connector.rs` `agents_are_refused_every_settings_entry_without_side_effects` | `status_carries_no_secret_and_matches_the_desktop_contract`             |
| `update_config`  | `sync.configure`      | 同上                                                                                     | `a_rejected_token_stops_until_a_new_one_is_saved`                       |
| `test_relay`     | `sync.test_relay`     | 同上                                                                                     | `test_relay_reports_without_reflecting_relay_text`                      |
| `create_pairing` | `sync.pairing_create` | 同上                                                                                     | `concurrent_pairing_requests_create_one_space_and_return_the_same_code` |
| `reset_space`    | `sync.reset`          | 同上                                                                                     | `reset_space_leaves_only_a_revocation_and_the_new_code_works`           |

拒绝用例比对的副作用：库里每张表（NS-1/2）、数据根下的文件（NS-3）、出站请求（NS-6：后台循环自己的 `GET /changes`
之外零请求，Agent 给的地址与 token 不出现在任何请求里）、宿主状态与内存队列（NS-8/9：阶段、状态、内存账本、待发布的脏集合）。
atm-sync 没有子进程与 Agent 配置的通道（NS-5、NS-7），由 `sync/tests/guards.rs` 扫源码与依赖看着。

Phone 主体只在 sync crate 里构造（`Principal::verified_phone`），只有 `work.create` 与 `dispatch.launch`；同步循环自己的
System 主体只能是 `system_job(JobId::SyncLoop)`（`domain/tests/principal_guard.rs` 的唯一例外）。手机端到端见
`sync/tests/commands.rs`（P-008、03 C-05）。
