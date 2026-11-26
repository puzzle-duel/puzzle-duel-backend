-- PZD-26/27: durable receipts for credential-issuing unified continue/confirm.
-- recoverLinked requires a receipt so unconfirmed switches cannot be recovered.
DO $guard$
BEGIN
  IF current_database() <> 'pzd_staging' THEN
    RAISE EXCEPTION 'PROVIDER_AUTH_STAGING_ONLY';
  END IF;
END;
$guard$;

CREATE TABLE IF NOT EXISTS public.pzd_provider_auth_receipts (
  provider text NOT NULL CHECK (provider IN ('apple', 'google')),
  provider_subject text NOT NULL,
  player_id uuid NOT NULL REFERENCES public.pzd_guest_accounts (player_id),
  resolution text NOT NULL CHECK (resolution IN (
    'link_guest',
    'existing_account',
    'created_account',
    'same_account',
    'switch_confirmed'
  )),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider, provider_subject)
);
CREATE INDEX IF NOT EXISTS pzd_provider_auth_receipts_committed
  ON public.pzd_provider_auth_receipts (committed_at);

REVOKE ALL ON public.pzd_provider_auth_receipts FROM PUBLIC;
REVOKE ALL ON public.pzd_provider_auth_receipts FROM pzd_app_runtime;
GRANT SELECT ON public.pzd_provider_auth_receipts TO pzd_app_runtime;
GRANT INSERT (
  provider,
  provider_subject,
  player_id,
  resolution,
  committed_at
) ON public.pzd_provider_auth_receipts TO pzd_app_runtime;
GRANT UPDATE (
  player_id,
  resolution,
  committed_at
) ON public.pzd_provider_auth_receipts TO pzd_app_runtime;
