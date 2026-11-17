/**
 * P0-E01 — Atomic PostgreSQL gameplay unit-of-work.
 *
 * Admission (ADR-T02) remains a separate durable write. This UoW covers the
 * entire adjudication commit: series lock → validate → replay → ledger →
 * snapshot → fence → admission outcome + immutable result. Any failure rolls
 * back every write; admission stays pending (never rejected with fence advanced).
 */

import type pg from 'pg';
import {
  applyMove,
  replayCore001V3,
  stateHashV3,
  stateToJson,
  type Move,
  type MoveApplied,
} from '../../engine/core001v3/index.mts';
import { seriesAdvisoryKeys } from '../ingress/series-fence.mts';
import { idleDeadlineFrom, isTimely, type SeriesFenceState } from '../ingress/types.mts';
import type { ImmutableAdmissionResult } from './admission-result.mts';
import { freezeAdmissionResult } from './admission-result.mts';
import {
  ADMISSION_RESULT_DDL,
  PostgresAcceptedMoveLedger,
  PostgresAuthoritativeSnapshotStore,
  PostgresTrustedChallengeStore,
  TRUSTED_GAMEPLAY_DDL,
} from './postgres-stores.mts';
import type { AuthoritativeGameSnapshot } from './move-ledger.mts';

export type UowFaultPoint =
  | 'after_lock'
  | 'before_ledger'
  | 'after_ledger'
  | 'before_snapshot'
  | 'after_snapshot'
  | 'before_fence'
  | 'after_fence'
  | 'before_outcome'
  | 'after_outcome'
  | 'before_commit';

export interface UowFaultHooks {
  /** Throw to abort inside the open transaction (must roll back). */
  inject?: (point: UowFaultPoint) => Promise<void> | void;
  /** Invoked after COMMIT succeeds — simulate crash-before-response. */
  afterCommitBeforeResponse?: () => Promise<void> | void;
}

export interface AdjudicateMoveInput {
  seriesKey: string;
  playerId: string;
  subgameOrdinal: number;
  admissionId: string;
  admissionSeq: number;
  trustedReceivedAt: Date;
  move: {
    offerIndex: 0 | 1 | 2;
    tap: [number, number];
    expectedBoardRevision: number;
    writerGeneration: number;
  };
}

export type AdjudicateMoveResult =
  | {
      decision: 'apply';
      result: ImmutableAdmissionResult;
      fence: SeriesFenceState;
      duplicateReplay?: boolean;
    }
  | {
      decision: 'reject';
      reason: string;
      fence?: SeriesFenceState;
      result?: ImmutableAdmissionResult;
      ledgerUnchanged?: boolean;
      checkpointUnchanged?: boolean;
    };

export class PostgresTrustedUnitOfWork {
  readonly #pool: pg.Pool;
  #faults: UowFaultHooks = {};

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  setFaultHooks(hooks: UowFaultHooks): void {
    this.#faults = hooks;
  }

  clearFaultHooks(): void {
    this.#faults = {};
  }

  async migrate(): Promise<void> {
    await this.#pool.query(TRUSTED_GAMEPLAY_DDL);
    await this.#pool.query(ADMISSION_RESULT_DDL);
  }

  /**
   * Atomically adjudicate an already-admitted pending move.
   * On any error inside the TX: ROLLBACK. Admission remains pending.
   * Reject paths that do not mutate fence/ledger/snapshot still commit the
   * outcome+result only (no partial score credit).
   */
  async adjudicateAcceptedMove(
    input: AdjudicateMoveInput,
  ): Promise<AdjudicateMoveResult> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const [k1, k2] = seriesAdvisoryKeys(input.seriesKey);
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);
      await this.#fault('after_lock');

      // Load original admission under lock; verify still pending or return frozen result.
      const admRes = await client.query(
        `SELECT admission_id, series_key, player_id, outcome, result_json,
                trusted_received_at_ms, admission_seq
         FROM command_admission_journal
         WHERE admission_id = $1 FOR UPDATE`,
        [input.admissionId],
      );
      if (!admRes.rowCount) {
        await client.query('ROLLBACK');
        return { decision: 'reject', reason: 'CHALLENGE_NOT_FOUND' };
      }
      const adm = admRes.rows[0];
      if (String(adm.series_key) !== input.seriesKey || String(adm.player_id) !== input.playerId) {
        await client.query('ROLLBACK');
        return { decision: 'reject', reason: 'CHALLENGE_BINDING_MISMATCH' };
      }
      if (String(adm.outcome) === 'applied' && adm.result_json) {
        await client.query('COMMIT');
        const result = freezeAdmissionResult(
          typeof adm.result_json === 'string'
            ? JSON.parse(adm.result_json)
            : adm.result_json,
        );
        const fence = await this.#readFence(client, input.seriesKey);
        return {
          decision: 'apply',
          result,
          fence: fence!,
          duplicateReplay: true,
        };
      }
      if (String(adm.outcome) === 'rejected') {
        const result = adm.result_json
          ? freezeAdmissionResult(
              typeof adm.result_json === 'string'
                ? JSON.parse(adm.result_json)
                : adm.result_json,
            )
          : undefined;
        await client.query('COMMIT');
        const fence = await this.#readFence(client, input.seriesKey);
        return {
          decision: 'reject',
          reason: result?.rejectReason ?? 'SERIES_TERMINAL',
          fence: fence ?? undefined,
          result,
        };
      }

      const challenges = new PostgresTrustedChallengeStore(client);
      const ledger = new PostgresAcceptedMoveLedger(client);
      const snapshots = new PostgresAuthoritativeSnapshotStore(client);

      const challenge = await challenges.get(
        input.seriesKey,
        input.playerId,
        input.subgameOrdinal,
      );
      if (!challenge) {
        return this.#rejectOnly(client, input, 'CHALLENGE_NOT_FOUND');
      }
      if (
        challenge.playerId !== input.playerId ||
        challenge.seriesKey !== input.seriesKey
      ) {
        return this.#rejectOnly(client, input, 'CHALLENGE_BINDING_MISMATCH');
      }

      const fenceRow = await client.query(
        `SELECT * FROM series_fence_state WHERE series_key = $1 FOR UPDATE`,
        [input.seriesKey],
      );
      if (!fenceRow.rowCount) {
        return this.#rejectOnly(client, input, 'SERIES_TERMINAL');
      }
      const pre = mapFence(fenceRow.rows[0]);

      if (pre.lastAppliedAdmissionId === input.admissionId) {
        // Already applied via fence but result missing — reconstruct from snapshot.
        const snap = await snapshots.get(
          input.seriesKey,
          input.playerId,
          input.subgameOrdinal,
        );
        const result = freezeAdmissionResult({
          admissionId: input.admissionId,
          playerId: input.playerId,
          seriesKey: input.seriesKey,
          subgameOrdinal: input.subgameOrdinal,
          boardRevision: pre.boardRevision,
          score: pre.score,
          scoreDelta: 0,
          terminal: snap?.status === 'ended',
          terminalReason: snap?.terminalReason ?? null,
          stateHash: snap?.stateHash ?? '',
          writerGeneration: pre.writerGeneration,
          awaitAdvance: pre.status === 'AWAIT_ADVANCE',
          decision: 'apply',
        });
        await this.#writeOutcome(client, input.admissionId, 'applied', result);
        await client.query('COMMIT');
        return { decision: 'apply', result, fence: pre, duplicateReplay: true };
      }

      if (pre.status === 'COMPLETED' || pre.status === 'FORFEITED') {
        return this.#rejectOnly(client, input, 'SERIES_TERMINAL', pre, true);
      }
      if (pre.status === 'AWAIT_ADVANCE') {
        return this.#rejectOnly(client, input, 'POST_TERMINAL', pre, true);
      }
      if (!isTimely(input.trustedReceivedAt, pre.idleDeadlineAt)) {
        return this.#rejectOnly(client, input, 'IDLE_EXPIRED', pre, true);
      }
      if (pre.hardCutoffAt && !isTimely(input.trustedReceivedAt, pre.hardCutoffAt)) {
        return this.#rejectOnly(client, input, 'HARD_CUTOFF_EXPIRED', pre, true);
      }
      if (input.move.writerGeneration !== pre.writerGeneration) {
        return this.#rejectOnly(client, input, 'NOT_ACTIVE_WRITER', pre, true);
      }
      if (input.move.expectedBoardRevision !== pre.boardRevision) {
        return this.#rejectOnly(client, input, 'STATE_CONFLICT', pre, true);
      }

      const engineMove: Move = {
        offerIndex: input.move.offerIndex,
        tap: { row: input.move.tap[0], column: input.move.tap[1] },
      };

      const history = await ledger.list(
        input.seriesKey,
        input.playerId,
        input.subgameOrdinal,
      );
      const replayed = replayCore001V3({
        initialState: stateToJson(challenge.initialState),
        moves: history.map((h) => ({
          offerIndex: h.move.offerIndex,
          tap: [h.move.tap.row, h.move.tap.column],
        })),
      });
      if (!replayed.ok) {
        return this.#rejectOnly(client, input, 'REPLAY_MISMATCH');
      }

      const snap = await snapshots.get(
        input.seriesKey,
        input.playerId,
        input.subgameOrdinal,
      );
      if (snap && snap.stateHash !== replayed.stateHash) {
        return this.#rejectOnly(client, input, 'REPLAY_MISMATCH');
      }
      if (replayed.finalState.status === 'ended') {
        return this.#rejectOnly(client, input, 'POST_TERMINAL');
      }

      const applied = applyMove(replayed.finalState, engineMove);
      if (applied.kind === 'rejected') {
        return this.#rejectOnly(client, input, 'MOVE_REJECTED', pre, true);
      }
      if (applied.kind === 'unsafe') {
        return this.#rejectOnly(client, input, 'MOVE_UNSAFE', pre, true);
      }

      const moveApplied = applied as MoveApplied;
      const afterHash = stateHashV3(moveApplied.finalState);
      const terminal = moveApplied.finalState.status === 'ended';
      const terminalReason = moveApplied.finalState.terminalReason;
      const nextScore = pre.score + moveApplied.scoreDelta;
      if (!Number.isSafeInteger(nextScore) || nextScore < 0) {
        return this.#rejectOnly(client, input, 'MOVE_UNSAFE', pre, true);
      }

      const nextFence: SeriesFenceState = {
        ...pre,
        boardRevision: pre.boardRevision + 1,
        score: nextScore,
        idleDeadlineAt: idleDeadlineFrom(input.trustedReceivedAt, 300),
        status: terminal ? 'AWAIT_ADVANCE' : pre.status,
        resultsPublished: false,
        lastAppliedAdmissionId: input.admissionId,
      };

      await this.#fault('before_ledger');
      await ledger.append({
        seriesKey: input.seriesKey,
        playerId: input.playerId,
        subgameOrdinal: input.subgameOrdinal,
        challengeId: challenge.challengeId,
        admissionId: input.admissionId,
        admissionSeq: input.admissionSeq,
        boardRevisionAfter: nextFence.boardRevision,
        move: engineMove,
        scoreDelta: moveApplied.scoreDelta,
        scoreAfter: nextFence.score,
        stateHashBefore: replayed.stateHash,
        stateHashAfter: afterHash,
        rulesVersion: 'core-001.v3',
        trustedReceivedAt: input.trustedReceivedAt,
        terminalAfter: terminal,
        terminalReason,
      });
      await this.#fault('after_ledger');

      const snapshot: AuthoritativeGameSnapshot = {
        seriesKey: input.seriesKey,
        playerId: input.playerId,
        subgameOrdinal: input.subgameOrdinal,
        challengeId: challenge.challengeId,
        boardRevision: nextFence.boardRevision,
        moveCursor: history.length + 1,
        stateHash: afterHash,
        score: nextFence.score,
        status: terminal ? 'ended' : 'in_progress',
        terminalReason,
        state: moveApplied.finalState,
        ledgerAdmissionSeq: input.admissionSeq,
        writerGeneration: nextFence.writerGeneration,
        producedByAdmissionId: input.admissionId,
      };

      await this.#fault('before_snapshot');
      await snapshots.put(snapshot);
      await this.#fault('after_snapshot');

      await this.#fault('before_fence');
      await client.query(
        `UPDATE series_fence_state SET
           board_revision = $2,
           writer_generation = $3,
           status = $4,
           idle_deadline_at_ms = $5,
           hard_cutoff_at_ms = $6,
           score = $7,
           results_published = $8,
           last_applied_admission_id = $9,
           thinking_extension_consumed = $10
         WHERE series_key = $1`,
        [
          input.seriesKey,
          nextFence.boardRevision,
          nextFence.writerGeneration,
          nextFence.status,
          nextFence.idleDeadlineAt.getTime(),
          nextFence.hardCutoffAt ? nextFence.hardCutoffAt.getTime() : null,
          nextFence.score,
          nextFence.resultsPublished,
          nextFence.lastAppliedAdmissionId,
          nextFence.thinkingExtensionConsumed,
        ],
      );
      await this.#fault('after_fence');

      const result = freezeAdmissionResult({
        admissionId: input.admissionId,
        playerId: input.playerId,
        seriesKey: input.seriesKey,
        subgameOrdinal: input.subgameOrdinal,
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

      await this.#fault('before_outcome');
      await this.#writeOutcome(client, input.admissionId, 'applied', result);
      await this.#fault('after_outcome');

      await this.#fault('before_commit');
      await client.query('COMMIT');

      if (this.#faults.afterCommitBeforeResponse) {
        await this.#faults.afterCommitBeforeResponse();
      }

      return { decision: 'apply', result, fence: nextFence };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      // Do NOT mark rejected — leave pending so retry can complete atomically.
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Atomically apply a non-move fence mutation + outcome + immutable result.
   */
  async commitFenceMutation(args: {
    seriesKey: string;
    playerId: string;
    subgameOrdinal: number;
    admissionId: string;
    mutate: (
      current: SeriesFenceState,
    ) =>
      | { ok: true; next: SeriesFenceState; resultExtras?: Partial<ImmutableAdmissionResult> }
      | { ok: false; reason: string };
    /** Optional same-TX side effect after fence write (e.g. next-subgame snapshot). */
    afterFence?: (
      client: pg.PoolClient,
      next: SeriesFenceState,
    ) => Promise<void>;
  }): Promise<AdjudicateMoveResult> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const [k1, k2] = seriesAdvisoryKeys(args.seriesKey);
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);

      const admRes = await client.query(
        `SELECT outcome, result_json FROM command_admission_journal
         WHERE admission_id = $1 FOR UPDATE`,
        [args.admissionId],
      );
      if (!admRes.rowCount) {
        await client.query('ROLLBACK');
        return { decision: 'reject', reason: 'SERIES_TERMINAL' };
      }
      if (String(admRes.rows[0].outcome) === 'applied' && admRes.rows[0].result_json) {
        const result = freezeAdmissionResult(
          typeof admRes.rows[0].result_json === 'string'
            ? JSON.parse(admRes.rows[0].result_json)
            : admRes.rows[0].result_json,
        );
        await client.query('COMMIT');
        const fence = await this.#readFence(client, args.seriesKey);
        return { decision: 'apply', result, fence: fence!, duplicateReplay: true };
      }

      const fenceRow = await client.query(
        `SELECT * FROM series_fence_state WHERE series_key = $1 FOR UPDATE`,
        [args.seriesKey],
      );
      if (!fenceRow.rowCount) {
        await client.query('ROLLBACK');
        return { decision: 'reject', reason: 'SERIES_TERMINAL' };
      }
      const current = mapFence(fenceRow.rows[0]);
      if (current.lastAppliedAdmissionId === args.admissionId) {
        const snapStore = new PostgresAuthoritativeSnapshotStore(client);
        const snap = await snapStore.get(
          args.seriesKey,
          args.playerId,
          args.subgameOrdinal,
        );
        const result = freezeAdmissionResult({
          admissionId: args.admissionId,
          playerId: args.playerId,
          seriesKey: args.seriesKey,
          subgameOrdinal: args.subgameOrdinal,
          boardRevision: current.boardRevision,
          score: current.score,
          scoreDelta: 0,
          terminal: snap?.status === 'ended',
          terminalReason: snap?.terminalReason ?? null,
          stateHash: snap?.stateHash ?? '',
          writerGeneration: current.writerGeneration,
          awaitAdvance: current.status === 'AWAIT_ADVANCE',
          decision: 'apply',
        });
        await this.#writeOutcome(client, args.admissionId, 'applied', result);
        await client.query('COMMIT');
        return { decision: 'apply', result, fence: current, duplicateReplay: true };
      }

      const mutated = args.mutate(current);
      if (!mutated.ok) {
        const result = freezeAdmissionResult({
          admissionId: args.admissionId,
          playerId: args.playerId,
          seriesKey: args.seriesKey,
          subgameOrdinal: args.subgameOrdinal,
          boardRevision: current.boardRevision,
          score: current.score,
          scoreDelta: 0,
          terminal: false,
          terminalReason: null,
          stateHash: '',
          writerGeneration: current.writerGeneration,
          awaitAdvance: current.status === 'AWAIT_ADVANCE',
          decision: 'reject',
          rejectReason: mutated.reason,
        });
        await this.#writeOutcome(client, args.admissionId, 'rejected', result);
        await client.query('COMMIT');
        return {
          decision: 'reject',
          reason: mutated.reason,
          fence: current,
          result,
        };
      }

      const next = mutated.next;
      await client.query(
        `UPDATE series_fence_state SET
           board_revision = $2,
           writer_generation = $3,
           status = $4,
           idle_deadline_at_ms = $5,
           hard_cutoff_at_ms = $6,
           score = $7,
           results_published = $8,
           last_applied_admission_id = $9,
           thinking_extension_consumed = $10
         WHERE series_key = $1`,
        [
          args.seriesKey,
          next.boardRevision,
          next.writerGeneration,
          next.status,
          next.idleDeadlineAt.getTime(),
          next.hardCutoffAt ? next.hardCutoffAt.getTime() : null,
          next.score,
          next.resultsPublished,
          next.lastAppliedAdmissionId,
          next.thinkingExtensionConsumed,
        ],
      );

      if (args.afterFence) {
        await args.afterFence(client, next);
      }

      const snapStore = new PostgresAuthoritativeSnapshotStore(client);
      const snap = await snapStore.get(
        args.seriesKey,
        args.playerId,
        args.subgameOrdinal,
      );
      const result = freezeAdmissionResult({
        admissionId: args.admissionId,
        playerId: args.playerId,
        seriesKey: args.seriesKey,
        subgameOrdinal: args.subgameOrdinal,
        boardRevision: next.boardRevision,
        score: next.score,
        scoreDelta: 0,
        terminal: snap?.status === 'ended',
        terminalReason: snap?.terminalReason ?? null,
        stateHash: snap?.stateHash ?? '',
        writerGeneration: next.writerGeneration,
        awaitAdvance: next.status === 'AWAIT_ADVANCE',
        decision: 'apply',
        ...mutated.resultExtras,
      });
      await this.#writeOutcome(client, args.admissionId, 'applied', result);
      await client.query('COMMIT');
      return { decision: 'apply', result, fence: next };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async loadAdmissionResult(
    admissionId: string,
  ): Promise<ImmutableAdmissionResult | null> {
    const res = await this.#pool.query(
      `SELECT result_json FROM command_admission_journal WHERE admission_id = $1`,
      [admissionId],
    );
    if (!res.rowCount || res.rows[0].result_json == null) return null;
    const raw = res.rows[0].result_json;
    return freezeAdmissionResult(
      typeof raw === 'string' ? JSON.parse(raw) : raw,
    );
  }

  async #rejectOnly(
    client: pg.PoolClient,
    input: AdjudicateMoveInput,
    reason: string,
    fence?: SeriesFenceState,
    unchanged = true,
  ): Promise<AdjudicateMoveResult> {
    const result = freezeAdmissionResult({
      admissionId: input.admissionId,
      playerId: input.playerId,
      seriesKey: input.seriesKey,
      subgameOrdinal: input.subgameOrdinal,
      boardRevision: fence?.boardRevision ?? 0,
      score: fence?.score ?? 0,
      scoreDelta: 0,
      terminal: false,
      terminalReason: null,
      stateHash: '',
      writerGeneration: fence?.writerGeneration ?? 0,
      awaitAdvance: fence?.status === 'AWAIT_ADVANCE',
      decision: 'reject',
      rejectReason: reason,
    });
    await this.#writeOutcome(client, input.admissionId, 'rejected', result);
    await client.query('COMMIT');
    return {
      decision: 'reject',
      reason,
      fence,
      result,
      ledgerUnchanged: unchanged,
      checkpointUnchanged: unchanged,
    };
  }

  async #writeOutcome(
    client: pg.PoolClient,
    admissionId: string,
    outcome: 'applied' | 'rejected',
    result: ImmutableAdmissionResult,
  ): Promise<void> {
    await client.query(
      `UPDATE command_admission_journal
       SET outcome = $2, result_json = $3::jsonb
       WHERE admission_id = $1 AND outcome = 'pending'`,
      [admissionId, outcome, JSON.stringify(result)],
    );
  }

  async #readFence(
    client: pg.PoolClient,
    seriesKey: string,
  ): Promise<SeriesFenceState | null> {
    const res = await client.query(
      `SELECT * FROM series_fence_state WHERE series_key = $1`,
      [seriesKey],
    );
    if (!res.rowCount) return null;
    return mapFence(res.rows[0]);
  }

  async #fault(point: UowFaultPoint): Promise<void> {
    if (this.#faults.inject) {
      await this.#faults.inject(point);
    }
  }
}

function mapFence(row: Record<string, unknown>): SeriesFenceState {
  return {
    seriesKey: String(row.series_key),
    boardRevision: Number(row.board_revision),
    writerGeneration: Number(row.writer_generation),
    status: String(row.status) as SeriesFenceState['status'],
    idleDeadlineAt: new Date(Number(row.idle_deadline_at_ms)),
    hardCutoffAt:
      row.hard_cutoff_at_ms == null
        ? null
        : new Date(Number(row.hard_cutoff_at_ms)),
    score: Number(row.score),
    resultsPublished: Boolean(row.results_published),
    lastAppliedAdmissionId:
      row.last_applied_admission_id == null
        ? null
        : String(row.last_applied_admission_id),
    thinkingExtensionConsumed: Boolean(row.thinking_extension_consumed),
  };
}
