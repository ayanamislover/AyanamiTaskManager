-- 工作阶段与等待对象是正交事实；status 暂时保留为向后兼容投影。
ALTER TABLE work_items
  ADD COLUMN phase TEXT NOT NULL DEFAULT 'BACKLOG'
  CHECK(phase IN ('BACKLOG','READY','CLAIMED','IN_PROGRESS','BLOCKED','VERIFYING','DONE','CANCELLED'));
ALTER TABLE work_items
  ADD COLUMN waiting_on TEXT
  CHECK(waiting_on IS NULL OR waiting_on IN ('USER','AGENT'));
ALTER TABLE work_items
  ADD COLUMN phase_inferred INTEGER NOT NULL DEFAULT 0
  CHECK(phase_inferred IN (0, 1));

UPDATE work_items
SET phase = CASE status
      WHEN 'WAITING_AGENT' THEN 'IN_PROGRESS'
      WHEN 'WAITING_USER' THEN 'IN_PROGRESS'
      ELSE status
    END,
    waiting_on = CASE status
      WHEN 'WAITING_AGENT' THEN 'AGENT'
      WHEN 'WAITING_USER' THEN 'USER'
      ELSE NULL
    END,
    phase_inferred = CASE
      WHEN status IN ('WAITING_AGENT', 'WAITING_USER') THEN 1
      ELSE 0
    END;

CREATE INDEX idx_work_items_phase_waiting
  ON work_items(phase, waiting_on, priority, sort_key);
