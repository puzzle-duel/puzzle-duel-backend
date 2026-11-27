import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHttpDiagnostic, diagnosticRoute, safeDiagnosticErrorCode, emitHttpDiagnostic, resolveRequestId } from '../../src/diagnostics/http-correlation.mts';

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

test('staging error reasons are exact allowlisted codes, never raw exception text', () => {
  assert.equal(safeDiagnosticErrorCode('WRITER_NOT_AUTHORIZED'), 'WRITER_NOT_AUTHORIZED');
  assert.equal(safeDiagnosticErrorCode('STALE_WRITER'), 'STALE_WRITER');
  assert.equal(safeDiagnosticErrorCode('WRITER_STILL_ACTIVE'), 'WRITER_STILL_ACTIVE');
  for (const code of ['INVALID_REFRESH', 'REFRESH_REPLAY', 'REFRESH_EXPIRED',
    'TOKEN_FORMAT_INVALID', 'TOKEN_NOT_FOUND', 'FAMILY_REVOKED', 'FAMILY_MISSING',
    'GUEST_LOGOUT_REVOKED']) {
    assert.equal(safeDiagnosticErrorCode(code), code);
  }
  for (const value of ['Bearer private', 'UNEXPECTED_RAW_EXCEPTION', {}, undefined, '']) {
    assert.equal(safeDiagnosticErrorCode(value), undefined);
  }
  const event = buildHttpDiagnostic({
    requestId: 'abcdef0123456789abcdef0123456789',
    operation: 'tournament_http', route: 'tournament_series',
    errorCode: 'WRITER_NOT_AUTHORIZED', method: 'POST', status: 409, durationMs: 8,
  });
  assert.equal(event.errorCode, 'WRITER_NOT_AUTHORIZED');
  assert.equal(event.route, 'tournament_series');
  const untrusted = buildHttpDiagnostic({
    requestId: 'abcdef0123456789abcdef0123456789',
    operation: 'tournament_http', route: 'other',
    errorCode: 'Bearer private', method: 'POST', status: 409, durationMs: 8,
  });
  assert.equal('errorCode' in untrusted, false);
});

test('HTTP route classifier never includes series IDs or query strings', () => {
  assert.equal(diagnosticRoute('/v1/tournament/session'), 'tournament_session');
  assert.equal(diagnosticRoute('/v1/diagnostics/reports'), 'diagnostic_report');
  assert.equal(diagnosticRoute('/v1/tournament/leaderboards/daily?date=2026-11-22'), 'leaderboard_daily');
  assert.equal(diagnosticRoute('/v1/tournament/series/secret-series-id/command'), 'tournament_command');
  assert.equal(diagnosticRoute('/v1/tournament/series/secret-series-id'), 'tournament_series');
  assert.equal(diagnosticRoute('/v1/auth/guest'), 'guest_auth');
  assert.equal(diagnosticRoute('/v1/auth/providers/continue'), 'provider_auth');
  assert.equal(diagnosticRoute('/v1/auth/providers/challenge'), 'provider_auth');
  assert.equal(diagnosticRoute('/v1/profile/me/badges'), 'profile_badges');
  assert.equal(diagnosticRoute('/v1/tournament/me/badges'), 'profile_badges');
  assert.equal(diagnosticRoute('/malicious/secret'), 'other');
});

test('AUTH_SQLSTATE_* diagnostic reasons are privacy-safe allowlisted', () => {
  assert.equal(safeDiagnosticErrorCode('AUTH_SQLSTATE_42703'), 'AUTH_SQLSTATE_42703');
  assert.equal(safeDiagnosticErrorCode('AUTH_SQLSTATE_42501'), 'AUTH_SQLSTATE_42501');
  assert.equal(safeDiagnosticErrorCode('AUTH_SQLSTATE_ABCD'), undefined);
  assert.equal(safeDiagnosticErrorCode('AUTH_SQLSTATE_42703; DROP'), undefined);
  const event = buildHttpDiagnostic({
    requestId: 'abcdef0123456789abcdef0123456789',
    operation: 'tournament_http',
    route: 'provider_auth',
    errorCode: 'AUTH_SQLSTATE_42703',
    method: 'POST',
    status: 503,
    durationMs: 10,
  });
  assert.equal(event.errorCode, 'AUTH_SQLSTATE_42703');
  assert.equal(event.route, 'provider_auth');
});

test('writer mismatch subtype is emitted only for exact sanctioned writer denials', () => {
  const base = {
    requestId: 'abcdef0123456789abcdef0123456789',
    operation: 'tournament_http', method: 'POST', status: 409,
    durationMs: 5,
  };
  for (const writerDenial of ['SESSION_MISMATCH', 'DEVICE_MISMATCH', 'GENERATION_MISMATCH']) {
    const event = buildHttpDiagnostic({ ...base, errorCode: 'WRITER_NOT_AUTHORIZED', writerDenial });
    assert.equal(event.writerDenial, writerDenial);
    assert.equal(JSON.stringify(event).includes('sessionSecret'), false);
  }
  for (const errorCode of ['UNAUTHENTICATED', 'WRITER_NOT_AUTHORIZED']) {
    for (const writerDenial of ['player-123', 'Bearer sensitive', '<script>']) {
      const event = buildHttpDiagnostic({ ...base, errorCode, writerDenial });
      assert.equal('writerDenial' in event, false);
    }
  }
  assert.equal('writerDenial' in buildHttpDiagnostic({
    ...base, errorCode: 'UNAUTHENTICATED', writerDenial: 'SESSION_MISMATCH',
  }), false);
});
