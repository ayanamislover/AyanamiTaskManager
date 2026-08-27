-- Reconciliation reads durable per-WorkItem projections instead of replaying the full event log.
-- These fields are derived facts: migration/backfill and later maintenance must not change the
-- WorkItem business version or updated_at timestamp.
ALTER TABLE work_items ADD COLUMN ever_claimed_at TEXT;
ALTER TABLE work_items ADD COLUMN last_started_at TEXT;
ALTER TABLE work_items ADD COLUMN last_session_closed_at TEXT;
ALTER TABLE work_items ADD COLUMN last_evidence_at TEXT;

UPDATE work_items
SET ever_claimed_at = COALESCE(
      (
        SELECT MIN(event.created_at)
        FROM events event
        WHERE event.aggregate_type = 'WORK_ITEM'
          AND event.aggregate_id = work_items.id
          AND event.type IN ('work.claimed', 'work.started')
      ),
      work_items.started_at
    ),
    last_started_at = COALESCE(
      (
        SELECT MAX(event.created_at)
        FROM events event
        WHERE event.aggregate_type = 'WORK_ITEM'
          AND event.aggregate_id = work_items.id
          AND event.type = 'work.started'
      ),
      work_items.started_at
    ),
    last_session_closed_at = (
      SELECT MAX(session.closed_at)
      FROM events event
      JOIN agent_sessions session ON session.id = event.session_id
      WHERE event.aggregate_type = 'WORK_ITEM'
        AND event.aggregate_id = work_items.id
        AND event.type IN ('work.claimed', 'work.started')
        AND session.closed_at IS NOT NULL
    ),
    last_evidence_at = (
      SELECT MAX(candidate.at)
      FROM (
        SELECT progress.created_at AS at
        FROM progress_updates progress
        WHERE progress.work_item_id = work_items.id
          AND COALESCE(json_array_length(progress.evidence_json), 0) > 0
        UNION ALL
        SELECT checklist.updated_at AS at
        FROM checklist_items checklist
        WHERE checklist.work_item_id = work_items.id
          AND COALESCE(json_array_length(checklist.evidence_json), 0) > 0
        UNION ALL
        SELECT submission.created_at AS at
        FROM review_submissions submission
        JOIN review_requests request ON request.id = submission.request_id
        WHERE (request.review_work_item_id = work_items.id
               OR request.parent_work_item_id = work_items.id)
          AND COALESCE(json_array_length(submission.evidence_json), 0) > 0
        UNION ALL
        SELECT project_update.created_at AS at
        FROM project_updates project_update
        JOIN json_each(project_update.completed_json) completed
        WHERE project_update.status = 'PUBLISHED'
          AND COALESCE(json_array_length(project_update.evidence_json), 0) > 0
          AND json_type(completed.value, '$.workItemKey') = 'text'
          AND json_extract(completed.value, '$.workItemKey') = (
            SELECT meta.project_code || '-T-' || printf('%04d', work_items.local_no)
            FROM project_meta meta
            WHERE meta.singleton = 1
          )
      ) candidate
    );

CREATE INDEX idx_events_work_session_lifecycle
  ON events(session_id, aggregate_id, created_at DESC)
  WHERE aggregate_type = 'WORK_ITEM'
    AND type IN ('work.claimed', 'work.started');
