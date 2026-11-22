import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const tool = 'ops/staging/migrations/validate-sql.py';
function check(sql: string, expected: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'pzd-migration-sql-'));
  try {
    const file = join(dir, 'migration.sql');
    writeFileSync(file, sql);
    const r = spawnSync('python3', [tool, file], { encoding: 'utf8' });
    assert.equal(r.status === 0, expected, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test('PZD-50 actual reviewed migration permits PL/pgSQL BEGIN but not transaction BEGIN', () => {
  check(readFileSync('migrations/staging/0001_same_device_writer_recovery.sql', 'utf8'), true);
});
test('PZD-50 blocks transaction statements including multiline BEGIN', () => {
  for (const stmt of ['BEGIN;', 'BEGIN\n;', 'BEGIN TRANSACTION;', 'COMMIT;', 'ROLLBACK;', 'SAVEPOINT a;', 'END;', 'START TRANSACTION;']) {
    check('SELECT 1;\n'+stmt+'\nSELECT 2;', false);
  }
});
test('PZD-50 blocks psql commands and avoids comment/string false positives', () => {
  check('SELECT 1;\n\\\\i /tmp/unsafe.sql', false);
  check('-- BEGIN;\nSELECT \'COMMIT;\';\nDO $x$ BEGIN PERFORM 1; END $x$;', true);
  check('/* BEGIN; */\nSELECT 1;', true);
  check('DO $x$ BEGIN PERFORM 1;', false);
});
