import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const bootstrap = readFileSync(new URL('../../ops/staging/create-test-player.mts', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../../.github/workflows/staging-test-players.yml', import.meta.url), 'utf8');
const service = readFileSync(new URL('../../src/staging/guest-auth-service.mts', import.meta.url), 'utf8');
const cd = readFileSync(new URL('../../.github/workflows/staging-cd.yml', import.meta.url), 'utf8');

test('named test players are isolated to staging DB and explicit selection', () => {
  for (const name of ['Gökhan Aydın', 'Serap Nazlı Aydın']) assert.ok(bootstrap.includes(name));
  assert.match(bootstrap, /PZD_RUNTIME_PROFILE !== 'staging'/);
  assert.match(bootstrap, /PZD_RANKED_HTTP_ENABLED === 'true'/);
  assert.match(bootstrap, /PZD_TEST_PLAYER_CREATE !== 'YES'/);
  assert.match(bootstrap, /db\.pathname !== '\/pzd_staging'/);
  assert.match(bootstrap, /openSync\(destination, 'wx', 0o600\)/);
});

test('credential persistence happens before DB commit', () => {
  const persisted = service.indexOf('await beforeCommit(credentials, { client, playerId })');
  const committed = service.indexOf("await client.query('COMMIT')", persisted);
  assert.ok(persisted >= 0 && committed > persisted);
  assert.match(bootstrap, /fsyncSync\(fd\)/);
  assert.match(bootstrap, /auth\.create\(new Date\(\), async \(issued, context\) =>/);
});

test('provisioning requires explicit workflow and private SSH', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /--env-file=\/home\/pzd-staging\/pzd-staging\/staging\.env/);
  assert.match(workflow, /for player in gokhan serap/);
  assert.match(cd, /ops\/staging\/create-test-player\.mts/);
});

test('named profiles and crash reconciliation are DB-backed', () => {
  assert.match(bootstrap, /reconcileExisting\(pool, slug, destination\)/);
  assert.match(bootstrap, /pzd_staging_test_players/);
  assert.match(bootstrap, /token_digest=\$2/);
  assert.match(bootstrap, /context\.client\.query/);
  assert.doesNotMatch(workflow, /test -s "\$file"/);
});
