# 数据模型边界

## Registry

Registry 保存项目注册、路径别名、摘要缓存、全局搜索投影、Quick Task、保存视图、备份目录、设置和全局事件。它不得保存正式项目的任务正文、检查项、决策正文或完整进度历史。

## Project

每个项目库包含 `project_meta`、计数器、目标、里程碑、工作项、关系、检查项、进度/项目更新、阻塞、记录、附件、Agent/session、领取、交接、事件、幂等键、outbox、设置与 FTS 文档。

所有可编辑聚合有 `version`；所有 Agent/CLI mutation 有 `session_id + op_id` 幂等键与请求指纹；所有领域写入在同一事务写事件和 actor。项目内序列单调递增，Registry 有独立全局序列。

项目身份由不可变 ULID 与全局唯一 `project_code` 组成；源码目录只写 `.ayanami-task/project.json` 身份标记，数据库始终位于受管数据目录。

## Session Git Context

`agent_sessions` 中的 Git 字段是 Session 工作目录的只读观察快照，不是 Agent 声明的事实：`cwd` 确定观察起点，ATM 在 `begin` 和受控刷新时从该目录运行 Git 只读查询，记录 `git_branch`、`git_head`、`git_repo_root`、`worktree_root`、`git_common_dir`、`git_is_linked_worktree`、`git_detached`、`git_dirty`、`git_available` 与 `git_error`。若调用方同时自报 branch/head，以本机观察值为准。

观察失败不会阻止 Session 创建或继续写入任务；ATM 保留可安全复用的已有路径值，将 `git_available` 置为 `0` 并填充稳定的 `git_error`，因此 Git 不可用时只能降级显示，不能据此推断源码状态。刷新产生变化时写入 `agent.git_context.updated` 事件并提升 Session 版本；没有变化则不制造新事件。

自动刷新只发生在 `begin`、有意义的进度/项目更新、`verify`、`complete`、`end`，以及用户明确触发的手动刷新端点。相同 `worktree_root` 或 `git_branch` 的在线 Session 只生成冲突警告，关系不构成互斥锁，也不会阻止领取或执行。
