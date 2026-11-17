/**
 * P0-F11 / P0-F12 / P1-F15 — atomic device handoff unit-of-work.
 *
 * Fail-closed authorization: only the session that currently owns the writer
 * binding may hand off. Caller must present expectedWriterGeneration (observed).
 * Cross-device seize by a non-writer same-player session is rejected (product
 * recovery policy beyond current-writer handoff remains BLOCKED).
 *
 * One TX under series advisory lock:
 * admission FOR UPDATE → writer FOR UPDATE + CAS → fence FOR UPDATE →
 * snapshot writer_generation → writer row update → immutable outcome.
 */
import type pg from 'pg';
import { seriesAdvisoryKeys } from '../ingress/series-fence.mts';
import { isTimely, type SeriesFenceState } from '../ingress/types.mts';
import {
  freezeAdmissionResult,
  type ImmutableAdmissionResult,
} from './admission-result.mts';

export type AtomicHandoffResult =
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
    };

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

export class AtomicDeviceHandoffUnitOfWork {
  readonly #pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async commit(args: {
    seriesKey: string;
    playerId: string;
    subgameOrdinal: number;
    admissionId: string;
    trustedReceivedAt: Date;
    callerSessionId: string;
    callerDeviceId: string;
    /** Caller-observed generation — never server-fetched into the CAS blindly. */
    expectedWriterGeneration: number;
  }): Promise<AtomicHandoffResult> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const [k1, k2] = seriesAdvisoryKeys(args.seriesKey);
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);

      const adm = await client.query(
        `SELECT outcome, result_json FROM command_admission_journal
         WHERE admission_id = $1 FOR UPDATE`,
        [args.admissionId],
      );
      if (!adm.rowCount) {
        await client.query('ROLLBACK');
        return { decision: 'reject', reason: 'SERIES_TERMINAL' };
      }
      if (String(adm.rows[0].outcome) === 'applied' && adm.rows[0].result_json) {
        const result = freezeAdmissionResult(
          typeof adm.rows[0].result_json === 'string'
            ? JSON.parse(adm.rows[0].result_json)
            : adm.rows[0].result_json,
        );
        const fenceRow = await client.query(
          `SELECT * FROM series_fence_state WHERE series_key = $1`,
          [args.seriesKey],
        );
        await client.query('COMMIT');
        return {
          decision: 'apply',
          result,
          fence: mapFence(fenceRow.rows[0]),
          duplicateReplay: true,
        };
      }
      if (String(adm.rows[0].outcome) === 'rejected' && adm.rows[0].result_json) {
        const result = freezeAdmissionResult(
          typeof adm.rows[0].result_json === 'string'
            ? JSON.parse(adm.rows[0].result_json)
            : adm.rows[0].result_json,
        );
        await client.query('COMMIT');
        return {
          decision: 'reject',
          reason: result.rejectReason ?? 'SERIES_TERMINAL',
          result,
        };
      }

      const writerRow = await client.query(
        `SELECT * FROM tournament_series_writer WHERE series_key = $1 FOR UPDATE`,
        [args.seriesKey],
      );
      if (!writerRow.rowCount) {
        await client.query('ROLLBACK');
        return { decision: 'reject', reason: 'WRITER_NOT_AUTHORIZED' };
      }
      const writer = writerRow.rows[0];
      if (String(writer.player_id) !== args.playerId) {
        await this.#rejectOnly(client, args, 'SERIES_NOT_OWNED');
        return { decision: 'reject', reason: 'SERIES_NOT_OWNED' };
      }
      // P0-F11: only the active writer session/device may hand off.
      if (
        String(writer.session_id) !== args.callerSessionId ||
        String(writer.device_id) !== args.callerDeviceId
      ) {
        await this.#rejectOnly(client, args, 'WRITER_NOT_AUTHORIZED');
        return { decision: 'reject', reason: 'WRITER_NOT_AUTHORIZED' };
      }
      if (Number(writer.writer_generation) !== args.expectedWriterGeneration) {
        await this.#rejectOnly(client, args, 'STALE_WRITER');
        return { decision: 'reject', reason: 'STALE_WRITER' };
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
          decision: 'apply',
        });
        await this.#writeOutcome(client, args.admissionId, 'applied', result);
        await client.query('COMMIT');
        return { decision: 'apply', result, fence: current, duplicateReplay: true };
      }
      if (current.status === 'COMPLETED' || current.status === 'FORFEITED') {
        await this.#rejectOnly(client, args, 'SERIES_TERMINAL', current);
        return { decision: 'reject', reason: 'SERIES_TERMINAL', fence: current };
      }
      if (!isTimely(args.trustedReceivedAt, current.idleDeadlineAt)) {
        await this.#rejectOnly(client, args, 'IDLE_EXPIRED', current);
        return { decision: 'reject', reason: 'IDLE_EXPIRED', fence: current };
      }
      if (
        current.hardCutoffAt &&
        !isTimely(args.trustedReceivedAt, current.hardCutoffAt)
      ) {
        await this.#rejectOnly(client, args, 'HARD_CUTOFF_EXPIRED', current);
        return { decision: 'reject', reason: 'HARD_CUTOFF_EXPIRED', fence: current };
      }
      if (current.writerGeneration !== args.expectedWriterGeneration) {
        await this.#rejectOnly(client, args, 'STALE_WRITER', current);
        return { decision: 'reject', reason: 'STALE_WRITER', fence: current };
      }

      const nextGen = current.writerGeneration + 1;
      const nextFence: SeriesFenceState = {
        ...current,
        writerGeneration: nextGen,
        // Handoff alone must not refresh inactivity (TD-05 / Q04).
        lastAppliedAdmissionId: args.admissionId,
      };

      const time = await client.query(
        `SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS ms`,
      );
      const nowMs = Number(time.rows[0].ms);

      await client.query(
        `UPDATE tournament_series_writer
         SET writer_generation = $2, updated_at_ms = $3
         WHERE series_key = $1`,
        [args.seriesKey, nextGen, nowMs],
      );

      await client.query(
        `UPDATE series_fence_state SET
           writer_generation = $2,
           last_applied_admission_id = $3
         WHERE series_key = $1`,
        [args.seriesKey, nextGen, args.admissionId],
      );

      await client.query(
        `UPDATE authoritative_game_snapshot
         SET writer_generation = $4
         WHERE series_key = $1 AND player_id = $2 AND subgame_ordinal = $3`,
        [args.seriesKey, args.playerId, args.subgameOrdinal, nextGen],
      );

      const result = freezeAdmissionResult({
        admissionId: args.admissionId,
        playerId: args.playerId,
        seriesKey: args.seriesKey,
        subgameOrdinal: args.subgameOrdinal,
        boardRevision: nextFence.boardRevision,
        score: nextFence.score,
        scoreDelta: 0,
        terminal: false,
        terminalReason: null,
        stateHash: '',
        writerGeneration: nextGen,
        awaitAdvance: nextFence.status === 'AWAIT_ADVANCE',
        decision: 'apply',
      });
      await this.#writeOutcome(client, args.admissionId, 'applied', result);
      await client.query('COMMIT');
      return { decision: 'apply', result, fence: nextFence };
    } catch {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw new Error('HANDOFF_UNAVAILABLE');
    } finally {
      client.release();
    }
  }

  async #rejectOnly(
    client: pg.PoolClient,
    args: {
      seriesKey: string;
      playerId: string;
      subgameOrdinal: number;
      admissionId: string;
    },
    reason: string,
    fence?: SeriesFenceState,
  ): Promise<void> {
    const result = freezeAdmissionResult({
      admissionId: args.admissionId,
      playerId: args.playerId,
      seriesKey: args.seriesKey,
      subgameOrdinal: args.subgameOrdinal,
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
    await this.#writeOutcome(client, args.admissionId, 'rejected', result);
    await client.query('COMMIT');
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
}
