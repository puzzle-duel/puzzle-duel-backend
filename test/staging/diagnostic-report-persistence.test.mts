import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticReportStore } from '../../src/diagnostics/report-store.mts';
import { StagingDiagnosticReportFiles } from '../../src/diagnostics/staging-report-files.mts';

test('staging diagnostic 201 requires private persisted report', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pzd-staging-report-'));
  try {
    const files = new StagingDiagnosticReportFiles(join(directory, 'reports'));
    const store = new DiagnosticReportStore(Date.now, (id, events) => files.save(id, events));
    const event = {
      timestamp: '2026-11-23T00:00:00.000Z',
      level: 'info', code: 'httpCompleted',
      operation: 'move_animation_arming',
      traceId: '0123456789abcdef0123456789abcdef',
      durationMs: 1234,
    };
    const result = store.submit('player-a', { events: [event] });
    assert.equal(result.ok, true);
    if (result.ok) {
      const data = JSON.parse(readFileSync(join(directory, 'reports', result.reportId + '.json'), 'utf8'));
      assert.deepEqual(data.events, [event]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
