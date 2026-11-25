-- PZD-26: identity_links are INSERT-only for the runtime role.
-- Reject UPDATE/DELETE even if a future grant accidentally widens privileges.
DO $guard$
BEGIN
  IF current_database() <> 'pzd_staging' THEN
    RAISE EXCEPTION 'PROVIDER_AUTH_STAGING_ONLY';
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.pzd_identity_links_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'IDENTITY_LINK_IMMUTABLE';
END;
$$;

DROP TRIGGER IF EXISTS pzd_identity_links_immutable_upd ON public.pzd_identity_links;
CREATE TRIGGER pzd_identity_links_immutable_upd
  BEFORE UPDATE ON public.pzd_identity_links
  FOR EACH ROW EXECUTE FUNCTION public.pzd_identity_links_immutable();

DROP TRIGGER IF EXISTS pzd_identity_links_immutable_del ON public.pzd_identity_links;
CREATE TRIGGER pzd_identity_links_immutable_del
  BEFORE DELETE ON public.pzd_identity_links
  FOR EACH ROW EXECUTE FUNCTION public.pzd_identity_links_immutable();
