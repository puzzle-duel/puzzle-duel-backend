-- PZD-26/27: operation-bound receipts for credential-issuing unified continue/confirm.
-- recoverLinked requires the exact operation receipt — never a historical
-- (provider, subject) login alone. Corrects the pending 0009 shape in place
-- (not applied to live staging; do not introduce 0010).
DO $guard$
BEGIN
  IF current_database() <> 'pzd_staging' THEN
    RAISE EXCEPTION 'PROVIDER_AUTH_STAGING_ONLY';
  END IF;
END;
$guard$;

-- Bind continuations to the client-generated operation id for confirm/recovery.
ALTER TABLE public.pzd_provider_continuations
  ADD COLUMN IF NOT EXISTS operation_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS pzd_provider_continuations_operation_uidx
  ON public.pzd_provider_continuations (operation_id)
  WHERE operation_id IS NOT NULL;

-- Replace any prior pending receipts shape keyed only by (provider, subject).
DROP TABLE IF EXISTS public.pzd_provider_auth_receipts CASCADE;

CREATE TABLE public.pzd_provider_auth_receipts (
  operation_id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('apple', 'google')),
  -- Server-verified subject; never logged.
  provider_subject text NOT NULL,
  player_id uuid NOT NULL REFERENCES public.pzd_guest_accounts (player_id),
  source_guest_player_id uuid,
  source_family_id uuid,
  resolution text NOT NULL CHECK (resolution IN (
    'link_guest',
    'existing_account',
    'created_account',
    'same_account',
    'switch_confirmed',
    'login'
  )),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (source_guest_player_id IS NULL AND source_family_id IS NULL)
    OR (source_guest_player_id IS NOT NULL AND source_family_id IS NOT NULL)
  )
);
CREATE INDEX pzd_provider_auth_receipts_committed
  ON public.pzd_provider_auth_receipts (committed_at);
CREATE INDEX pzd_provider_auth_receipts_provider_subject
  ON public.pzd_provider_auth_receipts (provider, provider_subject);

REVOKE ALL ON public.pzd_provider_auth_receipts FROM PUBLIC;
REVOKE ALL ON public.pzd_provider_auth_receipts FROM pzd_app_runtime;
GRANT SELECT ON public.pzd_provider_auth_receipts TO pzd_app_runtime;
GRANT INSERT (
  operation_id,
  provider,
  provider_subject,
  player_id,
  source_guest_player_id,
  source_family_id,
  resolution,
  committed_at
) ON public.pzd_provider_auth_receipts TO pzd_app_runtime;
-- No UPDATE/DELETE: receipts are insert-once per operation.

GRANT INSERT (operation_id) ON public.pzd_provider_continuations TO pzd_app_runtime;
