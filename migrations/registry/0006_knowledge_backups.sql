CREATE TABLE backup_catalog_new (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('REGISTRY','PROJECT','KNOWLEDGE')),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  reason TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT
);
INSERT INTO backup_catalog_new SELECT * FROM backup_catalog;
DROP TABLE backup_catalog;
ALTER TABLE backup_catalog_new RENAME TO backup_catalog;
