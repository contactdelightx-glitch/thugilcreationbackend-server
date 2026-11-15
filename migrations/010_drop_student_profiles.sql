-- A student is just an account in `users` with a completed enrollment, so the separate
-- student_profiles table is not needed. Idempotent: safe to re-run.
DROP TABLE IF EXISTS student_profiles;
