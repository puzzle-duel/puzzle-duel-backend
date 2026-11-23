SELECT CASE WHEN
  to_regclass('public.pzd_staging_enrollment_grants') IS NOT NULL
  AND has_table_privilege('pzd_app_runtime', 'public.pzd_staging_enrollment_grants', 'SELECT,INSERT,UPDATE,DELETE')
THEN 'PASS' ELSE 'BLOCKED' END;
