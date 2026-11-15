-- The issued certificate's file link (from Supabase course_certificates). Idempotent: safe to re-run.
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS certificate_url TEXT;
