ALTER TABLE agent_sessions ADD COLUMN git_repo_root TEXT;
ALTER TABLE agent_sessions ADD COLUMN worktree_root TEXT;
ALTER TABLE agent_sessions ADD COLUMN git_common_dir TEXT;
ALTER TABLE agent_sessions ADD COLUMN git_is_linked_worktree INTEGER;
ALTER TABLE agent_sessions ADD COLUMN git_detached INTEGER;
ALTER TABLE agent_sessions ADD COLUMN git_dirty INTEGER;
ALTER TABLE agent_sessions ADD COLUMN git_available INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_sessions ADD COLUMN git_error TEXT;

CREATE INDEX idx_agent_sessions_active_worktree
  ON agent_sessions(connection_state, worktree_root);
CREATE INDEX idx_agent_sessions_active_branch
  ON agent_sessions(connection_state, git_branch);
