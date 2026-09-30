-- 总览「最近变化」分业务、系统两个窗口取事件，备份健康单独取最近一次备份结果（ATM-T-0536）。
-- 系统事件、备份事件稀少的库里，没有索引就要把整张 global_events 扫一遍。
-- 部分索引的条件必须和 packages/storage-sqlite/src/global-event-queries.ts 的查询条件结构一致，
-- SQLite 才会用上；改一边就要改另一边（有 EXPLAIN QUERY PLAN 用例盯着）。
CREATE INDEX idx_global_events_system_class
ON global_events(sequence)
WHERE (COALESCE(actor, 'SYSTEM') = 'SYSTEM' OR type LIKE 'backup.%'
      OR type IN ('project.creating', 'agent.git_context.updated', 'database.recovered'));

CREATE INDEX idx_global_events_backup_outcome
ON global_events(sequence)
WHERE type IN ('backup.created', 'backup.failed');
