-- One row per unique URL (after canonicalization), however many times it was saved.
CREATE TABLE documents (
  id              TEXT PRIMARY KEY,                -- documentId(canonical_url)
  canonical_url   TEXT NOT NULL UNIQUE,
  url             TEXT NOT NULL,                   -- as first saved; what we actually fetch
  title           TEXT,
  extract_status  TEXT NOT NULL DEFAULT 'pending', -- pending | ok | thin | failed
  extract_method  TEXT,                            -- extension | readability | html | pdf | plain | ...
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  raw_key         TEXT,                            -- R2 key of the fetched bytes
  markdown_key    TEXT,                            -- R2 key of the extracted markdown
  content_chars   INTEGER,
  embedding_model TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per bookmark event: the same document can be saved from Chrome and from X.
CREATE TABLE saves (
  id          TEXT PRIMARY KEY,                    -- `${source}:${source_id}`
  source      TEXT NOT NULL,                       -- chrome | x
  source_id   TEXT NOT NULL,
  document_id TEXT REFERENCES documents(id),
  saved_at    TEXT NOT NULL,
  title       TEXT,
  note        TEXT,
  folder      TEXT,
  author      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source, source_id)
);
CREATE INDEX saves_document ON saves(document_id);
CREATE INDEX saves_saved_at ON saves(saved_at);

-- The passages we embed. id doubles as the Vectorize vector id.
CREATE TABLE chunks (
  id              TEXT PRIMARY KEY,                -- `${namespace}:${document_id}:${idx}`
  document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  idx             INTEGER NOT NULL,
  heading         TEXT,
  text            TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  UNIQUE (document_id, idx)
);

-- Keyword side of hybrid search. Porter stemming makes "hoarding" match "hoard".
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  title,
  chunk_id UNINDEXED,
  document_id UNINDEXED,
  tokenize = 'porter unicode61'
);
