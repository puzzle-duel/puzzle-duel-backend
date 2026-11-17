/**
 * PZD-41 F2-A — hardened schema, claim integrity, readiness predicate proofs.
 * Structural readiness only — not trusted gameplay/replay authorization (F2-B).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DAILY_CLAIM_DDL } from '../../../src/tournament/claims/postgres-daily-claim.mts';
import { computeFourCategoryScores } from '../../../src/tournament/results/four-category-scores.mts';
import {
  F2A_CATEGORIES,
  F2A_PUBLICATION_DROP_DDL,
  F2A_PUBLICATION_UPGRADE_DDL,
  F2B_TRUSTED_PROVENANCE_BRAND,
  evaluateLeaderboardReadEligibility,
  evaluatePublicationReadiness,
  evaluateStructuralReadiness,
  migrateF2APublicationSchema,
  onTimeBadgeFromClaim,
  publicationIdempotencyKey,
  type F2BTrustedProvenanceAttestation,
} from '../../../src/tournament/results/f2a-publication-schema.mts';

const url = process.env.PZD_INGRESS_DATABASE_URL;

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const HASH = 'c'.repeat(64);

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
    assert.equal(
      publicationIdempotencyKey(id),
      'f2-publish:11111111-1111-4111-8111-111111111111',
    );
    assert.throws(() => publicationIdempotencyKey('not-a-uuid'));
  });
});

type Pool = pg.Pool;

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query(F2A_PUBLICATION_DROP_DDL);
  await pool.query('DROP TABLE IF EXISTS tournament_daily_claim CASCADE');
  await pool.query(DAILY_CLAIM_DDL);
  await migrateF2APublicationSchema(pool);
}

async function insertClaim(
  pool: Pool,
  args: {
    seriesId: string;
    playerId: string;
    date: string;
    started: number;
    digest?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO tournament_daily_claim
       (series_id, player_id, original_utc_date, started_at_ms, manifest_digest, status)
     VALUES ($1,$2,$3::date,$4,$5,'ACTIVE')`,
    [args.seriesId, args.playerId, args.date, args.started, args.digest ?? DIGEST_A],
  );
}

async function insertCompletion(
  pool: Pool | pg.PoolClient,
  args: {
    seriesId: string;
    playerId: string;
    date: string;
    started: number;
    completed?: number;
    digest?: string;
    idem?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO tournament_daily_series_completion
       (series_id, player_id, original_utc_date, claim_started_at_ms, completed_at_ms,
        manifest_digest, publication_idempotency_key, revision)
     VALUES ($1,$2,$3::date,$4,$5,$6,$7,1)`,
    [
      args.seriesId,
      args.playerId,
      args.date,
      args.started,
      args.completed ?? args.started + 60_000,
      args.digest ?? DIGEST_A,
      args.idem ?? publicationIdempotencyKey(args.seriesId),
    ],
  );
}

const SCORES = [10, 20, 30, 40, 50, 60];

async function insertSixSubgames(
  pool: Pool | pg.PoolClient,
  seriesId: string,
  scores: number[] = SCORES,
): Promise<void> {
  for (let ordinal = 1; ordinal <= 6; ordinal += 1) {
    await pool.query(
      `INSERT INTO tournament_verified_subgame_score
         (series_id, subgame_ordinal, challenge_id, state_hash, score, ledger_admission_seq)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [seriesId, ordinal, `chal-${ordinal}`, HASH, scores[ordinal - 1], ordinal],
    );
  }
}

async function insertCategories(
  pool: Pool | pg.PoolClient,
  seriesId: string,
  scores: number[] = SCORES,
): Promise<void> {
  const cats = computeFourCategoryScores(
    scores.map((score, i) => ({ ordinal: i + 1, score })),
  );
  const map: Record<string, number> = {
    EASY: cats.easy,
    MEDIUM: cats.medium,
    HARD: cats.hard,
    ALL: cats.all,
  };
  for (const category of F2A_CATEGORIES) {
    await pool.query(
      `INSERT INTO tournament_daily_result_category (series_id, category, score)
       VALUES ($1,$2,$3)`,
      [seriesId, category, map[category]],
    );
  }
}

async function insertBadge(
  pool: Pool | pg.PoolClient,
  args: { seriesId: string; date: string; started: number; awarded?: boolean },
): Promise<void> {
  const awarded =
    args.awarded ??
    onTimeBadgeFromClaim({
      originalUtcDate: args.date,
      claimStartedAtMs: args.started,
    });
  await pool.query(
    `INSERT INTO tournament_on_time_badge
       (series_id, awarded, claim_started_at_ms, original_utc_date)
     VALUES ($1,$2,$3,$4::date)`,
    [args.seriesId, awarded, args.started, args.date],
  );
}

async function publishComplete(
  pool: Pool | pg.PoolClient,
  args: {
    seriesId: string;
    playerId: string;
    date: string;
    started: number;
    scores?: number[];
  },
): Promise<void> {
  const scores = args.scores ?? SCORES;
  await insertCompletion(pool, args);
  await insertSixSubgames(pool, args.seriesId, scores);
  await insertCategories(pool, args.seriesId, scores);
  await insertBadge(pool, args);
}

describe('PZD-41 F2-A — claim identity integrity + readiness', () => {
  it('adversarial matrix: mismatches NOT_VISIBLE; complete fixture visible; isolation/rollback', async () => {
    assert.ok(url, 'PostgreSQL required for F2-A schema proofs');
    const pool = new pg.Pool({ connectionString: url, max: 6 });
    const matrix: Array<{ case: string; result: 'PASS' | 'FAIL'; detail: string }> = [];
    const record = (name: string, ok: boolean, detail: string) => {
      matrix.push({ case: name, result: ok ? 'PASS' : 'FAIL', detail });
      assert.ok(ok, `${name}: ${detail}`);
    };

    try {
      await resetSchema(pool);

      const date = '2026-11-17';
      const started = Date.parse('2026-11-17T12:00:00.000Z');
      const seriesId = randomUUID();
      const playerId = 'player-f2a-1';
      await insertClaim(pool, { seriesId, playerId, date, started });

      // --- Claim identity FK adversarial ---
      try {
        await insertCompletion(pool, {
          seriesId,
          playerId: 'other-player',
          date,
          started,
        });
        record('completion.player_id mismatch', false, 'insert succeeded');
      } catch (e) {
        record(
          'completion.player_id mismatch',
          /foreign key|violates/i.test(String(e)),
          String(e),
        );
      }

      try {
        await insertCompletion(pool, {
          seriesId,
          playerId,
          date: '2026-11-16',
          started,
        });
        record('completion.original_utc_date mismatch', false, 'insert succeeded');
      } catch (e) {
        record(
          'completion.original_utc_date mismatch',
          /foreign key|violates/i.test(String(e)),
          String(e),
        );
      }

      try {
        await insertCompletion(pool, {
          seriesId,
          playerId,
          date,
          started: started + 1,
        });
        record('completion.claim_started_at_ms mismatch', false, 'insert succeeded');
      } catch (e) {
        record(
          'completion.claim_started_at_ms mismatch',
          /foreign key|violates/i.test(String(e)),
          String(e),
        );
      }

      try {
        await insertCompletion(pool, {
          seriesId,
          playerId,
          date,
          started,
          digest: DIGEST_B,
        });
        record('completion.manifest_digest mismatch', false, 'insert succeeded');
      } catch (e) {
        record(
          'completion.manifest_digest mismatch',
          /foreign key|violates/i.test(String(e)),
          String(e),
        );
      }

      // Claim identity immutable on UPDATE
      try {
        await pool.query(
          `UPDATE tournament_daily_claim SET player_id = 'mutated' WHERE series_id = $1`,
          [seriesId],
        );
        record('claim identity UPDATE rejected', false, 'update succeeded');
      } catch (e) {
        record(
          'claim identity UPDATE rejected',
          /TOURNAMENT_DAILY_CLAIM_IDENTITY_IMMUTABLE|integrity/i.test(String(e)),
          String(e),
        );
      }

      // Status-only update still allowed
      await pool.query(
        `UPDATE tournament_daily_claim SET status = 'AWAIT_ADVANCE' WHERE series_id = $1`,
        [seriesId],
      );
      record('claim status UPDATE allowed', true, 'status-only update ok');

      // Missing completion => NOT_VISIBLE
      {
        const r = await evaluatePublicationReadiness(pool, seriesId);
        record(
          'missing completion receipt',
          r.visible === false && r.reason === 'NOT_VISIBLE',
          JSON.stringify(r),
        );
      }

      await insertCompletion(pool, { seriesId, playerId, date, started });

      // Five of six subgames
      for (let ordinal = 1; ordinal <= 5; ordinal += 1) {
        await pool.query(
          `INSERT INTO tournament_verified_subgame_score
             (series_id, subgame_ordinal, challenge_id, state_hash, score, ledger_admission_seq)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [seriesId, ordinal, `chal-${ordinal}`, HASH, SCORES[ordinal - 1], ordinal],
        );
      }
      {
        const r = await evaluatePublicationReadiness(pool, seriesId);
        record(
          'five of six verified subgames',
          r.visible === false,
          JSON.stringify(r),
        );
      }

      // Duplicate ordinal rejected at PK
      try {
        await pool.query(
          `INSERT INTO tournament_verified_subgame_score
             (series_id, subgame_ordinal, challenge_id, state_hash, score, ledger_admission_seq)
           VALUES ($1,3,'chal-3',$2,1,3)`,
          [seriesId, HASH],
        );
        record('duplicate ordinal', false, 'insert succeeded');
      } catch (e) {
        record('duplicate ordinal', /duplicate|unique/i.test(String(e)), String(e));
      }

      // Complete sixth ordinal then wrong category set
      await pool.query(
        `INSERT INTO tournament_verified_subgame_score
           (series_id, subgame_ordinal, challenge_id, state_hash, score, ledger_admission_seq)
         VALUES ($1,6,'chal-6',$2,$3,6)`,
        [seriesId, HASH, SCORES[5]],
      );

      // Three of four categories
      await pool.query(
        `INSERT INTO tournament_daily_result_category (series_id, category, score)
         VALUES ($1,'EASY',60),($1,'MEDIUM',90),($1,'HARD',60)`,
        [seriesId],
      );
      {
        const r = await evaluatePublicationReadiness(pool, seriesId);
        record('three of four categories', r.visible === false, JSON.stringify(r));
      }

      await pool.query(
        `INSERT INTO tournament_daily_result_category (series_id, category, score)
         VALUES ($1,'ALL',999)`,
        [seriesId],
      );
      {
        const r = await evaluatePublicationReadiness(pool, seriesId);
        record(
          'incorrect category total / missing badge',
          r.visible === false,
          JSON.stringify(r),
        );
      }

      // Fix categories to match but wrong badge awarded
      await pool.query(`DELETE FROM tournament_daily_result_category WHERE series_id = $1`, [
        seriesId,
      ]);
      await insertCategories(pool, seriesId);
      await pool.query(
        `INSERT INTO tournament_on_time_badge
           (series_id, awarded, claim_started_at_ms, original_utc_date)
         VALUES ($1,false,$2,$3::date)`,
        [seriesId, started, date],
      );
      {
        const r = await evaluatePublicationReadiness(pool, seriesId);
        // started is mid-day so awarded should be true; false is inconsistent
        record(
          'inconsistent On-Time badge decision',
          r.visible === false,
          JSON.stringify(r),
        );
      }

      await pool.query(`DELETE FROM tournament_on_time_badge WHERE series_id = $1`, [
        seriesId,
      ]);
      {
        const r = await evaluatePublicationReadiness(pool, seriesId);
        record('missing On-Time badge decision', r.visible === false, JSON.stringify(r));
      }

      // Badge with wrong claim start rejected by FK
      try {
        await pool.query(
          `INSERT INTO tournament_on_time_badge
             (series_id, awarded, claim_started_at_ms, original_utc_date)
           VALUES ($1,true,$2,$3::date)`,
          [seriesId, started + 5, date],
        );
        record('badge claim_started mismatch FK', false, 'insert succeeded');
      } catch (e) {
        record(
          'badge claim_started mismatch FK',
          /foreign key|violates/i.test(String(e)),
          String(e),
        );
      }

      await insertBadge(pool, { seriesId, date, started });
      {
        const r = await evaluatePublicationReadiness(pool, seriesId);
        const structural = await evaluateStructuralReadiness(pool, seriesId);
        const leaderboard = await evaluateLeaderboardReadEligibility(
          pool,
          seriesId,
          null,
        );
        record(
          'correct complete fixture visible',
          r.visible === true &&
            r.easy === 60 &&
            r.medium === 90 &&
            r.hard === 60 &&
            r.all === 210 &&
            r.onTimeAwarded === true &&
            structural.structurallyComplete === true &&
            structural.replayVerified === false &&
            structural.publicationAuthorized === false &&
            leaderboard.authorized === false &&
            leaderboard.reason === 'TRUSTED_PROVENANCE_REQUIRED',
          JSON.stringify({ r, structural, leaderboard }),
        );
      }

      // Idempotency: duplicate key cannot create second publication
      const otherSeries = randomUUID();
      await insertClaim(pool, {
        seriesId: otherSeries,
        playerId: 'player-f2a-2',
        date,
        started,
      });
      try {
        await insertCompletion(pool, {
          seriesId: otherSeries,
          playerId: 'player-f2a-2',
          date,
          started,
          idem: publicationIdempotencyKey(seriesId),
        });
        record('repeated idempotency key', false, 'insert succeeded');
      } catch (e) {
        record(
          'repeated idempotency key',
          /duplicate|unique/i.test(String(e)),
          String(e),
        );
      }

      // DELETE claim blocked while completion exists
      try {
        await pool.query(`DELETE FROM tournament_daily_claim WHERE series_id = $1`, [
          seriesId,
        ]);
        record('DELETE claim with completion', false, 'delete succeeded');
      } catch (e) {
        record(
          'DELETE claim with completion',
          /foreign key|violates|restrict/i.test(String(e)),
          String(e),
        );
      }

      // Uncommitted TX cannot leak published rows to second connection
      const seriesTx = randomUUID();
      await insertClaim(pool, {
        seriesId: seriesTx,
        playerId: 'player-f2a-tx',
        date,
        started,
      });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await publishComplete(client, {
          seriesId: seriesTx,
          playerId: 'player-f2a-tx',
          date,
          started,
        });
        const inside = await evaluatePublicationReadiness(client, seriesTx);
        const outside = await evaluatePublicationReadiness(pool, seriesTx);
        record(
          'uncommitted TX no leak to second connection',
          inside.visible === true && outside.visible === false,
          JSON.stringify({ inside, outside }),
        );
        await client.query('ROLLBACK');
        const after = await evaluatePublicationReadiness(pool, seriesTx);
        record(
          'rollback leaves zero visible results',
          after.visible === false,
          JSON.stringify(after),
        );
      } finally {
        client.release();
      }

      // Upgrade DDL is compatible after clean migrate (no mismatched rows)
      await pool.query(F2A_PUBLICATION_UPGRADE_DDL);
      {
        const r = await evaluatePublicationReadiness(pool, seriesId);
        record(
          'upgrade DDL compatibility on clean schema',
          r.visible === true,
          JSON.stringify(r),
        );
      }

      console.log(
        'F2A_ADVERSARIAL_MATRIX ' +
          JSON.stringify(
            matrix.map((m) => ({ case: m.case, result: m.result })),
          ),
      );
      assert.equal(
        matrix.every((m) => m.result === 'PASS'),
        true,
        'adversarial matrix contains FAIL',
      );
    } finally {
      await pool.query(F2A_PUBLICATION_DROP_DDL);
      await pool.query('DROP TABLE IF EXISTS tournament_daily_claim CASCADE');
      await pool.end();
    }
  });
});


describe('PZD-41 F2-A — structural readiness is not publication authorization', () => {
  it('synthetic structurally-complete rows remain leaderboard-unauthorized', async () => {
    assert.ok(url, 'PostgreSQL required');
    const pool = new pg.Pool({ connectionString: url, max: 4 });
    try {
      await resetSchema(pool);
      const seriesId = randomUUID();
      const date = '2026-11-17';
      const started = Date.parse('2026-11-17T08:00:00.000Z');
      await insertClaim(pool, {
        seriesId,
        playerId: 'synthetic-player',
        date,
        started,
      });
      // Synthetic fixture — structurally complete, NOT Stage E replay-verified.
      await publishComplete(pool, {
        seriesId,
        playerId: 'synthetic-player',
        date,
        started,
      });

      const structural = await evaluateStructuralReadiness(pool, seriesId);
      assert.equal(structural.structurallyComplete, true);
      if (!structural.structurallyComplete) return;
      assert.equal(structural.replayVerified, false);
      assert.equal(structural.publicationAuthorized, false);

      const viewFlags = await pool.query(
        `SELECT replay_verified, publication_authorized
         FROM tournament_f2a_structural_readiness WHERE series_id = $1`,
        [seriesId],
      );
      assert.equal(viewFlags.rows.length, 1);
      assert.equal(viewFlags.rows[0].replay_verified, false);
      assert.equal(viewFlags.rows[0].publication_authorized, false);

      const withoutAttestation = await evaluateLeaderboardReadEligibility(
        pool,
        seriesId,
        null,
      );
      assert.deepEqual(withoutAttestation, {
        authorized: false,
        reason: 'TRUSTED_PROVENANCE_REQUIRED',
      });

      // Forged plain-object "attestation" without brand must not authorize.
      const forged = {
        seriesId,
        sixTerminalProvenanceVerified: true as const,
        verifiedAtMs: Date.now(),
        revision: 1,
      };
      const forgedResult = await evaluateLeaderboardReadEligibility(
        pool,
        seriesId,
        forged as unknown as F2BTrustedProvenanceAttestation,
      );
      assert.equal(forgedResult.authorized, false);
      assert.equal(forgedResult.reason, 'TRUSTED_PROVENANCE_REQUIRED');

      // Even a branded object cannot authorize until F2-B minting exists.
      const branded = {
        [F2B_TRUSTED_PROVENANCE_BRAND]: true as const,
        seriesId,
        sixTerminalProvenanceVerified: true as const,
        verifiedAtMs: Date.now(),
        revision: 1,
      } as F2BTrustedProvenanceAttestation;
      const brandedResult = await evaluateLeaderboardReadEligibility(
        pool,
        seriesId,
        branded,
      );
      assert.equal(brandedResult.authorized, false);
      assert.equal(brandedResult.reason, 'F2B_GATE_NOT_IMPLEMENTED');

      // Old publication_ready view name must not exist.
      const oldView = await pool.query(
        `SELECT to_regclass('public.tournament_f2a_publication_ready') AS reg`,
      );
      assert.equal(oldView.rows[0].reg, null);
    } finally {
      await pool.query(F2A_PUBLICATION_DROP_DDL);
      await pool.query('DROP TABLE IF EXISTS tournament_daily_claim CASCADE');
      await pool.end();
    }
  });
});

describe('PZD-41 F2-A — idempotent claim-identity migration safety', () => {
  it('reapplies without DROP/ADD churn; upgrade and rollback preserve F1 uniqueness', async () => {
    assert.ok(url, 'PostgreSQL required');
    const pool = new pg.Pool({ connectionString: url, max: 4 });
    try {
      await pool.query(F2A_PUBLICATION_DROP_DDL);
      await pool.query('DROP TABLE IF EXISTS tournament_daily_claim CASCADE');
      await pool.query(DAILY_CLAIM_DDL);

      await migrateF2APublicationSchema(pool);
      const before = await pool.query(
        `SELECT oid FROM pg_constraint
         WHERE conname = 'tournament_daily_claim_f2a_identity_uq'
           AND conrelid = 'tournament_daily_claim'::regclass`,
      );
      assert.equal(before.rows.length, 1);
      const oidBefore = before.rows[0].oid;

      // Second apply must be a no-op for the unique constraint (same OID).
      await migrateF2APublicationSchema(pool);
      const after = await pool.query(
        `SELECT oid FROM pg_constraint
         WHERE conname = 'tournament_daily_claim_f2a_identity_uq'
           AND conrelid = 'tournament_daily_claim'::regclass`,
      );
      assert.equal(after.rows.length, 1);
      assert.equal(after.rows[0].oid, oidBefore);

      const trigger = await pool.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgname = 'trg_tournament_daily_claim_identity_immutable'
           AND tgrelid = 'tournament_daily_claim'::regclass
           AND NOT tgisinternal`,
      );
      assert.equal(trigger.rows.length, 1);

      // Upgrade path re-run is also idempotent.
      await pool.query(F2A_PUBLICATION_UPGRADE_DDL);
      await pool.query(F2A_PUBLICATION_UPGRADE_DDL);

      const seriesId = randomUUID();
      const date = '2026-11-17';
      const started = Date.parse('2026-11-17T10:00:00.000Z');
      await insertClaim(pool, {
        seriesId,
        playerId: 'idem-player',
        date,
        started,
      });
      await publishComplete(pool, {
        seriesId,
        playerId: 'idem-player',
        date,
        started,
      });
      assert.equal(
        (await evaluateStructuralReadiness(pool, seriesId)).structurallyComplete,
        true,
      );

      // Rollback F2-A objects; F1 claim table and UNIQUE(player_id, date) remain.
      await pool.query(F2A_PUBLICATION_DROP_DDL);
      const f1Unique = await pool.query(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'tournament_daily_claim'::regclass
           AND contype = 'u'`,
      );
      assert.ok(
        f1Unique.rows.some(
          (r) => r.conname === 'tournament_daily_claim_player_id_original_utc_date_key',
        ),
      );
      const f2aGone = await pool.query(
        `SELECT 1 FROM pg_constraint
         WHERE conname = 'tournament_daily_claim_f2a_identity_uq'`,
      );
      assert.equal(f2aGone.rows.length, 0);

      // Claim row still present; F1 uniqueness still enforces.
      const claim = await pool.query(
        `SELECT player_id FROM tournament_daily_claim WHERE series_id = $1`,
        [seriesId],
      );
      assert.equal(claim.rows[0].player_id, 'idem-player');
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO tournament_daily_claim
               (series_id, player_id, original_utc_date, started_at_ms, manifest_digest, status)
             VALUES ($1,'idem-player',$2::date,$3,$4,'ACTIVE')`,
            [randomUUID(), date, started, DIGEST_A],
          ),
        /duplicate|unique/i,
      );
    } finally {
      await pool.query(F2A_PUBLICATION_DROP_DDL);
      await pool.query('DROP TABLE IF EXISTS tournament_daily_claim CASCADE');
      await pool.end();
    }
  });
});
