-- PZD-49 staging-only candidate; apply explicitly with staging migrator.
-- Never execute DDL from the HTTP runtime.
CREATE TABLE IF NOT EXISTS pzd_guest_accounts (
  player_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pzd_guest_families (
  family_id uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES pzd_guest_accounts(player_id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pzd_guest_refresh (
  token_digest char(64) PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES pzd_guest_families(family_id),
  player_id uuid NOT NULL REFERENCES pzd_guest_accounts(player_id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pzd_guest_refresh_family_idx ON pzd_guest_refresh(family_id);
