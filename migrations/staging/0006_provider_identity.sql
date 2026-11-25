-- PZD-26: provider identity links + verified account class (staging-only, additive).
DO $guard$
BEGIN
  IF current_database() <> 'pzd_staging' THEN
    RAISE EXCEPTION 'PROVIDER_AUTH_STAGING_ONLY';
  END IF;
END;
$guard$;

ALTER TABLE public.pzd_guest_accounts
  ADD COLUMN IF NOT EXISTS account_class text NOT NULL DEFAULT 'guest';

DO $account_class$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.pzd_guest_accounts'::regclass
      AND conname = 'pzd_guest_accounts_account_class_check'
  ) THEN
    ALTER TABLE public.pzd_guest_accounts
      ADD CONSTRAINT pzd_guest_accounts_account_class_check
      CHECK (account_class IN ('guest', 'verified'));
  END IF;
END;
$account_class$;

CREATE TABLE IF NOT EXISTS public.pzd_identity_links (
  provider text NOT NULL CHECK (provider IN ('apple', 'google')),
  provider_subject text NOT NULL CHECK (char_length(provider_subject) BETWEEN 1 AND 255),
  player_id uuid NOT NULL REFERENCES public.pzd_guest_accounts(player_id),
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS pzd_identity_links_player_idx
  ON public.pzd_identity_links (player_id);

REVOKE ALL ON public.pzd_identity_links FROM PUBLIC;
REVOKE ALL ON public.pzd_identity_links FROM pzd_app_runtime;
GRANT SELECT ON public.pzd_identity_links TO pzd_app_runtime;
GRANT INSERT (provider, provider_subject, player_id, linked_at)
  ON public.pzd_identity_links TO pzd_app_runtime;

-- Runtime may promote guest -> verified but must never demote verified -> guest.
DO $acct_priv$
BEGIN
  EXECUTE 'REVOKE UPDATE ON public.pzd_guest_accounts FROM pzd_app_runtime';
  EXECUTE 'GRANT SELECT ON public.pzd_guest_accounts TO pzd_app_runtime';
  EXECUTE 'GRANT UPDATE (account_class) ON public.pzd_guest_accounts TO pzd_app_runtime';
EXCEPTION WHEN undefined_object THEN
  NULL;
END;
$acct_priv$;

-- Prevent un-consuming challenges even if a role gains broader UPDATE rights later.
CREATE OR REPLACE FUNCTION public.pzd_provider_challenge_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.nonce_digest IS DISTINCT FROM NEW.nonce_digest
       OR OLD.binding_digest IS DISTINCT FROM NEW.binding_digest
       OR OLD.provider IS DISTINCT FROM NEW.provider
       OR OLD.purpose IS DISTINCT FROM NEW.purpose
       OR OLD.expires_at IS DISTINCT FROM NEW.expires_at THEN
      RAISE EXCEPTION 'CHALLENGE_IMMUTABLE';
    END IF;
    IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
      RAISE EXCEPTION 'CHALLENGE_IMMUTABLE';
    END IF;
    IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NULL THEN
      RAISE EXCEPTION 'CHALLENGE_IMMUTABLE';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pzd_provider_challenge_immutable_trg ON public.pzd_provider_challenges;
CREATE TRIGGER pzd_provider_challenge_immutable_trg
  BEFORE UPDATE ON public.pzd_provider_challenges
  FOR EACH ROW EXECUTE FUNCTION public.pzd_provider_challenge_immutable();
