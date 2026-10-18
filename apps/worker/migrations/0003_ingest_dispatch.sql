-- Set only after the Workflow service confirms creation or an existing instance.
ALTER TABLE documents ADD COLUMN workflow_started INTEGER NOT NULL DEFAULT 0;

UPDATE documents SET workflow_started = 1
WHERE extract_status <> 'pending' OR attempts > 0;
