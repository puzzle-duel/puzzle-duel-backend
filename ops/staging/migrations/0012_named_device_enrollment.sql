-- Apply explicitly in isolated pzd_staging only; never auto-run on startup.
BEGIN;
CREATE TABLE IF NOT EXISTS public.pzd_staging_device_enrollment (
  code_digest text PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.pzd_guest_accounts(player_id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS pzd_staging_device_enrollment_player_idx
  ON public.pzd_staging_device_enrollment(player_id);
COMMIT;
