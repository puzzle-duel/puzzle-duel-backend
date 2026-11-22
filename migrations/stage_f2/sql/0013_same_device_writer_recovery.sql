-- pzd-migration: 0013_same_device_writer_recovery
-- pzd-requires: 0012_utc_daily_manifest
-- pzd-transactional: true
-- pzd-reversible: false
-- pzd-expands: staging same-device proof-of-possession credential and writer recovery
-- pzd-contracts: PZD-50
-- Only the original writer session's registered key can be pinned at FIRST claim.
-- NEVER backfill original_device_credential_id on historical claims.

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

-- Existing application runtime writer/session privileges remain unchanged.
-- No UPDATE of historical series_writer or claim records occurs in migration.
