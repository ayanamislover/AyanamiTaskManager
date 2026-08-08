CREATE TABLE app_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  current_sequence INTEGER NOT NULL DEFAULT 0,
  data_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  db_path TEXT,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('CREATING','ACTIVE','ARCHIVED','RESTORING','MIGRATION_FAILED','TRASHED')),
  coordination_mode TEXT NOT NULL DEFAULT 'AUTO' CHECK(coordination_mode IN ('SOLO','AUTO','MULTI')),
  creation_reason TEXT,
  creation_signals_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE project_paths (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  canonical_path TEXT NOT NULL,
  git_common_dir TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  UNIQUE(project_id, canonical_path),
  UNIQUE(canonical_path)
);

CREATE TABLE project_summary_cache (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  project_sequence INTEGER NOT NULL DEFAULT 0,
  progress REAL NOT NULL DEFAULT 0,
  progress_source TEXT NOT NULL DEFAULT 'NONE',
  health TEXT NOT NULL DEFAULT 'UNKNOWN',
  lifecycle TEXT NOT NULL,
  current_objective TEXT,
  current_milestone TEXT,
  active_count INTEGER NOT NULL DEFAULT 0,
  ready_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  waiting_user_count INTEGER NOT NULL DEFAULT 0,
  waiting_agent_count INTEGER NOT NULL DEFAULT 0,
  active_agent_count INTEGER NOT NULL DEFAULT 0,
  overdue_count INTEGER NOT NULL DEFAULT 0,
  last_project_update_at TEXT,
  last_activity_at TEXT,
  next_target_date TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE global_search_documents (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  project_sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, entity_type, entity_key)
);

CREATE VIRTUAL TABLE global_search_documents_fts USING fts5(
  project_id UNINDEXED,
  entity_type UNINDEXED,
  entity_key UNINDEXED,
  title,
  summary,
  tokenize = 'trigram'
);

CREATE TABLE quick_tasks (
  id TEXT PRIMARY KEY,
  local_no INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('OPEN','IN_PROGRESS','BLOCKED','DONE','CANCELLED','PROMOTED')),
  due_date TEXT,
  source_cwd TEXT,
  actor TEXT NOT NULL,
  percent INTEGER,
  latest_summary TEXT,
  promoted_project_id TEXT REFERENCES projects(id),
  promoted_work_item_key TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE quick_task_updates (
  id TEXT PRIMARY KEY,
  quick_task_id TEXT NOT NULL REFERENCES quick_tasks(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  percent INTEGER,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE saved_views (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  query_json TEXT NOT NULL DEFAULT '{}',
  sort_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE backup_catalog (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('REGISTRY','PROJECT')),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  reason TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT
);

CREATE TABLE global_events (
  sequence INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE import_history (
  source_sha256 TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  result_json TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY(source_sha256, project_id)
);

CREATE INDEX idx_projects_lifecycle ON projects(lifecycle, updated_at DESC);
CREATE INDEX idx_project_paths_common ON project_paths(git_common_dir);
CREATE INDEX idx_quick_tasks_status ON quick_tasks(status, updated_at DESC);
CREATE INDEX idx_global_events_sequence ON global_events(sequence);

