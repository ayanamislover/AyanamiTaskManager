ALTER TABLE records ADD COLUMN source_type TEXT NOT NULL DEFAULT 'AGENT'
  CHECK(source_type IN ('USER','AGENT','SYSTEM','IMPORT'));
ALTER TABLE records ADD COLUMN source_actor_id TEXT;
ALTER TABLE records ADD COLUMN source_session_id TEXT;
ALTER TABLE records ADD COLUMN source_ref TEXT;

UPDATE records
SET source_type = CASE actor
    WHEN 'USER' THEN 'USER'
    WHEN 'SYSTEM' THEN 'SYSTEM'
    ELSE 'AGENT'
  END,
  source_actor_id = actor;

ALTER TABLE agent_sessions ADD COLUMN predecessor_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL;
ALTER TABLE agent_sessions ADD COLUMN retirement_reason TEXT;

ALTER TABLE handoffs ADD COLUMN to_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL;
ALTER TABLE handoffs ADD COLUMN checkpoint_sequence INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_records_resume
  ON records(status, source_type, kind, importance, updated_at DESC);
CREATE INDEX idx_agent_sessions_predecessor
  ON agent_sessions(predecessor_session_id);
CREATE INDEX idx_handoffs_checkpoint
  ON handoffs(work_item_id, checkpoint_sequence DESC);
