# 数据模型边界

3.0 只有一个库 `data\atm.sqlite`（位于 `%LOCALAPPDATA%\AyanamiTaskManager3`）：全局实体、各项目数据（以 `project_id` 区分）与知识表同库，表结构见 `apps/desktop/native/store/migrations/0001_schema_v1.sql`。每个项目与知识库各是一个范围，有独立的范围世代（`scope_generations`），按范围恢复时只换这一个范围的数据。2.x 的 Registry 库与每项目一个库的划分、outbox 与投影缓存在 3.0 都不存在；转换时 2.x 的数据逐值并入这一个库。

## 全局

`app_meta` 记录库身份、发布代际（generation）、实例纪元与全局序列；`projects`、`project_paths` 保存项目注册与路径，`quick_tasks`、`saved_views`、`settings`、`import_history`、`project_restore_requests` 是全局实体；`global_feed` 是只增不删的全局事件流，按范围恢复时只给备份点之后的行打上撤销标记。手机同步与派单的配置和账本（`sync_state`、`sync_processed`、`dispatch_runs`、`dispatch_requests` 等）、整库备份登记 `backups` 与 2.x 备份的只读登记 `legacy_backups` 也在这里。

## Project

项目数据包括计数器、目标、里程碑、工作项、关系、检查项、进度/项目更新、阻塞、记录、附件、Agent/session、领取、交接、事件、review、工程统计与搜索文档，一律以 `(project_id, …)` 复合键存放。幂等回执在全库共用的 `idempotency_receipts` 表里，按范围（`PROJECT`、`KNOWLEDGE`、`GLOBAL`）区分。

所有可编辑聚合有 `version`；所有 Agent/CLI mutation 有 `session_id + op_id` 幂等键与请求指纹；所有领域写入在同一事务写事件和 actor。项目内序列单调递增，全局事件流有独立的全局序列。

项目身份由不可变 ULID 与全局唯一 `project_code` 组成；源码目录只写 `.ayanami-task/project.json` 身份标记，数据库始终位于受管数据目录。

## Knowledge

知识表包括 `knowledge_meta`（数据库身份、世代、目录序列、范围世代）、`knowledge_entries`（永久 ID、可编辑 slug、head revision、乐观锁 version、归档状态）、`knowledge_revisions`（完整 JSON 快照及唯一 `revision_id`）和 `knowledge_fts`（当前修订索引与无正文元数据投影）；保存的幂等回执记在 `idempotency_receipts` 里，范围为 `KNOWLEDGE`。数字修订序号从 1 开始，仅供显示与历史排序；永久引用是 `entryId@revisionId`。来源 Record 自身的版本可从 0 开始。

旧修订不受重命名、归档和源项目删除影响，库里的触发器拒绝修改修订、只在知识库恢复事务里允许删除。归档仅修改条目状态；回看旧版或用旧版内容另存会创建新修订，不改写旧快照。`project_record` 来源必须带不可变 projectId、recordId、sourceVersion 和可读 key。文件/URL 来源只是引用，不会触发访问或执行。

搜索游标绑定数据库身份、generation、目录序列、查询及筛选；目录改变要求重搜。正文游标固定永久 ID、`revisionId`、首屏编辑版本、章节和偏移，不绑定易变目录序列或预算，正常重启可继续。恢复备份刷新 generation，使恢复前游标明确失效；`entryId@revisionId` 可重新读取备份内存在的版本，不存在则返回 NOT_FOUND。不能用恢复后可能重用的数字序号充当永久引用。

更新与归档同时校验 `expectedVersion` 和 `expectedRevisionId`，防止恢复旧备份后版本号回退、再增长到相同数字时让旧编辑请求绕过冲突检测。幂等重试仍先于版本校验；客户端保留同一草稿请求的 opId，直到保存成功或内容改变。

知识库没有单独的备份：整库备份同时含知识表，恢复时选择“知识库”范围，只换知识表、在一个事务里完成。项目导出（`.aytproj`）不包含知识库；2.x 的知识库备份可以导入，合并进知识库，id 或 slug 已存在的条目跳过。应用打包仅包含迁移与通用 Skill，不含用户知识。

## Session Git Context

`agent_sessions` 中的 Git 字段是 Session 工作目录的只读观察快照，不是 Agent 声明的事实：`cwd` 确定观察起点，ATM 在 `begin` 和受控刷新时从该目录运行 Git 只读查询，记录 `git_branch`、`git_head`、`git_repo_root`、`worktree_root`、`git_common_dir`、`git_is_linked_worktree`、`git_detached`、`git_dirty`、`git_available` 与 `git_error`。若调用方同时自报 branch/head，以本机观察值为准。

观察失败不会阻止 Session 创建或继续写入任务；ATM 保留可安全复用的已有路径值，将 `git_available` 置为 `0` 并填充稳定的 `git_error`，因此 Git 不可用时只能降级显示，不能据此推断源码状态。刷新产生变化时写入 `agent.git_context.updated` 事件并提升 Session 版本；没有变化则不制造新事件。

自动刷新只发生在 `begin`、有意义的进度/项目更新、`verify`、`complete`、`end`，以及用户明确触发的手动刷新端点。相同 `worktree_root` 或 `git_branch` 的在线 Session 只生成冲突警告，关系不构成互斥锁，也不会阻止领取或执行。
