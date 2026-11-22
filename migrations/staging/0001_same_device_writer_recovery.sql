-- PZD-50: STAGING-ONLY, OPERATOR-EXECUTED, FORWARD-ONLY migration.
-- NEVER run on pzd_ingress, production or other databases.
-- Prerequisite: guest/session PostgreSQL schema is provisioned and verified.
-- No backfill or mutation of existing claim, writer or session rows.
-- Executed inside the reusable migration runner's single transaction;
-- DO NOT add BEGIN/COMMIT, dynamic SQL or data-bearing output.
DO $guard$
BEGIN
  IF current_database() <> 'pzd_staging' THEN
    RAISE EXCEPTION 'RECOVERY_MIGRATION_STAGING_ONLY';
  END IF;
  IF to_regclass('public.tournament_auth_session') IS NULL OR
     to_regclass('public.tournament_series_writer') IS NULL OR
     to_regclass('public.tournament_verified_identity') IS NULL THEN
    RAISE EXCEPTION 'RECOVERY_PREREQUISITES_MISSING';
  END IF;
END;
$guard$;

CREATE TABLE IF NOT EXISTS public.tournament_device_credential (
  credential_id UUID PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES public.tournament_verified_identity(player_id),
  key_sha256 TEXT NOT NULL,
  public_key_spki BYTEA NOT NULL,
  created_at_ms BIGINT NOT NULL,
  revoked_at_ms BIGINT NULL,
  UNIQUE (player_id, key_sha256)
);

ALTER TABLE public.tournament_auth_session
  ADD COLUMN IF NOT EXISTS device_credential_id UUID NULL
    REFERENCES public.tournament_device_credential(credential_id);

ALTER TABLE public.tournament_series_writer
  ADD COLUMN IF NOT EXISTS original_device_credential_id UUID NULL
    REFERENCES public.tournament_device_credential(credential_id);

CREATE TABLE IF NOT EXISTS public.tournament_writer_recovery_challenge (
  challenge_id UUID PRIMARY KEY,
  series_key TEXT NOT NULL,
  player_id UUID NOT NULL,
  new_session_id UUID NOT NULL,
  credential_id UUID NOT NULL,
  nonce TEXT NOT NULL,
  expected_generation BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  consumed_at_ms BIGINT NULL,
  request_sha256 TEXT NULL,
  result_json JSONB NULL
);

ALTER TABLE public.tournament_device_credential OWNER TO pzd_migration_owner;
ALTER TABLE public.tournament_writer_recovery_challenge OWNER TO pzd_migration_owner;
REVOKE ALL ON public.tournament_device_credential FROM PUBLIC;
REVOKE ALL ON public.tournament_writer_recovery_challenge FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.tournament_device_credential TO pzd_app_runtime;
GRANT SELECT, INSERT, UPDATE ON public.tournament_writer_recovery_challenge TO pzd_app_runtime;
