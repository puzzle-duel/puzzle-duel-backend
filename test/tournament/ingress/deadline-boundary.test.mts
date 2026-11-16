import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ControllableClock } from '../../../src/tournament/ingress/clock.mts';
import { MemoryAdmissionJournal } from '../../../src/tournament/ingress/journal.mts';
import { SeriesCommandArbiter } from '../../../src/tournament/ingress/arbiter.mts';
import {
  applyThinkingExtension,
  idleDeadlineFrom,
  isTimely,
} from '../../../src/tournament/ingress/types.mts';

const T0 = new Date('2026-11-16T12:00:00.000Z');

describe('PZD-38 Gate A — deadline boundaries', () => {
  it('P38-03: deadline−1ms eligible; equality expired; +1ms expired', () => {
    const deadline = idleDeadlineFrom(T0, 300);
    assert.equal(deadline.toISOString(), '2026-11-16T12:05:00.000Z');

    const minus1 = new Date(deadline.getTime() - 1);
    const exact = new Date(deadline.getTime());
    const plus1 = new Date(deadline.getTime() + 1);

    assert.equal(isTimely(minus1, deadline), true);
    assert.equal(isTimely(exact, deadline), false);
    assert.equal(isTimely(plus1, deadline), false);
  });

  it('thinking extension only when remaining idle in (0, 60s]', () => {
    const idle = new Date(T0.getTime() + 30_000);
    const remainingOk = 30_000;
    const extended = applyThinkingExtension(idle, remainingOk, null);
    assert.ok(extended);
    assert.equal(extended!.getTime(), idle.getTime() + 60_000);

    assert.equal(applyThinkingExtension(idle, 0, null), null);
    assert.equal(applyThinkingExtension(idle, 60_001, null), null);
  });

  it('predeadline admit + postdeadline adjudication still eligible', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const arbiter = new SeriesCommandArbiter(journal);
    const idleDeadlineAt = idleDeadlineFrom(T0, 300);

    clock.set(new Date(idleDeadlineAt.getTime() - 1));

    const result = await arbiter.admitAndEvaluate(
      {
        seriesKey: 's1',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'k1',
        payloadHash: 'h1',
      },
      {
        seriesKey: 's1',
        idleDeadlineAt,
        hardCutoffAt: null,
        status: 'ACTIVE',
      },
      {
        afterAdmit: async () => {
          // Simulate DB lock / processing finishing after the deadline.
          clock.set(new Date(idleDeadlineAt.getTime() + 5_000));
        },
      },
    );

    assert.equal(result.decision, 'apply');
    if (result.decision === 'apply') {
      assert.equal(
        result.command.trustedReceivedAt.getTime(),
        idleDeadlineAt.getTime() - 1,
      );
    }
  });

  it('deadline-equal ingress is rejected even if processing is immediate', async () => {
    const clock = new ControllableClock(T0);
    const journal = new MemoryAdmissionJournal({ clock });
    const arbiter = new SeriesCommandArbiter(journal);
    const idleDeadlineAt = idleDeadlineFrom(T0, 300);
    clock.set(idleDeadlineAt);

    const result = await arbiter.admitAndEvaluate(
      {
        seriesKey: 's1',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'k-eq',
        payloadHash: 'h',
      },
      {
        seriesKey: 's1',
        idleDeadlineAt,
        hardCutoffAt: null,
        status: 'ACTIVE',
      },
    );

    assert.equal(result.decision, 'reject');
    if (result.decision === 'reject') {
      assert.equal(result.reason, 'IDLE_EXPIRED');
    }
  });

  it('clientDeclaredAt is ignored for eligibility', async () => {
    const clock = new ControllableClock(new Date(T0.getTime() + 301_000));
    const journal = new MemoryAdmissionJournal({ clock });
    const arbiter = new SeriesCommandArbiter(journal);
    const idleDeadlineAt = idleDeadlineFrom(T0, 300);

    const result = await arbiter.admitAndEvaluate(
      {
        seriesKey: 's1',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'spoof',
        payloadHash: 'h',
        clientDeclaredAt: new Date(T0.getTime() + 1),
      },
      {
        seriesKey: 's1',
        idleDeadlineAt,
        hardCutoffAt: null,
        status: 'ACTIVE',
      },
    );

    assert.equal(result.decision, 'reject');
  });
});
