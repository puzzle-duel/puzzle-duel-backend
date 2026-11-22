-- Read-only staging verifier. This file is NOT passed to SQL validator.
BEGIN READ ONLY;
SELECT CASE WHEN current_database()='pzd_staging'
  AND EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pzd_guest_refresh'
      AND column_name='rotation_id_digest')
THEN 'PASS' ELSE 'BLOCKED' END;
ROLLBACK;
