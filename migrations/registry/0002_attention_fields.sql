ALTER TABLE project_summary_cache
ADD COLUMN stale_claim_count INTEGER NOT NULL DEFAULT 0;
