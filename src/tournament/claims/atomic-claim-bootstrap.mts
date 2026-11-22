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
import { lockWeeklySettlement, SERIES_FENCE_DDL } from '../ingress/series-fence.mts';
import { idleDeadlineFrom } from '../ingress/types.mts';
import {
  DAILY_CLAIM_DDL,
  type ImmutableDailyClaim,
} from './postgres-daily-claim.mts';
import { computeSeriesHardCutoffMs } from './hard-cutoff.mts';
import type { PinnedDailyManifest, PinnedManifestRegistry } from './pinned-manifest-registry.mts';
import { selectOrCreateUtcDailyManifest } from '../uat/postgres-utc-daily-manifests.mts';

function dayManifestAdvisoryKeys(_utcDate: string): [number, number] {
  // One global lock serializes adjacent-day manifest creation as well:
  // a backfilled old date cannot race with tomorrow's first claim.
  const digest = createHash('sha256').update('manifest:all-utc-dates:v1').digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

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

/**
 * Monday 00:00 UTC closes new claims for every earlier week.
 * The bootstrap calls this with the PostgreSQL clock sampled after the
 * weekly settlement lock. An invalid date or timestamp fails closed.
 */
export function claimWindowClosed(nowMs: number, originalUtcDate: string): boolean {
  const requested = dateMs(originalUtcDate);
  if (requested === null || !Number.isSafeInteger(nowMs)) return true;
  const today = Math.floor(nowMs / 86400000) * 86400000;
  return requested < utcWeekStart(today) || requested > today;
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
  readonly #anchorOriginalDevice: boolean;
  readonly #enableUtcDailyManifests: boolean;

  constructor(
    pool: pg.Pool,
    manifests: PinnedManifestRegistry,
    options: { anchorOriginalDevice?: boolean; enableUtcDailyManifests?: boolean } = {},
  ) {
    this.#anchorOriginalDevice = options.anchorOriginalDevice === true;
    this.#enableUtcDailyManifests = options.enableUtcDailyManifests === true;
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
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // Before the trusted clock sample, so a claim blocked by FINAL cannot
      // keep a pre-cutoff timestamp and appear after the week is closed.
      await lockWeeklySettlement(client);
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
      if (claimWindowClosed(now, args.originalUtcDate)) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'CLAIM_WINDOW_CLOSED' };
      }

      let manifest: PinnedDailyManifest = this.#manifests.requireActive();
      if (this.#enableUtcDailyManifests) {
        // Serialize ALL players' first claim for a UTC day, independently
        // of the existing per-player/day claim lock.
        const [dayKey1, dayKey2] = dayManifestAdvisoryKeys(args.originalUtcDate);
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [dayKey1, dayKey2]);
        const historical = await client.query(
          `SELECT DISTINCT manifest_digest FROM tournament_daily_claim
           WHERE original_utc_date=$1::date`,
          [args.originalUtcDate],
        );
        if (historical.rows.length > 1) throw new Error('MIXED_DAILY_MANIFEST_DIGEST');
        const previousDigest = historical.rows.length === 1
          ? String(historical.rows[0].manifest_digest) : null;
        const pinnedLegacy = previousDigest ? this.#manifests.get(previousDigest) : null;
        if (pinnedLegacy) {
          // On a mid-day opt-in, preserve every existing player's challenge
          // instead of silently giving later arrivals a different set.
          manifest = pinnedLegacy;
        } else {
          manifest = await selectOrCreateUtcDailyManifest(client, args.originalUtcDate);
          if (previousDigest !== null && previousDigest !== manifest.digest) {
            throw new Error('DAILY_MANIFEST_CUTOVER_CONFLICT');
          }
        }
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
      if (manifest.subgames.length !== 6) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'MANIFEST_UNAVAILABLE' };
      }

      const hardCutoffMs = computeSeriesHardCutoffMs({
        originalUtcDate: claim.originalUtcDate,
        startedAtMs: claim.startedAtMs,
      });
      if (hardCutoffMs === null) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'BOOTSTRAP_FAILED' };
      }

      const assignedAt = new Date(now);
      const idleDeadlineAt = idleDeadlineFrom(assignedAt, 300);
      await client.query(
        `INSERT INTO series_fence_state (
           series_key, board_revision, writer_generation, status,
           idle_deadline_at_ms, hard_cutoff_at_ms, score, results_published,
           last_applied_admission_id, thinking_extension_consumed
         ) VALUES ($1,0,1,'ACTIVE',$2,$3,0,FALSE,NULL,FALSE)`,
        [claim.seriesId, idleDeadlineAt.getTime(), hardCutoffMs],
      );

      // Pin all six challenges at claim time; snapshot only ordinal 1 until Advance.
      for (const subgame of manifest.subgames) {
        const binding = bindTrustedChallenge({
          seriesKey: claim.seriesId,
          playerId: args.session.playerId,
          subgameOrdinal: subgame.ordinal,
          challengeId: subgame.challengeId,
          generatorVersion: subgame.generatorVersion,
          contentVersion: subgame.contentVersion,
          initialStateRaw: subgame.initialState,
          assignedAt,
        });
        await client.query(
          `INSERT INTO trusted_challenge_binding (
             series_key, player_id, subgame_ordinal, challenge_id,
             rules_version, generator_version, content_version,
             initial_state_digest, initial_state_json, assigned_at_ms
           ) VALUES ($1,$2,$3,$4,'core-001.v3',$5,$6,$7,$8::jsonb,$9)`,
          [
            claim.seriesId,
            args.session.playerId,
            subgame.ordinal,
            binding.challengeId,
            binding.generatorVersion,
            binding.contentVersion,
            binding.initialStateDigest,
            JSON.stringify(stateToJson(binding.initialState as GameState)),
            now,
          ],
        );
        if (subgame.ordinal === 1) {
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
        }
      }

      const writer = await this.#writers.bindInitial(client, {
        seriesKey: claim.seriesId,
        playerId: args.session.playerId,
        sessionId: args.session.sessionId,
        deviceId: args.session.deviceId,
        nowMs: now,
      });
      if (this.#anchorOriginalDevice) {
        // Only the ORIGINAL immutable claim may pin its registered device key.
        // Existing claims never backfill an anchor on a later login.
        const pinned = await client.query(
          `UPDATE tournament_series_writer w SET original_device_credential_id=s.device_credential_id
           FROM tournament_auth_session s
           WHERE w.series_key=$1 AND w.player_id=$2 AND w.session_id=$3
             AND s.session_id=$3 AND s.player_id=$2
             AND s.device_credential_id IS NOT NULL
             AND w.original_device_credential_id IS NULL`,
          [claim.seriesId, args.session.playerId, args.session.sessionId],
        );
        // No new ranked claim with an unanchored writer while recovery is
        // explicitly enabled. Roll back the entire first-claim transaction.
        // Existing claims never reach this block and are never backfilled.
        if (pinned.rowCount !== 1) throw new Error('ORIGINAL_DEVICE_KEY_REQUIRED');
      }

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
