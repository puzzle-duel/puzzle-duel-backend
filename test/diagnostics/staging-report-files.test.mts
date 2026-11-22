import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { StagingDiagnosticReportFiles } from '../../src/diagnostics/staging-report-files.mts';

const ID = 'aabbccdd-1122-3344-5566-77889900aabb';
test('staging reports persist to a private, validated, bounded file', () => {
  const root = mkdtempSync(join(tmpdir(), 'pzd-report-'));
  try {
    const store = new StagingDiagnosticReportFiles(join(root, 'reports'), () => 1_900_000_000_000);
    const events = [{ timestamp: '2026-11-23T00:00:00Z', operation: 'move_command_returned', durationMs: 123 }];
    store.save(ID, events);
    const directory = join(root, 'reports');
    assert.equal(statSync(directory).mode & 0o077, 0);
    const file = join(directory, ID + '.json');
    assert.equal(statSync(file).mode & 0o077, 0);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).events, events);
    assert.throws(() => store.save(ID, events));
    assert.throws(() => store.save('../path', events));
    assert.throws(() => store.save('b'.repeat(36), Array(65).fill({})));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects symlink instead of following a diagnostic directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'pzd-report-link-'));
  try {
    const linked = join(root, 'alias');
    symlinkSync(root, linked);
    assert.throws(() =>
      new StagingDiagnosticReportFiles(linked).save(ID, []),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
