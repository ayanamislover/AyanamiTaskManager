ALTER TABLE project_updates
  ADD COLUMN session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL;

CREATE INDEX idx_project_updates_operation_session
  ON project_updates(op_id, session_id)
  WHERE op_id IS NOT NULL;
