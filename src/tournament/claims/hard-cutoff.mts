/**
 * R-01 trusted hard-cutoff calculation for an immutable daily claim.
 *
 * All series started during their original active UTC week retain the same
 * absolute completion deadline: next Monday 01:00 UTC. Monday 00:00 UTC
 * still closes NEW claims for the previous week (claimWindowClosed).
 * The final hour is only for already-started in-flight settlement.
 * Fail closed (null) for invalid dates, timestamps or cross-week claims.
 */
export function utcWeekMondayMs(dayMs: number): number {
  return dayMs - ((new Date(dayMs).getUTCDay() + 6) % 7) * 86400000;
}

export function parseUtcDateMs(utcDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(utcDate)) return null;
  const n = Date.parse(utcDate + 'T00:00:00.000Z');
  if (!Number.isFinite(n)) return null;
  if (new Date(n).toISOString().slice(0, 10) !== utcDate) return null;
  return n;
}

/** Absolute series hard cutoff in epoch ms, or null if not calculable. */
export function computeSeriesHardCutoffMs(args: {
  originalUtcDate: string;
  startedAtMs: number;
}): number | null {
  const originalMs = parseUtcDateMs(args.originalUtcDate);
  if (originalMs === null) return null;
  if (!Number.isSafeInteger(args.startedAtMs) || args.startedAtMs < 1) return null;

  const weekMonday = utcWeekMondayMs(originalMs);
  const nextMonday = weekMonday + 7 * 86400000;
  // The claim must have started within the requested date's UTC week.
  if (args.startedAtMs < originalMs || args.startedAtMs >= nextMonday) return null;
  // Prior-week in-flight completion grace ends Monday 01:00 UTC.
  return nextMonday + 60 * 60 * 1000;
}

/** Exclusive deadline: eligible iff trustedNow < hardCutoff. */
export function isBeforeHardCutoff(
  trustedNowMs: number,
  hardCutoffMs: number,
): boolean {
  return trustedNowMs < hardCutoffMs;
}
