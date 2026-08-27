CREATE INDEX idx_search_documents_keyset
ON search_documents(updated_at DESC, entity_type, entity_key);
