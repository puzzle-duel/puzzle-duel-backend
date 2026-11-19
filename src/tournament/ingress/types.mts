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
  /** Expected board revision for move CAS (TD-03). */
  expectedBoardRevision?: number;
  /** Claimed writer generation (TD-05). Consistency only; auth is Phase B. */
  writerGeneration?: number;
  /**
   * @deprecated P1-04: never accept from clients. Presence is rejected.
   * Test-only move effects use ServerMoveEffectResolver.
   */
  scoreDelta?: number;
  /**
   * @deprecated P1-04: never accept from clients. Presence is rejected.
   */
  completesSeries?: boolean;
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
  expectedBoardRevision?: number;
  writerGeneration?: number;
}

export type AdmitResult =
  | { ok: true; command: AdmittedCommand; outcome: CommandOutcomeStatus }
  | {
      ok: false;
      reason: 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      existing: AdmittedCommand;
      outcome: CommandOutcomeStatus;
    }
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

/**
 * TD-07: one deliberate +60s extension. Eligible only when remaining idle
 * is in (0, 60_000] ms. Cap at hardCutoffAt; never exceed cutoff.
 */
export function applyThinkingExtension(
  currentIdleDeadline: Date,
  remainingMs: number,
  hardCutoff: Date | null,
): Date | null {
  if (remainingMs <= 0 || remainingMs > 60_000) return null;
  const extended = new Date(currentIdleDeadline.getTime() + 60_000);
  if (hardCutoff && extended.getTime() > hardCutoff.getTime()) {
    return hardCutoff;
  }
  return extended;
}

export type SeriesTerminalStatus =
  | 'ACTIVE'
  | 'AWAIT_ADVANCE'
  | 'COMPLETED'
  | 'FORFEITED';

export interface SeriesFenceState {
  seriesKey: string;
  boardRevision: number;
  writerGeneration: number;
  status: SeriesTerminalStatus;
  idleDeadlineAt: Date;
  hardCutoffAt: Date | null;
  score: number;
  /**
   * Four-category atomic publish. Phase A must keep this false —
   * publication is Phase C (NOT_RUN).
   */
  resultsPublished: boolean;
  /** Last admission that successfully mutated fence (duplicate-safe). */
  lastAppliedAdmissionId: string | null;
  /**
   * P1-01 / TD-07: durable one-shot thinking extension consumption for the
   * entire six-subgame series. Never reset between subgames.
   */
  thinkingExtensionConsumed: boolean;
}

/** Test-only / internal move effect. Never sourced from client JSON. */
export interface ServerDerivedMoveEffect {
  scoreDelta: number;
  /**
   * The current subgame ended. Phase A records AWAIT_ADVANCE only.
   * It does not complete the six-game series and does not publish.
   */
  completesSubgame: boolean;
}

export type ServerMoveEffectResolver = (
  command: AdmitCommandInput,
) => ServerDerivedMoveEffect | null;
