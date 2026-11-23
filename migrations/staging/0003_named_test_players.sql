-- Staging-only named test players; explicit approved migration.
CREATE TABLE public.pzd_staging_test_players (
  slug text PRIMARY KEY CHECK (slug IN ('gokhan', 'serap')),
  player_id uuid NOT NULL UNIQUE REFERENCES public.pzd_guest_accounts(player_id),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.pzd_staging_test_players FROM PUBLIC;
GRANT SELECT, INSERT ON public.pzd_staging_test_players TO pzd_app_runtime;
