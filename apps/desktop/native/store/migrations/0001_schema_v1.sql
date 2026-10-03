-- ATM 3 单库 schema v1（W1a）。
-- 底稿是 output/atm3-spec/05-data-mapping.md §2.2，按 10-w0-r1-resolutions.md 的 R3/R3′/R4/R4′/R5/R6/A3 调和。
-- 与 05 的每一处差异都写在 store/SCHEMA-NOTES.md。
-- 约定：2.0 的 id 逐值保留；项目实体一律 (project_id, …) 复合键；
-- 复合 FK 一律 DEFERRABLE INITIALLY DEFERRED、无级联（05 §2.1 第 3 条）。

-- ===== 0. 元数据 =====
CREATE TABLE app_meta (
  singleton          INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version     INTEGER NOT NULL,
  data_root_id       TEXT    NOT NULL,
  generation         TEXT    NOT NULL,
  instance_epoch     TEXT    NOT NULL,
  global_seq         INTEGER NOT NULL DEFAULT 0,
  scope_gen_counter  INTEGER NOT NULL DEFAULT 0,
  converted_from     TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- 范围世代：由 app_meta.scope_gen_counter 分配，永不复用（05 §2.7，A3）。
CREATE TABLE scope_generations (
  gen INTEGER PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('PROJECT','KNOWLEDGE')),
  scope_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('CONVERTED','CREATED','RESTORED','IMPORTED')),
  backup_id TEXT, pre_restore_backup_id TEXT,
  seq_before INTEGER, seq_after INTEGER,
  epoch TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX ix_scope_generations_scope ON scope_generations(scope_kind, scope_id, gen);

-- 仅在恢复事务内有行，事务结束前删除。
CREATE TABLE restore_guard (scope_kind TEXT PRIMARY KEY);

-- ===== 1. 全局实体 =====
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- L-001：持久状态只有三个；RESTORING / CREATING / MIGRATION_FAILED 不再持久化。
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('ACTIVE','ARCHIVED','TRASHED')),
  coordination_mode TEXT NOT NULL DEFAULT 'AUTO' CHECK (coordination_mode IN ('SOLO','AUTO','MULTI')),
  health TEXT NOT NULL DEFAULT 'UNKNOWN',
  creation_reason TEXT,
  creation_signals_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0,
  meta_version INTEGER NOT NULL DEFAULT 0,
  project_seq INTEGER NOT NULL DEFAULT 0,
  scope_gen INTEGER NOT NULL REFERENCES scope_generations(gen) DEFERRABLE INITIALLY DEFERRED,
  epoch TEXT NOT NULL,
  legacy_schema_version INTEGER,
  -- W1f：2.x 原值。registry 的 db_path 与项目库的整行 project_meta 放不进单库的列
  -- （project_meta 的 lifecycle / updated_at 等与 registry 各走各的，2.0 从不同步），转换时原样存这里供反投影。
  legacy_json TEXT CHECK (legacy_json IS NULL OR json_valid(legacy_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
);
CREATE INDEX ix_projects_lifecycle ON projects(lifecycle, updated_at DESC);

CREATE TABLE project_paths (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  canonical_path TEXT NOT NULL UNIQUE,
  git_common_dir TEXT, is_primary INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT NOT NULL,
  UNIQUE (project_id, canonical_path)
);
CREATE INDEX ix_project_paths_common ON project_paths(git_common_dir);

CREATE TABLE quick_tasks (
  id TEXT PRIMARY KEY, local_no INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('OPEN','IN_PROGRESS','BLOCKED','DONE','CANCELLED','PROMOTED')),
  due_date TEXT, source_cwd TEXT, actor TEXT NOT NULL, percent INTEGER, latest_summary TEXT,
  promoted_project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  promoted_work_item_key TEXT,
  -- R5：全局引用双重绑定，存公开 key 的同时存不可复用的实体 id。读取时核对，对不上即「已被恢复撤销」。
  promoted_work_item_id TEXT,
  version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX ix_quick_tasks_status ON quick_tasks(status, updated_at DESC);
CREATE INDEX ix_quick_tasks_search_keyset ON quick_tasks(updated_at DESC, local_no);

CREATE TABLE quick_task_updates (
  id TEXT PRIMARY KEY,
  quick_task_id TEXT NOT NULL REFERENCES quick_tasks(id) DEFERRABLE INITIALLY DEFERRED,
  summary TEXT NOT NULL, percent INTEGER, actor TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE saved_views (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  name TEXT NOT NULL, query_json TEXT NOT NULL DEFAULT '{}', sort_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);

CREATE TABLE import_history (
  source_sha256 TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  result_json TEXT NOT NULL, imported_at TEXT NOT NULL,
  PRIMARY KEY (source_sha256, project_id)
);

CREATE TABLE project_restore_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  requested_by TEXT NOT NULL, source_cwd TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count >= 1),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT,
  CHECK ((status = 'PENDING') = (decided_at IS NULL)),
  CHECK ((status = 'PENDING') = (decided_by IS NULL))
);
CREATE UNIQUE INDEX ux_restore_requests_pending ON project_restore_requests(project_id) WHERE status = 'PENDING';
CREATE INDEX ix_restore_requests_project ON project_restore_requests(project_id, created_at);

-- R6：全局流 global_feed，只增不删。2.0 global_events 的列逐值保留，另加 R6 的三列。
-- 按范围恢复时，备份点之后属于该范围的行写 undone_by_restore_gen，不删除。
CREATE TABLE global_feed (
  global_seq INTEGER PRIMARY KEY,
  type TEXT NOT NULL, aggregate_id TEXT NOT NULL, actor TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL, dedupe_key TEXT,
  project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  event_id TEXT,
  undone_by_restore_gen INTEGER REFERENCES scope_generations(gen) DEFERRABLE INITIALLY DEFERRED,
  -- event_id 只是引用，不设 FK：按范围恢复后，项目流回到备份时的状态，全局流的行仍保留原 event_id 并标注为已撤销。
  CHECK (event_id IS NULL OR project_id IS NOT NULL)
);
CREATE UNIQUE INDEX ux_global_feed_dedupe ON global_feed(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX ix_global_feed_project ON global_feed(project_id, global_seq) WHERE project_id IS NOT NULL;
-- 业务 / 系统 / 备份结果三个窗口的部分索引，谓词沿用 registry/0008。
CREATE INDEX ix_global_feed_business_class ON global_feed(global_seq)
  WHERE type <> 'project.summary.updated'
    AND NOT (COALESCE(actor, 'SYSTEM') = 'SYSTEM' OR substr(type, 1, 7) = 'backup.'
             OR type IN ('project.creating', 'agent.git_context.updated', 'database.recovered'));
CREATE INDEX ix_global_feed_system_class ON global_feed(global_seq)
  WHERE type <> 'project.summary.updated'
    AND (COALESCE(actor, 'SYSTEM') = 'SYSTEM' OR substr(type, 1, 7) = 'backup.'
         OR type IN ('project.creating', 'agent.git_context.updated', 'database.recovered'));
CREATE INDEX ix_global_feed_backup_outcome ON global_feed(global_seq)
  WHERE type IN ('backup.created', 'backup.failed');

-- ===== 2. 知识库（范围 KNOWLEDGE）=====
CREATE TABLE knowledge_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  database_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  scope_gen INTEGER NOT NULL REFERENCES scope_generations(gen) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE knowledge_entries (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
  head_revision INTEGER NOT NULL, version INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  FOREIGN KEY (id, head_revision) REFERENCES knowledge_revisions(entry_id, revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE knowledge_revisions (
  entry_id TEXT NOT NULL REFERENCES knowledge_entries(id) DEFERRABLE INITIALLY DEFERRED,
  revision INTEGER NOT NULL, revision_id TEXT NOT NULL UNIQUE,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  PRIMARY KEY (entry_id, revision)
);
-- 修订不可改；删除只允许在范围恢复事务里（restore_guard 开关）。
CREATE TRIGGER knowledge_revisions_no_update BEFORE UPDATE ON knowledge_revisions
BEGIN SELECT RAISE(ABORT, 'knowledge revisions are immutable'); END;
CREATE TRIGGER knowledge_revisions_no_delete BEFORE DELETE ON knowledge_revisions
WHEN NOT EXISTS (SELECT 1 FROM restore_guard WHERE scope_kind = 'KNOWLEDGE')
BEGIN SELECT RAISE(ABORT, 'knowledge revisions are immutable'); END;
-- 派生，从 head revision 重建；字段与 2.0 一致（05 §2.5）。
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  entry_id UNINDEXED, metadata UNINDEXED, title, aliases, tags, summary, use_when, applies_to, body,
  tokenize = 'trigram');

-- ===== 3. 项目实体（全部复合键）=====
CREATE TABLE counters (
  project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  name TEXT NOT NULL, next_value INTEGER NOT NULL,
  PRIMARY KEY (project_id, name)
);

CREATE TABLE objectives (
  project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  id TEXT NOT NULL, local_no INTEGER NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', definition_of_done_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('PLANNED','ACTIVE','DONE','CANCELLED')),
  weight REAL NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id), UNIQUE (project_id, local_no)
);

CREATE TABLE milestones (
  project_id TEXT NOT NULL, id TEXT NOT NULL, local_no INTEGER NOT NULL, objective_id TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', planned_start_date TEXT, target_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('PLANNED','ACTIVE','DONE','CANCELLED')),
  weight REAL NOT NULL DEFAULT 1, sort_key INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id), UNIQUE (project_id, local_no),
  FOREIGN KEY (project_id, objective_id) REFERENCES objectives(project_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_milestones_objective ON milestones(project_id, objective_id, sort_key);

CREATE TABLE work_items (
  project_id TEXT NOT NULL, id TEXT NOT NULL, local_no INTEGER NOT NULL,
  parent_id TEXT, objective_id TEXT NOT NULL, milestone_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('EPIC','TASK','SUBTASK','BUG','RESEARCH','REVIEW')),
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', acceptance_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'BACKLOG'
    CHECK (phase IN ('BACKLOG','READY','CLAIMED','IN_PROGRESS','BLOCKED','VERIFYING','DONE','CANCELLED')),
  waiting_on TEXT CHECK (waiting_on IS NULL OR waiting_on IN ('USER','AGENT')),
  phase_inferred INTEGER NOT NULL DEFAULT 0 CHECK (phase_inferred IN (0,1)),
  priority TEXT NOT NULL CHECK (priority IN ('LOW','NORMAL','HIGH','CRITICAL')),
  sort_key INTEGER NOT NULL DEFAULT 0, planned_start_date TEXT, target_date TEXT,
  started_at TEXT, completed_at TEXT,
  assignee_agent_id TEXT, claimed_by_session_id TEXT, claim_lease_until TEXT,
  reported_progress REAL, computed_progress REAL NOT NULL DEFAULT 0, progress_source TEXT NOT NULL DEFAULT 'NONE',
  weight REAL NOT NULL DEFAULT 1, blocked_reason TEXT, waiting_for TEXT,
  verification_required INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0,
  created_by_agent_id TEXT, created_by_session_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
  source_quick_id TEXT,
  cancel_reason TEXT, duplicate_of_id TEXT, superseded_by_id TEXT,
  ever_claimed_at TEXT, last_started_at TEXT, last_session_closed_at TEXT, last_evidence_at TEXT,
  PRIMARY KEY (project_id, id), UNIQUE (project_id, local_no), UNIQUE (project_id, source_quick_id),
  FOREIGN KEY (project_id, parent_id)        REFERENCES work_items(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, objective_id)     REFERENCES objectives(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, milestone_id)     REFERENCES milestones(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, duplicate_of_id)  REFERENCES work_items(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, superseded_by_id) REFERENCES work_items(project_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_work_items_status ON work_items(project_id, status, priority, sort_key);
CREATE INDEX ix_work_items_parent ON work_items(project_id, parent_id);
CREATE INDEX ix_work_items_milestone ON work_items(project_id, milestone_id, status);
CREATE INDEX ix_work_items_phase_waiting ON work_items(project_id, phase, waiting_on, priority, sort_key);
CREATE INDEX ix_work_items_duplicate_of ON work_items(project_id, duplicate_of_id);
CREATE INDEX ix_work_items_superseded_by ON work_items(project_id, superseded_by_id);
CREATE INDEX ix_work_items_task_list_keyset ON work_items(
  project_id,
  (CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END),
  sort_key, created_at, local_no
) WHERE archived_at IS NULL;

CREATE TABLE work_item_relations (
  project_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('BLOCKS','RELATES','DUPLICATES','DISCOVERED_FROM')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, source_id, target_id, relation_type), CHECK (source_id <> target_id),
  FOREIGN KEY (project_id, source_id) REFERENCES work_items(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, target_id) REFERENCES work_items(project_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_relations_target ON work_item_relations(project_id, target_id, relation_type);

CREATE TABLE checklist_items (
  project_id TEXT NOT NULL, id TEXT NOT NULL, work_item_id TEXT NOT NULL, title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('REQUIRED','OPTIONAL','ACCEPTANCE','VERIFICATION')),
  status TEXT NOT NULL CHECK (status IN ('TODO','DOING','DONE','SKIPPED')),
  weight REAL NOT NULL DEFAULT 1, evidence_required INTEGER NOT NULL DEFAULT 0, evidence_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, work_item_id) REFERENCES work_items(project_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_checklist_work ON checklist_items(project_id, work_item_id, status);

CREATE TABLE labels (project_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (project_id, id), UNIQUE (project_id, name));
CREATE TABLE work_item_labels (project_id TEXT NOT NULL, work_item_id TEXT NOT NULL, label_id TEXT NOT NULL,
  PRIMARY KEY (project_id, work_item_id, label_id),
  FOREIGN KEY (project_id, work_item_id) REFERENCES work_items(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, label_id) REFERENCES labels(project_id, id) DEFERRABLE INITIALLY DEFERRED);

CREATE TABLE progress_updates (
  project_id TEXT NOT NULL, id TEXT NOT NULL, work_item_id TEXT NOT NULL,
  percent REAL, progress_bucket INTEGER, summary TEXT NOT NULL, summary_hash TEXT NOT NULL,
  completed_json TEXT NOT NULL DEFAULT '[]', next_json TEXT NOT NULL DEFAULT '[]', blocker_text TEXT,
  actor TEXT NOT NULL, session_id TEXT, created_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]', op_id TEXT,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, work_item_id) REFERENCES work_items(project_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_progress_work_created ON progress_updates(project_id, work_item_id, created_at DESC);
CREATE INDEX ix_progress_updates_op_id ON progress_updates(project_id, op_id) WHERE op_id IS NOT NULL;

CREATE TABLE project_updates (
  project_id TEXT NOT NULL, id TEXT NOT NULL,
  health TEXT NOT NULL CHECK (health IN ('ON_TRACK','AT_RISK','OFF_TRACK','UNKNOWN')),
  summary TEXT NOT NULL, completed_json TEXT NOT NULL DEFAULT '[]', risks_json TEXT NOT NULL DEFAULT '[]',
  next_json TEXT NOT NULL DEFAULT '[]', from_sequence INTEGER NOT NULL, to_sequence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','PUBLISHED')), actor TEXT NOT NULL,
  published_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  op_id TEXT, evidence_json TEXT NOT NULL DEFAULT '[]', session_id TEXT,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, session_id) REFERENCES agent_sessions(project_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_project_updates_op_id ON project_updates(project_id, op_id) WHERE op_id IS NOT NULL;
CREATE INDEX ix_project_updates_operation_session ON project_updates(project_id, op_id, session_id) WHERE op_id IS NOT NULL;

CREATE TABLE blockers (
  project_id TEXT NOT NULL, id TEXT NOT NULL, local_no INTEGER NOT NULL, work_item_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', waiting_for TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','RESOLVED','CANCELLED')), actor TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT,
  PRIMARY KEY (project_id, id), UNIQUE (project_id, local_no),
  FOREIGN KEY (project_id, work_item_id) REFERENCES work_items(project_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_blockers_status ON blockers(project_id, status, severity);

CREATE TABLE records (
  project_id TEXT NOT NULL, id TEXT NOT NULL, local_no INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('DECISION','CONSTRAINT','FACT','RISK','REFERENCE','LESSON','VERIFICATION','WAIVER')),
  title TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  importance TEXT NOT NULL CHECK (importance IN ('LOW','NORMAL','HIGH','CRITICAL')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','SUPERSEDED','RETRACTED')),
  supersedes_id TEXT, scope TEXT NOT NULL DEFAULT 'PROJECT', work_item_id TEXT, actor TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'AGENT' CHECK (source_type IN ('USER','AGENT','SYSTEM','IMPORT')),
  source_actor_id TEXT, source_session_id TEXT, source_ref TEXT, topic TEXT, subject_key TEXT, op_id TEXT,
  PRIMARY KEY (project_id, id), UNIQUE (project_id, local_no),
  FOREIGN KEY (project_id, supersedes_id) REFERENCES records(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, work_item_id) REFERENCES work_items(project_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_records_active ON records(project_id, status, importance, kind);
CREATE INDEX ix_records_resume ON records(project_id, status, source_type, kind, importance, updated_at DESC);
CREATE INDEX ix_records_active_topic ON records(project_id, status, topic, updated_at DESC) WHERE topic IS NOT NULL;
CREATE INDEX ix_records_active_subject_key ON records(project_id, status, subject_key, updated_at DESC) WHERE subject_key IS NOT NULL;
CREATE INDEX ix_records_op_id ON records(project_id, op_id) WHERE op_id IS NOT NULL;
CREATE INDEX ix_records_list_keyset ON records(project_id, updated_at DESC, local_no DESC);

CREATE TABLE artifacts (
  project_id TEXT NOT NULL, id TEXT NOT NULL, work_item_id TEXT, record_id TEXT,
  kind TEXT NOT NULL, name TEXT NOT NULL,
  local_path TEXT,
  legacy_local_path TEXT,
  external_ref TEXT, sha256 TEXT, size_bytes INTEGER, metadata_json TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, work_item_id) REFERENCES work_items(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, record_id) REFERENCES records(project_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE agents (
  project_id TEXT NOT NULL, id TEXT NOT NULL, display_name TEXT NOT NULL, client_kind TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE agent_sessions (
  project_id TEXT NOT NULL, id TEXT NOT NULL, agent_id TEXT NOT NULL,
  parent_session_id TEXT, thread_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('PRIMARY','SUBAGENT','REVIEWER','OBSERVER')),
  cwd TEXT, git_branch TEXT, git_head TEXT, work_state TEXT NOT NULL, connection_state TEXT NOT NULL,
  current_work_item_id TEXT, heartbeat_at TEXT, version INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT,
  predecessor_session_id TEXT, retirement_reason TEXT,
  git_repo_root TEXT, worktree_root TEXT, git_common_dir TEXT, git_is_linked_worktree INTEGER,
  git_detached INTEGER, git_dirty INTEGER, git_available INTEGER NOT NULL DEFAULT 0, git_error TEXT,
  close_reason TEXT CHECK (close_reason IN ('HEARTBEAT_TIMEOUT','EXPLICIT_END','EXPLICIT_RETIRE','FORCE_CLOSE')),
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, agent_id) REFERENCES agents(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, parent_session_id) REFERENCES agent_sessions(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, predecessor_session_id) REFERENCES agent_sessions(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, current_work_item_id) REFERENCES work_items(project_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_sessions_state ON agent_sessions(project_id, connection_state, work_state);
CREATE INDEX ix_agent_sessions_predecessor ON agent_sessions(project_id, predecessor_session_id);
CREATE INDEX ix_agent_sessions_active_worktree ON agent_sessions(project_id, connection_state, worktree_root);
CREATE INDEX ix_agent_sessions_active_branch ON agent_sessions(project_id, connection_state, git_branch);
CREATE INDEX ix_agent_sessions_list_keyset ON agent_sessions(project_id, started_at DESC, id DESC);

CREATE TABLE handoffs (
  project_id TEXT NOT NULL, id TEXT NOT NULL, work_item_id TEXT NOT NULL,
  from_session_id TEXT NOT NULL, to_agent_id TEXT NOT NULL, to_session_id TEXT,
  summary TEXT NOT NULL, next_action TEXT NOT NULL, created_at TEXT NOT NULL, acknowledged_at TEXT,
  checkpoint_sequence INTEGER NOT NULL DEFAULT 0,
  -- R4′：待确认的交接可由发出方 lineage 中任一 ONLINE 后继确认，记下确认者。
  ack_by_session TEXT,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, work_item_id) REFERENCES work_items(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, from_session_id) REFERENCES agent_sessions(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, to_agent_id) REFERENCES agents(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, to_session_id) REFERENCES agent_sessions(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, ack_by_session) REFERENCES agent_sessions(project_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_handoffs_checkpoint ON handoffs(project_id, work_item_id, checkpoint_sequence DESC);

-- R6：项目流 events，与 global_feed 在同一个写事务里同步写入；按范围恢复时回到备份状态。
CREATE TABLE events (
  project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, session_id TEXT,
  aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, causation_id TEXT, correlation_id TEXT,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL, op_id TEXT,
  PRIMARY KEY (project_id, seq), UNIQUE (project_id, id)
);
CREATE INDEX ix_events_op_id ON events(project_id, op_id) WHERE op_id IS NOT NULL;
CREATE INDEX ix_events_work_session_lifecycle ON events(project_id, session_id, aggregate_id, created_at DESC)
  WHERE aggregate_type = 'WORK_ITEM' AND type IN ('work.claimed', 'work.started');

CREATE TABLE review_requests (
  project_id TEXT NOT NULL, id TEXT NOT NULL, local_no INTEGER NOT NULL,
  review_work_item_id TEXT NOT NULL, parent_work_item_id TEXT NOT NULL,
  parent_checklist_id TEXT NOT NULL, parent_checklist_version INTEGER NOT NULL,
  expected_candidate_hashes_json TEXT NOT NULL, created_by_agent_id TEXT NOT NULL,
  created_by_session_id TEXT NOT NULL, created_at TEXT NOT NULL, op_id TEXT NOT NULL,
  PRIMARY KEY (project_id, id), UNIQUE (project_id, local_no), UNIQUE (project_id, review_work_item_id),
  FOREIGN KEY (project_id, review_work_item_id) REFERENCES work_items(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, parent_work_item_id) REFERENCES work_items(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, parent_checklist_id) REFERENCES checklist_items(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, created_by_session_id) REFERENCES agent_sessions(project_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_review_requests_parent ON review_requests(project_id, parent_work_item_id, parent_checklist_id);

CREATE TABLE review_submissions (
  project_id TEXT NOT NULL, id TEXT NOT NULL, local_no INTEGER NOT NULL, request_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('APPROVED','CHANGES_REQUESTED')),
  reviewed_hashes_json TEXT NOT NULL, evidence_json TEXT NOT NULL, record_id TEXT NOT NULL,
  reviewer_agent_id TEXT NOT NULL, reviewer_session_id TEXT NOT NULL,
  review_task_version INTEGER NOT NULL, parent_checklist_version INTEGER NOT NULL,
  created_at TEXT NOT NULL, op_id TEXT NOT NULL,
  PRIMARY KEY (project_id, id), UNIQUE (project_id, local_no),
  UNIQUE (project_id, request_id), UNIQUE (project_id, record_id),
  FOREIGN KEY (project_id, request_id) REFERENCES review_requests(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, record_id) REFERENCES records(project_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id, reviewer_session_id) REFERENCES agent_sessions(project_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE engineering_project_metrics (
  project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  id TEXT NOT NULL, git_head TEXT NOT NULL, captured_at TEXT NOT NULL, payload_json TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX ix_engineering_project_metrics_latest ON engineering_project_metrics(project_id, captured_at DESC);

CREATE TABLE engineering_work_item_metrics (
  project_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
  baseline_ref TEXT NOT NULL, baseline_captured_at TEXT NOT NULL,
  payload_json TEXT, captured_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, work_item_id),
  FOREIGN KEY (project_id, work_item_id) REFERENCES work_items(project_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ix_engineering_work_item_metrics_updated ON engineering_work_item_metrics(project_id, updated_at DESC);

-- ===== 4. 幂等回执（R3 单表；R3′ 查找；R4 墓碑原地翻转；A3 调用索引）=====
-- 取代 05 的 project_idempotency、global_idempotency 和 idempotency_tombstones。
CREATE TABLE idempotency_receipts (
  receipt_id INTEGER PRIMARY KEY,
  -- 回执所在的范围：项目、知识库，或不随任何范围恢复的全局（quick registry 等）。
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('PROJECT','KNOWLEDGE','GLOBAL')),
  scope_id TEXT NOT NULL,                     -- project_id、知识库 database_id，或字面量 'GLOBAL'
  -- R3 的新键 (ns_kind, ns_id, op_id)。CALL 是 A3 的三个 indexed operation。
  -- 转换来的知识行反推不出 op_id，这三列都可以为 NULL，此时必须有 legacy_key。
  ns_kind TEXT CHECK (ns_kind IS NULL OR ns_kind IN ('SESSION','ACTOR','GLOBAL','CALL')),
  ns_id TEXT,
  op_id TEXT,
  legacy_key TEXT,                            -- 2.0 原键，逐值保留；3.0 新写入为 NULL
  -- W1f：2.0 项目回执的原 op_id（每一行都有，不论能否被命中）与 R7‴ 分类。
  -- 惰性类（PROMOTION_HISTORY / LEGACY_UNCLASSIFIED）在 R3′ 收集候选时排除，新键为 NULL。
  legacy_op_id TEXT,
  legacy_class TEXT CHECK (legacy_class IS NULL OR legacy_class IN
    ('BEGIN','USER','SYSTEM_CONST','AGENT','PROMOTION_HISTORY','LEGACY_UNCLASSIFIED')),
  actor_session_id TEXT,                      -- 2.0 0007 拆出的列，逐值保留（R7 的三种形状）
  operation TEXT NOT NULL,
  fp_v INTEGER NOT NULL CHECK (fp_v IN (1,2)),
  fp_family TEXT NOT NULL CHECK (fp_family IN ('kernel-v1','knowledge-v1','canon-v2')),
  fingerprint TEXT NOT NULL,
  receipt_json TEXT NOT NULL,                 -- 回执原文，逐字节保留
  receipt_format TEXT,
  author_agent TEXT, author_session TEXT,     -- R3′：比较时按候选的原作者重建指纹
  -- 回执落在哪一代范围上。GLOBAL（quick registry、begin 的 NONE 分支等，A3）不随任何范围恢复，没有世代，为 NULL；
  -- 项目、知识库的回执必须指向真实分配过的世代（#9b）。
  scope_generation INTEGER REFERENCES scope_generations(gen) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT,                            -- 2.0 知识行没有时间
  state TEXT NOT NULL DEFAULT 'VALID' CHECK (state IN ('VALID','TOMBSTONED')),
  tombstoned_by_gen INTEGER REFERENCES scope_generations(gen) DEFERRABLE INITIALLY DEFERRED,
  tombstoned_at TEXT,
  -- A3 调用索引的三列（另一列是 op_id）。只有 ns_kind = 'CALL' 的行有值，并且必须齐全。
  call_principal_kind TEXT CHECK (call_principal_kind IS NULL OR call_principal_kind IN ('AGENT','USER')),
  call_principal_id TEXT,
  call_operation TEXT,
  CHECK ((scope_kind = 'GLOBAL') = (scope_generation IS NULL)),
  CHECK (scope_kind <> 'GLOBAL' OR scope_id = 'GLOBAL'),
  -- 墓碑只由按范围恢复产生，GLOBAL 回执不在任何范围里。
  CHECK (scope_kind <> 'GLOBAL' OR state = 'VALID'),
  CHECK ((state = 'TOMBSTONED') = (tombstoned_by_gen IS NOT NULL)),
  CHECK ((state = 'TOMBSTONED') = (tombstoned_at IS NOT NULL)),
  CHECK (op_id IS NOT NULL OR legacy_key IS NOT NULL),
  CHECK (legacy_class IS NULL OR legacy_key IS NOT NULL),
  CHECK (legacy_op_id IS NULL OR legacy_key IS NOT NULL),
  CHECK ((ns_kind IS NULL) = (ns_id IS NULL)),
  CHECK ((ns_kind IS NULL) = (op_id IS NULL)),
  CHECK ((COALESCE(ns_kind, '') = 'CALL') = (call_operation IS NOT NULL)),
  CHECK (call_operation IS NULL OR (call_principal_kind IS NOT NULL AND call_principal_id IS NOT NULL)),
  CHECK (call_operation IS NOT NULL OR (call_principal_kind IS NULL AND call_principal_id IS NULL)),
  CHECK (COALESCE(ns_kind, '') <> 'CALL' OR ns_id = call_principal_id)
);
-- R3′ 第 3 步：同一 scope 内按新键或 legacy 键收候选。
CREATE UNIQUE INDEX ux_receipts_ns ON idempotency_receipts(scope_kind, scope_id, ns_kind, ns_id, op_id)
  WHERE ns_kind IS NOT NULL AND ns_kind <> 'CALL';
CREATE UNIQUE INDEX ux_receipts_legacy ON idempotency_receipts(scope_kind, scope_id, legacy_key)
  WHERE legacy_key IS NOT NULL;
-- A3：四列原值组成的全局部分唯一索引，不含 scope，不做字符串拼接。
CREATE UNIQUE INDEX ux_receipts_call ON idempotency_receipts(call_principal_kind, call_principal_id, call_operation, op_id)
  WHERE call_operation IS NOT NULL;
-- 对应 project/0007 的 idx_idempotency_op_id。
CREATE INDEX ix_receipts_op ON idempotency_receipts(scope_kind, scope_id, op_id, actor_session_id);

-- ===== 5. 搜索（派生，05 §2.5）=====
CREATE TABLE search_docs (
  doc_id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, entity_key TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
  UNIQUE (project_id, entity_type, entity_id)
);
CREATE INDEX ix_search_docs_keyset ON search_docs(updated_at DESC, project_id, entity_type, entity_key);
CREATE VIRTUAL TABLE search_fts USING fts5(title, body,
  content = 'search_docs', content_rowid = 'doc_id', tokenize = 'trigram');
CREATE TRIGGER search_docs_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO search_fts(rowid, title, body) VALUES (new.doc_id, new.title, new.body);
END;
CREATE TRIGGER search_docs_ad AFTER DELETE ON search_docs BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body) VALUES ('delete', old.doc_id, old.title, old.body);
END;
CREATE TRIGGER search_docs_au AFTER UPDATE ON search_docs BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body) VALUES ('delete', old.doc_id, old.title, old.body);
  INSERT INTO search_fts(rowid, title, body) VALUES (new.doc_id, new.title, new.body);
END;

-- ===== 6. 手机同步与派单（05 §2.4）=====
CREATE TABLE sync_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  v INTEGER NOT NULL, enabled INTEGER NOT NULL, relay_url TEXT, app_id TEXT NOT NULL,
  device_id TEXT NOT NULL, device_name TEXT NOT NULL, space_id TEXT, cursor TEXT,
  head_digest TEXT, last_sync_at TEXT, last_ack_sweep_at TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE sync_processed (
  ord INTEGER PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE
);
CREATE TABLE sync_published (
  project_code TEXT PRIMARY KEY, h TEXT NOT NULL, d TEXT NOT NULL, head_json TEXT NOT NULL
);
CREATE TABLE dispatch_config (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL, permission_mode TEXT NOT NULL, max_concurrent INTEGER NOT NULL,
  model TEXT, effort TEXT, source_state TEXT NOT NULL CHECK (source_state IN ('OK','MISSING','CORRUPT_DEFAULTED')),
  updated_at TEXT NOT NULL
);
CREATE TABLE dispatch_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  requests_since TEXT, lost_before TEXT,
  runs_damaged_at_conversion INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE dispatch_runs (
  run TEXT PRIMARY KEY, project_code TEXT NOT NULL, task_key TEXT NOT NULL, title TEXT NOT NULL,
  -- R5：全局对象对项目实体的引用同时存不可复用的实体 id。
  task_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('mobile','desktop')),
  state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled','interrupted')),
  session_id TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, exit_code INTEGER,
  summary_json TEXT, error TEXT, cwd TEXT NOT NULL, requested_by TEXT,
  pid INTEGER, process_identity TEXT, request_id TEXT,
  log_root TEXT NOT NULL CHECK (log_root IN ('LEGACY','CURRENT'))
);
CREATE TABLE dispatch_requests (
  id TEXT PRIMARY KEY, at TEXT NOT NULL,
  run_snapshot_json TEXT, rejected_code TEXT, rejected_message TEXT,
  CHECK ((run_snapshot_json IS NULL) <> (rejected_code IS NULL))
);

-- ===== 7. 备份目录 =====
CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('DAILY','WEEKLY','MANUAL','PRE_RESTORE','PRE_MIGRATION','PRE_ARCHIVE','PRE_TRASH','EXPORT')),
  path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  schema_version INTEGER NOT NULL, generation TEXT NOT NULL,
  attachments_manifest_sha256 TEXT,
  created_at TEXT NOT NULL, verified_at TEXT, pinned_until TEXT
);
CREATE TABLE legacy_backups (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('CATALOG','PRE_MIGRATION_FILE','KNOWLEDGE_BEFORE_RESTORE','KNOWLEDGE_ORPHAN')),
  scope TEXT NOT NULL CHECK (scope IN ('REGISTRY','PROJECT','KNOWLEDGE')),
  project_id TEXT, legacy_path TEXT NOT NULL, sha256 TEXT, size_bytes INTEGER,
  reason TEXT, schema_version INTEGER, created_at TEXT, verified_at TEXT,
  importable TEXT NOT NULL CHECK (importable IN ('AS_PROJECT','AS_KNOWLEDGE','NO'))
);
