import type { ServerMoveEffectResolver } from '../adjudication/trusted-gameplay.mts';
import type { AdmissionJournal } from './journal.mts';
import type { SeriesFenceStore } from './series-fence.mts';
import {
  idleDeadlineFrom,
  isTimely,
  type AdmittedCommand,
  type AdmitCommandInput,
  type AdmitResult,
  type SeriesFenceState,
} from './types.mts';

export type AdjudicationResult =
  | {
      decision: 'apply';
      command: AdmittedCommand;
      state: SeriesFenceState;
      duplicateReplay?: boolean;
    }
  | {
      decision: 'reject';
      command: AdmittedCommand;
      reason:
        | 'IDLE_EXPIRED'
        | 'HARD_CUTOFF_EXPIRED'
        | 'SERIES_TERMINAL'
        | 'INGRESS_UNAVAILABLE'
        | 'IDEMPOTENCY_PAYLOAD_CONFLICT'
        | 'STATE_CONFLICT'
        | 'NOT_ACTIVE_WRITER'
        | 'EXTENSION_UNAVAILABLE'
        | 'MOVE_REQUIRES_SERVER_EFFECT'
        | 'CLIENT_SCORE_REJECTED';
      state?: SeriesFenceState;
      duplicateReplay?: boolean;
    }
  | { decision: 'unavailable'; reason: 'INGRESS_UNAVAILABLE' };

/**
 * Per-series arbiter: admit first (durable trusted time), then evaluate
 * eligibility against deadlines using the original trustedReceivedAt —
 * never Date.now() at later lock acquisition (contract §4 / TD-02/TD-03).
 *
 * Stage E: client `scoreDelta` / `completesSeries` never authorize ranked
 * score or completion. Moves require a server `ServerMoveEffectResolver`
 * (tests inject fakes; production uses TrustedGameplayService instead).
 */
export class SeriesCommandArbiter {
  readonly #journal: AdmissionJournal;
  readonly #fence: SeriesFenceStore;
  readonly #moveEffect: ServerMoveEffectResolver | null;
  /** Serialize adjudication per admissionId (duplicate concurrent retries). */
  readonly #admissionLocks = new Map<string, Promise<void>>();

  constructor(
    journal: AdmissionJournal,
    fence: SeriesFenceStore,
    moveEffect: ServerMoveEffectResolver | null = null,
  ) {
    this.#journal = journal;
    this.#fence = fence;
    this.#moveEffect = moveEffect;
  }

  async admitAndEvaluate(
    input: AdmitCommandInput,
    options?: {
      /** Simulated delay between admit and lock/adjudication. */
      afterAdmit?: () => Promise<void>;
    },
  ): Promise<AdjudicationResult> {
    const admit = await this.#journal.admit(input);
    if (!admit.ok) {
      return this.#mapAdmitFailure(admit);
    }

    // Duplicate with prior outcome: never re-mutate (idempotent replay).
    if (admit.command.status === 'duplicate' && admit.outcome !== 'pending') {
      const state = await this.#fence.get(input.seriesKey);
      if (admit.outcome === 'applied') {
        return {
          decision: 'apply',
          command: admit.command,
          state: state!,
          duplicateReplay: true,
        };
      }
      return {
        decision: 'reject',
        command: admit.command,
        reason: 'SERIES_TERMINAL',
        state: state ?? undefined,
        duplicateReplay: true,
      };
    }

    if (options?.afterAdmit) {
      await options.afterAdmit();
    }

    return this.#adjudicateAdmitted(admit.command);
  }

  /**
   * Expiry barrier (TD-13): forfeit only when no eligible pending admitted
   * command remains before the deadline watermark.
   */
  async canSafelyForfeit(
    seriesKey: string,
    idleDeadlineAt: Date,
  ): Promise<{ allowed: boolean; blocking: AdmittedCommand[] }> {
    const state = await this.#fence.get(seriesKey);
    if (state?.status === 'COMPLETED' || state?.status === 'FORFEITED') {
      return { allowed: false, blocking: [] };
    }
    const blocking = await this.#journal.listEligiblePending(
      seriesKey,
      idleDeadlineAt,
    );
    return { allowed: blocking.length === 0, blocking };
  }

  /**
   * Weekly settlement barrier (TD-13): do not finalize while eligible
   * pre-cutoff admissions remain pending across the settlement set.
   */
  async canSafelyFinalizeWeekly(
    seriesKeys: string[],
    cutoffExclusive: Date,
  ): Promise<{ allowed: boolean; blocking: AdmittedCommand[] }> {
    const blocking = await this.#journal.listEligiblePendingForSeries(
      seriesKeys,
      cutoffExclusive,
    );
    return { allowed: blocking.length === 0, blocking };
  }

  /**
   * Attempt inactivity forfeiture only when barrier allows.
   */
  async tryForfeitForInactivity(
    seriesKey: string,
  ): Promise<
    | { ok: true; state: SeriesFenceState }
    | { ok: false; reason: 'BLOCKED_PENDING' | 'ALREADY_TERMINAL'; blocking?: AdmittedCommand[] }
  > {
    const state = await this.#fence.get(seriesKey);
    if (!state) throw new Error(`missing series ${seriesKey}`);
    if (state.status === 'COMPLETED' || state.status === 'FORFEITED') {
      return { ok: false, reason: 'ALREADY_TERMINAL' };
    }
    const barrier = await this.canSafelyForfeit(seriesKey, state.idleDeadlineAt);
    if (!barrier.allowed) {
      return { ok: false, reason: 'BLOCKED_PENDING', blocking: barrier.blocking };
    }
    const mutated = await this.#fence.mutate(seriesKey, (current) => {
      if (current.status === 'COMPLETED' || current.status === 'FORFEITED') {
        return { ok: false, reason: 'ALREADY_TERMINAL', current };
      }
      return {
        ok: true,
        next: { ...current, status: 'FORFEITED', resultsPublished: false },
      };
    });
    if (!mutated.ok) {
      return { ok: false, reason: 'ALREADY_TERMINAL' };
    }
    return { ok: true, state: mutated.state };
  }

  async #adjudicateAdmitted(
    command: AdmittedCommand,
  ): Promise<AdjudicationResult> {
    return this.#withAdmissionLock(command.admissionId, async () => {
      const existingOutcome = await this.#journal.getOutcome(command.admissionId);
      if (existingOutcome === 'applied') {
        const state = await this.#fence.get(command.seriesKey);
        return {
          decision: 'apply' as const,
          command,
          state: state!,
          duplicateReplay: true,
        };
      }
      if (existingOutcome === 'rejected') {
        const state = await this.#fence.get(command.seriesKey);
        return {
          decision: 'reject' as const,
          command,
          reason: 'SERIES_TERMINAL' as const,
          state: state ?? undefined,
          duplicateReplay: true,
        };
      }
      return this.#evaluatePending(command);
    });
  }

  async #evaluatePending(
    command: AdmittedCommand,
  ): Promise<AdjudicationResult> {
    const mutated = await this.#fence.mutate(command.seriesKey, (current) => {
      if (current.lastAppliedAdmissionId === command.admissionId) {
        return { ok: true, next: current };
      }

      if (current.status === 'COMPLETED' || current.status === 'FORFEITED') {
        return { ok: false, reason: 'SERIES_TERMINAL', current };
      }

      const t = command.trustedReceivedAt;
      if (!isTimely(t, current.idleDeadlineAt)) {
        return { ok: false, reason: 'IDLE_EXPIRED', current };
      }
      if (current.hardCutoffAt && !isTimely(t, current.hardCutoffAt)) {
        return { ok: false, reason: 'HARD_CUTOFF_EXPIRED', current };
      }

      if (command.commandType === 'device_handoff') {
        // Handoff alone must not refresh inactivity (Q04 / TD-05).
        return {
          ok: true,
          next: {
            ...current,
            writerGeneration: current.writerGeneration + 1,
            lastAppliedAdmissionId: command.admissionId,
          },
        };
      }

      if (
        command.writerGeneration !== undefined &&
        command.writerGeneration !== current.writerGeneration
      ) {
        return { ok: false, reason: 'NOT_ACTIVE_WRITER', current };
      }

      if (command.commandType === 'thinking_extension') {
        const remaining = current.idleDeadlineAt.getTime() - t.getTime();
        if (remaining <= 0 || remaining > 60_000) {
          return { ok: false, reason: 'EXTENSION_UNAVAILABLE', current };
        }
        return {
          ok: true,
          next: {
            ...current,
            idleDeadlineAt: new Date(current.idleDeadlineAt.getTime() + 60_000),
            lastAppliedAdmissionId: command.admissionId,
          },
        };
      }

      if (command.commandType === 'move') {
        if (
          command.expectedBoardRevision === undefined ||
          command.expectedBoardRevision !== current.boardRevision
        ) {
          return { ok: false, reason: 'STATE_CONFLICT', current };
        }
        if (
          command.writerGeneration === undefined ||
          command.writerGeneration !== current.writerGeneration
        ) {
          return { ok: false, reason: 'NOT_ACTIVE_WRITER', current };
        }
        if (!this.#moveEffect) {
          return { ok: false, reason: 'MOVE_REQUIRES_SERVER_EFFECT', current };
        }
        const effect = this.#moveEffect({
          seriesKey: command.seriesKey,
          playerId: command.playerId,
          commandType: command.commandType,
          idempotencyKey: command.idempotencyKey,
          payloadHash: command.payloadHash,
          expectedBoardRevision: command.expectedBoardRevision,
          writerGeneration: command.writerGeneration,
        });
        if (!effect) {
          return { ok: false, reason: 'MOVE_REQUIRES_SERVER_EFFECT', current };
        }
        const nextScore = current.score + effect.scoreDelta;
        if (!Number.isSafeInteger(nextScore) || nextScore < 0) {
          return { ok: false, reason: 'CLIENT_SCORE_REJECTED', current };
        }
        const nextRevision = current.boardRevision + 1;
        const nextIdle = idleDeadlineFrom(t, 300);
        // Server-derived completion may mark COMPLETED; four-category
        // leaderboard publish remains NOT_RUN (resultsPublished stays false).
        return {
          ok: true,
          next: {
            ...current,
            boardRevision: nextRevision,
            score: nextScore,
            idleDeadlineAt: nextIdle,
            status: effect.completesSubgame ? 'COMPLETED' : current.status,
            resultsPublished: false,
            lastAppliedAdmissionId: command.admissionId,
          },
        };
      }

      if (command.commandType === 'abandon') {
        return {
          ok: true,
          next: {
            ...current,
            status: 'FORFEITED',
            resultsPublished: false,
            lastAppliedAdmissionId: command.admissionId,
          },
        };
      }

      // start / advance: Phase A treats as no board mutation beyond deadline policy.
      if (command.commandType === 'advance') {
        return {
          ok: true,
          next: {
            ...current,
            idleDeadlineAt: idleDeadlineFrom(t, 300),
            status: 'ACTIVE',
            lastAppliedAdmissionId: command.admissionId,
          },
        };
      }

      return {
        ok: true,
        next: { ...current, lastAppliedAdmissionId: command.admissionId },
      };
    });

    if (!mutated.ok) {
      if (mutated.state.lastAppliedAdmissionId === command.admissionId) {
        await this.#journal.markOutcome(command.admissionId, 'applied');
        return {
          decision: 'apply',
          command,
          state: mutated.state,
          duplicateReplay: true,
        };
      }
      await this.#journal.markOutcome(command.admissionId, 'rejected');
      return {
        decision: 'reject',
        command,
        reason: mutated.reason as Extract<
          AdjudicationResult,
          { decision: 'reject' }
        >['reason'],
        state: mutated.state,
      };
    }

    const won = await this.#journal.markOutcome(command.admissionId, 'applied');
    if (!won) {
      const state = await this.#fence.get(command.seriesKey);
      const outcome = await this.#journal.getOutcome(command.admissionId);
      if (outcome === 'applied' && state) {
        return {
          decision: 'apply',
          command,
          state,
          duplicateReplay: true,
        };
      }
    }
    return { decision: 'apply', command, state: mutated.state };
  }

  async #withAdmissionLock<T>(
    admissionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.#admissionLocks.get(admissionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#admissionLocks.set(
      admissionId,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  #mapAdmitFailure(admit: Exclude<AdmitResult, { ok: true }>): AdjudicationResult {
    if (admit.reason === 'INGRESS_UNAVAILABLE') {
      return { decision: 'unavailable', reason: 'INGRESS_UNAVAILABLE' };
    }
    return {
      decision: 'reject',
      command: admit.existing,
      reason: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
    };
  }
}
