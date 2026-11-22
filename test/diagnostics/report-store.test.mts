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

test('accepts allowlisted writer rejection reason, rejects arbitrary report error codes', () => {
  const store = new DiagnosticReportStore();
  assert.equal(store.submit('player-a', { events: [
    { ...event, code: 'writerBindingRejected', httpStatus: 409,
      errorCode: 'WRITER_NOT_AUTHORIZED' },
  ] }).ok, true);
  assert.deepEqual(store.submit('player-b', { events: [
    { ...event, errorCode: 'Bearer secret' },
  ] }), { ok: false, status: 400, error: 'MALFORMED_REQUEST' });
  assert.deepEqual(store.submit('player-c', { events: [
    { ...event, errorCode: 'SENSITIVE_UNRECOGNIZED_CODE' },
  ] }), { ok: false, status: 400, error: 'MALFORMED_REQUEST' });
});

test('persistence failures deny 201 and allow safe retry', () => {
  let fail = true;
  const persisted: { reportId: string; events: readonly unknown[] }[] = [];
  const store = new DiagnosticReportStore(() => 100_000, (reportId, events) => {
    if (fail) throw new Error('disk diagnostic private detail');
    persisted.push({ reportId, events });
  });
  assert.deepEqual(store.submit('player-a', { events: [event] }),
    { ok: false, status: 503, error: 'DIAGNOSTICS_UNAVAILABLE' });
  fail = false;
  const next = store.submit('player-a', { events: [event] });
  assert.equal(next.ok, true);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0]?.events, [event]);
});
