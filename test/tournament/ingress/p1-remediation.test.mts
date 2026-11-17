import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { ControllableClock } from '../../../src/tournament/ingress/clock.mts';
import { MemoryAdmissionJournal } from '../../../src/tournament/ingress/journal.mts';
import { PostgresAdmissionJournal } from '../../../src/tournament/ingress/postgres-journal.mts';
import {
  MemorySeriesFenceStore,
  PostgresSeriesFenceStore,
} from '../../../src/tournament/ingress/series-fence.mts';
import { SeriesCommandArbiter } from '../../../src/tournament/ingress/arbiter.mts';
import {
  applyThinkingExtension,
  idleDeadlineFrom,
} from '../../../src/tournament/ingress/types.mts';
import { T0, baseFence, fixedMoveEffect } from './test-helpers.mts';

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

describe('PZD-38 P1-01 — one thinking extension per series', () => {
  it('memory: second distinct key rejected; same-key retry does not re-extend', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const fence = new MemorySeriesFenceStore();
    const idle = new Date(T0.getTime() + 30_000);
    await fence.put(baseFence('s1', { idleDeadlineAt: idle }));
    const arbiter = new SeriesCommandArbiter(journal, fence);
    clock.set(new Date(idle.getTime() - 15_000));

    const first = await arbiter.admitAndEvaluate({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'thinking_extension',
      idempotencyKey: 'ext-1',
      payloadHash: 'h1',
    });
    assert.equal(first.decision, 'apply');
    const afterFirst = await fence.get('s1');
    assert.equal(afterFirst!.thinkingExtensionConsumed, true);
    assert.equal(afterFirst!.idleDeadlineAt.getTime(), idle.getTime() + 60_000);

    const second = await arbiter.admitAndEvaluate({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'thinking_extension',
      idempotencyKey: 'ext-2',
      payloadHash: 'h2',
    });
    assert.equal(second.decision, 'reject');
    if (second.decision === 'reject') {
      assert.equal(second.reason, 'EXTENSION_UNAVAILABLE');
    }
    assert.equal(
      (await fence.get('s1'))!.idleDeadlineAt.getTime(),
      idle.getTime() + 60_000,
    );

    const retry = await arbiter.admitAndEvaluate({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'thinking_extension',
      idempotencyKey: 'ext-1',
      payloadHash: 'h1',
    });
    assert.equal(retry.decision, 'apply');
    if (retry.decision === 'apply') assert.equal(retry.duplicateReplay, true);
    assert.equal(
      (await fence.get('s1'))!.idleDeadlineAt.getTime(),
      idle.getTime() + 60_000,
    );
  });

  it('memory: concurrent extensions — exactly one succeeds', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const fence = new MemorySeriesFenceStore();
    const idle = new Date(T0.getTime() + 30_000);
    await fence.put(baseFence('s1', { idleDeadlineAt: idle }));
    const arbiter = new SeriesCommandArbiter(journal, fence);
    clock.set(new Date(idle.getTime() - 10_000));

    const [a, b] = await Promise.all([
      arbiter.admitAndEvaluate({
        seriesKey: 's1',
        playerId: 'p1',
        commandType: 'thinking_extension',
        idempotencyKey: 'c1',
        payloadHash: 'hc1',
      }),
      arbiter.admitAndEvaluate({
        seriesKey: 's1',
        playerId: 'p1',
        commandType: 'thinking_extension',
        idempotencyKey: 'c2',
        payloadHash: 'hc2',
      }),
    ]);
    const decisions = [a.decision, b.decision].sort();
    assert.deepEqual(decisions, ['apply', 'reject']);
    assert.equal((await fence.get('s1'))!.thinkingExtensionConsumed, true);
  });

  it('memory: rejected ineligible extension does not consume', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const fence = new MemorySeriesFenceStore();
    const idle = new Date(T0.getTime() + 120_000); // 120s remaining > 60s
    await fence.put(baseFence('s1', { idleDeadlineAt: idle }));
    const arbiter = new SeriesCommandArbiter(journal, fence);
    clock.set(T0);

    const bad = await arbiter.admitAndEvaluate({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'thinking_extension',
      idempotencyKey: 'too-early',
      payloadHash: 'h',
    });
    assert.equal(bad.decision, 'reject');
    assert.equal((await fence.get('s1'))!.thinkingExtensionConsumed, false);
  });

  it('memory: consumption survives process restart snapshot', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const fence = new MemorySeriesFenceStore();
    const idle = new Date(T0.getTime() + 30_000);
    await fence.put(baseFence('s1', { idleDeadlineAt: idle }));
    const arbiter = new SeriesCommandArbiter(journal, fence);
    clock.set(new Date(idle.getTime() - 5_000));
    await arbiter.admitAndEvaluate({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'thinking_extension',
      idempotencyKey: 'ext',
      payloadHash: 'h',
    });
    const snap = await fence.get('s1');
    const fence2 = new MemorySeriesFenceStore();
    await fence2.put(snap!);
    assert.equal((await fence2.get('s1'))!.thinkingExtensionConsumed, true);
    const arbiter2 = new SeriesCommandArbiter(journal, fence2);
    const again = await arbiter2.admitAndEvaluate({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'thinking_extension',
      idempotencyKey: 'ext-new',
      payloadHash: 'h2',
    });
    assert.equal(again.decision, 'reject');
  });

  it('postgres: extension consumed flag durable across connections', async (t) => {
    const pool = await connectOrSkip(t);
    if (!pool) return;
    try {
      await pool.query('DROP TABLE IF EXISTS command_admission_journal');
      await pool.query('DROP TABLE IF EXISTS series_fence_state');
      const clock = new ControllableClock(T0);
      const journal = new PostgresAdmissionJournal(pool, clock);
      const fence = new PostgresSeriesFenceStore(pool);
      await journal.migrate();
      await fence.migrate();
      const idle = new Date(T0.getTime() + 30_000);
      await fence.put(baseFence('pg-ext', { idleDeadlineAt: idle }));
      clock.set(new Date(idle.getTime() - 10_000));
      const arbiter = new SeriesCommandArbiter(journal, fence);
      const first = await arbiter.admitAndEvaluate({
        seriesKey: 'pg-ext',
        playerId: 'p1',
        commandType: 'thinking_extension',
        idempotencyKey: 'pg-ext-1',
        payloadHash: 'h',
      });
      assert.equal(first.decision, 'apply');

      // New store instance = reconnect / process restart fidelity.
      const fence2 = new PostgresSeriesFenceStore(pool);
      const state = await fence2.get('pg-ext');
      assert.equal(state!.thinkingExtensionConsumed, true);

      const arbiter2 = new SeriesCommandArbiter(journal, fence2);
      const second = await arbiter2.admitAndEvaluate({
        seriesKey: 'pg-ext',
        playerId: 'p1',
        commandType: 'thinking_extension',
        idempotencyKey: 'pg-ext-2',
        payloadHash: 'h2',
      });
      assert.equal(second.decision, 'reject');
    } finally {
      await pool.end();
    }
  });
});

describe('PZD-38 P1-02 — hard cutoff on thinking extension', () => {
  const cases: Array<{ name: string; remaining: number; expectOk: boolean }> = [
    { name: 'remaining 60001', remaining: 60_001, expectOk: false },
    { name: 'remaining 60000', remaining: 60_000, expectOk: true },
    { name: 'remaining 1', remaining: 1, expectOk: true },
    { name: 'remaining 0', remaining: 0, expectOk: false },
  ];

  for (const c of cases) {
    it(`memory arbiter: ${c.name}`, async () => {
      const clock = new ControllableClock(T0);
      const journal = new MemoryAdmissionJournal({ clock });
      const fence = new MemorySeriesFenceStore();
      const idle = new Date(T0.getTime() + c.remaining);
      await fence.put(baseFence('s1', { idleDeadlineAt: idle }));
      const arbiter = new SeriesCommandArbiter(journal, fence);
      clock.set(T0);
      const r = await arbiter.admitAndEvaluate({
        seriesKey: 's1',
        playerId: 'p1',
        commandType: 'thinking_extension',
        idempotencyKey: `r-${c.remaining}`,
        payloadHash: 'h',
      });
      assert.equal(r.decision, c.expectOk ? 'apply' : 'reject');
      if (!c.expectOk) {
        assert.equal((await fence.get('s1'))!.thinkingExtensionConsumed, false);
      }
    });
  }

  it('memory: hard cutoff 30s away caps extension', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const fence = new MemorySeriesFenceStore();
    const idle = new Date(T0.getTime() + 30_000);
    const hard = new Date(idle.getTime() + 30_000);
    await fence.put(
      baseFence('s1', { idleDeadlineAt: idle, hardCutoffAt: hard }),
    );
    const arbiter = new SeriesCommandArbiter(journal, fence);
    clock.set(new Date(idle.getTime() - 15_000));
    const r = await arbiter.admitAndEvaluate({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'thinking_extension',
      idempotencyKey: 'cap',
      payloadHash: 'h',
    });
    assert.equal(r.decision, 'apply');
    assert.equal((await fence.get('s1'))!.idleDeadlineAt.getTime(), hard.getTime());
  });

  it('memory: exactly at hard cutoff — extension/move ineligible', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const fence = new MemorySeriesFenceStore();
    const hard = new Date(T0.getTime() + 60_000);
    const idle = new Date(T0.getTime() + 30_000);
    await fence.put(
      baseFence('s1', { idleDeadlineAt: idle, hardCutoffAt: hard }),
    );
    const arbiter = new SeriesCommandArbiter(journal, fence, {
      resolveMoveEffect: fixedMoveEffect(1),
    });
    clock.set(hard); // equality => expired
    const move = await arbiter.admitAndEvaluate({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'at-hard',
      payloadHash: 'h',
      expectedBoardRevision: 0,
      writerGeneration: 1,
    });
    assert.equal(move.decision, 'reject');
    if (move.decision === 'reject') {
      assert.ok(
        move.reason === 'HARD_CUTOFF_EXPIRED' || move.reason === 'IDLE_EXPIRED',
      );
    }
  });

  it('memory: one ms after hard cutoff rejected', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const fence = new MemorySeriesFenceStore();
    const hard = new Date(T0.getTime() + 60_000);
    await fence.put(
      baseFence('s1', {
        idleDeadlineAt: new Date(hard.getTime() + 100_000),
        hardCutoffAt: hard,
      }),
    );
    const arbiter = new SeriesCommandArbiter(journal, fence, {
      resolveMoveEffect: fixedMoveEffect(1),
    });
    clock.set(new Date(hard.getTime() + 1));
    const move = await arbiter.admitAndEvaluate({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'after-hard',
      payloadHash: 'h',
      expectedBoardRevision: 0,
      writerGeneration: 1,
    });
    assert.equal(move.decision, 'reject');
    if (move.decision === 'reject') {
      assert.equal(move.reason, 'HARD_CUTOFF_EXPIRED');
    }
  });

  it('unit: applyThinkingExtension hard-cutoff table', () => {
    const idle = new Date(T0.getTime() + 30_000);
    const hard = new Date(idle.getTime() + 30_000);
    assert.equal(applyThinkingExtension(idle, 60_001, hard), null);
    assert.equal(applyThinkingExtension(idle, 0, hard), null);
    assert.equal(
      applyThinkingExtension(idle, 60_000, hard)?.getTime(),
      hard.getTime(),
    );
    assert.equal(
      applyThinkingExtension(idle, 1, null)?.getTime(),
      idle.getTime() + 60_000,
    );
  });
});

describe('PZD-38 P1-03 — atomic expiry vs pending admission', () => {
  it('memory: forfeit blocked when pending exists under series lock', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const fence = new MemorySeriesFenceStore();
    const idle = idleDeadlineFrom(T0, 300);
    await fence.put(baseFence('s1', { idleDeadlineAt: idle }));
    const arbiter = new SeriesCommandArbiter(journal, fence, {
      resolveMoveEffect: fixedMoveEffect(1),
    });
    clock.set(new Date(idle.getTime() - 1));
    await journal.admit({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'pend',
      payloadHash: 'h',
    });
    const f = await arbiter.tryForfeitForInactivity('s1');
    assert.equal(f.ok, false);
    if (!f.ok) assert.equal(f.reason, 'BLOCKED_PENDING');
  });

  it('postgres: TOCTOU — admit between unlocked check and locked forfeit keeps pending', async (t) => {
    const pool = await connectOrSkip(t);
    if (!pool) return;
    try {
      await pool.query('DROP TABLE IF EXISTS command_admission_journal');
      await pool.query('DROP TABLE IF EXISTS series_fence_state');
      const clock = new ControllableClock(T0);
      const journal = new PostgresAdmissionJournal(pool, clock);
      const fence = new PostgresSeriesFenceStore(pool);
      await journal.migrate();
      await fence.migrate();
      const idle = idleDeadlineFrom(T0, 300);
      await fence.put(baseFence('pg-toc', { idleDeadlineAt: idle }));
      const arbiter = new SeriesCommandArbiter(journal, fence, {
        resolveMoveEffect: fixedMoveEffect(1),
      });

      let releaseAdmit!: () => void;
      const admitGate = new Promise<void>((r) => {
        releaseAdmit = r;
      });
      let admitDone!: () => void;
      const admitFinished = new Promise<void>((r) => {
        admitDone = r;
      });

      clock.set(new Date(idle.getTime() - 1));

      const forfeitPromise = arbiter.tryForfeitForInactivity('pg-toc', {
        beforeLockedBarrier: async () => {
          // Signal concurrent admit, then wait until it has durably committed.
          releaseAdmit();
          await admitFinished;
        },
      });

      await admitGate;
      const admit = await journal.admit({
        seriesKey: 'pg-toc',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'race-admit',
        payloadHash: 'h',
        expectedBoardRevision: 0,
        writerGeneration: 1,
      });
      assert.equal(admit.ok, true);
      admitDone();

      const forfeit = await forfeitPromise;
      assert.equal(forfeit.ok, false);
      if (!forfeit.ok) assert.equal(forfeit.reason, 'BLOCKED_PENDING');
      assert.equal((await fence.get('pg-toc'))!.status, 'ACTIVE');
      assert.equal(
        (await journal.listEligiblePending('pg-toc', idle)).length,
        1,
      );
    } finally {
      await pool.end();
    }
  });

  it('postgres: reversed order — admit commits first, then forfeit blocked', async (t) => {
    const pool = await connectOrSkip(t);
    if (!pool) return;
    try {
      await pool.query('DROP TABLE IF EXISTS command_admission_journal');
      await pool.query('DROP TABLE IF EXISTS series_fence_state');
      const clock = new ControllableClock(T0);
      const journal = new PostgresAdmissionJournal(pool, clock);
      const fence = new PostgresSeriesFenceStore(pool);
      await journal.migrate();
      await fence.migrate();
      const idle = idleDeadlineFrom(T0, 300);
      await fence.put(baseFence('pg-rev', { idleDeadlineAt: idle }));
      const arbiter = new SeriesCommandArbiter(journal, fence, {
        resolveMoveEffect: fixedMoveEffect(1),
      });
      clock.set(new Date(idle.getTime() - 1));
      const admit = await journal.admit({
        seriesKey: 'pg-rev',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'first',
        payloadHash: 'h',
      });
      assert.equal(admit.ok, true);
      const forfeit = await arbiter.tryForfeitForInactivity('pg-rev');
      assert.equal(forfeit.ok, false);
    } finally {
      await pool.end();
    }
  });

  it('postgres: simultaneous completion vs forfeit — COMPLETED wins, no publish', async (t) => {
    const pool = await connectOrSkip(t);
    if (!pool) return;
    try {
      await pool.query('DROP TABLE IF EXISTS command_admission_journal');
      await pool.query('DROP TABLE IF EXISTS series_fence_state');
      const clock = new ControllableClock(T0);
      const journal = new PostgresAdmissionJournal(pool, clock);
      const fence = new PostgresSeriesFenceStore(pool);
      await journal.migrate();
      await fence.migrate();
      const idle = idleDeadlineFrom(T0, 300);
      await fence.put(baseFence('pg-comp', { idleDeadlineAt: idle }));
      const arbiter = new SeriesCommandArbiter(journal, fence, {
        resolveMoveEffect: fixedMoveEffect(10, true),
      });
      clock.set(new Date(idle.getTime() - 1));
      const [done, forfeit] = await Promise.all([
        arbiter.admitAndEvaluate({
          seriesKey: 'pg-comp',
          playerId: 'p1',
          commandType: 'move',
          idempotencyKey: 'h1',
          payloadHash: 'h',
          expectedBoardRevision: 0,
          writerGeneration: 1,
        }),
        arbiter.tryForfeitForInactivity('pg-comp'),
      ]);
      // Either forfeit blocked by pending/COMPLETED, or completion applied.
      if (done.decision === 'apply') {
        assert.equal(done.state.status, 'COMPLETED');
        assert.equal(done.state.resultsPublished, false);
        assert.equal(forfeit.ok, false);
      } else {
        // Rare: forfeit won empty-pending race before admit — admit then rejects terminal.
        assert.ok(forfeit.ok || done.decision === 'reject');
      }
    } finally {
      await pool.end();
    }
  });
});

describe('PZD-38 P1-04 — untrusted score/completion authority', () => {
  it('rejects positive/negative/overflow client scoreDelta', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const fence = new MemorySeriesFenceStore();
    await fence.put(baseFence('s1'));
    const arbiter = new SeriesCommandArbiter(journal, fence, {
      resolveMoveEffect: fixedMoveEffect(1),
    });
    for (const scoreDelta of [1, -1, Number.MAX_SAFE_INTEGER + 1, 999999]) {
      const r = await arbiter.admitAndEvaluate({
        seriesKey: 's1',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: `score-${scoreDelta}`,
        payloadHash: `h-${scoreDelta}`,
        expectedBoardRevision: 0,
        writerGeneration: 1,
        scoreDelta,
      });
      assert.equal(r.decision, 'reject');
      if (r.decision === 'reject') {
        assert.equal(r.reason, 'UNTRUSTED_SCORE_AUTHORITY');
      }
    }
    assert.equal((await fence.get('s1'))!.score, 0);
    assert.equal((await fence.get('s1'))!.resultsPublished, false);
  });

  it('rejects forged completesSeries without trusted resolver completion', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const fence = new MemorySeriesFenceStore();
    await fence.put(baseFence('s1'));
    const arbiter = new SeriesCommandArbiter(journal, fence, {
      resolveMoveEffect: fixedMoveEffect(5, false),
    });
    const r = await arbiter.admitAndEvaluate({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'forge-complete',
      payloadHash: 'h',
      expectedBoardRevision: 0,
      writerGeneration: 1,
      completesSeries: true,
    });
    assert.equal(r.decision, 'reject');
    if (r.decision === 'reject') {
      assert.equal(r.reason, 'UNTRUSTED_COMPLETION_AUTHORITY');
    }
    assert.equal((await fence.get('s1'))!.status, 'ACTIVE');
    assert.equal((await fence.get('s1'))!.resultsPublished, false);
  });

  it('trusted resolver may COMPLETE without publishing results', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const fence = new MemorySeriesFenceStore();
    await fence.put(baseFence('s1'));
    const arbiter = new SeriesCommandArbiter(journal, fence, {
      resolveMoveEffect: fixedMoveEffect(8, true),
    });
    const r = await arbiter.admitAndEvaluate({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'ok-complete',
      payloadHash: 'h',
      expectedBoardRevision: 0,
      writerGeneration: 1,
    });
    assert.equal(r.decision, 'apply');
    if (r.decision === 'apply') {
      assert.equal(r.state.status, 'COMPLETED');
      assert.equal(r.state.resultsPublished, false);
      assert.equal(r.state.score, 8);
    }
  });

  it('move without ServerMoveEffectResolver fails closed', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const fence = new MemorySeriesFenceStore();
    await fence.put(baseFence('s1'));
    const arbiter = new SeriesCommandArbiter(journal, fence);
    const r = await arbiter.admitAndEvaluate({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'no-resolver',
      payloadHash: 'h',
      expectedBoardRevision: 0,
      writerGeneration: 1,
    });
    assert.equal(r.decision, 'reject');
    if (r.decision === 'reject') {
      assert.equal(r.reason, 'MOVE_EFFECT_UNAVAILABLE');
    }
  });
});
