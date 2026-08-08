CREATE TABLE engineering_project_metrics (
  id TEXT PRIMARY KEY,
  git_head TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX idx_engineering_project_metrics_latest
  ON engineering_project_metrics(captured_at DESC);

CREATE TABLE engineering_work_item_metrics (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  baseline_ref TEXT NOT NULL,
  baseline_captured_at TEXT NOT NULL,
  payload_json TEXT,
  captured_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_engineering_work_item_metrics_updated
  ON engineering_work_item_metrics(updated_at DESC);
