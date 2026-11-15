-- enrollment_certificates -> certificates (one row per certificate that was requested or issued).
-- Idempotent: does nothing on a database that already has `certificates`.
DO $$
BEGIN
  IF to_regclass('public.enrollment_certificates') IS NOT NULL AND to_regclass('public.certificates') IS NULL THEN
    ALTER TABLE enrollment_certificates RENAME TO certificates;
  END IF;
END $$;
