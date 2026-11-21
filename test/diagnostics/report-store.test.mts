import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiagnosticReportStore } from '../../src/diagnostics/report-store.mts';

const event = {
  timestamp: '2026-11-21T12:00:00.000Z', level: 'warning',
  code: 'httpFailed', operation: 'tournament_http',
  requestId: '0123456789abcdef0123456789abcdef', httpStatus: 401,
};

test('report returns id, rate limits and expires', () => {
  let now = 100_000;
  const store = new DiagnosticReportStore(() => now);
  const first = store.submit('player-a', { events: [event] });
  assert.equal(first.ok, true);
  if (first.ok) assert.match(first.reportId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(store.submit('player-a', { events: [] }),
    { ok: false, status: 429, error: 'RATE_LIMITED' });
  now += 60_001;
  assert.equal(store.submit('player-a', { events: [] }).ok, true);
});

test('rejects arbitrary fields and secrets, never accepts raw payloads', () => {
  const store = new DiagnosticReportStore();
  for (const payload of [
    { events: [{ ...event, authorization: 'Bearer secret' }] },
    { events: [{ ...event, operation: 'Bearer_secret' + 'x'.repeat(70) }] },
    { events: [{ ...event, requestId: 'secret' }] },
    { events: [{ ...event, httpStatus: 999 }] },
    { events: [], token: 'secret' },
    { events: Array.from({ length: 65 }, () => event) },
  ]) {
    assert.deepEqual(store.submit('player-a', payload),
      { ok: false, status: 400, error: 'MALFORMED_REQUEST' });
  }
});
