/**
 * PZD-40 atomic daily claim + Stage E series bootstrap.
 *
 * One PostgreSQL transaction establishes claim row, fence, first challenge,
 * snapshot and active writer binding — or returns the immutable original.
 * Never accepts client playerId/manifestDigest/seriesId as authority.
 */
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { stateToJson, type GameState } from '../../engine/core001v3/index.mts';
import {
  bindTrustedChallenge,
  digestInitialState,
} from '../adjudication/trusted-challenge.mts';
import { TRUSTED_GAMEPLAY_DDL } from '../adjudication/postgres-stores.mts';
import type { VerifiedSession } from '../auth/postgres-verified-sessions.mts';
import {
  PostgresSeriesWriterStore,
  SERIES_WRITER_DDL,
} from '../auth/series-writer-binding.mts';
import { SERIES_FENCE_DDL } from '../ingress/series-fence.mts';
import { idleDeadlineFrom } from '../ingress/types.mts';
import {
  DAILY_CLAIM_DDL,
  type ImmutableDailyClaim,
} from './postgres-daily-claim.mts';
import type { PinnedManifestRegistry } from './pinned-manifest-registry.mts';

function claimAdvisoryKeys(playerId: string, utcDate: string): [number, number] {
  const digest = createHash('sha256')
    .update(`claim:${playerId}:${utcDate}`)
    .digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export type AtomicClaimResult =
  | {
      ok: true;
      original: boolean;
      claim: ImmutableDailyClaim;
      writerGeneration: number;
      deviceId: string;
      sessionId: string;
    }
  | {
      ok: false;
      reason:
        | 'INVALID_DATE'
        | 'CLAIM_WINDOW_CLOSED'
        | 'MANIFEST_UNAVAILABLE'
        | 'UNAUTHENTICATED'
        | 'BOOTSTRAP_FAILED';
    };

function dateMs(s: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const n = Date.parse(s + 'T00:00:00.000Z');
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === s
    ? n
    : null;
}

function utcWeekStart(dayMs: number): number {
  return dayMs - ((new Date(dayMs).getUTCDay() + 6) % 7) * 86400000;
}

function mapClaim(row: Record<string, unknown>): ImmutableDailyClaim {
  return {
    seriesId: String(row.series_id),
    playerId: String(row.player_id),
    originalUtcDate: String(row.original_utc_date_text),
    startedAtMs: Number(row.started_at_ms),
    manifestDigest: String(row.manifest_digest),
    status: String(row.status) as ImmutableDailyClaim['status'],
  };
}

export class AtomicDailyClaimBootstrap {
  readonly #pool: pg.Pool;
  readonly #manifests: PinnedManifestRegistry;
  readonly #writers: PostgresSeriesWriterStore;

  constructor(pool: pg.Pool, manifests: PinnedManifestRegistry) {
    this.#pool = pool;
    this.#manifests = manifests;
    this.#writers = new PostgresSeriesWriterStore(pool);
  }

  async migrate(): Promise<void> {
    await this.#pool.query(DAILY_CLAIM_DDL);
    await this.#pool.query(SERIES_FENCE_DDL);
    await this.#pool.query(
      `ALTER TABLE series_fence_state
       ADD COLUMN IF NOT EXISTS thinking_extension_consumed BOOLEAN NOT NULL DEFAULT FALSE`,
    );
    await this.#pool.query(TRUSTED_GAMEPLAY_DDL);
    await this.#pool.query(SERIES_WRITER_DDL);
  }

  /**
   * Claim for the verified session's internal player_id only.
   * originalUtcDate is the requested calendar day; window uses DB clock.
   */
  async claimAndBootstrap(args: {
    session: VerifiedSession;
    originalUtcDate: string;
  }): Promise<AtomicClaimResult> {
    const requested = dateMs(args.originalUtcDate);
    if (requested === null) return { ok: false, reason: 'INVALID_DATE' };
    const manifest = this.#manifests.requireActive();
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize concurrent same-player/day starts before unique insert.
      const [k1, k2] = claimAdvisoryKeys(
        args.session.playerId,
        args.originalUtcDate,
      );
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);

      const time = await client.query(
        `SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS ms`,
      );
      const now = Number(time.rows[0].ms);
      const today = Math.floor(now / 86400000) * 86400000;
      if (requested < utcWeekStart(today) || requested > today) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'CLAIM_WINDOW_CLOSED' };
      }

      const seriesId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO tournament_daily_claim
           (series_id, player_id, original_utc_date, started_at_ms, manifest_digest)
         VALUES ($1, $2, $3::date, $4, $5)
         ON CONFLICT (player_id, original_utc_date) DO NOTHING
         RETURNING *, to_char(original_utc_date, 'YYYY-MM-DD') AS original_utc_date_text`,
        [
          seriesId,
          args.session.playerId,
          args.originalUtcDate,
          now,
          manifest.digest,
        ],
      );

      if (!inserted.rowCount) {
        const existing = await client.query(
          `SELECT *, to_char(original_utc_date, 'YYYY-MM-DD') AS original_utc_date_text
           FROM tournament_daily_claim
           WHERE player_id = $1 AND original_utc_date = $2::date`,
          [args.session.playerId, args.originalUtcDate],
        );
        if (!existing.rowCount) throw new Error('CLAIM_CONFLICT_MISSING');
        const claim = mapClaim(existing.rows[0]);
        const writer = await this.#writers.bindInitial(client, {
          seriesKey: claim.seriesId,
          playerId: args.session.playerId,
          sessionId: args.session.sessionId,
          deviceId: args.session.deviceId,
          nowMs: now,
        });
        await client.query('COMMIT');
        return {
          ok: true,
          original: false,
          claim,
          writerGeneration: writer.writerGeneration,
          deviceId: writer.deviceId,
          sessionId: writer.sessionId,
        };
      }

      const claim = mapClaim(inserted.rows[0]);
      const subgame = manifest.subgames.find((s) => s.ordinal === 1);
      if (!subgame) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'MANIFEST_UNAVAILABLE' };
      }

      const assignedAt = new Date(now);
      const binding = bindTrustedChallenge({
        seriesKey: claim.seriesId,
        playerId: args.session.playerId,
        subgameOrdinal: 1,
        challengeId: subgame.challengeId,
        generatorVersion: subgame.generatorVersion,
        contentVersion: subgame.contentVersion,
        initialStateRaw: subgame.initialState,
        assignedAt,
      });

      const idleDeadlineAt = idleDeadlineFrom(assignedAt, 300);
      await client.query(
        `INSERT INTO series_fence_state (
           series_key, board_revision, writer_generation, status,
           idle_deadline_at_ms, hard_cutoff_at_ms, score, results_published,
           last_applied_admission_id, thinking_extension_consumed
         ) VALUES ($1,0,1,'ACTIVE',$2,NULL,0,FALSE,NULL,FALSE)`,
        [claim.seriesId, idleDeadlineAt.getTime()],
      );

      await client.query(
        `INSERT INTO trusted_challenge_binding (
           series_key, player_id, subgame_ordinal, challenge_id,
           rules_version, generator_version, content_version,
           initial_state_digest, initial_state_json, assigned_at_ms
         ) VALUES ($1,$2,1,$3,'core-001.v3',$4,$5,$6,$7::jsonb,$8)`,
        [
          claim.seriesId,
          args.session.playerId,
          binding.challengeId,
          binding.generatorVersion,
          binding.contentVersion,
          binding.initialStateDigest,
          JSON.stringify(stateToJson(binding.initialState as GameState)),
          now,
        ],
      );

      await client.query(
        `INSERT INTO authoritative_game_snapshot (
           series_key, player_id, subgame_ordinal, challenge_id,
           board_revision, move_cursor, state_hash, score, status,
           terminal_reason, state_json, ledger_admission_seq,
           writer_generation, produced_by_admission_id
         ) VALUES ($1,$2,1,$3,0,0,$4,0,'in_progress',NULL,$5::jsonb,0,1,NULL)`,
        [
          claim.seriesId,
          args.session.playerId,
          binding.challengeId,
          digestInitialState(binding.initialState as GameState),
          JSON.stringify(stateToJson(binding.initialState as GameState)),
        ],
      );

      const writer = await this.#writers.bindInitial(client, {
        seriesKey: claim.seriesId,
        playerId: args.session.playerId,
        sessionId: args.session.sessionId,
        deviceId: args.session.deviceId,
        nowMs: now,
      });

      await client.query('COMMIT');
      return {
        ok: true,
        original: true,
        claim,
        writerGeneration: writer.writerGeneration,
        deviceId: writer.deviceId,
        sessionId: writer.sessionId,
      };
    } catch {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      return { ok: false, reason: 'BOOTSTRAP_FAILED' };
    } finally {
      client.release();
    }
  }

  async getClaimForPlayer(
    playerId: string,
    seriesId: string,
  ): Promise<ImmutableDailyClaim | null> {
    const res = await this.#pool.query(
      `SELECT *, to_char(original_utc_date, 'YYYY-MM-DD') AS original_utc_date_text
       FROM tournament_daily_claim
       WHERE series_id = $1 AND player_id = $2`,
      [seriesId, playerId],
    );
    if (!res.rowCount) return null;
    return mapClaim(res.rows[0]);
  }
}
