-- 总览「最近变化」分业务、系统两个窗口取事件，备份健康单独取最近一次备份结果（ATM-T-0536）。
-- 哪一类在某个库里稀少，没有索引时 LIMIT 就管不住扫描量，要把整张 global_events 扫一遍。
-- 条件与 packages/storage-sqlite/src/global-event-queries.ts 的查询条件结构一致，SQLite 才会用上
-- （有 EXPLAIN QUERY PLAN 用例盯着）。本迁移发布后不能再改：要改条件就新增迁移重建索引。
-- 不用 LIKE：连接上设过 case_sensitive_like 时，含 LIKE 的部分索引建不起来。
CREATE INDEX idx_global_events_business_class
ON global_events(sequence)
WHERE type <> 'project.summary.updated'
  AND NOT (COALESCE(actor, 'SYSTEM') = 'SYSTEM' OR substr(type, 1, 7) = 'backup.'
      OR type IN ('project.creating', 'agent.git_context.updated', 'database.recovered'));

CREATE INDEX idx_global_events_system_class
ON global_events(sequence)
WHERE type <> 'project.summary.updated'
  AND (COALESCE(actor, 'SYSTEM') = 'SYSTEM' OR substr(type, 1, 7) = 'backup.'
      OR type IN ('project.creating', 'agent.git_context.updated', 'database.recovered'));

CREATE INDEX idx_global_events_backup_outcome
ON global_events(sequence)
WHERE type IN ('backup.created', 'backup.failed');
