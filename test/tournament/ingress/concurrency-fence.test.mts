import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ControllableClock } from '../../../src/tournament/ingress/clock.mts';
import { MemoryAdmissionJournal } from '../../../src/tournament/ingress/journal.mts';
import { MemorySeriesFenceStore } from '../../../src/tournament/ingress/series-fence.mts';
import { SeriesCommandArbiter } from '../../../src/tournament/ingress/arbiter.mts';
import { idleDeadlineFrom } from '../../../src/tournament/ingress/types.mts';
import type { ServerMoveEffectResolver } from '../../../src/tournament/adjudication/trusted-gameplay.mts';

const T0 = new Date('2026-11-16T12:00:00.000Z');

/** Test-only server effects keyed by idempotency — never from client body. */
function effectsByKey(
  map: Record<string, { scoreDelta: number; completesSubgame?: boolean }>,
): ServerMoveEffectResolver {
  return (input) => {
    const effect = map[input.idempotencyKey];
    if (!effect) return null;
    return {
      scoreDelta: effect.scoreDelta,
      completesSubgame: effect.completesSubgame ?? false,
    };
  };
}

async function setup(moveEffect: ServerMoveEffectResolver | null = null) {
  const clock = new ControllableClock(T0);
  const journal = new MemoryAdmissionJournal({ clock });
  const fence = new MemorySeriesFenceStore();
  const idleDeadlineAt = idleDeadlineFrom(T0, 300);
  await fence.put({
    seriesKey: 's1',
    boardRevision: 0,
    writerGeneration: 1,
    status: 'ACTIVE',
    idleDeadlineAt,
    hardCutoffAt: null,
    score: 0,
    resultsPublished: false,
    lastAppliedAdmissionId: null,
  });
  return {
    clock,
    journal,
    fence,
    idleDeadlineAt,
    arbiter: new SeriesCommandArbiter(journal, fence, moveEffect),
  };
}

describe('PZD-38 Gate A — concurrency fences (Stage E server effects)', () => {
  it('Case A: two distinct moves at same revision => one apply, one STATE_CONFLICT, one score', async () => {
    const { arbiter, fence } = await setup(
      effectsByKey({ 'm-a': { scoreDelta: 5 }, 'm-b': { scoreDelta: 9 } }),
    );
    const [a, b] = await Promise.all([
      arbiter.admitAndEvaluate({
        seriesKey: 's1',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'm-a',
        payloadHash: 'ha',
        expectedBoardRevision: 0,
        writerGeneration: 1,
      }),
      arbiter.admitAndEvaluate({
        seriesKey: 's1',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'm-b',
        payloadHash: 'hb',
        expectedBoardRevision: 0,
        writerGeneration: 1,
      }),
    ]);

    const decisions = [a.decision, b.decision].sort();
    assert.deepEqual(decisions, ['apply', 'reject']);
    const applied = a.decision === 'apply' ? a : b;
    const rejected = a.decision === 'reject' ? a : b;
    assert.equal(applied.decision, 'apply');
    assert.equal(rejected.decision, 'reject');
    if (rejected.decision === 'reject') {
      assert.equal(rejected.reason, 'STATE_CONFLICT');
    }
    const state = await fence.get('s1');
    assert.equal(state!.boardRevision, 1);
    assert.ok(state!.score === 5 || state!.score === 9);
  });

  it('Case B: concurrent duplicate idempotency => one logical apply, no double score', async () => {
    const { arbiter, fence } = await setup(
      effectsByKey({ same: { scoreDelta: 3 } }),
    );
    const results = await Promise.all([
      arbiter.admitAndEvaluate({
        seriesKey: 's1',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'same',
        payloadHash: 'h',
        expectedBoardRevision: 0,
        writerGeneration: 1,
      }),
      arbiter.admitAndEvaluate({
        seriesKey: 's1',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'same',
        payloadHash: 'h',
        expectedBoardRevision: 0,
        writerGeneration: 1,
      }),
    ]);

    assert.ok(results.every((r) => r.decision === 'apply'));
    const state = await fence.get('s1');
    assert.equal(state!.score, 3);
    assert.equal(state!.boardRevision, 1);
  });

  it('Case C: expiry worker cannot forfeit while timely pending move exists', async () => {
    const { clock, journal, arbiter, idleDeadlineAt } = await setup(
      effectsByKey({ 'late-process': { scoreDelta: 1 } }),
    );
    clock.set(new Date(idleDeadlineAt.getTime() - 1));
    await journal.admit({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'late-process',
      payloadHash: 'h',
      expectedBoardRevision: 0,
      writerGeneration: 1,
    });
    clock.set(new Date(idleDeadlineAt.getTime() + 1));
    const attempt = await arbiter.tryForfeitForInactivity('s1');
    assert.equal(attempt.ok, false);
  });

  it('Case D: timely H1 completes once; timeout cannot overwrite COMPLETED; no leaderboard publish', async () => {
    const { clock, arbiter, fence, idleDeadlineAt } = await setup(
      effectsByKey({
        'h1-final': { scoreDelta: 100, completesSubgame: true },
      }),
    );
    clock.set(new Date(idleDeadlineAt.getTime() - 1));
    const done = await arbiter.admitAndEvaluate(
      {
        seriesKey: 's1',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'h1-final',
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
    assert.equal(done.decision, 'apply');
    if (done.decision === 'apply') {
      assert.equal(done.state.status, 'COMPLETED');
      // Stage E: completion does not imply four-category publish.
      assert.equal(done.state.resultsPublished, false);
    }
    const forfeit = await arbiter.tryForfeitForInactivity('s1');
    assert.equal(forfeit.ok, false);
    const state = await fence.get('s1');
    assert.equal(state!.status, 'COMPLETED');
    assert.equal(state!.resultsPublished, false);
  });

  it('Case E: handoff fences old writer; handoff does not refresh idle deadline', async () => {
    const { arbiter, fence, idleDeadlineAt } = await setup(
      effectsByKey({ 'old-device': { scoreDelta: 50 } }),
    );
    const before = (await fence.get('s1'))!.idleDeadlineAt.getTime();
    const handoff = await arbiter.admitAndEvaluate({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'device_handoff',
      idempotencyKey: 'handoff-1',
      payloadHash: 'h',
      writerGeneration: 1,
    });
    assert.equal(handoff.decision, 'apply');
    const afterHandoff = await fence.get('s1');
    assert.equal(afterHandoff!.writerGeneration, 2);
    assert.equal(afterHandoff!.idleDeadlineAt.getTime(), before);
    assert.equal(afterHandoff!.idleDeadlineAt.getTime(), idleDeadlineAt.getTime());

    const stale = await arbiter.admitAndEvaluate({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'old-device',
      payloadHash: 'old',
      expectedBoardRevision: 0,
      writerGeneration: 1,
    });
    assert.equal(stale.decision, 'reject');
    if (stale.decision === 'reject') {
      assert.equal(stale.reason, 'NOT_ACTIVE_WRITER');
    }
    assert.equal((await fence.get('s1'))!.score, 0);
  });

  it('Case F: weekly settlement blocked while eligible pre-cutoff H1 pending', async () => {
    const { clock, journal, arbiter, idleDeadlineAt } = await setup();
    const mondayCutoff = new Date('2026-11-17T01:00:00.000Z');
    clock.set(new Date(mondayCutoff.getTime() - 1));
    await journal.admit({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'week-h1',
      payloadHash: 'h',
    });
    clock.set(new Date(mondayCutoff.getTime() + 60_000));
    const barrier = await arbiter.canSafelyFinalizeWeekly(
      ['s1', 's2'],
      mondayCutoff,
    );
    assert.equal(barrier.allowed, false);
    assert.equal(barrier.blocking.length, 1);
    assert.equal(
      (await arbiter.canSafelyForfeit('s1', idleDeadlineAt)).allowed,
      true,
    );
  });

  it('Stage E: client scoreDelta on admit input cannot authorize score without server effect', async () => {
    const { arbiter, fence } = await setup(null);
    const result = await arbiter.admitAndEvaluate({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'forged-score',
      payloadHash: 'x',
      expectedBoardRevision: 0,
      writerGeneration: 1,
      scoreDelta: 100_000,
      completesSeries: true,
    });
    assert.equal(result.decision, 'reject');
    if (result.decision === 'reject') {
      assert.equal(result.reason, 'MOVE_REQUIRES_SERVER_EFFECT');
    }
    assert.equal((await fence.get('s1'))!.score, 0);
    assert.equal((await fence.get('s1'))!.boardRevision, 0);
  });
});
