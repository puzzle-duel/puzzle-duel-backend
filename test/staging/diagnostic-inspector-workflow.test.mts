import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const yaml = readFileSync('.github/workflows/staging-diagnostic-status.yml', 'utf8');
const actionName = '      - name: Inspect last 1 MiB or correlate by exact requestId and reportId';
const start = yaml.indexOf(actionName);
assert.ok(start >= 0, 'expected inspector step');
const run = yaml.indexOf('        run: |\n', start);
assert.ok(run >= 0, 'expected workflow run block');
const source = yaml.slice(run + '        run: |\n'.length);
const script = source.split('\n').filter(Boolean).map(line => {
  assert.ok(line.startsWith('          '), 'unexpected YAML indentation: ' + line.slice(0, 40));
  return line.slice(10);
}).join('\n') + '\n';

function execute(inputs: Record<string,string>) {
  const dir = mkdtempSync(join(tmpdir(), 'pzd-inspector-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'ssh'), '#!/bin/sh\ncat >/dev/null\necho "SSH_STUB_OK"\n', { mode: 0o700 });
    writeFileSync(join(dir, 'event.json'), JSON.stringify({ inputs }));
    writeFileSync(join(dir, 'summary.md'), '');
    const result = spawnSync('bash', ['-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: join(dir, 'bin') + ':' + process.env.PATH,
        GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
        HOST: '127.0.0.1', USER: 'staging' },
      timeout: 10000,
    });
    return { ...result, summary: readFileSync(join(dir, 'summary.md'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Inspector shell and embedded Python are syntactically valid; exactly one remote reader', () => {
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /environment: pzd-staging/);
  assert.match(yaml, /StrictHostKeyChecking=yes/);
  assert.equal((script.match(/ssh -o BatchMode=yes/g) || []).length, 1);
  assert.equal((script.match(/<<'PY'/g) || []).length, 1);
  assert.equal((script.match(/^PY$/gm) || []).length, 1);
  const shell = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(shell.status, 0, shell.stderr);
  const embedded = script.match(/<<'PY'.*\n([\s\S]*?)\nPY\n/);
  assert.ok(embedded, 'embedded Python must have a closing here-doc');
  const python = spawnSync('python3', ['-c', 'import ast,sys;ast.parse(sys.stdin.read())'], {
    input: embedded[1], encoding: 'utf8',
  });
  assert.equal(python.status, 0, python.stderr);
  assert.match(script, /SESSION_MISMATCH/);
  assert.match(script, /DEVICE_MISMATCH/);
  assert.match(script, /GENERATION_MISMATCH/);
  assert.doesNotMatch(script, /(?:TRUNCATE|DROP DATABASE|UPDATE tournament_series_writer)/);
  assert.doesNotMatch(yaml, /^\s+(?:RID|REPORT):\s*\$\{\{\s*inputs\./m);
});

test('empty inputs run latest 1 MiB read mode without SSH secrets in output', () => {
  const r = execute({});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SSH_STUB_OK/);
  assert.match(r.summary, /SSH_STUB_OK/);
  assert.match(script, /remaining=1024\*1024/);
});

test('request and report IDs in either input are accepted without echoing IDs', () => {
  const rid = 'abcdef0123456789abcdef0123456789';
  const report = '0bdffacf-d352-4687-abe3-1f0a28646b33';
  for (const inputs of [
    { request_id: rid }, { report_id: report }, { request_id: report }, { report_id: rid },
  ]) {
    const r = execute(inputs);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SSH_STUB_OK/);
    assert.doesNotMatch(r.stdout + r.stderr + r.summary, new RegExp(rid + '|' + report));
  }
});

test('invalid URLs, conflicting IDs and arbitrary input fail before SSH', () => {
  for (const inputs of [
    { report_id: 'https://github.com/puzzle-duel/puzzle-duel-backend/actions/runs/123' },
    { request_id: 'invalid' },
    { report_id: 'invalid' },
    { request_id: 'abcdef0123456789abcdef0123456789', report_id: '0bdffacf-d352-4687-abe3-1f0a28646b33' },
  ]) {
    const r = execute(inputs);
    assert.equal(r.status, 2, r.stderr);
    assert.doesNotMatch(r.stdout, /SSH_STUB_OK/);
  }
});
