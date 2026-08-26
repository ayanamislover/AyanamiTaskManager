-- Review verdict 是跨 Agent 验收的审计事实；请求和提交各自只允许一份落账。
INSERT OR IGNORE INTO counters(name, next_value) VALUES ('review_request', 1);
INSERT OR IGNORE INTO counters(name, next_value) VALUES ('review_submission', 1);

CREATE TABLE review_requests (
  id TEXT PRIMARY KEY,
  local_no INTEGER NOT NULL UNIQUE,
  review_work_item_id TEXT NOT NULL UNIQUE REFERENCES work_items(id) ON DELETE CASCADE,
  parent_work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  parent_checklist_id TEXT NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
  parent_checklist_version INTEGER NOT NULL,
  expected_candidate_hashes_json TEXT NOT NULL,
  created_by_agent_id TEXT NOT NULL,
  created_by_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  created_at TEXT NOT NULL,
  op_id TEXT NOT NULL
);

CREATE TABLE review_submissions (
  id TEXT PRIMARY KEY,
  local_no INTEGER NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE REFERENCES review_requests(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL CHECK(verdict IN ('APPROVED','CHANGES_REQUESTED')),
  reviewed_hashes_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  record_id TEXT NOT NULL UNIQUE REFERENCES records(id),
  reviewer_agent_id TEXT NOT NULL,
  reviewer_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  review_task_version INTEGER NOT NULL,
  parent_checklist_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  op_id TEXT NOT NULL
);

CREATE INDEX idx_review_requests_parent ON review_requests(parent_work_item_id, parent_checklist_id);
CREATE INDEX idx_review_submissions_request ON review_submissions(request_id);
