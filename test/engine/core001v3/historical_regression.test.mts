import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifyChecksumLedger(versionDir: string): number {
  const ledger = readFileSync(join(versionDir, 'CHECKSUMS.txt'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  for (const line of ledger) {
    const [digest, rel] = line.split(/\s+/);
    assert.ok(digest && rel, `malformed checksum line: ${line}`);
    const actual = sha256File(join(versionDir, rel));
    assert.equal(actual, digest, rel);
  }
  return ledger.length;
}

test('historical v1 fixture checksum ledger unchanged', () => {
  const count = verifyChecksumLedger(join(root, 'docs/contracts/gameplay/v1'));
  assert.equal(count, 27);
});

test('historical v2 fixture checksum ledger unchanged', () => {
  const count = verifyChecksumLedger(join(root, 'docs/contracts/gameplay/v2'));
  assert.equal(count, 8);
});

test('v1/v2 validate.mjs still execute', () => {
  for (const version of ['v1', 'v2'] as const) {
    const script = join(root, `docs/contracts/gameplay/${version}/validate.mjs`);
    const result = spawnSync(process.execPath, [script], {
      cwd: join(root, `docs/contracts/gameplay/${version}`),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test('v1 reference_check.py PASS', () => {
  const dir = join(root, 'docs/contracts/gameplay/v1');
  const result = spawnSync('python3', ['reference_check.py'], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS|OK|ok/i);
});

test('v2 reference_check.py PASS', () => {
  const dir = join(root, 'docs/contracts/gameplay/v2');
  const result = spawnSync('python3', ['reference_check.py'], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('gen-001.v1 TypeScript generator vectors still PASS', () => {
  const fixtureDir =
    process.env.PZD_GENERATOR_FIXTURES ??
    join(
      root,
      '../puzzle-duel-client/docs/contracts/generator/gen-001.v1/fixtures',
    );
  let files: string[] = [];
  try {
    files = readdirSync(fixtureDir).filter((f) => f.endsWith('.json'));
  } catch {
    assert.fail(
      `generator fixtures missing at ${fixtureDir}; set PZD_GENERATOR_FIXTURES`,
    );
  }
  assert.equal(files.length, 15);
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--test', 'test/generator.test.mts'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PZD_GENERATOR_FIXTURES: fixtureDir },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
