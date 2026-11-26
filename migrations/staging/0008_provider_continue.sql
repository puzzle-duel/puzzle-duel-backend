-- PZD-26/27: unified provider continue + single-use account-switch continuation.
-- Additive staging-only; no existing player mutation.
DO $guard$
BEGIN
  IF current_database() <> 'pzd_staging' THEN
    RAISE EXCEPTION 'PROVIDER_AUTH_STAGING_ONLY';
  END IF;
END;
$guard$;

-- Allow unified continue challenges alongside login/link.
ALTER TABLE public.pzd_provider_challenges
  DROP CONSTRAINT IF EXISTS pzd_provider_challenges_purpose_check;
ALTER TABLE public.pzd_provider_challenges
  ADD CONSTRAINT pzd_provider_challenges_purpose_check
  CHECK (purpose IN ('login', 'link', 'continue'));

CREATE TABLE IF NOT EXISTS public.pzd_provider_continuations (
  continuation_digest char(64) PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('apple', 'google')),
  -- Server-only subject binding; never logged or returned to clients.
  provider_subject text NOT NULL,
  target_player_id uuid NOT NULL REFERENCES public.pzd_guest_accounts (player_id),
  source_guest_player_id uuid,
  source_family_id uuid,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (
    (source_guest_player_id IS NULL AND source_family_id IS NULL)
    OR (source_guest_player_id IS NOT NULL AND source_family_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS pzd_provider_continuations_expiry
  ON public.pzd_provider_continuations (expires_at);

REVOKE ALL ON public.pzd_provider_continuations FROM PUBLIC;
REVOKE ALL ON public.pzd_provider_continuations FROM pzd_app_runtime;
GRANT SELECT ON public.pzd_provider_continuations TO pzd_app_runtime;
GRANT INSERT (
  continuation_digest,
  provider,
  provider_subject,
  target_player_id,
  source_guest_player_id,
  source_family_id,
  expires_at
) ON public.pzd_provider_continuations TO pzd_app_runtime;
GRANT UPDATE (consumed_at) ON public.pzd_provider_continuations TO pzd_app_runtime;
