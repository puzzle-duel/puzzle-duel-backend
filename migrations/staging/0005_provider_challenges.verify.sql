BEGIN READ ONLY;
SELECT CASE WHEN current_database()='pzd_staging'
 AND to_regclass('public.pzd_provider_challenges') IS NOT NULL
 AND to_regclass('public.pzd_provider_challenges_expiry') IS NOT NULL
THEN 'PASS' ELSE 'BLOCKED' END;
ROLLBACK;
