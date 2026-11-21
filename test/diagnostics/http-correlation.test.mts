import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHttpDiagnostic, emitHttpDiagnostic, resolveRequestId } from '../../src/diagnostics/http-correlation.mts';

test('valid 128-bit client correlation is preserved; malformed values replaced', () => {
  const valid = 'abcdef0123456789abcdef0123456789';
  assert.equal(resolveRequestId(valid), valid);
  for (const input of ['Bearer secret', 'abcdef', '../foo', '', ['abc']]) {
    const result = resolveRequestId(input);
    assert.match(result, /^[a-f0-9]{32}$/);
    assert.notEqual(result, input);
  }
});

test('structured output is allowlisted and excludes request data', () => {
  const requestId = resolveRequestId(undefined);
  const event = buildHttpDiagnostic({
    requestId, operation: 'tournament_http', method: 'POST', status: 401,
    durationMs: 12.6, now: new Date('2026-11-21T00:00:00.000Z'),
  });
  const lines: string[] = [];
  emitHttpDiagnostic(event, (line) => lines.push(line));
  assert.equal(event.outcome, 'client_error');
  assert.equal(event.durationMs, 13);
  assert.deepEqual(Object.keys(JSON.parse(lines[0]!)).sort(), [
    'code', 'durationMs', 'method', 'operation', 'outcome', 'requestId', 'status', 'timestamp',
  ]);
  assert.throws(() => buildHttpDiagnostic({
    requestId, operation: 'Bearer-secret', method: 'GET', durationMs: 1,
  }));
});
