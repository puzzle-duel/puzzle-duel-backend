-- PZD-26: staging-only, additive, no existing player mutation.
DO $guard$
BEGIN
  IF current_database() <> 'pzd_staging' THEN
    RAISE EXCEPTION 'PROVIDER_AUTH_STAGING_ONLY';
  END IF;
END;
$guard$;
CREATE TABLE IF NOT EXISTS public.pzd_provider_challenges (
  nonce_digest char(64) PRIMARY KEY,
  binding_digest char(64) NOT NULL,
  provider text NOT NULL CHECK (provider IN ('apple','google')),
  purpose text NOT NULL CHECK (purpose IN ('login','link')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS pzd_provider_challenges_expiry
  ON public.pzd_provider_challenges (expires_at);
REVOKE ALL ON public.pzd_provider_challenges FROM PUBLIC;
