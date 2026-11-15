-- Clients created by the admin get a password, stored only as a bcrypt hash.
-- Nullable: designers imported from Supabase have no password here. Idempotent: safe to re-run.
ALTER TABLE designers ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
