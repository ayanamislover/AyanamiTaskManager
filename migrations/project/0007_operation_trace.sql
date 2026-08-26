ALTER TABLE records ADD COLUMN op_id TEXT;
ALTER TABLE progress_updates ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE progress_updates ADD COLUMN op_id TEXT;
ALTER TABLE project_updates ADD COLUMN op_id TEXT;
ALTER TABLE events ADD COLUMN op_id TEXT;
ALTER TABLE idempotency_keys ADD COLUMN op_id TEXT;
ALTER TABLE idempotency_keys ADD COLUMN actor_session_id TEXT;

UPDATE idempotency_keys
SET op_id = CASE
  WHEN instr(key, ':') > 0 THEN substr(key, instr(key, ':') + 1)
  ELSE key
END,
actor_session_id = CASE
  WHEN instr(key, ':') > 0 AND substr(key, 1, instr(key, ':') - 1) <> 'session-begin'
    THEN substr(key, 1, instr(key, ':') - 1)
  ELSE NULL
END
WHERE op_id IS NULL;

CREATE INDEX idx_records_op_id ON records(op_id) WHERE op_id IS NOT NULL;
CREATE INDEX idx_progress_updates_op_id ON progress_updates(op_id) WHERE op_id IS NOT NULL;
CREATE INDEX idx_project_updates_op_id ON project_updates(op_id) WHERE op_id IS NOT NULL;
CREATE INDEX idx_events_op_id ON events(op_id) WHERE op_id IS NOT NULL;
CREATE INDEX idx_idempotency_op_id ON idempotency_keys(op_id, actor_session_id);
