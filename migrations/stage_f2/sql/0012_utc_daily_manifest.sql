-- pzd-migration: 0012_utc_daily_manifest
-- pzd-requires: 0011_journal_receipt_immutable
-- pzd-transactional: true
-- pzd-reversible: false
-- pzd-expands: immutable server-authoritative UTC daily six-challenge manifests
-- pzd-contracts: PZD-48

CREATE TABLE IF NOT EXISTS public.tournament_utc_daily_manifest (
  utc_date DATE PRIMARY KEY,
  manifest_digest CHAR(64) NOT NULL UNIQUE,
  content_version TEXT NOT NULL,
  manifest_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT utc_daily_digest_hex CHECK (manifest_digest ~ '^[a-f0-9]{64}$')
);

CREATE OR REPLACE FUNCTION public.pzd_reject_utc_daily_manifest_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_UTC_DAILY_MANIFEST'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_pzd_utc_daily_manifest_immutable'
      AND tgrelid = 'public.tournament_utc_daily_manifest'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_pzd_utc_daily_manifest_immutable
      BEFORE UPDATE OR DELETE ON public.tournament_utc_daily_manifest
      FOR EACH ROW EXECUTE FUNCTION public.pzd_reject_utc_daily_manifest_mutation();
  END IF;
END $$;

ALTER TABLE public.tournament_utc_daily_manifest OWNER TO pzd_migration_owner;
ALTER FUNCTION public.pzd_reject_utc_daily_manifest_mutation() OWNER TO pzd_migration_owner;
REVOKE ALL ON public.tournament_utc_daily_manifest FROM PUBLIC;
GRANT SELECT, INSERT ON public.tournament_utc_daily_manifest TO pzd_app_runtime;
REVOKE ALL ON FUNCTION public.pzd_reject_utc_daily_manifest_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pzd_reject_utc_daily_manifest_mutation() TO pzd_app_runtime;
