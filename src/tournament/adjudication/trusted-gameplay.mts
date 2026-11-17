import {
  applyMove,
  replayCore001V3,
  stateHashV3,
  stateToJson,
  type GameState,
  type Move,
  type MoveApplied,
} from '../../engine/core001v3/index.mts';
import type { IngressClock } from '../ingress/clock.mts';
import type { AdmissionJournal } from '../ingress/journal.mts';
import type { SeriesFenceStore } from '../ingress/series-fence.mts';
import {
  idleDeadlineFrom,
  isTimely,
  type AdmitCommandInput,
  type SeriesFenceState,
} from '../ingress/types.mts';
import {
  validateUntrustedClientCommand,
  type UntrustedClientCommand,
  type UntrustedMovePayload,
} from './client-commands.mts';
import type {
  AcceptedMoveLedger,
  AuthoritativeGameSnapshot,
  AuthoritativeSnapshotStore,
} from './move-ledger.mts';
import type { TrustedChallengeStore } from './trusted-challenge.mts';

export type TrustedGameplayDecision =
  | {
      decision: 'apply';
      score: number;
      scoreDelta: number;
      boardRevision: number;
      stateHash: string;
      terminal: boolean;
      terminalReason: string | null;
      subgameOrdinal: number;
      awaitAdvance: boolean;
      duplicateReplay?: boolean;
      fence: SeriesFenceState;
    }
  | {
      decision: 'reject';
      reason:
        | 'FORBIDDEN_AUTHORITY_FIELD'
        | 'MALFORMED_COMMAND'
        | 'MISSING_MOVE_GUARDS'
        | 'CHALLENGE_NOT_FOUND'
        | 'CHALLENGE_BINDING_MISMATCH'
        | 'IDLE_EXPIRED'
        | 'HARD_CUTOFF_EXPIRED'
        | 'SERIES_TERMINAL'
        | 'STATE_CONFLICT'
        | 'NOT_ACTIVE_WRITER'
        | 'MOVE_REJECTED'
        | 'MOVE_UNSAFE'
        | 'REPLAY_MISMATCH'
        | 'CHECKPOINT_OVERWRITE_REJECTED'
        | 'POST_TERMINAL'
        | 'INGRESS_UNAVAILABLE'
        | 'IDEMPOTENCY_PAYLOAD_CONFLICT'
        | 'ADVANCE_NOT_ELIGIBLE'
        | 'EXTENSION_UNAVAILABLE';
      fence?: SeriesFenceState;
      checkpointUnchanged?: boolean;
      ledgerUnchanged?: boolean;
    }
  | { decision: 'unavailable'; reason: 'INGRESS_UNAVAILABLE' };

export interface TrustedGameplayServiceOptions {
  journal: AdmissionJournal;
  fence: SeriesFenceStore;
  challenges: TrustedChallengeStore;
  ledger: AcceptedMoveLedger;
  snapshots: AuthoritativeSnapshotStore;
  clock: IngressClock;
  /**
   * Active subgame ordinal for the series (1..6). Stage E keeps this
   * server-side; clients cannot choose ordinal.
   */
  resolveActiveOrdinal: (seriesKey: string, playerId: string) => Promise<number>;
}

/**
 * Trusted ranked move path: admission → fence → challenge → ledger replay →
 * applyMove → atomic persist. Client score/completion/checkpoint never authorize.
 */
export class TrustedGameplayService {
  readonly #journal: AdmissionJournal;
  readonly #fence: SeriesFenceStore;
  readonly #challenges: TrustedChallengeStore;
  readonly #ledger: AcceptedMoveLedger;
  readonly #snapshots: AuthoritativeSnapshotStore;
  readonly #clock: IngressClock;
  readonly #resolveActiveOrdinal: (
    seriesKey: string,
    playerId: string,
  ) => Promise<number>;
  readonly #admissionLocks = new Map<string, Promise<void>>();

  constructor(options: TrustedGameplayServiceOptions) {
    this.#journal = options.journal;
    this.#fence = options.fence;
    this.#challenges = options.challenges;
    this.#ledger = options.ledger;
    this.#snapshots = options.snapshots;
    this.#clock = options.clock;
    this.#resolveActiveOrdinal = options.resolveActiveOrdinal;
  }

  /**
   * V3-48 / adversarial entry: any client checkpoint replacement attempt.
   * Always rejects; trusted snapshot and ledger remain unchanged.
   */
  async rejectCheckpointOverwrite(args: {
    seriesKey: string;
    playerId: string;
    subgameOrdinal: number;
    attemptedCheckpoint: unknown;
    forgedStateHash?: string;
  }): Promise<TrustedGameplayDecision> {
    const before = await this.#snapshots.get(
      args.seriesKey,
      args.playerId,
      args.subgameOrdinal,
    );
    const watermark = await this.#ledger.latestWatermark(
      args.seriesKey,
      args.playerId,
      args.subgameOrdinal,
    );
    const fence = await this.#fence.get(args.seriesKey);
    // Touch args so callers can assert they were considered and ignored.
    void args.attemptedCheckpoint;
    void args.forgedStateHash;
    const after = await this.#snapshots.get(
      args.seriesKey,
      args.playerId,
      args.subgameOrdinal,
    );
    const watermarkAfter = await this.#ledger.latestWatermark(
      args.seriesKey,
      args.playerId,
      args.subgameOrdinal,
    );
    const unchanged =
      JSON.stringify(before) === JSON.stringify(after) &&
      JSON.stringify(watermark) === JSON.stringify(watermarkAfter);
    return {
      decision: 'reject',
      reason: 'CHECKPOINT_OVERWRITE_REJECTED',
      fence: fence ?? undefined,
      checkpointUnchanged: unchanged,
      ledgerUnchanged: unchanged,
    };
  }

  async handleClientCommand(raw: unknown): Promise<TrustedGameplayDecision> {
    const validated = validateUntrustedClientCommand(raw);
    if (!validated.ok) {
      return { decision: 'reject', reason: validated.reason };
    }
    const command = validated.command;
    if (command.commandType === 'checkpoint_overwrite' || command.attemptedCheckpoint) {
      const ordinal = await this.#resolveActiveOrdinal(command.seriesKey, command.playerId);
      return this.rejectCheckpointOverwrite({
        seriesKey: command.seriesKey,
        playerId: command.playerId,
        subgameOrdinal: ordinal,
        attemptedCheckpoint: command.attemptedCheckpoint ?? command,
      });
    }

    if (command.commandType === 'move') {
      return this.#handleMove(command);
    }

    // Non-move commands reuse Phase A admission+fence without client score authority.
    return this.#handleNonMove(command);
  }

  async #handleMove(command: UntrustedClientCommand): Promise<TrustedGameplayDecision> {
    const move = command.move!;
    const admitInput: AdmitCommandInput = {
      seriesKey: command.seriesKey,
      playerId: command.playerId,
      commandType: 'move',
      idempotencyKey: command.idempotencyKey,
      payloadHash: command.payloadHash,
      expectedBoardRevision: move.expectedBoardRevision,
      writerGeneration: move.writerGeneration,
      // Explicitly absent — never accept client score/completion.
    };

    const admit = await this.#journal.admit(admitInput);
    if (!admit.ok) {
      if (admit.reason === 'INGRESS_UNAVAILABLE') {
        return { decision: 'unavailable', reason: 'INGRESS_UNAVAILABLE' };
      }
      return {
        decision: 'reject',
        reason: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
      };
    }

    if (admit.command.status === 'duplicate' && admit.outcome !== 'pending') {
      const fence = await this.#fence.get(command.seriesKey);
      if (admit.outcome === 'applied' && fence) {
        const ordinal = await this.#resolveActiveOrdinal(command.seriesKey, command.playerId);
        const snap = await this.#snapshots.get(command.seriesKey, command.playerId, ordinal);
        return {
          decision: 'apply',
          score: fence.score,
          scoreDelta: 0,
          boardRevision: fence.boardRevision,
          stateHash: snap?.stateHash ?? '',
          terminal: snap?.status === 'ended',
          terminalReason: snap?.terminalReason ?? null,
          subgameOrdinal: ordinal,
          awaitAdvance: fence.status === 'AWAIT_ADVANCE',
          duplicateReplay: true,
          fence,
        };
      }
      return {
        decision: 'reject',
        reason: 'SERIES_TERMINAL',
        fence: fence ?? undefined,
      };
    }

    return this.#withAdmissionLock(admit.command.admissionId, async () => {
      const existing = await this.#journal.getOutcome(admit.command.admissionId);
      if (existing === 'applied') {
        const fence = (await this.#fence.get(command.seriesKey))!;
        const ordinal = await this.#resolveActiveOrdinal(command.seriesKey, command.playerId);
        const snap = await this.#snapshots.get(command.seriesKey, command.playerId, ordinal);
        return {
          decision: 'apply' as const,
          score: fence.score,
          scoreDelta: 0,
          boardRevision: fence.boardRevision,
          stateHash: snap?.stateHash ?? '',
          terminal: snap?.status === 'ended',
          terminalReason: snap?.terminalReason ?? null,
          subgameOrdinal: ordinal,
          awaitAdvance: fence.status === 'AWAIT_ADVANCE',
          duplicateReplay: true,
          fence,
        };
      }
      if (existing === 'rejected') {
        const fence = await this.#fence.get(command.seriesKey);
        return {
          decision: 'reject' as const,
          reason: 'SERIES_TERMINAL' as const,
          fence: fence ?? undefined,
        };
      }
      return this.#adjudicateMove(command, move, admit.command.admissionId, admit.command.admissionSeq, admit.command.trustedReceivedAt);
    });
  }

  async #adjudicateMove(
    command: UntrustedClientCommand,
    move: UntrustedMovePayload,
    admissionId: string,
    admissionSeq: number,
    trustedReceivedAt: Date,
  ): Promise<TrustedGameplayDecision> {
    const ordinal = await this.#resolveActiveOrdinal(command.seriesKey, command.playerId);
    const challenge = await this.#challenges.get(
      command.seriesKey,
      command.playerId,
      ordinal,
    );
    if (!challenge) {
      await this.#journal.markOutcome(admissionId, 'rejected');
      return { decision: 'reject', reason: 'CHALLENGE_NOT_FOUND' };
    }
    if (challenge.playerId !== command.playerId || challenge.seriesKey !== command.seriesKey) {
      await this.#journal.markOutcome(admissionId, 'rejected');
      return { decision: 'reject', reason: 'CHALLENGE_BINDING_MISMATCH' };
    }

    const pre = await this.#fence.get(command.seriesKey);
    if (!pre) {
      await this.#journal.markOutcome(admissionId, 'rejected');
      return { decision: 'reject', reason: 'SERIES_TERMINAL' };
    }
    if (pre.lastAppliedAdmissionId === admissionId) {
      const snap = await this.#snapshots.get(command.seriesKey, command.playerId, ordinal);
      return {
        decision: 'apply',
        score: pre.score,
        scoreDelta: 0,
        boardRevision: pre.boardRevision,
        stateHash: snap?.stateHash ?? '',
        terminal: snap?.status === 'ended',
        terminalReason: snap?.terminalReason ?? null,
        subgameOrdinal: ordinal,
        awaitAdvance: pre.status === 'AWAIT_ADVANCE',
        duplicateReplay: true,
        fence: pre,
      };
    }
    if (pre.status === 'COMPLETED' || pre.status === 'FORFEITED') {
      await this.#journal.markOutcome(admissionId, 'rejected');
      return { decision: 'reject', reason: 'SERIES_TERMINAL', fence: pre, checkpointUnchanged: true, ledgerUnchanged: true };
    }
    if (pre.status === 'AWAIT_ADVANCE') {
      await this.#journal.markOutcome(admissionId, 'rejected');
      return { decision: 'reject', reason: 'POST_TERMINAL', fence: pre, checkpointUnchanged: true, ledgerUnchanged: true };
    }
    if (!isTimely(trustedReceivedAt, pre.idleDeadlineAt)) {
      await this.#journal.markOutcome(admissionId, 'rejected');
      return { decision: 'reject', reason: 'IDLE_EXPIRED', fence: pre, checkpointUnchanged: true, ledgerUnchanged: true };
    }
    if (pre.hardCutoffAt && !isTimely(trustedReceivedAt, pre.hardCutoffAt)) {
      await this.#journal.markOutcome(admissionId, 'rejected');
      return { decision: 'reject', reason: 'HARD_CUTOFF_EXPIRED', fence: pre, checkpointUnchanged: true, ledgerUnchanged: true };
    }
    if (move.writerGeneration !== pre.writerGeneration) {
      await this.#journal.markOutcome(admissionId, 'rejected');
      return { decision: 'reject', reason: 'NOT_ACTIVE_WRITER', fence: pre, checkpointUnchanged: true, ledgerUnchanged: true };
    }
    if (move.expectedBoardRevision !== pre.boardRevision) {
      await this.#journal.markOutcome(admissionId, 'rejected');
      return { decision: 'reject', reason: 'STATE_CONFLICT', fence: pre, checkpointUnchanged: true, ledgerUnchanged: true };
    }

    if (move.offerIndex !== 0 && move.offerIndex !== 1 && move.offerIndex !== 2) {
      await this.#journal.markOutcome(admissionId, 'rejected');
      return { decision: 'reject', reason: 'MOVE_UNSAFE', ledgerUnchanged: true };
    }
    const engineMove: Move = {
      offerIndex: move.offerIndex,
      tap: { row: move.tap[0], column: move.tap[1] },
    };

    const history = await this.#ledger.list(command.seriesKey, command.playerId, ordinal);
    const replayed = replayCore001V3({
      initialState: stateToJson(challenge.initialState),
      // Wire taps are [row, column] arrays (canonical v3 move JSON).
      moves: history.map((h) => ({
        offerIndex: h.move.offerIndex,
        tap: [h.move.tap.row, h.move.tap.column],
      })),
    });
    if (!replayed.ok) {
      await this.#journal.markOutcome(admissionId, 'rejected');
      return { decision: 'reject', reason: 'REPLAY_MISMATCH' };
    }

    const snap = await this.#snapshots.get(command.seriesKey, command.playerId, ordinal);
    if (snap && snap.stateHash !== replayed.stateHash) {
      await this.#journal.markOutcome(admissionId, 'rejected');
      return { decision: 'reject', reason: 'REPLAY_MISMATCH' };
    }

    const beforeHash = replayed.stateHash;
    if (replayed.finalState.status === 'ended') {
      await this.#journal.markOutcome(admissionId, 'rejected');
      return { decision: 'reject', reason: 'POST_TERMINAL' };
    }

    const applied = applyMove(replayed.finalState, engineMove);
    if (applied.kind === 'rejected') {
      await this.#journal.markOutcome(admissionId, 'rejected');
      return { decision: 'reject', reason: 'MOVE_REJECTED', ledgerUnchanged: true };
    }
    if (applied.kind === 'unsafe') {
      await this.#journal.markOutcome(admissionId, 'rejected');
      return { decision: 'reject', reason: 'MOVE_UNSAFE', ledgerUnchanged: true };
    }

    const moveApplied = applied as MoveApplied;
    const afterHash = stateHashV3(moveApplied.finalState);
    const terminal = moveApplied.finalState.status === 'ended';
    const terminalReason = moveApplied.finalState.terminalReason;

    // Atomic-ish memory unit: fence + ledger + snapshot + outcome.
    // PostgreSQL path uses a single transaction in PostgresTrustedUnitOfWork.
    let nextFence: SeriesFenceState | null = null;
    try {
      const commit = await this.#fence.mutate(command.seriesKey, (current) => {
        if (current.lastAppliedAdmissionId === admissionId) {
          return { ok: true, next: current };
        }
        if (move.expectedBoardRevision !== current.boardRevision) {
          return { ok: false, reason: 'STATE_CONFLICT', current };
        }
        if (move.writerGeneration !== current.writerGeneration) {
          return { ok: false, reason: 'NOT_ACTIVE_WRITER', current };
        }
        const nextScore = current.score + moveApplied.scoreDelta;
        if (!Number.isSafeInteger(nextScore) || nextScore < 0) {
          return { ok: false, reason: 'MOVE_UNSAFE', current };
        }
        nextFence = {
          ...current,
          boardRevision: current.boardRevision + 1,
          score: nextScore,
          idleDeadlineAt: idleDeadlineFrom(trustedReceivedAt, 300),
          status: terminal ? 'AWAIT_ADVANCE' : current.status,
          // Never publish from client; four-category publish remains NOT_RUN.
          resultsPublished: false,
          lastAppliedAdmissionId: admissionId,
        };
        return { ok: true, next: nextFence };
      });

      if (!commit.ok) {
        await this.#journal.markOutcome(admissionId, 'rejected');
        return {
          decision: 'reject',
          reason: commit.reason as Extract<TrustedGameplayDecision, { decision: 'reject' }>['reason'],
          fence: commit.state,
          ledgerUnchanged: true,
          checkpointUnchanged: true,
        };
      }

      await this.#ledger.append({
        seriesKey: command.seriesKey,
        playerId: command.playerId,
        subgameOrdinal: ordinal,
        challengeId: challenge.challengeId,
        admissionId,
        admissionSeq,
        boardRevisionAfter: commit.state.boardRevision,
        move: engineMove,
        scoreDelta: moveApplied.scoreDelta,
        scoreAfter: commit.state.score,
        stateHashBefore: beforeHash,
        stateHashAfter: afterHash,
        rulesVersion: 'core-001.v3',
        trustedReceivedAt,
        terminalAfter: terminal,
        terminalReason,
      });

      const snapshot: AuthoritativeGameSnapshot = {
        seriesKey: command.seriesKey,
        playerId: command.playerId,
        subgameOrdinal: ordinal,
        challengeId: challenge.challengeId,
        boardRevision: commit.state.boardRevision,
        moveCursor: history.length + 1,
        stateHash: afterHash,
        score: commit.state.score,
        status: terminal ? 'ended' : 'in_progress',
        terminalReason,
        state: moveApplied.finalState,
        ledgerAdmissionSeq: admissionSeq,
        writerGeneration: commit.state.writerGeneration,
        producedByAdmissionId: admissionId,
      };
      await this.#snapshots.put(snapshot);
      await this.#journal.markOutcome(admissionId, 'applied');

      return {
        decision: 'apply',
        score: commit.state.score,
        scoreDelta: moveApplied.scoreDelta,
        boardRevision: commit.state.boardRevision,
        stateHash: afterHash,
        terminal,
        terminalReason,
        subgameOrdinal: ordinal,
        awaitAdvance: terminal,
        fence: commit.state,
      };
    } catch (error) {
      // Best-effort reject if append failed after fence mutation — tests assert
      // memory stores stay consistent; Postgres UoW rolls back as one TX.
      await this.#journal.markOutcome(admissionId, 'rejected');
      throw error;
    }
  }

  async #handleNonMove(command: UntrustedClientCommand): Promise<TrustedGameplayDecision> {
    if (command.commandType === 'advance') {
      return this.#handleAdvance(command);
    }
    const admitInput: AdmitCommandInput = {
      seriesKey: command.seriesKey,
      playerId: command.playerId,
      commandType: command.commandType as AdmitCommandInput['commandType'],
      idempotencyKey: command.idempotencyKey,
      payloadHash: command.payloadHash,
    };
    const admit = await this.#journal.admit(admitInput);
    if (!admit.ok) {
      if (admit.reason === 'INGRESS_UNAVAILABLE') {
        return { decision: 'unavailable', reason: 'INGRESS_UNAVAILABLE' };
      }
      return { decision: 'reject', reason: 'IDEMPOTENCY_PAYLOAD_CONFLICT' };
    }

    const mutated = await this.#fence.mutate(command.seriesKey, (current) => {
      if (current.lastAppliedAdmissionId === admit.command.admissionId) {
        return { ok: true, next: current };
      }
      if (current.status === 'COMPLETED' || current.status === 'FORFEITED') {
        return { ok: false, reason: 'SERIES_TERMINAL', current };
      }
      const t = admit.command.trustedReceivedAt;
      if (!isTimely(t, current.idleDeadlineAt)) {
        return { ok: false, reason: 'IDLE_EXPIRED', current };
      }
      if (current.hardCutoffAt && !isTimely(t, current.hardCutoffAt)) {
        return { ok: false, reason: 'HARD_CUTOFF_EXPIRED', current };
      }
      if (command.commandType === 'device_handoff') {
        return {
          ok: true,
          next: {
            ...current,
            writerGeneration: current.writerGeneration + 1,
            lastAppliedAdmissionId: admit.command.admissionId,
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
            lastAppliedAdmissionId: admit.command.admissionId,
          },
        };
      }
      if (command.commandType === 'thinking_extension') {
        const remaining = current.idleDeadlineAt.getTime() - t.getTime();
        if (remaining <= 0 || remaining > 60_000) {
          return { ok: false, reason: 'EXTENSION_UNAVAILABLE', current };
        }
        const extended = new Date(current.idleDeadlineAt.getTime() + 60_000);
        const clamped =
          current.hardCutoffAt && extended.getTime() > current.hardCutoffAt.getTime()
            ? current.hardCutoffAt
            : extended;
        return {
          ok: true,
          next: {
            ...current,
            idleDeadlineAt: clamped,
            lastAppliedAdmissionId: admit.command.admissionId,
          },
        };
      }
      // start
      return {
        ok: true,
        next: { ...current, lastAppliedAdmissionId: admit.command.admissionId },
      };
    });

    if (!mutated.ok) {
      await this.#journal.markOutcome(admit.command.admissionId, 'rejected');
      return {
        decision: 'reject',
        reason: mutated.reason as Extract<TrustedGameplayDecision, { decision: 'reject' }>['reason'],
        fence: mutated.state,
      };
    }
    await this.#journal.markOutcome(admit.command.admissionId, 'applied');
    const ordinal = await this.#resolveActiveOrdinal(command.seriesKey, command.playerId);
    const snap = await this.#snapshots.get(command.seriesKey, command.playerId, ordinal);
    return {
      decision: 'apply',
      score: mutated.state.score,
      scoreDelta: 0,
      boardRevision: mutated.state.boardRevision,
      stateHash: snap?.stateHash ?? '',
      terminal: snap?.status === 'ended',
      terminalReason: snap?.terminalReason ?? null,
      subgameOrdinal: ordinal,
      awaitAdvance: mutated.state.status === 'AWAIT_ADVANCE',
      fence: mutated.state,
    };
  }

  async #handleAdvance(command: UntrustedClientCommand): Promise<TrustedGameplayDecision> {
    const admitInput: AdmitCommandInput = {
      seriesKey: command.seriesKey,
      playerId: command.playerId,
      commandType: 'advance',
      idempotencyKey: command.idempotencyKey,
      payloadHash: command.payloadHash,
    };
    const admit = await this.#journal.admit(admitInput);
    if (!admit.ok) {
      if (admit.reason === 'INGRESS_UNAVAILABLE') {
        return { decision: 'unavailable', reason: 'INGRESS_UNAVAILABLE' };
      }
      return { decision: 'reject', reason: 'IDEMPOTENCY_PAYLOAD_CONFLICT' };
    }
    const ordinal = await this.#resolveActiveOrdinal(command.seriesKey, command.playerId);
    const snap = await this.#snapshots.get(command.seriesKey, command.playerId, ordinal);
    const mutated = await this.#fence.mutate(command.seriesKey, (current) => {
      if (current.lastAppliedAdmissionId === admit.command.admissionId) {
        return { ok: true, next: current };
      }
      if (current.status !== 'AWAIT_ADVANCE' || !snap || snap.status !== 'ended') {
        return { ok: false, reason: 'ADVANCE_NOT_ELIGIBLE', current };
      }
      const t = admit.command.trustedReceivedAt;
      if (!isTimely(t, current.idleDeadlineAt)) {
        return { ok: false, reason: 'IDLE_EXPIRED', current };
      }
      // Completing H1 (ordinal 6) marks series COMPLETED without publishing
      // four-category leaderboard rows (publication gate NOT_RUN).
      const completed = ordinal >= 6;
      return {
        ok: true,
        next: {
          ...current,
          idleDeadlineAt: idleDeadlineFrom(t, 300),
          status: completed ? 'COMPLETED' : 'ACTIVE',
          resultsPublished: false,
          lastAppliedAdmissionId: admit.command.admissionId,
        },
      };
    });
    if (!mutated.ok) {
      await this.#journal.markOutcome(admit.command.admissionId, 'rejected');
      return {
        decision: 'reject',
        reason: mutated.reason as Extract<TrustedGameplayDecision, { decision: 'reject' }>['reason'],
        fence: mutated.state,
      };
    }
    await this.#journal.markOutcome(admit.command.admissionId, 'applied');
    return {
      decision: 'apply',
      score: mutated.state.score,
      scoreDelta: 0,
      boardRevision: mutated.state.boardRevision,
      stateHash: snap?.stateHash ?? '',
      terminal: false,
      terminalReason: null,
      subgameOrdinal: ordinal,
      awaitAdvance: false,
      fence: mutated.state,
    };
  }

  async #withAdmissionLock<T>(admissionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#admissionLocks.get(admissionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#admissionLocks.set(admissionId, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Server-only move effect used by Phase A fence regression fakes. */
export interface ServerDerivedMoveEffect {
  scoreDelta: number;
  completesSubgame: boolean;
}

/**
 * Injected into Phase A SeriesCommandArbiter so ingress CAS tests still run
 * without accepting client scoreDelta. Production uses TrustedGameplayService.
 */
export type ServerMoveEffectResolver = (
  command: AdmitCommandInput,
) => ServerDerivedMoveEffect | null;
