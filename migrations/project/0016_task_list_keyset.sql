-- Stable WorkItem keyset order. The expression matches the canonical task list query exactly.
CREATE INDEX idx_work_items_task_list_keyset
  ON work_items(
    (CASE priority
      WHEN 'CRITICAL' THEN 0
      WHEN 'HIGH' THEN 1
      WHEN 'NORMAL' THEN 2
      ELSE 3
    END),
    sort_key,
    created_at,
    local_no
  )
  WHERE archived_at IS NULL;
