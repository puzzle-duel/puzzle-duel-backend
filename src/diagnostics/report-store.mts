import { randomUUID } from 'node:crypto';

/** Staging-only, in-memory diagnostic reports. Never stores tokens or raw errors. */
export class DiagnosticReportStore {
  private readonly reports = new Map<string, { expiresAt: number; events: readonly unknown[] }>();
  private readonly lastByPlayer = new Map<string, number>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  submit(playerId: string, payload: unknown):
    | { ok: true; reportId: string }
    | { ok: false; status: number; error: string } {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, status: 400, error: 'MALFORMED_REQUEST' };
    }
    const obj = payload as Record<string, unknown>;
    if (Object.keys(obj).some((key) => key !== 'events') ||
        !Array.isArray(obj.events) || obj.events.length > 64) {
      return { ok: false, status: 400, error: 'MALFORMED_REQUEST' };
    }
    const allowedCodes = new Set([
      'applicationStarted', 'httpCompleted', 'httpFailed', 'authExpired',
      'authRefreshSucceeded', 'authRefreshFailed', 'sessionRestored',
      'sessionRestoreFailed', 'writerBindingRejected', 'diagnosticFailure',
    ]);
    const allowedLevels = new Set(['verbose', 'debug', 'info', 'warning', 'error', 'fatal']);
    const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    const events: unknown[] = [];
    for (const raw of obj.events) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, status: 400, error: 'MALFORMED_REQUEST' };
      }
      const e = raw as Record<string, unknown>;
      const keys = Object.keys(e);
      if (keys.some((key) => ![
        'timestamp', 'level', 'code', 'operation', 'requestId', 'traceId',
        'httpMethod', 'httpStatus', 'durationMs',
      ].includes(key)) ||
        typeof e.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(e.timestamp) ||
        !Number.isFinite(Date.parse(e.timestamp)) ||
        !allowedLevels.has(String(e.level)) || !allowedCodes.has(String(e.code)) ||
        typeof e.operation !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(e.operation) ||
        (e.requestId !== undefined && (typeof e.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(e.requestId))) ||
        (e.traceId !== undefined && (typeof e.traceId !== 'string' || !/^[a-f0-9]{32}$/.test(e.traceId))) ||
        (e.httpMethod !== undefined && !allowedMethods.has(String(e.httpMethod))) ||
        (e.httpStatus !== undefined && (!Number.isInteger(e.httpStatus) || Number(e.httpStatus) < 100 || Number(e.httpStatus) > 599)) ||
        (e.durationMs !== undefined && (!Number.isSafeInteger(e.durationMs) || Number(e.durationMs) < 0))) {
        return { ok: false, status: 400, error: 'MALFORMED_REQUEST' };
      }
      events.push(Object.freeze({ ...e }));
    }
    const now = this.now();
    // Bound the lightweight per-player rate limiter as well as report storage.
    for (const [id, last] of this.lastByPlayer) {
      if (now - last >= 60_000) this.lastByPlayer.delete(id);
    }
    while (this.lastByPlayer.size >= 1000 && !this.lastByPlayer.has(playerId)) {
      const oldest = this.lastByPlayer.keys().next().value;
      if (oldest === undefined) break;
      this.lastByPlayer.delete(oldest);
    }
    const previous = this.lastByPlayer.get(playerId);
    if (previous !== undefined && now - previous < 60_000) {
      return { ok: false, status: 429, error: 'RATE_LIMITED' };
    }
    for (const [id, report] of this.reports) {
      if (report.expiresAt <= now) this.reports.delete(id);
    }
    while (this.reports.size >= 100) {
      const oldest = this.reports.keys().next().value;
      if (oldest === undefined) break;
      this.reports.delete(oldest);
    }
    const reportId = randomUUID();
    this.reports.set(reportId, { expiresAt: now + 3_600_000, events });
    this.lastByPlayer.set(playerId, now);
    return { ok: true, reportId };
  }
}
