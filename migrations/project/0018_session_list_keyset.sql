CREATE INDEX idx_agent_sessions_list_keyset
  ON agent_sessions(started_at DESC, id DESC);
