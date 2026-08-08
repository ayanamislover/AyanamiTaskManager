CREATE TABLE project_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  project_id TEXT NOT NULL UNIQUE,
  project_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE',
  coordination_mode TEXT NOT NULL DEFAULT 'AUTO',
  health TEXT NOT NULL DEFAULT 'UNKNOWN',
  current_sequence INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL
);

CREATE TABLE objectives (
  id TEXT PRIMARY KEY,
  local_no INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition_of_done_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('PLANNED','ACTIVE','DONE','CANCELLED')),
  weight REAL NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  local_no INTEGER NOT NULL UNIQUE,
  objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  planned_start_date TEXT,
  target_date TEXT,
  status TEXT NOT NULL CHECK(status IN ('PLANNED','ACTIVE','DONE','CANCELLED')),
  weight REAL NOT NULL DEFAULT 1,
  sort_key INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  local_no INTEGER NOT NULL UNIQUE,
  parent_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
  objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK(type IN ('EPIC','TASK','SUBTASK','BUG','RESEARCH','REVIEW')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  priority TEXT NOT NULL CHECK(priority IN ('LOW','NORMAL','HIGH','CRITICAL')),
  sort_key INTEGER NOT NULL DEFAULT 0,
  planned_start_date TEXT,
  target_date TEXT,
  started_at TEXT,
  completed_at TEXT,
  assignee_agent_id TEXT,
  claimed_by_session_id TEXT,
  claim_lease_until TEXT,
  reported_progress REAL,
  computed_progress REAL NOT NULL DEFAULT 0,
  progress_source TEXT NOT NULL DEFAULT 'NONE',
  weight REAL NOT NULL DEFAULT 1,
  blocked_reason TEXT,
  waiting_for TEXT,
  verification_required INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  created_by_agent_id TEXT,
  created_by_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  source_quick_id TEXT UNIQUE
);

CREATE TABLE work_item_relations (
  source_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK(relation_type IN ('BLOCKS','RELATES','DUPLICATES')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_id, target_id, relation_type),
  CHECK(source_id <> target_id)
);

CREATE TABLE checklist_items (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('REQUIRED','OPTIONAL','ACCEPTANCE','VERIFICATION')),
  status TEXT NOT NULL CHECK(status IN ('TODO','DOING','DONE','SKIPPED')),
  weight REAL NOT NULL DEFAULT 1,
  evidence_required INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE work_item_labels (
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY(work_item_id, label_id)
);

CREATE TABLE progress_updates (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  percent REAL,
  progress_bucket INTEGER,
  summary TEXT NOT NULL,
  summary_hash TEXT NOT NULL,
  completed_json TEXT NOT NULL DEFAULT '[]',
  next_json TEXT NOT NULL DEFAULT '[]',
  blocker_text TEXT,
  actor TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE project_updates (
  id TEXT PRIMARY KEY,
  health TEXT NOT NULL CHECK(health IN ('ON_TRACK','AT_RISK','OFF_TRACK','UNKNOWN')),
  summary TEXT NOT NULL,
  completed_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  next_json TEXT NOT NULL DEFAULT '[]',
  from_sequence INTEGER NOT NULL,
  to_sequence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('DRAFT','PUBLISHED')),
  actor TEXT NOT NULL,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE blockers (
  id TEXT PRIMARY KEY,
  local_no INTEGER NOT NULL UNIQUE,
  work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
  severity TEXT NOT NULL CHECK(severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  waiting_for TEXT,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','RESOLVED','CANCELLED')),
  actor TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE records (
  id TEXT PRIMARY KEY,
  local_no INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('DECISION','CONSTRAINT','FACT','RISK','REFERENCE','LESSON','VERIFICATION','WAIVER')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  importance TEXT NOT NULL CHECK(importance IN ('LOW','NORMAL','HIGH','CRITICAL')),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','SUPERSEDED','RETRACTED')),
  supersedes_id TEXT REFERENCES records(id),
  scope TEXT NOT NULL DEFAULT 'PROJECT',
  work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
  actor TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
  record_id TEXT REFERENCES records(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  local_path TEXT,
  external_ref TEXT,
  sha256 TEXT,
  size_bytes INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  client_kind TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  parent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  thread_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('PRIMARY','SUBAGENT','REVIEWER','OBSERVER')),
  cwd TEXT,
  git_branch TEXT,
  git_head TEXT,
  work_state TEXT NOT NULL,
  connection_state TEXT NOT NULL,
  current_work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
  heartbeat_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  from_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  to_agent_id TEXT NOT NULL REFERENCES agents(id),
  summary TEXT NOT NULL,
  next_action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  session_id TEXT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  causation_id TEXT,
  correlation_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  project_sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE search_documents (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(entity_type, entity_id)
);

CREATE VIRTUAL TABLE search_documents_fts USING fts5(
  entity_type UNINDEXED,
  entity_id UNINDEXED,
  entity_key UNINDEXED,
  title,
  body,
  tokenize = 'trigram'
);

CREATE INDEX idx_milestones_objective ON milestones(objective_id, sort_key);
CREATE INDEX idx_work_items_status ON work_items(status, priority, sort_key);
CREATE INDEX idx_work_items_parent ON work_items(parent_id);
CREATE INDEX idx_work_items_milestone ON work_items(milestone_id, status);
CREATE INDEX idx_relations_target ON work_item_relations(target_id, relation_type);
CREATE INDEX idx_checklist_work ON checklist_items(work_item_id, status);
CREATE INDEX idx_progress_work_created ON progress_updates(work_item_id, created_at DESC);
CREATE INDEX idx_blockers_status ON blockers(status, severity);
CREATE INDEX idx_records_active ON records(status, importance, kind);
CREATE INDEX idx_sessions_state ON agent_sessions(connection_state, work_state);
CREATE INDEX idx_events_sequence ON events(sequence);
CREATE INDEX idx_outbox_pending ON outbox(delivered_at, project_sequence);
