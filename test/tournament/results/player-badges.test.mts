/**
 * PZD-43 — authenticated player badge collection read model.
 * No new grant rules; counts come only from immutable F2-B badge rows.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DAILY_CLAIM_DDL } from '../../../src/tournament/claims/postgres-daily-claim.mts';
import {
  F2A_PUBLICATION_DROP_DDL,
  migrateF2APublicationSchema,
  publicationIdempotencyKey,
} from '../../../src/tournament/results/f2a-publication-schema.mts';
import {
  clampBadgeGrantLimit,
  loadPlayerBadgeCollection,
} from '../../../src/tournament/results/player-badges.mts';

const url = process.env.PZD_INGRESS_DATABASE_URL;

describe('PZD-43 player badge helpers', () => {
  it('clamps grantLimit safely', () => {
    assert.equal(clampBadgeGrantLimit(undefined), 50);
    assert.equal(clampBadgeGrantLimit(0), 50);
    assert.equal(clampBadgeGrantLimit(-1), 50);
    assert.equal(clampBadgeGrantLimit(3), 3);
    assert.equal(clampBadgeGrantLimit(1000), 100);
  });
});

describe('PZD-43 loadPlayerBadgeCollection', () => {
  it('counts only awarded On-Time rows for the authenticated player', async (t) => {
    if (!url) {
      t.skip('PostgreSQL required');
      return;
    }
    const pool = new pg.Pool({ connectionString: url, max: 4 });
    t.after(async () => {
      await pool.query(F2A_PUBLICATION_DROP_DDL);
      await pool.query('DROP TABLE IF EXISTS tournament_daily_claim CASCADE');
      await pool.end();
    });

    await pool.query(F2A_PUBLICATION_DROP_DDL);
    await pool.query('DROP TABLE IF EXISTS tournament_daily_claim CASCADE');
    await pool.query(DAILY_CLAIM_DDL);
    await migrateF2APublicationSchema(pool);

    const playerA = randomUUID();
    const playerB = randomUUID();
    const seriesA1 = randomUUID();
    const seriesA2 = randomUUID();
    const seriesB = randomUUID();
    const started = Date.parse('2026-11-17T12:00:00.000Z');

    async function seed(args: {
      seriesId: string;
      playerId: string;
      date: string;
      awarded: boolean;
    }) {
      await pool.query(
        `INSERT INTO tournament_daily_claim
           (series_id, player_id, original_utc_date, started_at_ms, manifest_digest, status)
         VALUES ($1,$2,$3::date,$4,$5,'COMPLETED')`,
        [args.seriesId, args.playerId, args.date, started, 'a'.repeat(64)],
      );
      await pool.query(
        `INSERT INTO tournament_daily_series_completion
           (series_id, player_id, original_utc_date, claim_started_at_ms, completed_at_ms,
            manifest_digest, publication_idempotency_key, revision)
         VALUES ($1,$2,$3::date,$4,$5,$6,$7,1)`,
        [
          args.seriesId,
          args.playerId,
          args.date,
          started,
          started + 60_000,
          'a'.repeat(64),
          publicationIdempotencyKey(args.seriesId),
        ],
      );
      await pool.query(
        `INSERT INTO tournament_on_time_badge
           (series_id, awarded, claim_started_at_ms, original_utc_date)
         VALUES ($1,$2,$3,$4::date)`,
        [args.seriesId, args.awarded, started, args.date],
      );
    }

    await seed({
      seriesId: seriesA1,
      playerId: playerA,
      date: '2026-11-16',
      awarded: true,
    });
    await seed({
      seriesId: seriesA2,
      playerId: playerA,
      date: '2026-11-17',
      awarded: true,
    });
    await seed({
      seriesId: seriesB,
      playerId: playerB,
      date: '2026-11-17',
      awarded: true,
    });

    const forA = await loadPlayerBadgeCollection(pool, playerA);
    assert.equal(forA.playerScoped, true);
    assert.equal(forA.badges.length, 1);
    assert.equal(forA.badges[0]?.badgeId, 'on_time');
    assert.equal(forA.badges[0]?.earnedCount, 2);
    assert.equal(forA.badges[0]?.lastEarnedAt, '2026-11-17');
    assert.equal(forA.badges[0]?.grants.length, 2);
    assert.equal(forA.badges[0]?.provenance, 'f2b_publication');
    assert.equal(forA.badges[0]?.repeatable, true);

    const forB = await loadPlayerBadgeCollection(pool, playerB);
    assert.equal(forB.badges[0]?.earnedCount, 1);
    assert.equal(forB.badges[0]?.grants[0]?.seriesId, seriesB);

    const empty = await loadPlayerBadgeCollection(pool, randomUUID());
    assert.equal(empty.badges[0]?.earnedCount, 0);
    assert.equal(empty.badges[0]?.lastEarnedAt, null);
    assert.equal(empty.badges[0]?.grants.length, 0);

    // awarded=false does not increment.
    const seriesMiss = randomUUID();
    await seed({
      seriesId: seriesMiss,
      playerId: playerA,
      date: '2026-11-18',
      awarded: false,
    });
    const afterMiss = await loadPlayerBadgeCollection(pool, playerA);
    assert.equal(afterMiss.badges[0]?.earnedCount, 2);
  });
});
