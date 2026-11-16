import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { ControllableClock } from '../../../src/tournament/ingress/clock.mts';
import { PostgresAdmissionJournal } from '../../../src/tournament/ingress/postgres-journal.mts';
import { SeriesCommandArbiter } from '../../../src/tournament/ingress/arbiter.mts';
import { idleDeadlineFrom } from '../../../src/tournament/ingress/types.mts';

const DATABASE_URL =
  process.env.PZD_INGRESS_DATABASE_URL ??
  'postgresql://pzd:pzd@127.0.0.1:55432/pzd_ingress';

const T0 = new Date('2026-11-16T12:00:00.000Z');

describe('PZD-38 Gate A — PostgreSQL durable journal', () => {
  it('admits predeadline H1, survives delayed commit past deadline', async (t) => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    try {
      await pool.query('SELECT 1');
    } catch {
      await pool.end();
      t.skip(`postgres unavailable at ${DATABASE_URL}`);
      return;
    }

    const clock = new ControllableClock(T0);
    const journal = new PostgresAdmissionJournal(pool, clock);
    await pool.query('DROP TABLE IF EXISTS command_admission_journal');
    await journal.migrate();

    const idleDeadlineAt = idleDeadlineFrom(T0, 300);
    clock.set(new Date(idleDeadlineAt.getTime() - 1));
    const arbiter = new SeriesCommandArbiter(journal);

    const result = await arbiter.admitAndEvaluate(
      {
        seriesKey: 'pg-s1',
        playerId: 'p1',
        commandType: 'move',
        idempotencyKey: 'final-h1',
        payloadHash: 'h1',
      },
      {
        seriesKey: 'pg-s1',
        idleDeadlineAt,
        hardCutoffAt: null,
        status: 'ACTIVE',
      },
      {
        afterAdmit: async () => {
          clock.set(new Date(idleDeadlineAt.getTime() + 2_000));
        },
      },
    );

    assert.equal(result.decision, 'apply');
    const again = await journal.admit({
      seriesKey: 'pg-s1',
      playerId: 'p1',
      commandType: 'move',
      idempotencyKey: 'final-h1',
      payloadHash: 'h1',
    });
    assert.equal(again.ok, true);
    if (again.ok && result.decision === 'apply') {
      assert.equal(again.command.status, 'duplicate');
      assert.equal(
        again.command.trustedReceivedAt.toISOString(),
        result.command.trustedReceivedAt.toISOString(),
      );
    }

    await pool.end();
  });
});
