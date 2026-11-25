BEGIN READ ONLY;
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM pg_trigger
  WHERE tgrelid = 'public.pzd_identity_links'::regclass
    AND tgname = 'pzd_identity_links_immutable_upd'
    AND NOT tgisinternal
) AND EXISTS (
  SELECT 1 FROM pg_trigger
  WHERE tgrelid = 'public.pzd_identity_links'::regclass
    AND tgname = 'pzd_identity_links_immutable_del'
    AND NOT tgisinternal
) AND NOT has_table_privilege('pzd_app_runtime','public.pzd_identity_links','UPDATE')
  AND NOT has_table_privilege('pzd_app_runtime','public.pzd_identity_links','DELETE') THEN 'PASS' ELSE 'BLOCKED' END;
ROLLBACK;
