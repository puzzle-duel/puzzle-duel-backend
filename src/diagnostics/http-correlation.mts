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
]);

export function safeDiagnosticErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ERROR_CODES.has(value) ? value : undefined;
}

/** Categorizes only static route patterns; no series/player/manifest IDs or query strings. */
export function diagnosticRoute(url: string | undefined): string {
  const path = url?.split('?', 1)[0] ?? '';
  if (path === '/v1/diagnostics/reports') return 'diagnostic_report';
  if (path === '/v1/tournament/session') return 'tournament_session';
  if (path.includes('/leaderboards/daily')) return 'leaderboard_daily';
  if (path.includes('/leaderboards/weekly')) return 'leaderboard_weekly';
  if (path.includes('/manifests/')) return 'tournament_manifest';
  if (path.includes('/series/') && /\/commands?(?:\/|$)/.test(path)) return 'tournament_command';
  if (path.includes('/series/')) return 'tournament_series';
  if (path.startsWith('/v1/tournament/')) return 'tournament_other';
  if (path.startsWith('/v1/auth/')) return 'guest_auth';
  return 'other';
}


export function buildHttpDiagnostic(input: {
  requestId: string;
  operation: string;
  route?: string;
  errorCode?: unknown;
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
