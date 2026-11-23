-- Staging-only operator-approved enrollment for existing named guest identities.
CREATE TABLE public.pzd_staging_enrollment_grants (
  code_digest text PRIMARY KEY CHECK (code_digest ~ '^[0-9a-f]{64}$'),
  player_id uuid NOT NULL REFERENCES public.pzd_guest_accounts(player_id),
  expires_at timestamptz NOT NULL
);
REVOKE ALL ON public.pzd_staging_enrollment_grants FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pzd_staging_enrollment_grants TO pzd_app_runtime;
