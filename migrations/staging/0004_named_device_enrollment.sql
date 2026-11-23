-- Staging-only, explicitly applied. No production mutation.
BEGIN;
CREATE TABLE IF NOT EXISTS public.pzd_staging_enrollment_grants (
  code_digest text PRIMARY KEY CHECK (code_digest ~ '^[0-9a-f]{64}$'),
  player_id uuid NOT NULL REFERENCES public.pzd_guest_accounts(player_id),
  expires_at timestamptz NOT NULL
);
REVOKE ALL ON public.pzd_staging_enrollment_grants FROM PUBLIC;
COMMIT;
