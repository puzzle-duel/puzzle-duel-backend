import type { IngressClock } from './clock.mts';
import { SystemUtcClock } from './clock.mts';
import type { AdmissionJournal } from './journal.mts';
import { PostgresAdmissionJournal } from './postgres-journal.mts';
import type { SeriesFenceStore } from './series-fence.mts';
import {
  MemorySeriesFenceStore,
  PostgresSeriesFenceStore,
} from './series-fence.mts';
import {
  applyThinkingExtension,
  idleDeadlineFrom,
  isTimely,
  type AdmittedCommand,
  type AdmitCommandInput,
  type AdmitResult,
  type SeriesFenceState,
  type ServerMoveEffectResolver,
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
      command?: AdmittedCommand;
      reason:
        | 'IDLE_EXPIRED'
        | 'HARD_CUTOFF_EXPIRED'
        | 'SERIES_TERMINAL'
        | 'INGRESS_UNAVAILABLE'
        | 'IDEMPOTENCY_PAYLOAD_CONFLICT'
        | 'STATE_CONFLICT'
        | 'NOT_ACTIVE_WRITER'
        | 'EXTENSION_UNAVAILABLE'
        | 'UNTRUSTED_SCORE_AUTHORITY'
        | 'UNTRUSTED_COMPLETION_AUTHORITY'
        | 'MOVE_EFFECT_UNAVAILABLE';
      state?: SeriesFenceState;
      duplicateReplay?: boolean;
    }
  | { decision: 'unavailable'; reason: 'INGRESS_UNAVAILABLE' };

export interface SeriesCommandArbiterOptions {
  /**
   * Test-only / internal resolver for move score effects.
   * Production Phase A without gameplay must omit this — moves then reject
   * with MOVE_EFFECT_UNAVAILABLE rather than trusting client fields.
   */
  resolveMoveEffect?: ServerMoveEffectResolver;
  /**
   * Authoritative trusted clock for inactivity expiry (P1-05).
   * Must be the same ControllableClock used by the journal in tests.
   */
  clock?: IngressClock;
}

export type ForfeitAttemptResult =
  | { ok: true; state: SeriesFenceState }
  | {
      ok: false;
      reason:
        | 'BLOCKED_PENDING'
        | 'ALREADY_TERMINAL'
        | 'NOT_EXPIRED'
        | 'FORFEIT_UNAVAILABLE';
      blocking?: AdmittedCommand[];
      state?: SeriesFenceState;
    };

/**
 * Per-series arbiter: admit first (durable trusted time), then evaluate
 * eligibility against deadlines using the original trustedReceivedAt —
 * never Date.now() at later lock acquisition (contract §4 / TD-02/TD-03).
 */
export class SeriesCommandArbiter {
  readonly #journal: AdmissionJournal;
  readonly #fence: SeriesFenceStore;
  readonly #resolveMoveEffect: ServerMoveEffectResolver | null;
  readonly #clock: IngressClock;
  /** Serialize adjudication per admissionId (duplicate concurrent retries). */
  readonly #admissionLocks = new Map<string, Promise<void>>();

  constructor(
    journal: AdmissionJournal,
    fence: SeriesFenceStore,
    options?: SeriesCommandArbiterOptions | ServerMoveEffectResolver,
  ) {
    this.#journal = journal;
    this.#fence = fence;
    // Back-compat: third arg may be the resolver function directly (tests).
    if (typeof options === 'function') {
      this.#resolveMoveEffect = options;
      this.#clock = new SystemUtcClock();
    } else {
      this.#resolveMoveEffect = options?.resolveMoveEffect ?? null;
      this.#clock = options?.clock ?? new SystemUtcClock();
    }
  }

  async admitAndEvaluate(
    input: AdmitCommandInput,
    options?: {
      /** Simulated delay between admit and lock/adjudication. */
      afterAdmit?: () => Promise<void>;
    },
  ): Promise<AdjudicationResult> {
    // P1-04: reject unverified client score/completion before durable admit.
    if (input.scoreDelta !== undefined) {
      return {
        decision: 'reject',
        reason: 'UNTRUSTED_SCORE_AUTHORITY',
      };
    }
    if (input.completesSeries !== undefined) {
      return {
        decision: 'reject',
        reason: 'UNTRUSTED_COMPLETION_AUTHORITY',
      };
    }

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

    return this.#adjudicateAdmitted(admit.command, input);
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
   * Lists pending journal rows for a caller-supplied series set.
   * This does not take the settlement lock, authorize F2-B publications,
   * or commit an immutable snapshot. Weekly FINAL is
   * F2CRankingService.finalizeWeek.
   */
  async canSafelyFinalizeWeekly(
    seriesKeys: string[],
    cutoffExclusive: Date,
  ): Promise<{ allowed: boolean; blocking: AdmittedCommand[] }> {
    const sorted = [...seriesKeys].sort();
    const blocking = await this.#journal.listEligiblePendingForSeries(
      sorted,
      cutoffExclusive,
    );
    return { allowed: blocking.length === 0, blocking };
  }

  /**
   * Attempt inactivity forfeiture only when barrier allows.
   * P1-03: pending check and FORFEITED transition share one locking protocol.
   * P1-05: trusted clock must show idle deadline reached (equality = expired);
   *         sampled under the same lock/TX as pending count + FORFEITED write.
   */
  async tryForfeitForInactivity(
    seriesKey: string,
    options?: { beforeLockedBarrier?: () => Promise<void> },
  ): Promise<ForfeitAttemptResult> {
    if (this.#fence instanceof PostgresSeriesFenceStore) {
      if (!(this.#journal instanceof PostgresAdmissionJournal)) {
        throw new Error('postgres fence requires postgres journal');
      }
      const journal = this.#journal;
      const result = await this.#fence.tryForfeitAtomically(
        seriesKey,
        (db, idleDeadlineAt) =>
          journal.countEligiblePendingOn(db, seriesKey, idleDeadlineAt),
        this.#clock,
        { beforeLockedBarrier: options?.beforeLockedBarrier },
      );
      if (result.ok) return { ok: true, state: result.state };
      if (result.reason === 'BLOCKED_PENDING') {
        const state = result.state ?? (await this.#fence.get(seriesKey));
        const blocking = state
          ? await this.#journal.listEligiblePending(
              seriesKey,
              state.idleDeadlineAt,
            )
          : [];
        return {
          ok: false,
          reason: 'BLOCKED_PENDING',
          blocking,
          state: state ?? undefined,
        };
      }
      if (result.reason === 'NOT_EXPIRED') {
        return {
          ok: false,
          reason: 'NOT_EXPIRED',
          state: result.state,
        };
      }
      return { ok: false, reason: 'ALREADY_TERMINAL', state: result.state };
    }

    // Memory path: hold fence series lock across time + pending check + forfeit.
    if (this.#fence instanceof MemorySeriesFenceStore) {
      if (options?.beforeLockedBarrier) {
        await options.beforeLockedBarrier();
      }
      return this.#fence.withSeriesLock(seriesKey, async () => {
        const state = await this.#fence.get(seriesKey);
        if (!state) throw new Error(`missing series ${seriesKey}`);
        if (state.status === 'COMPLETED' || state.status === 'FORFEITED') {
          return {
            ok: false as const,
            reason: 'ALREADY_TERMINAL' as const,
            state,
          };
        }
        const trustedNow = this.#clock.now();
        if (isTimely(trustedNow, state.idleDeadlineAt)) {
          return {
            ok: false as const,
            reason: 'NOT_EXPIRED' as const,
            state,
          };
        }
        const blocking = await this.#journal.listEligiblePending(
          seriesKey,
          state.idleDeadlineAt,
        );
        if (blocking.length > 0) {
          return {
            ok: false as const,
            reason: 'BLOCKED_PENDING' as const,
            blocking,
            state,
          };
        }
        // Put under held withSeriesLock (mutate is not reentrant).
        const next: SeriesFenceState = {
          ...state,
          status: 'FORFEITED',
          resultsPublished: false,
        };
        await this.#fence.put(next);
        return { ok: true as const, state: next };
      });
    }

    // P1-05: generic fallback without atomic trusted-time + pending + forfeit
    // is unsafe — fail closed (no mutation).
    return {
      ok: false,
      reason: 'FORFEIT_UNAVAILABLE',
      state: (await this.#fence.get(seriesKey)) ?? undefined,
    };
  }

  async #adjudicateAdmitted(
    command: AdmittedCommand,
    originalInput: AdmitCommandInput,
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
      return this.#evaluatePending(command, originalInput);
    });
  }

  async #evaluatePending(
    command: AdmittedCommand,
    originalInput: AdmitCommandInput,
  ): Promise<AdjudicationResult> {
    let moveEffect: ReturnType<ServerMoveEffectResolver> | undefined;
    if (command.commandType === 'move') {
      if (!this.#resolveMoveEffect) {
        await this.#journal.markOutcome(command.admissionId, 'rejected');
        return {
          decision: 'reject',
          command,
          reason: 'MOVE_EFFECT_UNAVAILABLE',
        };
      }
      moveEffect = this.#resolveMoveEffect(originalInput);
      if (!moveEffect) {
        await this.#journal.markOutcome(command.admissionId, 'rejected');
        return {
          decision: 'reject',
          command,
          reason: 'MOVE_EFFECT_UNAVAILABLE',
        };
      }
      if (
        !Number.isSafeInteger(moveEffect.scoreDelta) ||
        moveEffect.scoreDelta < 0
      ) {
        await this.#journal.markOutcome(command.admissionId, 'rejected');
        return {
          decision: 'reject',
          command,
          reason: 'UNTRUSTED_SCORE_AUTHORITY',
        };
      }
    }

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
        // P1-01: one successful extension per six-game series.
        if (current.thinkingExtensionConsumed) {
          return { ok: false, reason: 'EXTENSION_UNAVAILABLE', current };
        }
        const remaining = current.idleDeadlineAt.getTime() - t.getTime();
        // P1-02: use applyThinkingExtension (window + hard-cutoff cap).
        const extended = applyThinkingExtension(
          current.idleDeadlineAt,
          remaining,
          current.hardCutoffAt,
        );
        if (!extended) {
          return { ok: false, reason: 'EXTENSION_UNAVAILABLE', current };
        }
        // If hard cutoff already passed relative to receipt, reject.
        if (current.hardCutoffAt && !isTimely(t, current.hardCutoffAt)) {
          return { ok: false, reason: 'HARD_CUTOFF_EXPIRED', current };
        }
        return {
          ok: true,
          next: {
            ...current,
            idleDeadlineAt: extended,
            thinkingExtensionConsumed: true,
            lastAppliedAdmissionId: command.admissionId,
          },
        };
      }

      if (command.commandType === 'move') {
        if (
          command.expectedBoardRevision !== undefined &&
          command.expectedBoardRevision !== current.boardRevision
        ) {
          return { ok: false, reason: 'STATE_CONFLICT', current };
        }
        const effect = moveEffect!;
        const nextScore = current.score + effect.scoreDelta;
        if (!Number.isSafeInteger(nextScore) || nextScore < 0) {
          return { ok: false, reason: 'UNTRUSTED_SCORE_AUTHORITY', current };
        }
        const nextRevision = current.boardRevision + 1;
        const nextIdle = idleDeadlineFrom(t, 300);
        // One ended subgame is not six-game completion. AWAIT_ADVANCE is the
        // existing nonterminal status. Publication stays with the F2-B H1 path.
        return {
          ok: true,
          next: {
            ...current,
            boardRevision: nextRevision,
            score: nextScore,
            idleDeadlineAt: nextIdle,
            status: effect.completesSubgame ? 'AWAIT_ADVANCE' : current.status,
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

export type { ServerMoveEffectResolver, ServerDerivedMoveEffect } from './types.mts';
