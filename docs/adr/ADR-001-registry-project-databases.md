# ADR-001：Registry + 每项目独立 SQLite

状态：Accepted

全局 `registry.sqlite` 只保存项目注册、可重建摘要/搜索投影、设置、备份目录和 Quick Task；每个正式项目使用独立 `project.sqlite` 保存全部项目事实。项目库损坏、迁移失败、归档和恢复互不影响，正式任务不得落入 Registry。
