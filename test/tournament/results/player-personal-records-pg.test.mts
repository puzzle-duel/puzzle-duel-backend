/**
 * PZD-53 personal-best PostgreSQL integration.
 * Requires PZD_TEST_DATABASE_URL against an isolated disposable database.
 * Never targets pzd_staging / production.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import pg from 'pg';
import {
  loadPersonalRecordsSnapshot,
  projectTournamentBoardPersonalBestIsolated,
  syncPracticePersonalRecords,
  upsertPersonalBestMax,
  PRACTICE_PROVENANCE,
  TOURNAMENT_PROVENANCE,
  TOURNAMENT_GENERATOR_VERSION,
  TOURNAMENT_RULES_VERSION,
} from '../../../src/tournament/results/player-personal-records.mts';

const databaseUrl = process.env.PZD_TEST_DATABASE_URL;
const describePg = databaseUrl ? test : test.skip;
const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function assertIsolatedTestDatabase(name: string): void {
  if (!name || name === 'pzd_staging' || /(?:^|_)(?:prod|production|live|staging)(?:$|_)/i.test(name)) {
    throw new Error(`REFUSING_DESTRUCTIVE_TEST_SETUP:${name}`);
  }
  if (!/^pzd_[a-z0-9_]*test[a-z0-9_]*$/i.test(name) && name !== 'pzd_ci') {
    throw new Error(`REFUSING_DESTRUCTIVE_TEST_SETUP:${name}`);
  }
}

async function applyMigration(client: pg.PoolClient, dbName: string): Promise<void> {
  const escaped = dbName.replace(/'/g, "''");
  const sql = readFileSync(
    join(root, 'migrations/staging/0010_player_personal_best.sql'),
    'utf8',
  )
    .replace(/current_database\(\) <> 'pzd_staging'/g, `current_database() <> '${escaped}'`)
    .replace(/current_database\(\)='pzd_staging'/g, `current_database()='${escaped}'`);
  // Disposable CI DBs often lack pzd_app_runtime; keep DDL + indexes only.
  const ddlOnly = sql.replace(
    /\nREVOKE ALL[\s\S]*$/m,
    '\n',
  );
  await client.query(ddlOnly);
}

describePg('player personal best PostgreSQL max-only upsert', async (t) => {
  const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const admin = await adminPool.connect();
  let dbName = '';
  try {
    const db = await admin.query<{ current_database: string }>('SELECT current_database()');
    dbName = db.rows[0]!.current_database;
    assertIsolatedTestDatabase(dbName);
    await admin.query('DROP TABLE IF EXISTS public.player_personal_best CASCADE');
    await applyMigration(admin, dbName);
  } finally {
    admin.release();
  }

  t.after(async () => {
    const c = await adminPool.connect();
    try {
      await c.query('DROP TABLE IF EXISTS public.player_personal_best CASCADE');
    } finally {
      c.release();
      await adminPool.end();
    }
  });

  await t.test('first practice record creates a row; higher updates; lower/equal preserve', async () => {
    const playerId = 'player-a-personal-best';
    const client = await adminPool.connect();
    try {
      await client.query('DELETE FROM public.player_personal_best WHERE player_id = $1', [playerId]);

      const first = await upsertPersonalBestMax(client, {
        playerId,
        source: 'practice',
        difficulty: 'easy',
        rulesVersion: 'core-001.v2',
        generatorVersion: 'gen-001.v1',
        score: 12000,
        achievedAtMs: 1_000,
        provenance: PRACTICE_PROVENANCE,
        completionId: 'c1',
      });
      assert.equal(first.remoteScore, 12000);
      assert.equal(first.improved, true);

      const higher = await upsertPersonalBestMax(client, {
        playerId,
        source: 'practice',
        difficulty: 'easy',
        rulesVersion: 'core-001.v2',
        generatorVersion: 'gen-001.v1',
        score: 18000,
        achievedAtMs: 2_000,
        provenance: PRACTICE_PROVENANCE,
        completionId: 'c2',
      });
      assert.equal(higher.remoteScore, 18000);
      assert.equal(higher.improved, true);

      const lower = await upsertPersonalBestMax(client, {
        playerId,
        source: 'practice',
        difficulty: 'easy',
        rulesVersion: 'core-001.v2',
        generatorVersion: 'gen-001.v1',
        score: 15000,
        achievedAtMs: 3_000,
        provenance: PRACTICE_PROVENANCE,
        completionId: 'c3',
      });
      assert.equal(lower.remoteScore, 18000);
      assert.equal(lower.improved, false);

      const equal = await upsertPersonalBestMax(client, {
        playerId,
        source: 'practice',
        difficulty: 'easy',
        rulesVersion: 'core-001.v2',
        generatorVersion: 'gen-001.v1',
        score: 18000,
        achievedAtMs: 4_000,
        provenance: PRACTICE_PROVENANCE,
        completionId: 'c4',
      });
      assert.equal(equal.remoteScore, 18000);
      assert.equal(equal.improved, false);

      const row = await client.query<{
        score: string;
        achieved_at_ms: string;
        completion_id: string;
      }>(
        `SELECT score::text, achieved_at_ms::text, completion_id
         FROM public.player_personal_best
         WHERE player_id=$1 AND source='practice' AND difficulty='easy'`,
        [playerId],
      );
      assert.equal(row.rows[0]!.score, '18000');
      assert.equal(row.rows[0]!.achieved_at_ms, '2000');
      assert.equal(row.rows[0]!.completion_id, 'c2');
    } finally {
      client.release();
    }
  });

  await t.test('practice and tournament sources remain independent', async () => {
    const playerId = 'player-b-sources';
    const client = await adminPool.connect();
    try {
      await client.query('DELETE FROM public.player_personal_best WHERE player_id = $1', [playerId]);
      await upsertPersonalBestMax(client, {
        playerId,
        source: 'practice',
        difficulty: 'easy',
        rulesVersion: 'core-001.v2',
        generatorVersion: 'gen-001.v1',
        score: 24500,
        achievedAtMs: 10,
        provenance: PRACTICE_PROVENANCE,
        completionId: 'p1',
      });
      await upsertPersonalBestMax(client, {
        playerId,
        source: 'tournament',
        difficulty: 'easy',
        rulesVersion: TOURNAMENT_RULES_VERSION,
        generatorVersion: TOURNAMENT_GENERATOR_VERSION,
        score: 27300,
        achievedAtMs: 20,
        provenance: TOURNAMENT_PROVENANCE,
        completionId: 'series:1',
        seriesId: '00000000-0000-4000-8000-000000000001',
        subgameOrdinal: 1,
      });
      const snap = await loadPersonalRecordsSnapshot(adminPool, playerId);
      const practice = snap.records.find((r) => r.source === 'practice' && r.difficulty === 'easy');
      const tournament = snap.records.find((r) => r.source === 'tournament' && r.difficulty === 'easy');
      assert.equal(practice?.score, 24500);
      assert.equal(tournament?.score, 27300);
      assert.equal(practice?.provenance, PRACTICE_PROVENANCE);
      assert.equal(tournament?.provenance, TOURNAMENT_PROVENANCE);
    } finally {
      client.release();
    }
  });

  await t.test('practice sync batch is idempotent and rejects tournament writes', async () => {
    const playerId = 'player-c-sync';
    const body = {
      records: [{
        difficulty: 'hard',
        score: 9000,
        rulesVersion: 'core-001.v2',
        generatorVersion: 'gen-001.v1',
        achievedAt: '2026-11-27T12:00:00.000Z',
        completionId: 'practice-hard-1',
        localRevision: 1,
      }],
    };
    const first = await syncPracticePersonalRecords(adminPool, playerId, body);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.acknowledgements[0]!.remoteScore, 9000);

    const second = await syncPracticePersonalRecords(adminPool, playerId, body);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.acknowledgements[0]!.remoteScore, 9000);
    assert.equal(second.acknowledgements[0]!.improved, false);

    const rejected = await syncPracticePersonalRecords(adminPool, playerId, {
      records: [{
        ...body.records[0],
        source: 'tournament',
        score: 999999,
      }],
    });
    assert.equal(rejected.ok, false);
    if (rejected.ok) return;
    assert.equal(rejected.error, 'MALFORMED_REQUEST');
  });

  await t.test('concurrent higher and lower upserts retain the maximum', async () => {
    const playerId = 'player-d-concurrent';
    await adminPool.query('DELETE FROM public.player_personal_best WHERE player_id = $1', [playerId]);

    await Promise.all([
      (async () => {
        const c = await adminPool.connect();
        try {
          await upsertPersonalBestMax(c, {
            playerId,
            source: 'practice',
            difficulty: 'medium',
            rulesVersion: 'core-001.v2',
            generatorVersion: 'gen-001.v1',
            score: 12000,
            achievedAtMs: 1,
            provenance: PRACTICE_PROVENANCE,
            completionId: 'low',
          });
        } finally {
          c.release();
        }
      })(),
      (async () => {
        const c = await adminPool.connect();
        try {
          await upsertPersonalBestMax(c, {
            playerId,
            source: 'practice',
            difficulty: 'medium',
            rulesVersion: 'core-001.v2',
            generatorVersion: 'gen-001.v1',
            score: 18000,
            achievedAtMs: 2,
            provenance: PRACTICE_PROVENANCE,
            completionId: 'high',
          });
        } finally {
          c.release();
        }
      })(),
      (async () => {
        const c = await adminPool.connect();
        try {
          await upsertPersonalBestMax(c, {
            playerId,
            source: 'practice',
            difficulty: 'medium',
            rulesVersion: 'core-001.v2',
            generatorVersion: 'gen-001.v1',
            score: 15000,
            achievedAtMs: 3,
            provenance: PRACTICE_PROVENANCE,
            completionId: 'mid',
          });
        } finally {
          c.release();
        }
      })(),
    ]);

    const row = await adminPool.query<{ score: string }>(
      `SELECT score::text FROM public.player_personal_best
       WHERE player_id=$1 AND difficulty='medium' AND source='practice'`,
      [playerId],
    );
    assert.equal(row.rows[0]!.score, '18000');
  });

  await t.test('isolated projection failure does not abort F2-B; derive reconciles PB', async () => {
    await adminPool.query(`
      CREATE TABLE IF NOT EXISTS tournament_daily_series_completion (
        series_id uuid PRIMARY KEY,
        player_id text NOT NULL,
        completed_at_ms bigint NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tournament_verified_subgame_score (
        series_id uuid NOT NULL,
        subgame_ordinal int NOT NULL,
        score bigint NOT NULL,
        PRIMARY KEY (series_id, subgame_ordinal)
      );
      -- Staging-real type: series_key TEXT (not UUID). UUID here masked 42883.
      CREATE TABLE IF NOT EXISTS trusted_challenge_binding (
        series_key text NOT NULL,
        subgame_ordinal int NOT NULL,
        rules_version text,
        generator_version text,
        PRIMARY KEY (series_key, subgame_ordinal)
      );
    `);

    const playerId = 'player-e-projection-fail';
    const seriesId = '00000000-0000-4000-8000-0000000000ee';
    const score = 7777;
    const achievedAtMs = 90;
    await adminPool.query('DELETE FROM public.player_personal_best WHERE player_id=$1', [playerId]);
    await adminPool.query(
      'DELETE FROM tournament_verified_subgame_score WHERE series_id=$1::uuid',
      [seriesId],
    );
    await adminPool.query(
      'DELETE FROM tournament_daily_series_completion WHERE series_id=$1::uuid',
      [seriesId],
    );
    await adminPool.query(
      'DELETE FROM trusted_challenge_binding WHERE series_key=$1',
      [seriesId],
    );

    const client = await adminPool.connect();
    const diagnostics: Array<{
      code: string;
      sqlstate: string;
      ordinal: number;
      safeReason: string;
    }> = [];
    try {
      await client.query('BEGIN');

      // Authoritative F2-B publication work (outside the projection SAVEPOINT).
      await client.query(
        `INSERT INTO tournament_daily_series_completion(series_id, player_id, completed_at_ms)
         VALUES ($1::uuid, $2, $3)`,
        [seriesId, playerId, achievedAtMs],
      );
      await client.query(
        `INSERT INTO tournament_verified_subgame_score(series_id, subgame_ordinal, score)
         VALUES ($1::uuid, 1, $2)`,
        [seriesId, score],
      );
      await client.query(
        `INSERT INTO trusted_challenge_binding(
           series_key, subgame_ordinal, rules_version, generator_version
         ) VALUES ($1, 1, $2, $3)`,
        [seriesId, TOURNAMENT_RULES_VERSION, TOURNAMENT_GENERATOR_VERSION],
      );

      // Player-scoped trigger forces recoverable check_violation inside the
      // production SAVEPOINT helper without touching other players' rows.
      await client.query(`
        CREATE OR REPLACE FUNCTION public.pzd_pb_force_projection_fail()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $fn$
        BEGIN
          IF NEW.player_id = '${playerId}' THEN
            RAISE EXCEPTION 'forced projection check_violation'
              USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END;
        $fn$
      `);
      await client.query(`
        DROP TRIGGER IF EXISTS pzd_pb_force_projection_fail ON public.player_personal_best;
        CREATE TRIGGER pzd_pb_force_projection_fail
          BEFORE INSERT OR UPDATE ON public.player_personal_best
          FOR EACH ROW
          EXECUTE FUNCTION public.pzd_pb_force_projection_fail()
      `);

      const failed = await projectTournamentBoardPersonalBestIsolated(
        client,
        {
          playerId,
          seriesId,
          subgameOrdinal: 1,
          score,
          achievedAtMs,
        },
        {
          onFailure: (d) => {
            diagnostics.push({
              code: d.code,
              sqlstate: d.sqlstate,
              ordinal: d.ordinal,
              safeReason: d.safeReason,
            });
          },
        },
      );
      assert.equal(failed, 'failed_isolated');
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]!.code, 'tournament_record_projection_failed');
      assert.equal(diagnostics[0]!.sqlstate, '23514');
      assert.equal(diagnostics[0]!.ordinal, 1);
      assert.equal(diagnostics[0]!.safeReason, 'check_violation');

      // Drop the fault injection; authoritative F2-B rows must still commit.
      await client.query('DROP TRIGGER IF EXISTS pzd_pb_force_projection_fail ON public.player_personal_best');
      await client.query('DROP FUNCTION IF EXISTS public.pzd_pb_force_projection_fail()');
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('DROP TRIGGER IF EXISTS pzd_pb_force_projection_fail ON public.player_personal_best');
        await client.query('DROP FUNCTION IF EXISTS public.pzd_pb_force_projection_fail()');
      } catch { /* ignore */ }
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }

    const authoritative = await adminPool.query<{ score: string }>(
      `SELECT score::text FROM tournament_verified_subgame_score
       WHERE series_id=$1::uuid AND subgame_ordinal=1`,
      [seriesId],
    );
    assert.equal(authoritative.rows[0]!.score, String(score));

    const projected = await adminPool.query(
      `SELECT 1 FROM public.player_personal_best
       WHERE player_id=$1 AND source='tournament' AND difficulty='easy'`,
      [playerId],
    );
    assert.equal(projected.rowCount, 0);

    // Historical GET derivation reconciles the correct tournament personal best.
    const snap = await loadPersonalRecordsSnapshot(adminPool, playerId);
    const easy = snap.records.find(
      (r) => r.source === 'tournament' && r.difficulty === 'easy',
    );
    assert.equal(easy?.score, score);
    assert.equal(easy?.provenance, TOURNAMENT_PROVENANCE);

    // Later reconciliation projection succeeds once the table is healthy again.
    const reconcileClient = await adminPool.connect();
    try {
      await reconcileClient.query('BEGIN');
      const projectedOk = await projectTournamentBoardPersonalBestIsolated(
        reconcileClient,
        {
          playerId,
          seriesId,
          subgameOrdinal: 1,
          score,
          achievedAtMs,
        },
      );
      assert.equal(projectedOk, 'projected');
      await reconcileClient.query('COMMIT');
    } catch (err) {
      try { await reconcileClient.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      reconcileClient.release();
    }

    const stored = await adminPool.query<{ score: string }>(
      `SELECT score::text FROM public.player_personal_best
       WHERE player_id=$1 AND source='tournament' AND difficulty='easy'`,
      [playerId],
    );
    assert.equal(stored.rows[0]!.score, String(score));
  });

  await t.test('GET merges derived tournament bests over stale/partial projections', async () => {
    await adminPool.query(`
      CREATE TABLE IF NOT EXISTS tournament_daily_series_completion (
        series_id uuid PRIMARY KEY,
        player_id text NOT NULL,
        completed_at_ms bigint NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tournament_verified_subgame_score (
        series_id uuid NOT NULL,
        subgame_ordinal int NOT NULL,
        score bigint NOT NULL,
        PRIMARY KEY (series_id, subgame_ordinal)
      );
      -- Staging-real type: series_key TEXT (not UUID).
      CREATE TABLE IF NOT EXISTS trusted_challenge_binding (
        series_key text NOT NULL,
        subgame_ordinal int NOT NULL,
        rules_version text,
        generator_version text,
        PRIMARY KEY (series_key, subgame_ordinal)
      );
    `);

    const playerId = 'player-f-derive-merge';
    const seriesHigh = '00000000-0000-4000-8000-0000000000f1';
    const seriesLow = '00000000-0000-4000-8000-0000000000f2';
    await adminPool.query('DELETE FROM tournament_verified_subgame_score');
    await adminPool.query('DELETE FROM tournament_daily_series_completion');
    await adminPool.query('DELETE FROM trusted_challenge_binding');
    await adminPool.query(
      'DELETE FROM public.player_personal_best WHERE player_id=$1',
      [playerId],
    );

    await adminPool.query(
      `INSERT INTO tournament_daily_series_completion(series_id, player_id, completed_at_ms)
       VALUES ($1::uuid,$3,100), ($2::uuid,$3,200)`,
      [seriesHigh, seriesLow, playerId],
    );
    // Ordinal 1 = easy. Historical high 50000; later series lower 1000.
    await adminPool.query(
      `INSERT INTO tournament_verified_subgame_score(series_id, subgame_ordinal, score)
       VALUES ($1::uuid,1,50000), ($2::uuid,1,1000)`,
      [seriesHigh, seriesLow],
    );

    // Stale/partial projection only has the lower score.
    const client = await adminPool.connect();
    try {
      await upsertPersonalBestMax(client, {
        playerId,
        source: 'tournament',
        difficulty: 'easy',
        rulesVersion: TOURNAMENT_RULES_VERSION,
        generatorVersion: TOURNAMENT_GENERATOR_VERSION,
        score: 1000,
        achievedAtMs: 200,
        provenance: TOURNAMENT_PROVENANCE,
        completionId: `${seriesLow}:1`,
        seriesId: seriesLow,
        subgameOrdinal: 1,
      });
    } finally {
      client.release();
    }

    const snap = await loadPersonalRecordsSnapshot(adminPool, playerId);
    const easy = snap.records.find(
      (r) => r.source === 'tournament' && r.difficulty === 'easy',
    );
    assert.equal(easy?.score, 50000);
  });

  await t.test(
    'PZD-53: staging TEXT series_key + UUID series_id derive must not raise 42883',
    async () => {
      // Rebuild with staging-real TEXT series_key (prior cases may leave tables).
      await adminPool.query(`
        DROP TABLE IF EXISTS trusted_challenge_binding CASCADE;
        DROP TABLE IF EXISTS tournament_verified_subgame_score CASCADE;
        DROP TABLE IF EXISTS tournament_daily_series_completion CASCADE;
        CREATE TABLE tournament_daily_series_completion (
          series_id uuid PRIMARY KEY,
          player_id text NOT NULL,
          completed_at_ms bigint NOT NULL
        );
        CREATE TABLE tournament_verified_subgame_score (
          series_id uuid NOT NULL,
          subgame_ordinal int NOT NULL,
          score bigint NOT NULL,
          PRIMARY KEY (series_id, subgame_ordinal)
        );
        CREATE TABLE trusted_challenge_binding (
          series_key text NOT NULL,
          player_id text NOT NULL,
          subgame_ordinal int NOT NULL,
          rules_version text NOT NULL,
          generator_version text NOT NULL,
          PRIMARY KEY (series_key, player_id, subgame_ordinal)
        );
      `);

      const playerId = 'player-g-text-series-key';
      const seriesId = '00000000-0000-4000-8000-0000000000aa';
      await adminPool.query('DELETE FROM public.player_personal_best WHERE player_id=$1', [
        playerId,
      ]);
      await adminPool.query(
        `INSERT INTO tournament_daily_series_completion(series_id, player_id, completed_at_ms)
         VALUES ($1::uuid, $2, 42)`,
        [seriesId, playerId],
      );
      await adminPool.query(
        `INSERT INTO tournament_verified_subgame_score(series_id, subgame_ordinal, score)
         VALUES ($1::uuid, 6, 9000)`,
        [seriesId],
      );
      await adminPool.query(
        `INSERT INTO trusted_challenge_binding(
           series_key, player_id, subgame_ordinal, rules_version, generator_version
         ) VALUES ($1, $2, 6, $3, $4)`,
        [seriesId, playerId, TOURNAMENT_RULES_VERSION, TOURNAMENT_GENERATOR_VERSION],
      );

      // No projection row — GET must derive via the TEXT=UUID-safe JOIN.
      const snap = await loadPersonalRecordsSnapshot(adminPool, playerId);
      const hard = snap.records.find(
        (r) => r.source === 'tournament' && r.difficulty === 'hard',
      );
      assert.equal(hard?.score, 9000);
      assert.equal(hard?.rulesVersion, TOURNAMENT_RULES_VERSION);
      assert.equal(hard?.generatorVersion, TOURNAMENT_GENERATOR_VERSION);
      assert.equal(hard?.provenance, TOURNAMENT_PROVENANCE);
    },
  );
});
