/**
 * Phase A must not treat one ended subgame as six-game series completion.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { DAILY_CLAIM_DDL } from '../../../src/tournament/claims/postgres-daily-claim.mts';
import { ControllableClock } from '../../../src/tournament/ingress/clock.mts';
import { MemoryAdmissionJournal } from '../../../src/tournament/ingress/journal.mts';
import {
  MemorySeriesFenceStore,
  PostgresSeriesFenceStore,
} from '../../../src/tournament/ingress/series-fence.mts';
import { PostgresAdmissionJournal } from '../../../src/tournament/ingress/postgres-journal.mts';
import { SeriesCommandArbiter } from '../../../src/tournament/ingress/arbiter.mts';
import {
  F2A_PUBLICATION_DROP_DDL,
  migrateF2APublicationSchema,
} from '../../../src/tournament/results/f2a-publication-schema.mts';
import { F2B_PUBLICATION_HARDENING_DDL } from '../../../src/tournament/results/f2b-publication.mts';
import { T0, baseFence, fixedMoveEffect, moveEffectsByKey } from './test-helpers.mts';

const DATABASE_URL =
  process.env.PZD_INGRESS_DATABASE_URL ??
  'postgresql://pzd:pzd@127.0.0.1:55432/pzd_ingress';

const move = {
  seriesKey: 's1',
  playerId: 'p1',
  commandType: 'move' as const,
  idempotencyKey: 'subgame-end',
  payloadHash: 'h',
  expectedBoardRevision: 0,
  writerGeneration: 1,
};

function memoryArbiter() {
  const clock = new ControllableClock(T0);
  const journal = new MemoryAdmissionJournal({ clock });
  const fence = new MemorySeriesFenceStore();
  return {
    clock,
    journal,
    fence,
    arbiter: new SeriesCommandArbiter(journal, fence, {
      resolveMoveEffect: fixedMoveEffect(15, true),
      clock,
    }),
  };
}

describe('Phase A subgame end does not complete the series', () => {
  it('memory: one ended subgame awaits advance and does not publish', async () => {
    const { fence, arbiter } = memoryArbiter();
    await fence.put(baseFence('s1'));
    const result = await arbiter.admitAndEvaluate(move);
    assert.equal(result.decision, 'apply');
    if (result.decision !== 'apply') return;
    assert.equal(result.state.status, 'AWAIT_ADVANCE');
    assert.notEqual(result.state.status, 'COMPLETED');
    assert.equal(result.state.resultsPublished, false);
    assert.equal(result.state.score, 15);
    assert.equal(result.state.boardRevision, 1);

    const again = await arbiter.admitAndEvaluate(move);
    assert.equal(again.decision, 'apply');
    if (again.decision !== 'apply') return;
    assert.equal(again.duplicateReplay, true);
    assert.equal(again.state.status, 'AWAIT_ADVANCE');
    assert.equal(again.state.score, 15);
    assert.equal(again.state.boardRevision, 1);
    assert.equal(again.state.resultsPublished, false);
  });

  it('memory: concurrent admissions cannot complete the series', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const fence = new MemorySeriesFenceStore();
    await fence.put(baseFence('s1'));
    const arbiter = new SeriesCommandArbiter(journal, fence, {
      resolveMoveEffect: moveEffectsByKey({
        'race-a': { scoreDelta: 4, completesSubgame: true },
        'race-b': { scoreDelta: 9, completesSubgame: true },
      }),
      clock,
    });
    const [a, b] = await Promise.all([
      arbiter.admitAndEvaluate({ ...move, idempotencyKey: 'race-a', payloadHash: 'a' }),
      arbiter.admitAndEvaluate({ ...move, idempotencyKey: 'race-b', payloadHash: 'b' }),
    ]);
    const decisions = [a.decision, b.decision].sort();
    assert.deepEqual(decisions, ['apply', 'reject']);
    const applied = a.decision === 'apply' ? a : b;
    if (applied.decision !== 'apply') return;
    assert.equal(applied.state.status, 'AWAIT_ADVANCE');
    assert.notEqual(applied.state.status, 'COMPLETED');
    assert.equal(applied.state.resultsPublished, false);
    const stored = await fence.get('s1');
    assert.equal(stored!.status, 'AWAIT_ADVANCE');
    assert.equal(stored!.boardRevision, 1);
    assert.ok(stored!.score === 4 || stored!.score === 9);
  });
});

describe('Phase A PostgreSQL subgame end creates no publication', () => {
  it('keeps AWAIT_ADVANCE under duplicate and concurrent admission', async () => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
    const clock = new ControllableClock(T0);
    try {
      const version = await pool.query('SHOW server_version_num');
      const num = Number(version.rows[0].server_version_num);
      assert.ok(num >= 180000 && num < 190000, `PostgreSQL 18 required, got ${num}`);
      await pool.query(F2A_PUBLICATION_DROP_DDL);
      await pool.query('DROP TABLE IF EXISTS command_admission_journal');
      await pool.query('DROP TABLE IF EXISTS series_fence_state');
      await pool.query('DROP TABLE IF EXISTS tournament_daily_claim CASCADE');
      await pool.query(DAILY_CLAIM_DDL);
      const journal = new PostgresAdmissionJournal(pool, clock);
      const fence = new PostgresSeriesFenceStore(pool);
      await journal.migrate();
      await fence.migrate();
      await migrateF2APublicationSchema(pool);
      await pool.query(F2B_PUBLICATION_HARDENING_DDL);
      await fence.put(baseFence('s1'));

      const arbiter = new SeriesCommandArbiter(journal, fence, {
        resolveMoveEffect: fixedMoveEffect(15, true),
        clock,
      });
      const result = await arbiter.admitAndEvaluate(move);
      assert.equal(result.decision, 'apply');
      if (result.decision !== 'apply') return;
      assert.equal(result.state.status, 'AWAIT_ADVANCE');
      assert.notEqual(result.state.status, 'COMPLETED');
      assert.equal(result.state.resultsPublished, false);
      assert.equal(result.state.score, 15);

      const again = await arbiter.admitAndEvaluate(move);
      assert.equal(again.decision, 'apply');
      if (again.decision === 'apply') {
        assert.equal(again.duplicateReplay, true);
        assert.equal(again.state.score, 15);
        assert.equal(again.state.status, 'AWAIT_ADVANCE');
      }

      const raced = new SeriesCommandArbiter(journal, fence, {
        resolveMoveEffect: moveEffectsByKey({
          'pg-race-a': { scoreDelta: 3, completesSubgame: true },
          'pg-race-b': { scoreDelta: 5, completesSubgame: true },
        }),
        clock,
      });
      await fence.put(baseFence('s2'));
      const [a, b] = await Promise.all([
        raced.admitAndEvaluate({
          ...move,
          seriesKey: 's2',
          idempotencyKey: 'pg-race-a',
          payloadHash: 'a',
        }),
        raced.admitAndEvaluate({
          ...move,
          seriesKey: 's2',
          idempotencyKey: 'pg-race-b',
          payloadHash: 'b',
        }),
      ]);
      assert.deepEqual([a.decision, b.decision].sort(), ['apply', 'reject']);
      const stored = await fence.get('s2');
      assert.equal(stored!.status, 'AWAIT_ADVANCE');
      assert.notEqual(stored!.status, 'COMPLETED');
      assert.equal(stored!.resultsPublished, false);
      assert.equal(stored!.boardRevision, 1);

      for (const table of [
        'tournament_daily_series_completion',
        'tournament_verified_subgame_score',
        'tournament_daily_result_category',
        'tournament_on_time_badge',
        'tournament_f2b_trusted_provenance',
      ]) {
        const count = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
        assert.equal(count.rows[0].n, 0, table);
      }
    } finally {
      await pool.query(F2A_PUBLICATION_DROP_DDL).catch(() => undefined);
      await pool.query('DROP TABLE IF EXISTS tournament_daily_claim CASCADE').catch(() => undefined);
      await pool.end();
    }
  });
});
