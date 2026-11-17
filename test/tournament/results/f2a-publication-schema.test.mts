/**
 * PZD-41 F2-A — schema helpers + PostgreSQL constraint proofs.
 * Does NOT implement atomic publication (F2-B).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DAILY_CLAIM_DDL } from '../../../src/tournament/claims/postgres-daily-claim.mts';
import {
  F2A_CATEGORIES,
  F2A_PUBLICATION_DDL,
  F2A_PUBLICATION_DROP_DDL,
  onTimeBadgeFromClaim,
  publicationIdempotencyKey,
} from '../../../src/tournament/results/f2a-publication-schema.mts';

const url = process.env.PZD_INGRESS_DATABASE_URL;

describe('PZD-41 F2-A — on-time + idempotency helpers', () => {
  it('On-Time uses claim start within original UTC date only', () => {
    assert.equal(
      onTimeBadgeFromClaim({
        originalUtcDate: '2026-11-17',
        claimStartedAtMs: Date.parse('2026-11-17T00:00:00.000Z'),
      }),
      true,
    );
    assert.equal(
      onTimeBadgeFromClaim({
        originalUtcDate: '2026-11-17',
        claimStartedAtMs: Date.parse('2026-11-17T23:59:59.999Z'),
      }),
      true,
    );
    assert.equal(
      onTimeBadgeFromClaim({
        originalUtcDate: '2026-11-17',
        claimStartedAtMs: Date.parse('2026-11-18T00:00:00.000Z'),
      }),
      false,
    );
    assert.equal(
      onTimeBadgeFromClaim({
        originalUtcDate: '2026-11-17',
        claimStartedAtMs: Date.parse('2026-11-16T23:59:59.999Z'),
      }),
      false,
    );
  });

  it('publication idempotency key is stable per series UUID', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    assert.equal(publicationIdempotencyKey(id), 'f2-publish:11111111-1111-4111-8111-111111111111');
    assert.throws(() => publicationIdempotencyKey('not-a-uuid'));
  });
});

describe('PZD-41 F2-A — PostgreSQL additive schema constraints', () => {
  it('enforces FK, exactly-once completion/categories/badge, and rejects orphan categories', async () => {
    assert.ok(url, 'PostgreSQL required for F2-A schema proofs');
    const pool = new pg.Pool({ connectionString: url, max: 4 });
    try {
      await pool.query(F2A_PUBLICATION_DROP_DDL);
      await pool.query('DROP TABLE IF EXISTS tournament_daily_claim');
      await pool.query(DAILY_CLAIM_DDL);
      await pool.query(F2A_PUBLICATION_DDL);

      const seriesId = randomUUID();
      const playerId = 'player-f2a-1';
      const date = '2026-11-17';
      const started = Date.parse('2026-11-17T12:00:00.000Z');
      const digest = 'a'.repeat(64);

      await pool.query(
        `INSERT INTO tournament_daily_claim
           (series_id, player_id, original_utc_date, started_at_ms, manifest_digest, status)
         VALUES ($1,$2,$3::date,$4,$5,'ACTIVE')`,
        [seriesId, playerId, date, started, digest],
      );

      // Orphan category without completion must fail FK.
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO tournament_daily_result_category (series_id, category, score)
             VALUES ($1,'EASY',1)`,
            [seriesId],
          ),
        /foreign key|violates/i,
      );

      const idem = publicationIdempotencyKey(seriesId);
      await pool.query(
        `INSERT INTO tournament_daily_series_completion
           (series_id, player_id, original_utc_date, claim_started_at_ms, completed_at_ms,
            manifest_digest, publication_idempotency_key, revision)
         VALUES ($1,$2,$3::date,$4,$5,$6,$7,1)`,
        [seriesId, playerId, date, started, started + 60_000, digest, idem],
      );

      // Duplicate completion (same series) rejected.
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO tournament_daily_series_completion
               (series_id, player_id, original_utc_date, claim_started_at_ms, completed_at_ms,
                manifest_digest, publication_idempotency_key, revision)
             VALUES ($1,$2,$3::date,$4,$5,$6,$7,1)`,
            [seriesId, playerId, date, started, started + 1, digest, idem + ':dup'],
          ),
        /duplicate|unique/i,
      );

      // Duplicate idempotency key rejected.
      const otherSeries = randomUUID();
      await pool.query(
        `INSERT INTO tournament_daily_claim
           (series_id, player_id, original_utc_date, started_at_ms, manifest_digest, status)
         VALUES ($1,$2,$3::date,$4,$5,'ACTIVE')`,
        [otherSeries, 'player-f2a-2', date, started, digest],
      );
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO tournament_daily_series_completion
               (series_id, player_id, original_utc_date, claim_started_at_ms, completed_at_ms,
                manifest_digest, publication_idempotency_key, revision)
             VALUES ($1,$2,$3::date,$4,$5,$6,$7,1)`,
            [otherSeries, 'player-f2a-2', date, started, started + 1, digest, idem],
          ),
        /duplicate|unique/i,
      );

      for (let ordinal = 1; ordinal <= 6; ordinal += 1) {
        await pool.query(
          `INSERT INTO tournament_verified_subgame_score
             (series_id, subgame_ordinal, challenge_id, state_hash, score,
              ledger_admission_seq, produced_by_admission_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            seriesId,
            ordinal,
            `chal-${ordinal}`,
            'b'.repeat(64),
            ordinal * 10,
            ordinal,
            randomUUID(),
          ],
        );
      }
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO tournament_verified_subgame_score
               (series_id, subgame_ordinal, challenge_id, state_hash, score, ledger_admission_seq)
             VALUES ($1,3,'chal-3',$2,1,3)`,
            [seriesId, 'c'.repeat(64)],
          ),
        /duplicate|unique/i,
      );
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO tournament_verified_subgame_score
               (series_id, subgame_ordinal, challenge_id, state_hash, score, ledger_admission_seq)
             VALUES ($1,7,'chal-x',$2,1,1)`,
            [seriesId, 'd'.repeat(64)],
          ),
        /check|violates/i,
      );

      for (const category of F2A_CATEGORIES) {
        await pool.query(
          `INSERT INTO tournament_daily_result_category (series_id, category, score)
           VALUES ($1,$2,$3)`,
          [seriesId, category, category === 'ALL' ? 210 : 70],
        );
      }
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO tournament_daily_result_category (series_id, category, score)
             VALUES ($1,'EASY',1)`,
            [seriesId],
          ),
        /duplicate|unique/i,
      );
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO tournament_daily_result_category (series_id, category, score)
             VALUES ($1,'EASYX',1)`,
            [seriesId],
          ),
        /check|violates/i,
      );

      const awarded = onTimeBadgeFromClaim({
        originalUtcDate: date,
        claimStartedAtMs: started,
      });
      await pool.query(
        `INSERT INTO tournament_on_time_badge
           (series_id, awarded, claim_started_at_ms, original_utc_date)
         VALUES ($1,$2,$3,$4::date)`,
        [seriesId, awarded, started, date],
      );
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO tournament_on_time_badge
               (series_id, awarded, claim_started_at_ms, original_utc_date)
             VALUES ($1,false,$2,$3::date)`,
            [seriesId, started, date],
          ),
        /duplicate|unique/i,
      );

      const cats = await pool.query(
        `SELECT category FROM tournament_daily_result_category WHERE series_id = $1 ORDER BY category`,
        [seriesId],
      );
      assert.deepEqual(
        cats.rows.map((r) => r.category),
        ['ALL', 'EASY', 'HARD', 'MEDIUM'],
      );
      const scores = await pool.query(
        `SELECT COUNT(*)::int AS n FROM tournament_verified_subgame_score WHERE series_id = $1`,
        [seriesId],
      );
      assert.equal(scores.rows[0].n, 6);
    } finally {
      await pool.query(F2A_PUBLICATION_DROP_DDL);
      await pool.query('DROP TABLE IF EXISTS tournament_daily_claim');
      await pool.end();
    }
  });
});
