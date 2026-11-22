import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const github = readFileSync('ops/staging/migrations/setup-github-environment.sh','utf8');
const roles = readFileSync('ops/staging/migrations/provision-db-roles.sql','utf8');
const runner = readFileSync('ops/staging/migrations/run.sh','utf8');

test('operator setup and existing migration runner are valid bash', () => {
  for (const file of [
    'ops/staging/migrations/setup-github-environment.sh',
    'ops/staging/migrations/run.sh',
  ]) {
    const result = spawnSync('bash',['-n',file],{encoding:'utf8'});
    assert.equal(result.status,0,`${file}: ${result.stderr}`);
  }
});

test('GitHub environment setup requires a distinct approver and a verified branch policy', () => {
  assert.match(github,/prevent_self_review": true/);
  assert.match(github,/required_reviewers/);
  assert.match(github,/deployment-branch-policies/);
  assert.match(github,/version\/0\.0\.2/);
  assert.match(github,/\$\{reviewer,,\}/);
  assert.match(github,/gh secret set PZD_MIGRATION_SSH_PRIVATE_KEY/);
  assert.match(github,/ssh-keygen -F/);
  assert.doesNotMatch(github,/ssh-keyscan/);
});

test('PostgreSQL admin bootstrap is staging-only, passwordless source, and denies runtime owner rights', () => {
  assert.match(roles,/current_database\(\) <> 'pzd_staging'/);
  assert.match(roles,/CREATE ROLE pzd_staging_migrator/);
  assert.match(roles,/CREATE ROLE pzd_staging_backup/);
  assert.match(roles,/GRANT pzd_migration_owner TO pzd_staging_migrator/);
  assert.match(roles,/WITH ADMIN FALSE, INHERIT FALSE, SET TRUE/);
  assert.match(roles,/GRANT pg_read_all_data TO pzd_staging_backup/);
  assert.doesNotMatch(roles,/PASSWORD\s*'/i);
  assert.doesNotMatch(roles,/GRANT pzd_migration_owner TO pzd_app_runtime/i);
});

test('runner reads owner-protected history and verification after explicitly setting owner role', () => {
  assert.match(runner,/db_read_owner\(\)/);
  assert.match(runner,/-c 'SET ROLE pzd_migration_owner' -c "\$1"/);
  assert.match(runner,/previous="\$\(db_read_owner/);
  assert.match(runner,/-c 'SET ROLE pzd_migration_owner' -f "\$verify_file"/);
});
