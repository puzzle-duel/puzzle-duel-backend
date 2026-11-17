/**
 * Trusted ranked gameplay path (Stage E remediation).
 *
 * - P0-E02: AuthorizationGateway supplies TrustedAuthorizationContext.
 *   Untrusted seriesKey/playerId never authorize.
 * - P1-E03: Closed-schema parse + server payload digest.
 * - P0-E01: PostgreSQL path uses PostgresTrustedUnitOfWork (one TX).
 * - P1-E04: Immutable per-admission results for duplicate-safe retries.
 */

import {
  applyMove,
  replayCore001V3,
  stateHashV3,
  stateToJson,
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
  freezeAdmissionResult,
  type ImmutableAdmissionResult,
} from './admission-result.mts';
import type {
  AuthorizationGateway,
  TrustedAuthorizationContext,
} from './authorization.mts';
import {
  FailClosedAuthorizationGateway,
} from './authorization.mts';
import {
  computeAuthoritativePayloadDigest,
  validateUntrustedClientCommand,
  type UntrustedClientCommand,
  type UntrustedMovePayload,
} from './client-commands.mts';
import type {
  AcceptedMoveLedger,
  AuthoritativeGameSnapshot,
  AuthoritativeSnapshotStore,
} from './move-ledger.mts';
import type { PostgresTrustedUnitOfWork } from './postgres-uow.mts';
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
      admissionResult?: ImmutableAdmissionResult;
    }
  | {
      decision: 'reject';
      reason:
        | 'FORBIDDEN_AUTHORITY_FIELD'
        | 'MALFORMED_COMMAND'
        | 'UNKNOWN_PROPERTY'
        | 'PROTOTYPE_KEY'
        | 'MISSING_MOVE_GUARDS'
        | 'INVALID_INTEGER'
        | 'INVALID_HASH'
        | 'AUTH_REQUIRED'
        | 'PLAYER_MISMATCH'
        | 'SERIES_NOT_OWNED'
        | 'WRITER_NOT_AUTHORIZED'
        | 'COMMAND_NOT_ENTITLED'
        | 'AUTH_CONTRACT_UNAVAILABLE'
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
      admissionResult?: ImmutableAdmissionResult;
    }
  | { decision: 'unavailable'; reason: 'INGRESS_UNAVAILABLE' };

/**
 * Optional non-authoritative lookup hints for the AuthorizationGateway.
 * Never treated as ownership proof.
 */
export interface RankedCommandHints {
  seriesKeyHint?: string;
  playerIdHint?: string;
  writerGenerationHint?: number;
}

export interface TrustedGameplayServiceOptions {
  journal: AdmissionJournal;
  fence: SeriesFenceStore;
  challenges: TrustedChallengeStore;
  ledger: AcceptedMoveLedger;
  snapshots: AuthoritativeSnapshotStore;
  clock: IngressClock;
  /**
   * Required for ranked mutation. Defaults to fail-closed when omitted.
   */
  authorization?: AuthorizationGateway;
  /**
   * When set, accepted move/fence mutations use a single PostgreSQL TX.
   */
  postgresUow?: PostgresTrustedUnitOfWork;
  /**
   * Active subgame ordinal fallback when auth context is unavailable
   * (should not happen on authorized paths).
   */
  resolveActiveOrdinal?: (seriesKey: string, playerId: string) => Promise<number>;
}

function decisionFromResult(
  result: ImmutableAdmissionResult,
  fence: SeriesFenceState,
  duplicateReplay?: boolean,
): TrustedGameplayDecision {
  if (result.decision === 'reject') {
    return {
      decision: 'reject',
      reason: (result.rejectReason ?? 'SERIES_TERMINAL') as Extract<
        TrustedGameplayDecision,
        { decision: 'reject' }
      >['reason'],
      fence,
      admissionResult: result,
    };
  }
  return {
    decision: 'apply',
    score: result.score,
    scoreDelta: result.scoreDelta,
    boardRevision: result.boardRevision,
    stateHash: result.stateHash,
    terminal: result.terminal,
    terminalReason: result.terminalReason,
    subgameOrdinal: result.subgameOrdinal,
    awaitAdvance: result.awaitAdvance,
    duplicateReplay,
    fence,
    admissionResult: result,
  };
}

/**
 * Trusted ranked move path: authorize → parse → admit → atomic adjudicate.
 * Client score/completion/checkpoint never authorize.
 */
export class TrustedGameplayService {
  readonly #journal: AdmissionJournal;
  readonly #fence: SeriesFenceStore;
  readonly #challenges: TrustedChallengeStore;
  readonly #ledger: AcceptedMoveLedger;
  readonly #snapshots: AuthoritativeSnapshotStore;
  readonly #clock: IngressClock;
  readonly #authorization: AuthorizationGateway;
  readonly #postgresUow: PostgresTrustedUnitOfWork | null;
  readonly #resolveActiveOrdinal: (
    seriesKey: string,
    playerId: string,
  ) => Promise<number>;
  readonly #admissionLocks = new Map<string, Promise<void>>();
  readonly #seriesLocks = new Map<string, Promise<void>>();

  constructor(options: TrustedGameplayServiceOptions) {
    this.#journal = options.journal;
    this.#fence = options.fence;
    this.#challenges = options.challenges;
    this.#ledger = options.ledger;
    this.#snapshots = options.snapshots;
    this.#clock = options.clock;
    this.#authorization =
      options.authorization ?? new FailClosedAuthorizationGateway();
    this.#postgresUow = options.postgresUow ?? null;
    this.#resolveActiveOrdinal =
      options.resolveActiveOrdinal ??
      (async (_s, _p) => {
        throw new Error('resolveActiveOrdinal_required_without_auth_ordinal');
      });
  }

  /**
   * V3-48 / adversarial entry: any client checkpoint replacement attempt.
   * Always rejects; trusted snapshot and ledger remain unchanged.
   * Requires authorization — unauthenticated calls fail closed.
   */
  async rejectCheckpointOverwrite(args: {
    auth?: TrustedAuthorizationContext;
    hints?: RankedCommandHints;
    seriesKey?: string;
    playerId?: string;
    subgameOrdinal: number;
    attemptedCheckpoint: unknown;
    forgedStateHash?: string;
  }): Promise<TrustedGameplayDecision> {
    const authDecision = args.auth
      ? { ok: true as const, context: args.auth }
      : await this.#authorization.authorize({
          commandType: 'move',
          clientClaimedSeriesKey: args.hints?.seriesKeyHint ?? args.seriesKey,
          clientClaimedPlayerId: args.hints?.playerIdHint ?? args.playerId,
          clientClaimedWriterGeneration: args.hints?.writerGenerationHint,
        });
    if (!authDecision.ok) {
      return { decision: 'reject', reason: authDecision.reason };
    }
    const seriesKey = authDecision.context.series.seriesKey;
    const playerId = authDecision.context.principal.playerId;
    // Cross-series / cross-player forged targeting still rejected with no writes.
    if (
      (args.seriesKey !== undefined && args.seriesKey !== seriesKey) ||
      (args.playerId !== undefined && args.playerId !== playerId)
    ) {
      return {
        decision: 'reject',
        reason: 'CHECKPOINT_OVERWRITE_REJECTED',
        checkpointUnchanged: true,
        ledgerUnchanged: true,
      };
    }

    const before = await this.#snapshots.get(
      seriesKey,
      playerId,
      args.subgameOrdinal,
    );
    const watermark = await this.#ledger.latestWatermark(
      seriesKey,
      playerId,
      args.subgameOrdinal,
    );
    const fence = await this.#fence.get(seriesKey);
    void args.attemptedCheckpoint;
    void args.forgedStateHash;
    const after = await this.#snapshots.get(
      seriesKey,
      playerId,
      args.subgameOrdinal,
    );
    const watermarkAfter = await this.#ledger.latestWatermark(
      seriesKey,
      playerId,
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

  /**
   * Ranked entry. `hints` are non-authoritative lookup aids for the gateway.
   */
  async handleClientCommand(
    raw: unknown,
    hints: RankedCommandHints = {},
  ): Promise<TrustedGameplayDecision> {
    const validated = validateUntrustedClientCommand(raw);
    if (!validated.ok) {
      return { decision: 'reject', reason: validated.reason };
    }
    const command = validated.command;

    const authDecision = await this.#authorization.authorize({
      commandType: command.commandType,
      clientClaimedSeriesKey: hints.seriesKeyHint,
      clientClaimedPlayerId: hints.playerIdHint,
      clientClaimedWriterGeneration:
        hints.writerGenerationHint ?? command.move?.writerGeneration,
    });
    if (!authDecision.ok) {
      return { decision: 'reject', reason: authDecision.reason };
    }
    const auth = authDecision.context;

    if (command.commandType === 'move') {
      return this.#handleMove(auth, command);
    }
    if (command.commandType === 'advance') {
      return this.#handleAdvance(auth, command);
    }
    return this.#handleNonMove(auth, command);
  }

  async #handleMove(
    auth: TrustedAuthorizationContext,
    command: UntrustedClientCommand,
  ): Promise<TrustedGameplayDecision> {
    const move = command.move!;
    // Writer must match authorized session generation.
    if (move.writerGeneration !== auth.session.writerGeneration) {
      return { decision: 'reject', reason: 'WRITER_NOT_AUTHORIZED' };
    }

    const payloadHash = computeAuthoritativePayloadDigest({ auth, command });
    const admitInput: AdmitCommandInput = {
      seriesKey: auth.series.seriesKey,
      playerId: auth.principal.playerId,
      commandType: 'move',
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      expectedBoardRevision: move.expectedBoardRevision,
      writerGeneration: move.writerGeneration,
    };

    const admit = await this.#journal.admit(admitInput);
    if (!admit.ok) {
      if (admit.reason === 'INGRESS_UNAVAILABLE') {
        return { decision: 'unavailable', reason: 'INGRESS_UNAVAILABLE' };
      }
      return { decision: 'reject', reason: 'IDEMPOTENCY_PAYLOAD_CONFLICT' };
    }

    if (admit.command.status === 'duplicate' && admit.outcome !== 'pending') {
      return this.#duplicateFromAdmission(admit.command.admissionId, auth);
    }

    return this.#withAdmissionLock(admit.command.admissionId, async () => {
      const existingResult = await this.#journal.getResult(
        admit.command.admissionId,
      );
      if (existingResult) {
        const fence = await this.#fence.get(auth.series.seriesKey);
        if (!fence) {
          return { decision: 'reject', reason: 'SERIES_TERMINAL' };
        }
        return decisionFromResult(existingResult, fence, true);
      }
      const existing = await this.#journal.getOutcome(admit.command.admissionId);
      if (existing === 'applied' || existing === 'rejected') {
        return this.#duplicateFromAdmission(admit.command.admissionId, auth);
      }
      return this.#adjudicateMove(
        auth,
        move,
        admit.command.admissionId,
        admit.command.admissionSeq,
        admit.command.trustedReceivedAt,
      );
    });
  }

  async #duplicateFromAdmission(
    admissionId: string,
    auth: TrustedAuthorizationContext,
  ): Promise<TrustedGameplayDecision> {
    const frozen = await this.#journal.getResult(admissionId);
    const fence = await this.#fence.get(auth.series.seriesKey);
    if (frozen && fence) {
      return decisionFromResult(frozen, fence, true);
    }
    if (this.#postgresUow) {
      const fromUow = await this.#postgresUow.loadAdmissionResult(admissionId);
      if (fromUow && fence) {
        return decisionFromResult(fromUow, fence, true);
      }
    }
    // Fail closed rather than inventing current-ordinal snapshot (P1-E04).
    return {
      decision: 'reject',
      reason: 'SERIES_TERMINAL',
      fence: fence ?? undefined,
    };
  }

  async #adjudicateMove(
    auth: TrustedAuthorizationContext,
    move: UntrustedMovePayload,
    admissionId: string,
    admissionSeq: number,
    trustedReceivedAt: Date,
  ): Promise<TrustedGameplayDecision> {
    const ordinal = auth.series.activeSubgameOrdinal;

    if (this.#postgresUow) {
      try {
        const out = await this.#postgresUow.adjudicateAcceptedMove({
          seriesKey: auth.series.seriesKey,
          playerId: auth.principal.playerId,
          subgameOrdinal: ordinal,
          admissionId,
          admissionSeq,
          trustedReceivedAt,
          move: {
            offerIndex: move.offerIndex,
            tap: move.tap,
            expectedBoardRevision: move.expectedBoardRevision,
            writerGeneration: move.writerGeneration,
          },
        });
        if (out.decision === 'apply') {
          return decisionFromResult(out.result, out.fence, out.duplicateReplay);
        }
        return {
          decision: 'reject',
          reason: out.reason as Extract<
            TrustedGameplayDecision,
            { decision: 'reject' }
          >['reason'],
          fence: out.fence,
          checkpointUnchanged: out.checkpointUnchanged,
          ledgerUnchanged: out.ledgerUnchanged,
          admissionResult: out.result,
        };
      } catch {
        // TX rolled back; leave pending — surface unavailable so client retries.
        return { decision: 'unavailable', reason: 'INGRESS_UNAVAILABLE' };
      }
    }

    // Memory path: single series lock covering all mutations (test fidelity).
    return this.#withSeriesLock(auth.series.seriesKey, async () => {
      return this.#adjudicateMoveMemory(
        auth,
        move,
        admissionId,
        admissionSeq,
        trustedReceivedAt,
        ordinal,
      );
    });
  }

  async #adjudicateMoveMemory(
    auth: TrustedAuthorizationContext,
    move: UntrustedMovePayload,
    admissionId: string,
    admissionSeq: number,
    trustedReceivedAt: Date,
    ordinal: number,
  ): Promise<TrustedGameplayDecision> {
    const seriesKey = auth.series.seriesKey;
    const playerId = auth.principal.playerId;

    const challenge = await this.#challenges.get(seriesKey, playerId, ordinal);
    if (!challenge) {
      const result = freezeAdmissionResult({
        admissionId,
        playerId,
        seriesKey,
        subgameOrdinal: ordinal,
        boardRevision: 0,
        score: 0,
        scoreDelta: 0,
        terminal: false,
        terminalReason: null,
        stateHash: '',
        writerGeneration: 0,
        awaitAdvance: false,
        decision: 'reject',
        rejectReason: 'CHALLENGE_NOT_FOUND',
      });
      await this.#journal.markOutcomeWithResult(admissionId, 'rejected', result);
      return { decision: 'reject', reason: 'CHALLENGE_NOT_FOUND', admissionResult: result };
    }
    if (challenge.playerId !== playerId || challenge.seriesKey !== seriesKey) {
      const result = freezeAdmissionResult({
        admissionId,
        playerId,
        seriesKey,
        subgameOrdinal: ordinal,
        boardRevision: 0,
        score: 0,
        scoreDelta: 0,
        terminal: false,
        terminalReason: null,
        stateHash: '',
        writerGeneration: 0,
        awaitAdvance: false,
        decision: 'reject',
        rejectReason: 'CHALLENGE_BINDING_MISMATCH',
      });
      await this.#journal.markOutcomeWithResult(admissionId, 'rejected', result);
      return {
        decision: 'reject',
        reason: 'CHALLENGE_BINDING_MISMATCH',
        admissionResult: result,
      };
    }

    const pre = await this.#fence.get(seriesKey);
    if (!pre) {
      await this.#journal.markOutcomeWithResult(
        admissionId,
        'rejected',
        freezeAdmissionResult({
          admissionId,
          playerId,
          seriesKey,
          subgameOrdinal: ordinal,
          boardRevision: 0,
          score: 0,
          scoreDelta: 0,
          terminal: false,
          terminalReason: null,
          stateHash: '',
          writerGeneration: 0,
          awaitAdvance: false,
          decision: 'reject',
          rejectReason: 'SERIES_TERMINAL',
        }),
      );
      return { decision: 'reject', reason: 'SERIES_TERMINAL' };
    }
    if (pre.lastAppliedAdmissionId === admissionId) {
      const existing = await this.#journal.getResult(admissionId);
      if (existing) return decisionFromResult(existing, pre, true);
    }
    if (pre.status === 'COMPLETED' || pre.status === 'FORFEITED') {
      return this.#rejectMemory(admissionId, playerId, seriesKey, ordinal, pre, 'SERIES_TERMINAL');
    }
    if (pre.status === 'AWAIT_ADVANCE') {
      return this.#rejectMemory(admissionId, playerId, seriesKey, ordinal, pre, 'POST_TERMINAL');
    }
    if (!isTimely(trustedReceivedAt, pre.idleDeadlineAt)) {
      return this.#rejectMemory(admissionId, playerId, seriesKey, ordinal, pre, 'IDLE_EXPIRED');
    }
    if (pre.hardCutoffAt && !isTimely(trustedReceivedAt, pre.hardCutoffAt)) {
      return this.#rejectMemory(admissionId, playerId, seriesKey, ordinal, pre, 'HARD_CUTOFF_EXPIRED');
    }
    if (move.writerGeneration !== pre.writerGeneration) {
      return this.#rejectMemory(admissionId, playerId, seriesKey, ordinal, pre, 'NOT_ACTIVE_WRITER');
    }
    if (move.expectedBoardRevision !== pre.boardRevision) {
      return this.#rejectMemory(admissionId, playerId, seriesKey, ordinal, pre, 'STATE_CONFLICT');
    }

    const engineMove: Move = {
      offerIndex: move.offerIndex,
      tap: { row: move.tap[0], column: move.tap[1] },
    };

    const history = await this.#ledger.list(seriesKey, playerId, ordinal);
    const replayed = replayCore001V3({
      initialState: stateToJson(challenge.initialState),
      moves: history.map((h) => ({
        offerIndex: h.move.offerIndex,
        tap: [h.move.tap.row, h.move.tap.column],
      })),
    });
    if (!replayed.ok) {
      return this.#rejectMemory(admissionId, playerId, seriesKey, ordinal, pre, 'REPLAY_MISMATCH', false);
    }

    const snap = await this.#snapshots.get(seriesKey, playerId, ordinal);
    if (snap && snap.stateHash !== replayed.stateHash) {
      return this.#rejectMemory(admissionId, playerId, seriesKey, ordinal, pre, 'REPLAY_MISMATCH', false);
    }
    if (replayed.finalState.status === 'ended') {
      return this.#rejectMemory(admissionId, playerId, seriesKey, ordinal, pre, 'POST_TERMINAL');
    }

    const applied = applyMove(replayed.finalState, engineMove);
    if (applied.kind === 'rejected') {
      return this.#rejectMemory(admissionId, playerId, seriesKey, ordinal, pre, 'MOVE_REJECTED');
    }
    if (applied.kind === 'unsafe') {
      return this.#rejectMemory(admissionId, playerId, seriesKey, ordinal, pre, 'MOVE_UNSAFE');
    }

    const moveApplied = applied as MoveApplied;
    const afterHash = stateHashV3(moveApplied.finalState);
    const terminal = moveApplied.finalState.status === 'ended';
    const terminalReason = moveApplied.finalState.terminalReason;
    const nextScore = pre.score + moveApplied.scoreDelta;
    if (!Number.isSafeInteger(nextScore) || nextScore < 0) {
      return this.#rejectMemory(admissionId, playerId, seriesKey, ordinal, pre, 'MOVE_UNSAFE');
    }

    const nextFence: SeriesFenceState = {
      ...pre,
      boardRevision: pre.boardRevision + 1,
      score: nextScore,
      idleDeadlineAt: idleDeadlineFrom(trustedReceivedAt, 300),
      status: terminal ? 'AWAIT_ADVANCE' : pre.status,
      resultsPublished: false,
      lastAppliedAdmissionId: admissionId,
    };

    // Memory "transaction": mutate all stores under series lock; on failure
    // restore fence/ledger/snapshot and leave admission pending (not rejected).
    const fenceBefore = { ...pre };
    const ledgerBefore = await this.#ledger.list(seriesKey, playerId, ordinal);
    const snapBefore = snap ? { ...snap } : null;

    try {
      await this.#fence.put(nextFence);
      await this.#ledger.append({
        seriesKey,
        playerId,
        subgameOrdinal: ordinal,
        challengeId: challenge.challengeId,
        admissionId,
        admissionSeq,
        boardRevisionAfter: nextFence.boardRevision,
        move: engineMove,
        scoreDelta: moveApplied.scoreDelta,
        scoreAfter: nextFence.score,
        stateHashBefore: replayed.stateHash,
        stateHashAfter: afterHash,
        rulesVersion: 'core-001.v3',
        trustedReceivedAt,
        terminalAfter: terminal,
        terminalReason,
      });
      const snapshot: AuthoritativeGameSnapshot = {
        seriesKey,
        playerId,
        subgameOrdinal: ordinal,
        challengeId: challenge.challengeId,
        boardRevision: nextFence.boardRevision,
        moveCursor: history.length + 1,
        stateHash: afterHash,
        score: nextFence.score,
        status: terminal ? 'ended' : 'in_progress',
        terminalReason,
        state: moveApplied.finalState,
        ledgerAdmissionSeq: admissionSeq,
        writerGeneration: nextFence.writerGeneration,
        producedByAdmissionId: admissionId,
      };
      await this.#snapshots.put(snapshot);

      const result = freezeAdmissionResult({
        admissionId,
        playerId,
        seriesKey,
        subgameOrdinal: ordinal,
        boardRevision: nextFence.boardRevision,
        score: nextFence.score,
        scoreDelta: moveApplied.scoreDelta,
        terminal,
        terminalReason,
        stateHash: afterHash,
        writerGeneration: nextFence.writerGeneration,
        awaitAdvance: terminal,
        decision: 'apply',
      });
      await this.#journal.markOutcomeWithResult(admissionId, 'applied', result);
      return decisionFromResult(result, nextFence);
    } catch (error) {
      // Roll back memory stores; leave admission pending for retry.
      await this.#fence.put(fenceBefore);
      if (snapBefore) {
        await this.#snapshots.put(snapBefore);
      }
      if ('removeByAdmissionId' in this.#ledger) {
        await (
          this.#ledger as {
            removeByAdmissionId: (id: string) => Promise<void>;
          }
        ).removeByAdmissionId(admissionId);
      }
      void ledgerBefore;
      throw error;
    }
  }

  async #rejectMemory(
    admissionId: string,
    playerId: string,
    seriesKey: string,
    ordinal: number,
    fence: SeriesFenceState,
    reason: Extract<TrustedGameplayDecision, { decision: 'reject' }>['reason'],
    unchanged = true,
  ): Promise<TrustedGameplayDecision> {
    const result = freezeAdmissionResult({
      admissionId,
      playerId,
      seriesKey,
      subgameOrdinal: ordinal,
      boardRevision: fence.boardRevision,
      score: fence.score,
      scoreDelta: 0,
      terminal: false,
      terminalReason: null,
      stateHash: '',
      writerGeneration: fence.writerGeneration,
      awaitAdvance: fence.status === 'AWAIT_ADVANCE',
      decision: 'reject',
      rejectReason: reason,
    });
    await this.#journal.markOutcomeWithResult(admissionId, 'rejected', result);
    return {
      decision: 'reject',
      reason,
      fence,
      checkpointUnchanged: unchanged,
      ledgerUnchanged: unchanged,
      admissionResult: result,
    };
  }

  async #handleNonMove(
    auth: TrustedAuthorizationContext,
    command: UntrustedClientCommand,
  ): Promise<TrustedGameplayDecision> {
    const payloadHash = computeAuthoritativePayloadDigest({ auth, command });
    const admitInput: AdmitCommandInput = {
      seriesKey: auth.series.seriesKey,
      playerId: auth.principal.playerId,
      commandType: command.commandType as AdmitCommandInput['commandType'],
      idempotencyKey: command.idempotencyKey,
      payloadHash,
    };
    const admit = await this.#journal.admit(admitInput);
    if (!admit.ok) {
      if (admit.reason === 'INGRESS_UNAVAILABLE') {
        return { decision: 'unavailable', reason: 'INGRESS_UNAVAILABLE' };
      }
      return { decision: 'reject', reason: 'IDEMPOTENCY_PAYLOAD_CONFLICT' };
    }
    if (admit.command.status === 'duplicate' && admit.outcome !== 'pending') {
      return this.#duplicateFromAdmission(admit.command.admissionId, auth);
    }

    const ordinal = auth.series.activeSubgameOrdinal;

    if (this.#postgresUow) {
      try {
        const out = await this.#postgresUow.commitFenceMutation({
          seriesKey: auth.series.seriesKey,
          playerId: auth.principal.playerId,
          subgameOrdinal: ordinal,
          admissionId: admit.command.admissionId,
          mutate: (current) =>
            this.#nonMoveMutate(command, admit.command.admissionId, admit.command.trustedReceivedAt, current),
        });
        if (out.decision === 'apply') {
          // Keep auth gateway writer generation in sync after handoff.
          if (command.commandType === 'device_handoff' && 'update' in this.#authorization) {
            const gw = this.#authorization as {
              update?: (c: TrustedAuthorizationContext) => void;
              get?: (k: string) => TrustedAuthorizationContext | null;
            };
            const prev = gw.get?.(auth.series.seriesKey);
            if (prev && out.fence) {
              gw.update?.({
                ...prev,
                session: {
                  ...prev.session,
                  writerGeneration: out.fence.writerGeneration,
                },
              });
            }
          }
          return decisionFromResult(out.result, out.fence, out.duplicateReplay);
        }
        return {
          decision: 'reject',
          reason: out.reason as Extract<
            TrustedGameplayDecision,
            { decision: 'reject' }
          >['reason'],
          fence: out.fence,
          admissionResult: out.result,
        };
      } catch {
        return { decision: 'unavailable', reason: 'INGRESS_UNAVAILABLE' };
      }
    }

    return this.#withSeriesLock(auth.series.seriesKey, async () => {
      const mutated = await this.#fence.mutate(auth.series.seriesKey, (current) => {
        const r = this.#nonMoveMutate(
          command,
          admit.command.admissionId,
          admit.command.trustedReceivedAt,
          current,
        );
        if (!r.ok) return { ok: false as const, reason: r.reason, current };
        return { ok: true as const, next: r.next };
      });
      if (!mutated.ok) {
        const result = freezeAdmissionResult({
          admissionId: admit.command.admissionId,
          playerId: auth.principal.playerId,
          seriesKey: auth.series.seriesKey,
          subgameOrdinal: ordinal,
          boardRevision: mutated.state.boardRevision,
          score: mutated.state.score,
          scoreDelta: 0,
          terminal: false,
          terminalReason: null,
          stateHash: '',
          writerGeneration: mutated.state.writerGeneration,
          awaitAdvance: mutated.state.status === 'AWAIT_ADVANCE',
          decision: 'reject',
          rejectReason: mutated.reason,
        });
        await this.#journal.markOutcomeWithResult(
          admit.command.admissionId,
          'rejected',
          result,
        );
        return {
          decision: 'reject',
          reason: mutated.reason as Extract<
            TrustedGameplayDecision,
            { decision: 'reject' }
          >['reason'],
          fence: mutated.state,
          admissionResult: result,
        };
      }
      const snap = await this.#snapshots.get(
        auth.series.seriesKey,
        auth.principal.playerId,
        ordinal,
      );
      const result = freezeAdmissionResult({
        admissionId: admit.command.admissionId,
        playerId: auth.principal.playerId,
        seriesKey: auth.series.seriesKey,
        subgameOrdinal: ordinal,
        boardRevision: mutated.state.boardRevision,
        score: mutated.state.score,
        scoreDelta: 0,
        terminal: snap?.status === 'ended',
        terminalReason: snap?.terminalReason ?? null,
        stateHash: snap?.stateHash ?? '',
        writerGeneration: mutated.state.writerGeneration,
        awaitAdvance: mutated.state.status === 'AWAIT_ADVANCE',
        decision: 'apply',
      });
      await this.#journal.markOutcomeWithResult(
        admit.command.admissionId,
        'applied',
        result,
      );
      if (command.commandType === 'device_handoff' && 'update' in this.#authorization) {
        const gw = this.#authorization as {
          update?: (c: TrustedAuthorizationContext) => void;
          get?: (k: string) => TrustedAuthorizationContext | null;
        };
        const prev = gw.get?.(auth.series.seriesKey);
        if (prev) {
          gw.update?.({
            ...prev,
            session: {
              ...prev.session,
              writerGeneration: mutated.state.writerGeneration,
            },
          });
        }
      }
      return decisionFromResult(result, mutated.state);
    });
  }

  #nonMoveMutate(
    command: UntrustedClientCommand,
    admissionId: string,
    trustedReceivedAt: Date,
    current: SeriesFenceState,
  ):
    | { ok: true; next: SeriesFenceState }
    | { ok: false; reason: string } {
    if (current.lastAppliedAdmissionId === admissionId) {
      return { ok: true, next: current };
    }
    if (current.status === 'COMPLETED' || current.status === 'FORFEITED') {
      return { ok: false, reason: 'SERIES_TERMINAL' };
    }
    const t = trustedReceivedAt;
    if (!isTimely(t, current.idleDeadlineAt)) {
      return { ok: false, reason: 'IDLE_EXPIRED' };
    }
    if (current.hardCutoffAt && !isTimely(t, current.hardCutoffAt)) {
      return { ok: false, reason: 'HARD_CUTOFF_EXPIRED' };
    }
    if (command.commandType === 'device_handoff') {
      return {
        ok: true,
        next: {
          ...current,
          writerGeneration: current.writerGeneration + 1,
          lastAppliedAdmissionId: admissionId,
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
          lastAppliedAdmissionId: admissionId,
        },
      };
    }
    if (command.commandType === 'thinking_extension') {
      const remaining = current.idleDeadlineAt.getTime() - t.getTime();
      if (remaining <= 0 || remaining > 60_000) {
        return { ok: false, reason: 'EXTENSION_UNAVAILABLE' };
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
          lastAppliedAdmissionId: admissionId,
        },
      };
    }
    // start
    return {
      ok: true,
      next: { ...current, lastAppliedAdmissionId: admissionId },
    };
  }

  async #handleAdvance(
    auth: TrustedAuthorizationContext,
    command: UntrustedClientCommand,
  ): Promise<TrustedGameplayDecision> {
    const payloadHash = computeAuthoritativePayloadDigest({ auth, command });
    const admitInput: AdmitCommandInput = {
      seriesKey: auth.series.seriesKey,
      playerId: auth.principal.playerId,
      commandType: 'advance',
      idempotencyKey: command.idempotencyKey,
      payloadHash,
    };
    const admit = await this.#journal.admit(admitInput);
    if (!admit.ok) {
      if (admit.reason === 'INGRESS_UNAVAILABLE') {
        return { decision: 'unavailable', reason: 'INGRESS_UNAVAILABLE' };
      }
      return { decision: 'reject', reason: 'IDEMPOTENCY_PAYLOAD_CONFLICT' };
    }
    if (admit.command.status === 'duplicate' && admit.outcome !== 'pending') {
      return this.#duplicateFromAdmission(admit.command.admissionId, auth);
    }

    const ordinal = auth.series.activeSubgameOrdinal;

    const applyAdvance = (
      current: SeriesFenceState,
      snap: AuthoritativeGameSnapshot | null,
    ):
      | { ok: true; next: SeriesFenceState }
      | { ok: false; reason: string } => {
      if (current.lastAppliedAdmissionId === admit.command.admissionId) {
        return { ok: true, next: current };
      }
      if (current.status !== 'AWAIT_ADVANCE' || !snap || snap.status !== 'ended') {
        return { ok: false, reason: 'ADVANCE_NOT_ELIGIBLE' };
      }
      const t = admit.command.trustedReceivedAt;
      if (!isTimely(t, current.idleDeadlineAt)) {
        return { ok: false, reason: 'IDLE_EXPIRED' };
      }
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
    };

    if (this.#postgresUow) {
      try {
        const snap = await this.#snapshots.get(
          auth.series.seriesKey,
          auth.principal.playerId,
          ordinal,
        );
        const out = await this.#postgresUow.commitFenceMutation({
          seriesKey: auth.series.seriesKey,
          playerId: auth.principal.playerId,
          subgameOrdinal: ordinal,
          admissionId: admit.command.admissionId,
          mutate: (current) => {
            const r = applyAdvance(current, snap);
            if (!r.ok) return r;
            return {
              ok: true,
              next: r.next,
              resultExtras: {
                terminal: false,
                terminalReason: null,
                stateHash: snap?.stateHash ?? '',
                awaitAdvance: false,
              },
            };
          },
        });
        if (out.decision === 'apply') {
          return decisionFromResult(out.result, out.fence, out.duplicateReplay);
        }
        return {
          decision: 'reject',
          reason: out.reason as Extract<
            TrustedGameplayDecision,
            { decision: 'reject' }
          >['reason'],
          fence: out.fence,
          admissionResult: out.result,
        };
      } catch {
        return { decision: 'unavailable', reason: 'INGRESS_UNAVAILABLE' };
      }
    }

    return this.#withSeriesLock(auth.series.seriesKey, async () => {
      const snap = await this.#snapshots.get(
        auth.series.seriesKey,
        auth.principal.playerId,
        ordinal,
      );
      const mutated = await this.#fence.mutate(auth.series.seriesKey, (current) => {
        const r = applyAdvance(current, snap);
        if (!r.ok) return { ok: false as const, reason: r.reason, current };
        return { ok: true as const, next: r.next };
      });
      if (!mutated.ok) {
        const result = freezeAdmissionResult({
          admissionId: admit.command.admissionId,
          playerId: auth.principal.playerId,
          seriesKey: auth.series.seriesKey,
          subgameOrdinal: ordinal,
          boardRevision: mutated.state.boardRevision,
          score: mutated.state.score,
          scoreDelta: 0,
          terminal: false,
          terminalReason: null,
          stateHash: snap?.stateHash ?? '',
          writerGeneration: mutated.state.writerGeneration,
          awaitAdvance: mutated.state.status === 'AWAIT_ADVANCE',
          decision: 'reject',
          rejectReason: mutated.reason,
        });
        await this.#journal.markOutcomeWithResult(
          admit.command.admissionId,
          'rejected',
          result,
        );
        return {
          decision: 'reject',
          reason: mutated.reason as Extract<
            TrustedGameplayDecision,
            { decision: 'reject' }
          >['reason'],
          fence: mutated.state,
          admissionResult: result,
        };
      }
      const result = freezeAdmissionResult({
        admissionId: admit.command.admissionId,
        playerId: auth.principal.playerId,
        seriesKey: auth.series.seriesKey,
        subgameOrdinal: ordinal,
        boardRevision: mutated.state.boardRevision,
        score: mutated.state.score,
        scoreDelta: 0,
        terminal: false,
        terminalReason: null,
        stateHash: snap?.stateHash ?? '',
        writerGeneration: mutated.state.writerGeneration,
        awaitAdvance: false,
        decision: 'apply',
      });
      await this.#journal.markOutcomeWithResult(
        admit.command.admissionId,
        'applied',
        result,
      );
      return decisionFromResult(result, mutated.state);
    });
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

  async #withSeriesLock<T>(seriesKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#seriesLocks.get(seriesKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#seriesLocks.set(seriesKey, prev.then(() => gate));
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
