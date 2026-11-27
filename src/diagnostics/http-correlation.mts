/**
 * PZD-50: privacy-safe correlation primitives.
 * Only a generated 128-bit hex request id is accepted; never log request
 * headers, URLs, authorization tokens, payloads or arbitrary exceptions.
 */
import { randomBytes } from 'node:crypto';

const REQUEST_ID = /^[a-f0-9]{32}$/;

export function resolveRequestId(header: string | string[] | undefined): string {
  if (typeof header === 'string' && REQUEST_ID.test(header)) return header;
  return randomBytes(16).toString('hex');
}

export type DiagnosticOutcome = 'ok' | 'client_error' | 'server_error' | 'network_error';

export interface DiagnosticHttpEvent {
  readonly timestamp: string;
  readonly code: 'http_completed';
  readonly requestId: string;
  readonly operation: string;
  readonly route?: string;
  readonly errorCode?: string;
  readonly writerDenial?: 'SESSION_MISMATCH' | 'DEVICE_MISMATCH' | 'GENERATION_MISMATCH';
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'OTHER';
  readonly status: number | null;
  readonly durationMs: number;
  readonly outcome: DiagnosticOutcome;
}

const OPERATIONS = new Set(['tournament_http', 'diagnostic_report']);

// These are fixed protocol identifiers, never free-form exception messages.
const SAFE_ERROR_CODES = new Set([
  'UNAUTHENTICATED', 'NOT_FOUND', 'MALFORMED_REQUEST', 'RATE_LIMITED',
  'AUTH_UNAVAILABLE', 'TOURNAMENT_UNAVAILABLE', 'STALE_WRITER',
  'WRITER_NOT_AUTHORIZED', 'WRITER_STILL_ACTIVE', 'SERIES_NOT_OWNED',
  'SERIES_STATE_INCONSISTENT', 'SERIES_STATE_CORRUPT', 'SERIES_TERMINAL',
  'RECOVERY_NOT_ELIGIBLE', 'RECOVERY_PROOF_INVALID', 'PLAYER_MISMATCH',
  'IDLE_EXPIRED', 'HARD_CUTOFF_EXPIRED', 'SNAPSHOT_CHANGED',
  'INVALID_REFRESH', 'REFRESH_REPLAY', 'REFRESH_EXPIRED',
  'TOKEN_FORMAT_INVALID', 'TOKEN_NOT_FOUND', 'FAMILY_REVOKED', 'FAMILY_MISSING',
  'GUEST_LOGOUT_REVOKED',
  'RANKED_AUTH_REQUIRED', 'ACCOUNT_CONFLICT', 'GUEST_PROOF_REQUIRED',
  'INVALID_PROVIDER_ASSERTION', 'INVALID_PROVIDER_CHALLENGE',
  'PROVIDER_CONFIG_MISSING', 'AUTH_CHALLENGE_ISSUED',
  'AUTH_LOGIN_SUCCESS', 'AUTH_LINK_SUCCESS', 'PROVIDER_KEYS_UNAVAILABLE',
  'ACCOUNT_SWITCH_CONFIRMATION_REQUIRED', 'INVALID_CONTINUATION',
  'AUTH_CONTINUE_SUCCESS', 'AUTH_CONTINUE_CONFIRMED', 'RECOVERY_NOT_LINKED',
  'RECOVERY_OPERATION_INCOMPLETE',
  'SCHEMA_NOT_READY',
]);

const AUTH_SQLSTATE = /^AUTH_SQLSTATE_\d{5}$/;

export function safeDiagnosticErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (SAFE_ERROR_CODES.has(value)) return value;
  // Privacy-safe PostgreSQL SQLSTATE class only — never message/detail/params.
  if (AUTH_SQLSTATE.test(value)) return value;
  return undefined;
}

/** Categorizes only static route patterns; no series/player/manifest IDs or query strings. */
export function diagnosticRoute(url: string | undefined): string {
  const path = url?.split('?', 1)[0] ?? '';
  if (path === '/v1/diagnostics/reports') return 'diagnostic_report';
  if (path === '/v1/profile/me/badges' || path === '/v1/tournament/me/badges') {
    return 'profile_badges';
  }
  if (
    path === '/v1/profile/me/personal-records'
    || path === '/v1/profile/me/personal-records/practice/sync'
  ) {
    return 'profile_personal_records';
  }
  if (path.startsWith('/v1/profile/')) return 'profile_other';
  if (path === '/v1/tournament/session') return 'tournament_session';
  if (path.includes('/leaderboards/daily')) return 'leaderboard_daily';
  if (path.includes('/leaderboards/weekly')) return 'leaderboard_weekly';
  if (path.includes('/manifests/')) return 'tournament_manifest';
  if (path.includes('/series/') && /\/commands?(?:\/|$)/.test(path)) return 'tournament_command';
  if (path.includes('/series/')) return 'tournament_series';
  if (path.startsWith('/v1/tournament/')) return 'tournament_other';
  if (path.startsWith('/v1/auth/providers/')) return 'provider_auth';
  if (path.startsWith('/v1/auth/')) return 'guest_auth';
  return 'other';
}


export function buildHttpDiagnostic(input: {
  requestId: string;
  operation: string;
  route?: string;
  errorCode?: unknown;
  writerDenial?: unknown;
  method: string;
  status?: number;
  durationMs: number;
  now?: Date;
}): DiagnosticHttpEvent {
  if (!REQUEST_ID.test(input.requestId)) throw new Error('Invalid request ID');
  if (!OPERATIONS.has(input.operation)) throw new Error('Invalid operation');
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) throw new Error('Invalid duration');
  const status = input.status ?? null;
  if (status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) {
    throw new Error('Invalid HTTP status');
  }
  const method = (['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(input.method)
    ? input.method : 'OTHER') as DiagnosticHttpEvent['method'];
  return {
    timestamp: (input.now ?? new Date()).toISOString(),
    code: 'http_completed',
    requestId: input.requestId,
    operation: input.operation,
    ...(input.route ? { route: input.route } : {}),
    ...(safeDiagnosticErrorCode(input.errorCode) ? { errorCode: safeDiagnosticErrorCode(input.errorCode) } : {}),
    ...(input.errorCode === 'WRITER_NOT_AUTHORIZED' &&
      (input.writerDenial === 'SESSION_MISMATCH' ||
       input.writerDenial === 'DEVICE_MISMATCH' ||
       input.writerDenial === 'GENERATION_MISMATCH')
      ? { writerDenial: input.writerDenial } : {}),
    method,
    status,
    durationMs: Math.round(input.durationMs),
    outcome: status === null ? 'network_error' : status >= 500 ? 'server_error'
      : status >= 400 ? 'client_error' : 'ok',
  };
}

export function emitHttpDiagnostic(event: DiagnosticHttpEvent, write: (line: string) => void): void {
  write(JSON.stringify(event));
}
