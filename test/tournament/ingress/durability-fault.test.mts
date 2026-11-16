import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ControllableClock } from '../../../src/tournament/ingress/clock.mts';
import { MemoryAdmissionJournal } from '../../../src/tournament/ingress/journal.mts';
import { SeriesCommandArbiter } from '../../../src/tournament/ingress/arbiter.mts';
import { idleDeadlineFrom } from '../../../src/tournament/ingress/types.mts';

const T0 = new Date('2026-11-16T12:00:00.000Z');

describe('PZD-38 Gate A — durability and fault injection', () => {
  it('P38-05: fail closed when durable ingress unavailable — no fabricated accept', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock, failClosed: true });
    const arbiter = new SeriesCommandArbiter(journal);

    const result = await arbiter.admitAndEvaluate(
      {
        seriesKey: 's1',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'k',
        payloadHash: 'h',
      },
      {
        seriesKey: 's1',
        idleDeadlineAt: idleDeadlineFrom(T0, 300),
        hardCutoffAt: null,
        status: 'ACTIVE',
      },
    );

    assert.equal(result.decision, 'unavailable');
    assert.equal(await journal.getByIdempotency('s1', 'p1', 'k'), null);
  });

  it('crash before durable admission: no row, retry creates new admission', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    // Simulate crash with empty durable store.
    journal.restoreSnapshot([]);
    clock.advanceMs(10);
    const admit = await journal.admit({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'k',
      payloadHash: 'h',
    });
    assert.equal(admit.ok, true);
    if (admit.ok) {
      assert.equal(admit.command.admissionSeq, 1);
    }
  });

  it('crash after durable admission: retry returns same trustedReceivedAt', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const first = await journal.admit({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'k',
      payloadHash: 'h',
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const snap = journal.snapshot();
    const recovered = new MemoryAdmissionJournal({
      clock: new ControllableClock(new Date(T0.getTime() + 60_000)),
    });
    recovered.restoreSnapshot(snap);

    const second = await recovered.admit({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'k',
      payloadHash: 'h',
    });
    assert.equal(second.ok, true);
    if (second.ok && first.ok) {
      assert.equal(second.command.status, 'duplicate');
      assert.equal(
        second.command.trustedReceivedAt.toISOString(),
        first.command.trustedReceivedAt.toISOString(),
      );
      assert.equal(second.command.admissionId, first.command.admissionId);
    }
  });

  it('same key different payload => IDEMPOTENCY_PAYLOAD_CONFLICT', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    await journal.admit({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'k',
      payloadHash: 'h1',
    });
    const conflict = await journal.admit({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'k',
      payloadHash: 'h2',
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) {
      assert.equal(conflict.reason, 'IDEMPOTENCY_PAYLOAD_CONFLICT');
    }
  });

  it('timeout worker blocked while eligible pending admission exists', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const arbiter = new SeriesCommandArbiter(journal);
    const idleDeadlineAt = idleDeadlineFrom(T0, 300);

    clock.set(new Date(idleDeadlineAt.getTime() - 1));
    const admit = await journal.admit({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'final-h1',
      payloadHash: 'h',
    });
    assert.equal(admit.ok, true);

    // Wall clock is past deadline, but pending timely admission remains.
    clock.set(new Date(idleDeadlineAt.getTime() + 10_000));
    const barrier = await arbiter.canSafelyForfeit('s1', idleDeadlineAt);
    assert.equal(barrier.allowed, false);
    assert.equal(barrier.blocking.length, 1);

    if (admit.ok) {
      await journal.markOutcome(admit.command.admissionId, 'applied');
    }
    const after = await arbiter.canSafelyForfeit('s1', idleDeadlineAt);
    assert.equal(after.allowed, true);
  });

  it('consumer crash after admit before outcome mark: pending blocks forfeit; retry is duplicate', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const idleDeadlineAt = idleDeadlineFrom(T0, 300);
    clock.set(new Date(idleDeadlineAt.getTime() - 1));

    const admit = await journal.admit({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'pending-h1',
      payloadHash: 'h',
    });
    assert.equal(admit.ok, true);
    // Crash before markOutcome / series commit — admission durable, outcome pending.
    const snap = journal.snapshot();
    clock.set(new Date(idleDeadlineAt.getTime() + 5_000));
    const recovered = new MemoryAdmissionJournal({ clock });
    recovered.restoreSnapshot(snap);
    const arbiter = new SeriesCommandArbiter(recovered);
    const barrier = await arbiter.canSafelyForfeit('s1', idleDeadlineAt);
    assert.equal(barrier.allowed, false);

    const retry = await recovered.admit({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'pending-h1',
      payloadHash: 'h',
    });
    assert.equal(retry.ok, true);
    if (retry.ok && admit.ok) {
      assert.equal(retry.command.status, 'duplicate');
      assert.equal(
        retry.command.trustedReceivedAt.toISOString(),
        admit.command.trustedReceivedAt.toISOString(),
      );
    }
  });

  it('consumer crash after DB commit before response: retry returns applied duplicate identity', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const idleDeadlineAt = idleDeadlineFrom(T0, 300);
    clock.set(new Date(idleDeadlineAt.getTime() - 1));
    const arbiter = new SeriesCommandArbiter(journal);
    const first = await arbiter.admitAndEvaluate(
      {
        seriesKey: 's1',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'committed-h1',
        payloadHash: 'h',
      },
      {
        seriesKey: 's1',
        idleDeadlineAt,
        hardCutoffAt: null,
        status: 'ACTIVE',
      },
    );
    assert.equal(first.decision, 'apply');
    const snap = journal.snapshot();
    // Response lost; process restarts later with advanced wall clock.
    const recovered = new MemoryAdmissionJournal({
      clock: new ControllableClock(new Date(idleDeadlineAt.getTime() + 60_000)),
    });
    recovered.restoreSnapshot(snap);
    const again = await recovered.admit({
      seriesKey: 's1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'committed-h1',
      payloadHash: 'h',
    });
    assert.equal(again.ok, true);
    if (again.ok && first.decision === 'apply') {
      assert.equal(again.command.status, 'duplicate');
      assert.equal(again.command.admissionId, first.command.admissionId);
      assert.equal(
        again.command.trustedReceivedAt.toISOString(),
        first.command.trustedReceivedAt.toISOString(),
      );
    }
  });

  it('multi-instance competing admits: one seq order, stable idempotent winner', async () => {
    const clock = new ControllableClock(T0);
    // Shared durable store simulating multi-instance journal.
    const shared = new MemoryAdmissionJournal({ clock });

    const results = await Promise.all([
      shared.admit({
        seriesKey: 's1',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'a',
        payloadHash: 'ha',
      }),
      shared.admit({
        seriesKey: 's1',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'b',
        payloadHash: 'hb',
      }),
    ]);

    assert.equal(results.every((r) => r.ok), true);
    const seqs = results
      .filter((r) => r.ok)
      .map((r) => (r.ok ? r.command.admissionSeq : 0))
      .sort((a, b) => a - b);
    assert.deepEqual(seqs, [1, 2]);
    assert.equal(await shared.maxAdmissionSeq('s1'), 2);
  });
});
