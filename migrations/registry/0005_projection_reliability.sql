ALTER TABLE global_events
ADD COLUMN dedupe_key TEXT;

-- Preserve every historical event.  When old retries produced duplicates, only the
-- earliest row receives the durable key so the new unique index can be installed
-- without rewriting the audit stream.
WITH decoded AS (
  SELECT
    sequence,
    CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.projectId') END AS project_id,
    CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.sourceEventId') END AS source_event_id
  FROM global_events
),
candidates AS (
  SELECT
    MIN(sequence) AS sequence,
    'project:' || project_id || ':event:' || source_event_id AS dedupe_key
  FROM decoded
  WHERE typeof(project_id) = 'text'
    AND typeof(source_event_id) = 'text'
  GROUP BY project_id, source_event_id
)
UPDATE global_events
SET dedupe_key = (
  SELECT candidates.dedupe_key
  FROM candidates
  WHERE candidates.sequence = global_events.sequence
)
WHERE sequence IN (SELECT sequence FROM candidates);

CREATE UNIQUE INDEX idx_global_events_dedupe_key
ON global_events(dedupe_key)
WHERE dedupe_key IS NOT NULL;

CREATE TABLE project_projection_state (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  source_sequence INTEGER NOT NULL DEFAULT 0,
  projected_sequence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'APPLIED' CHECK(status IN ('APPLIED','DEFERRED')),
  last_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  CHECK(source_sequence >= 0),
  CHECK(projected_sequence >= 0),
  CHECK(retry_count >= 0),
  CHECK(projected_sequence <= source_sequence),
  CHECK(status <> 'APPLIED' OR projected_sequence = source_sequence)
);

INSERT INTO project_projection_state(
  project_id, source_sequence, projected_sequence, status, last_error, retry_count, updated_at
)
SELECT project_id, project_sequence, project_sequence, 'APPLIED', NULL, 0, updated_at
FROM project_summary_cache;
