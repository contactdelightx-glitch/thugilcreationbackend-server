-- Replace the is_active flag with a status: active | suspended | removed.
-- Idempotent: safe to run on a database that already has the status column.

ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'is_active'
  ) THEN
    UPDATE users SET status = CASE WHEN is_active THEN 'active' ELSE 'suspended' END;
    ALTER TABLE users DROP COLUMN is_active;
  END IF;
END $$;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('active', 'suspended', 'removed'));

CREATE INDEX IF NOT EXISTS users_status_idx ON users (status);
