import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authSqlStateDiagnosticReason,
  extractSqlState,
  ProviderAuthError,
} from '../../src/staging/provider-identity-service.mts';
import { safeDiagnosticErrorCode } from '../../src/diagnostics/http-correlation.mts';

test('extractSqlState accepts only five-digit PostgreSQL codes', () => {
  assert.equal(extractSqlState({ code: '42703' }), '42703');
  assert.equal(extractSqlState({ code: '42501' }), '42501');
  assert.equal(extractSqlState({ code: '28P01' }), undefined);
  assert.equal(extractSqlState({ code: 'permission denied' }), undefined);
  assert.equal(extractSqlState(new Error('42703')), undefined);
  assert.equal(
    authSqlStateDiagnosticReason('42703'),
    'AUTH_SQLSTATE_42703',
  );
  assert.equal(
    safeDiagnosticErrorCode(authSqlStateDiagnosticReason('42703')),
    'AUTH_SQLSTATE_42703',
  );
});

test('ProviderAuthError carries privacy-safe diagnosticReason without leaking SQL', () => {
  const error = new ProviderAuthError('AUTH_UNAVAILABLE', {
    diagnosticReason: authSqlStateDiagnosticReason('42703'),
  });
  assert.equal(error.code, 'AUTH_UNAVAILABLE');
  assert.equal(error.diagnosticReason, 'AUTH_SQLSTATE_42703');
  assert.equal(error.message.includes('player_id'), false);
  assert.equal(JSON.stringify(error).includes('SELECT'), false);
});
