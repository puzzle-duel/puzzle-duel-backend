import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { ControllableClock } from '../../../src/tournament/ingress/clock.mts';
import { PostgresAdmissionJournal } from '../../../src/tournament/ingress/postgres-journal.mts';
import { PostgresSeriesFenceStore } from '../../../src/tournament/ingress/series-fence.mts';
import { SeriesCommandArbiter } from '../../../src/tournament/ingress/arbiter.mts';
import { idleDeadlineFrom } from '../../../src/tournament/ingress/types.mts';
import {
  T0,
  baseFence,
  fixedMoveEffect,
  moveEffectsByKey,
} from './test-helpers.mts';

const DATABASE_URL =
  process.env.PZD_INGRESS_DATABASE_URL ??
  'postgresql://pzd:pzd@127.0.0.1:55432/pzd_ingress';

async function connectOrSkip(t: { skip: (msg?: string) => void }) {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
  try {
    await pool.query('SELECT 1');
  } catch {
    await pool.end();
    t.skip(`postgres unavailable at ${DATABASE_URL}`);
    return null;
  }
  return pool;
}

async function reset(pool: pg.Pool) {
  await pool.query('DROP TABLE IF EXISTS command_admission_journal');
  await pool.query('DROP TABLE IF EXISTS series_fence_state');
}

describe('PZD-38 Gate A — PostgreSQL durable journal', () => {
  it('admits predeadline H1, survives delayed commit past deadline', async (t) => {
    const pool = await connectOrSkip(t);
    if (!pool) return;

    const clock = new ControllableClock(T0);
    const journal = new PostgresAdmissionJournal(pool, clock);
    const fence = new PostgresSeriesFenceStore(pool);
    await reset(pool);
    await journal.migrate();
    await fence.migrate();

    const idleDeadlineAt = idleDeadlineFrom(T0, 300);
    await fence.put(baseFence('pg-s1', { idleDeadlineAt }));
    clock.set(new Date(idleDeadlineAt.getTime() - 1));
    const arbiter = new SeriesCommandArbiter(journal, fence, {
      resolveMoveEffect: fixedMoveEffect(42, true),
      clock,
    });

    const result = await arbiter.admitAndEvaluate(
      {
        seriesKey: 'pg-s1',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'final-h1',
        payloadHash: 'h1',
        expectedBoardRevision: 0,
        writerGeneration: 1,
      },
      {
        afterAdmit: async () => {
          clock.set(new Date(idleDeadlineAt.getTime() + 2_000));
        },
      },
    );

    assert.equal(result.decision, 'apply');
    if (result.decision === 'apply') {
      assert.equal(result.state.status, 'COMPLETED');
      assert.equal(result.state.resultsPublished, false);
      assert.equal(
        result.command.trustedReceivedAt.getTime(),
        idleDeadlineAt.getTime() - 1,
      );
    }

    const again = await arbiter.admitAndEvaluate({
      seriesKey: 'pg-s1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'final-h1',
      payloadHash: 'h1',
      expectedBoardRevision: 0,
      writerGeneration: 1,
    });
    assert.equal(again.decision, 'apply');
    if (again.decision === 'apply' && result.decision === 'apply') {
      assert.equal(again.duplicateReplay, true);
      assert.equal(again.state.score, 42);
      assert.equal(
        again.command.trustedReceivedAt.toISOString(),
        result.command.trustedReceivedAt.toISOString(),
      );
    }

    const forfeit = await arbiter.tryForfeitForInactivity('pg-s1');
    assert.equal(forfeit.ok, false);

    await pool.end();
  });

  it('concurrent PG admits assign distinct seq under advisory lock', async (t) => {
    const pool = await connectOrSkip(t);
    if (!pool) return;

    const clock = new ControllableClock(T0);
    const journal = new PostgresAdmissionJournal(pool, clock);
    await pool.query('DROP TABLE IF EXISTS command_admission_journal');
    await journal.migrate();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        journal.admit({
          seriesKey: 'pg-race',
          playerId: 'p1',
          commandType: 'move',
          idempotencyKey: `k-${i}`,
          payloadHash: `h-${i}`,
        }),
      ),
    );

    assert.equal(results.every((r) => r.ok), true);
    const seqs = results
      .filter((r) => r.ok)
      .map((r) => (r.ok ? r.command.admissionSeq : 0))
      .sort((a, b) => a - b);
    assert.deepEqual(
      seqs,
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    assert.equal(await journal.maxAdmissionSeq('pg-race'), 20);
    await pool.end();
  });

  it('DB unavailable fail-closed: no fabricated admission', async (t) => {
    const bad = new pg.Pool({
      connectionString: 'postgresql://pzd:pzd@127.0.0.1:1/nope',
      max: 1,
      connectionTimeoutMillis: 300,
    });
    const clock = new ControllableClock(T0);
    const journal = new PostgresAdmissionJournal(bad, clock);
    const result = await journal.admit({
      seriesKey: 'x',
      playerId: 'p',
      commandType: 'move',
      idempotencyKey: 'k',
      payloadHash: 'h',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'INGRESS_UNAVAILABLE');
    await bad.end();
    void t;
  });

  it('aborted admit leaves no durable row (simulated rollback path)', async (t) => {
    const pool = await connectOrSkip(t);
    if (!pool) return;
    const clock = new ControllableClock(T0);
    const journal = new PostgresAdmissionJournal(pool, clock);
    await pool.query('DROP TABLE IF EXISTS command_admission_journal');
    await journal.migrate();

    await pool.end();
    const deadPool = new pg.Pool({
      connectionString: 'postgresql://pzd:pzd@127.0.0.1:1/nope',
      connectionTimeoutMillis: 200,
    });
    const deadJournal = new PostgresAdmissionJournal(deadPool, clock);
    const admit = await deadJournal.admit({
      seriesKey: 'abort-s',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'gone',
      payloadHash: 'h',
    });
    assert.equal(admit.ok, false);
    await deadPool.end();

    const alive = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    const check = await alive.query(
      `SELECT count(*)::int AS c FROM command_admission_journal WHERE idempotency_key = 'gone'`,
    );
    assert.equal(check.rows[0].c, 0);
    await alive.end();
  });

  it('Case A on PG fence: concurrent revisions yield one mutation', async (t) => {
    const pool = await connectOrSkip(t);
    if (!pool) return;
    const clock = new ControllableClock(T0);
    const journal = new PostgresAdmissionJournal(pool, clock);
    const fence = new PostgresSeriesFenceStore(pool);
    await reset(pool);
    await journal.migrate();
    await fence.migrate();
    const idleDeadlineAt = idleDeadlineFrom(T0, 300);
    await fence.put(baseFence('pg-cas', { idleDeadlineAt }));
    const arbiter = new SeriesCommandArbiter(journal, fence, {
      resolveMoveEffect: moveEffectsByKey({
        a: { scoreDelta: 2 },
        b: { scoreDelta: 4 },
      }),
      clock,
    });
    const [a, b] = await Promise.all([
      arbiter.admitAndEvaluate({
        seriesKey: 'pg-cas',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'a',
        payloadHash: 'ha',
        expectedBoardRevision: 0,
        writerGeneration: 1,
      }),
      arbiter.admitAndEvaluate({
        seriesKey: 'pg-cas',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'b',
        payloadHash: 'hb',
        expectedBoardRevision: 0,
        writerGeneration: 1,
      }),
    ]);
    const decisions = [a.decision, b.decision].sort();
    assert.deepEqual(decisions, ['apply', 'reject']);
    const state = await fence.get('pg-cas');
    assert.equal(state!.boardRevision, 1);
    assert.ok(state!.score === 2 || state!.score === 4);
    await pool.end();
  });
});
