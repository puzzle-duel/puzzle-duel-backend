-- PZD-50: staging only. Explicit migration authorization required; no backfill.
DO $guard$
BEGIN
  IF current_database() <> 'pzd_staging' OR
     to_regclass('public.pzd_guest_refresh') IS NULL THEN
    RAISE EXCEPTION 'GUEST_RETRY_STAGING_ONLY';
  END IF;
END;
$guard$;

ALTER TABLE public.pzd_guest_refresh
  ADD COLUMN IF NOT EXISTS rotation_id_digest char(64) NULL;
