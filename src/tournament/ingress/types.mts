/** Command types from ADR-T02 / Phase A contract. */
export type TournamentCommandType =
  | 'start'
  | 'move'
  | 'advance'
  | 'thinking_extension'
  | 'device_handoff'
  | 'abandon';

export type AdmissionStatus = 'admitted' | 'duplicate' | 'unavailable';

export type CommandOutcomeStatus =
  | 'pending'
  | 'applied'
  | 'rejected'
  | 'unknown';

export interface AdmitCommandInput {
  seriesKey: string;
  playerId: string;
  commandType: TournamentCommandType;
  idempotencyKey: string;
  payloadHash: string;
  /** Optional client-declared time — ignored for eligibility. */
  clientDeclaredAt?: Date;
}

export interface AdmittedCommand {
  admissionId: string;
  seriesKey: string;
  playerId: string;
  commandType: TournamentCommandType;
  idempotencyKey: string;
  payloadHash: string;
  /** Original trusted server receipt; never rewritten on retry. */
  trustedReceivedAt: Date;
  /** Monotonic per-series admission order. */
  admissionSeq: number;
  status: AdmissionStatus;
}

export interface IdempotencyConflict extends AdmittedCommand {
  conflict: 'IDEMPOTENCY_PAYLOAD_CONFLICT';
}

export type AdmitResult =
  | { ok: true; command: AdmittedCommand }
  | { ok: false; reason: 'IDEMPOTENCY_PAYLOAD_CONFLICT'; existing: AdmittedCommand }
  | { ok: false; reason: 'INGRESS_UNAVAILABLE' };

/**
 * Exclusive deadline: eligible iff trustedReceivedAt < effectiveDeadline.
 * Equality is expired (ADR-T02 / contract §4).
 */
export function isTimely(
  trustedReceivedAt: Date,
  effectiveDeadline: Date,
): boolean {
  return trustedReceivedAt.getTime() < effectiveDeadline.getTime();
}

export function idleDeadlineFrom(
  trustedEventAt: Date,
  idleSeconds = 300,
): Date {
  return new Date(trustedEventAt.getTime() + idleSeconds * 1000);
}

export function applyThinkingExtension(
  currentIdleDeadline: Date,
  remainingMs: number,
  hardCutoff: Date | null,
): Date | null {
  // Eligible only when remaining idle is >0 and <=60s.
  if (remainingMs <= 0 || remainingMs > 60_000) return null;
  const extended = new Date(currentIdleDeadline.getTime() + 60_000);
  if (hardCutoff && extended.getTime() > hardCutoff.getTime()) {
    return hardCutoff;
  }
  return extended;
}
