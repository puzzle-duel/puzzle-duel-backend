/**
 * R-01 trusted hard-cutoff calculation for an immutable daily claim.
 *
 * - Same-calendar-day claim: min(originalDate+1 00:15 UTC, weekMonday+7d 01:00 UTC)
 * - Same-week retrospective claim (started after original date): week Monday+7d 01:00 only
 *   (do NOT apply the original-date+1 00:15 boundary)
 * - Fail closed (null) when inputs are not authoritative calendar/timestamps.
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

/**
 * Absolute series hard cutoff in epoch ms, or null if not calculable.
 */
export function computeSeriesHardCutoffMs(args: {
  originalUtcDate: string;
  startedAtMs: number;
}): number | null {
  const originalMs = parseUtcDateMs(args.originalUtcDate);
  if (originalMs === null) return null;
  if (!Number.isSafeInteger(args.startedAtMs) || args.startedAtMs < 1) return null;

  const weekMonday = utcWeekMondayMs(originalMs);
  // Prior-week in-flight completion window ends Monday 01:00 UTC of the next week.
  const weekHardCutoff = weekMonday + 7 * 86400000 + 60 * 60 * 1000;

  const startedDay = Math.floor(args.startedAtMs / 86400000) * 86400000;
  const originalDay = originalMs;
  const isRetrospectiveSameWeek = startedDay > originalDay;

  if (isRetrospectiveSameWeek) {
    // R-01: retrospective same-week play is not bound by original-date+1 00:15.
    return weekHardCutoff;
  }

  // Ordinary / same-day claim: prior-day in-flight grace ends at next midnight + 15m.
  const nextDayGrace = originalDay + 86400000 + 15 * 60 * 1000;
  return Math.min(nextDayGrace, weekHardCutoff);
}

/** Exclusive deadline: eligible iff trustedNow < hardCutoff. */
export function isBeforeHardCutoff(
  trustedNowMs: number,
  hardCutoffMs: number,
): boolean {
  return trustedNowMs < hardCutoffMs;
}
