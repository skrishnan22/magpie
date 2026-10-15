-- Cascading document deletes and chunk replacements must also remove keyword hits.
CREATE TRIGGER chunks_delete_fts AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE chunk_id = OLD.id;
END;

DELETE FROM chunks_fts
WHERE NOT EXISTS (SELECT 1 FROM chunks WHERE chunks.id = chunks_fts.chunk_id);
