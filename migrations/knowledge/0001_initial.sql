CREATE TABLE knowledge_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  database_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE knowledge_entries (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  head_revision INTEGER NOT NULL,
  version INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);
CREATE TABLE knowledge_revisions (
  entry_id TEXT NOT NULL REFERENCES knowledge_entries(id),
  revision INTEGER NOT NULL,
  revision_id TEXT NOT NULL UNIQUE,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  PRIMARY KEY(entry_id, revision)
);
CREATE TRIGGER knowledge_revisions_no_update BEFORE UPDATE ON knowledge_revisions
BEGIN SELECT RAISE(ABORT, 'knowledge revisions are immutable'); END;
CREATE TRIGGER knowledge_revisions_no_delete BEFORE DELETE ON knowledge_revisions
BEGIN SELECT RAISE(ABORT, 'knowledge revisions are immutable'); END;
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  entry_id UNINDEXED, metadata UNINDEXED, title, aliases, tags, summary, use_when, applies_to, body,
  tokenize = 'trigram'
);
CREATE TABLE knowledge_operations (
  op_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  receipt TEXT NOT NULL CHECK (json_valid(receipt))
);
