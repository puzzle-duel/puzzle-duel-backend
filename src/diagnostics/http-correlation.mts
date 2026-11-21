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
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'OTHER';
  readonly status: number | null;
  readonly durationMs: number;
  readonly outcome: DiagnosticOutcome;
}

const OPERATIONS = new Set(['tournament_http', 'diagnostic_report']);

export function buildHttpDiagnostic(input: {
  requestId: string;
  operation: string;
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
