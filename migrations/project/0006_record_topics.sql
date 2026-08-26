ALTER TABLE records ADD COLUMN topic TEXT;
ALTER TABLE records ADD COLUMN subject_key TEXT;

CREATE INDEX idx_records_active_topic
  ON records(status, topic, updated_at DESC)
  WHERE topic IS NOT NULL;
CREATE INDEX idx_records_active_subject_key
  ON records(status, subject_key, updated_at DESC)
  WHERE subject_key IS NOT NULL;
