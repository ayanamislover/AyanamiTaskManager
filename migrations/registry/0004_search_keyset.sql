CREATE INDEX idx_global_search_documents_keyset
ON global_search_documents(updated_at DESC, project_id, entity_type, entity_key);

CREATE INDEX idx_quick_tasks_search_keyset
ON quick_tasks(updated_at DESC, local_no);
