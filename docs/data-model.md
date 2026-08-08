# 数据模型边界

## Registry

Registry 保存项目注册、路径别名、摘要缓存、全局搜索投影、Quick Task、保存视图、备份目录、设置和全局事件。它不得保存正式项目的任务正文、检查项、决策正文或完整进度历史。

## Project

每个项目库包含 `project_meta`、计数器、目标、里程碑、工作项、关系、检查项、进度/项目更新、阻塞、记录、附件、Agent/session、领取、交接、事件、幂等键、outbox、设置与 FTS 文档。

所有可编辑聚合有 `version`；所有 Agent/CLI mutation 有 `session_id + op_id` 幂等键与请求指纹；所有领域写入在同一事务写事件和 actor。项目内序列单调递增，Registry 有独立全局序列。

项目身份由不可变 ULID 与全局唯一 `project_code` 组成；源码目录只写 `.ayanami-task/project.json` 身份标记，数据库始终位于受管数据目录。
