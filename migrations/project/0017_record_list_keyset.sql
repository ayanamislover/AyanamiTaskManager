CREATE INDEX idx_records_list_keyset
  ON records(updated_at DESC, local_no DESC);
