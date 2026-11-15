-- A designer is either active or suspended. Idempotent: safe to re-run.
ALTER TABLE designers DROP CONSTRAINT IF EXISTS designers_status_check;
ALTER TABLE designers ADD CONSTRAINT designers_status_check CHECK (status IN ('active', 'suspended'));
