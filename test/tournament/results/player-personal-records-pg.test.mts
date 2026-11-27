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
});
