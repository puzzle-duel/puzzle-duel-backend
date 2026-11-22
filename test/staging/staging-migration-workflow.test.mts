import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync('.github/workflows/staging-db-migrations.yml', 'utf8');
const runner = readFileSync('ops/staging/migrations/run.sh', 'utf8');
const recovery = readFileSync('migrations/staging/0001_same_device_writer_recovery.sql', 'utf8');
const verification = readFileSync('migrations/staging/0001_same_device_writer_recovery.verify.sql', 'utf8');

test('reusable staging migration runner is valid bash and manual-only', () => {
  const syntax = spawnSync('bash', ['-n', 'ops/staging/migrations/run.sh'], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.doesNotMatch(workflow, /^\s+pull_request:/m);
  assert.match(workflow, /environment: pzd-staging-migrations/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/version\/0\.0\.2'/);
  assert.match(workflow, /APPLY pzd_staging \$MIGRATION/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /permissions:\n  contents: read/);
});

test('host migration execution enforces separate roles, backup, ledger, and no service restart', () => {
  assert.match(runner, /migration-services\.conf/);
  assert.match(runner, /pzd_staging_migrate/);
  assert.match(runner, /pzd_staging_backup/);
  assert.match(runner, /pg_has_role\(session_user,'pzd_migration_owner','SET'\)/);
  assert.match(runner, /pg_dump -w -Fc/);
  assert.match(runner, /pg_restore --list/);
  assert.match(runner, /pzd_staging_migration_history/);
  assert.match(runner, /flock -x/);
  assert.match(runner, /ON_ERROR_STOP=1/);
  assert.match(runner, /Recovery feature activation: NOT PERFORMED/);
  assert.doesNotMatch(runner, /systemctl|DROP DATABASE|TRUNCATE /);
});

test('recovery migration is transactional via host wrapper and never backfills historical writers', () => {
  assert.match(recovery, /current_database\(\) <> 'pzd_staging'/);
  assert.match(recovery, /CREATE TABLE IF NOT EXISTS public\.tournament_device_credential/);
  assert.match(recovery, /original_device_credential_id UUID NULL/);
  assert.doesNotMatch(recovery, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/mi);
  assert.doesNotMatch(recovery, /UPDATE\s+(?:public\.)?tournament_series_writer\s+SET/i);
  assert.match(verification, /BEGIN READ ONLY/);
  assert.match(verification, /THEN 'PASS' ELSE 'BLOCKED'/);
});
