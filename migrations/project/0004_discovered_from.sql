CREATE TABLE work_item_relations_v2 (
  source_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK(relation_type IN ('BLOCKS','RELATES','DUPLICATES','DISCOVERED_FROM')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_id, target_id, relation_type),
  CHECK(source_id <> target_id)
);

INSERT INTO work_item_relations_v2(source_id, target_id, relation_type, created_at)
SELECT source_id, target_id, relation_type, created_at FROM work_item_relations;

DROP TABLE work_item_relations;
ALTER TABLE work_item_relations_v2 RENAME TO work_item_relations;

CREATE INDEX idx_relations_target ON work_item_relations(target_id, relation_type);
