-- 取消原因和任务关系是 WorkItem 的持久事实，不能只存在于一次事件 payload 中。
ALTER TABLE work_items ADD COLUMN cancel_reason TEXT;
ALTER TABLE work_items
  ADD COLUMN duplicate_of_id TEXT REFERENCES work_items(id) ON DELETE SET NULL;
ALTER TABLE work_items
  ADD COLUMN superseded_by_id TEXT REFERENCES work_items(id) ON DELETE SET NULL;

CREATE INDEX idx_work_items_duplicate_of ON work_items(duplicate_of_id);
CREATE INDEX idx_work_items_superseded_by ON work_items(superseded_by_id);
