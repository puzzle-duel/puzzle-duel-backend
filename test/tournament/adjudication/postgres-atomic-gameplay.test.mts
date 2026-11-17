import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { ControllableClock } from '../../../src/tournament/ingress/clock.mts';
import { PostgresAdmissionJournal } from '../../../src/tournament/ingress/postgres-journal.mts';
import { PostgresSeriesFenceStore } from '../../../src/tournament/ingress/series-fence.mts';
import { idleDeadlineFrom } from '../../../src/tournament/ingress/types.mts';
import { stateToJson } from '../../../src/engine/core001v3/index.mts';
import {
  PostgresTrustedUnitOfWork,
  PostgresTrustedChallengeStore,
  PostgresAcceptedMoveLedger,
  PostgresAuthoritativeSnapshotStore,
  TrustedGameplayService,
  MemoryVerifiedAuthorizationGateway,
  bindTrustedChallenge,
  selfConsistentJsonHash,
  type UowFaultPoint,
} from '../../../src/tournament/adjudication/index.mts';
import { FIXTURE, legalMoveCmd, makeAuth, T0 } from './helpers.mts';

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

async function resetSchema(pool: pg.Pool) {
  await pool.query(`
    DROP TABLE IF EXISTS accepted_move_ledger;
    DROP TABLE IF EXISTS authoritative_game_snapshot;
    DROP TABLE IF EXISTS trusted_challenge_binding;
    DROP TABLE IF EXISTS command_admission_journal;
    DROP TABLE IF EXISTS series_fence_state;
  `);
}

async function bootPg(pool: pg.Pool, seriesKey = 'pg-series-1') {
  const clock = new ControllableClock(T0);
  const journal = new PostgresAdmissionJournal(pool, clock);
  const fence = new PostgresSeriesFenceStore(pool);
  const uow = new PostgresTrustedUnitOfWork(pool);
  await journal.migrate();
  await fence.migrate();
  await uow.migrate();

  const challenges = new PostgresTrustedChallengeStore(pool);
  const ledger = new PostgresAcceptedMoveLedger(pool);
  const snapshots = new PostgresAuthoritativeSnapshotStore(pool);
  const authGw = new MemoryVerifiedAuthorizationGateway();
  const auth = makeAuth({ seriesKey, playerId: 'player-1' });
  authGw.register(auth);

  await fence.put({
    seriesKey,
    boardRevision: 0,
    writerGeneration: 1,
    status: 'ACTIVE',
    idleDeadlineAt: idleDeadlineFrom(T0, 300),
    hardCutoffAt: null,
    score: 0,
    resultsPublished: false,
    lastAppliedAdmissionId: null,
    thinkingExtensionConsumed: false,
  });

  const binding = bindTrustedChallenge({
    seriesKey,
    playerId: 'player-1',
    subgameOrdinal: 1,
    challengeId: 'chal-pg-1',
    generatorVersion: 'gen-001.v1-adapter-test',
    contentVersion: 'stage-e-pg',
    initialStateRaw: FIXTURE.initialState,
    assignedAt: T0,
  });
  await challenges.put(binding);
  await snapshots.put({
    seriesKey,
    playerId: 'player-1',
    subgameOrdinal: 1,
    challengeId: binding.challengeId,
    boardRevision: 0,
    moveCursor: 0,
    stateHash: binding.initialStateDigest,
    score: 0,
    status: 'in_progress',
    terminalReason: null,
    state: binding.initialState,
    ledgerAdmissionSeq: 0,
    writerGeneration: 1,
    producedByAdmissionId: null,
  });

  const service = new TrustedGameplayService({
    journal,
    fence,
    challenges,
    ledger,
    snapshots,
    clock,
    authorization: authGw,
    postgresUow: uow,
    resolveActiveOrdinal: async () => 1,
  });

  return {
    service,
    journal,
    fence,
    ledger,
    snapshots,
    challenges,
    uow,
    authGw,
    auth,
    binding,
    clock,
    seriesKey,
    hints: {
      seriesKeyHint: seriesKey,
      playerIdHint: 'player-1',
      writerGenerationHint: 1,
    },
  };
}

describe('Stage E — P0-E01 PostgreSQL atomic gameplay TX', () => {
  it('accepted move commits ledger+snapshot+fence+outcome in one TX', async (t) => {
    const pool = await connectOrSkip(t);
    if (!pool) return;
    try {
      await resetSchema(pool);
      const ctx = await bootPg(pool);
      const applied = await ctx.service.handleClientCommand(
        legalMoveCmd('pg-m1'),
        ctx.hints,
      );
      assert.equal(applied.decision, 'apply');
      const fence = await ctx.fence.get(ctx.seriesKey);
      assert.equal(fence!.boardRevision, 1);
      assert.equal((await ctx.ledger.list(ctx.seriesKey, 'player-1', 1)).length, 1);
      const snap = await ctx.snapshots.get(ctx.seriesKey, 'player-1', 1);
      assert.equal(snap!.boardRevision, 1);
      assert.equal(snap!.producedByAdmissionId, applied.admissionResult!.admissionId);
      const outcome = await ctx.journal.getOutcome(
        applied.admissionResult!.admissionId,
      );
      assert.equal(outcome, 'applied');
      const frozen = await ctx.journal.getResult(
        applied.admissionResult!.admissionId,
      );
      assert.ok(frozen);
      assert.equal(frozen!.stateHash, applied.admissionResult!.stateHash);
    } finally {
      await pool.end();
    }
  });

  const faultPoints: UowFaultPoint[] = [
    'before_ledger',
    'after_ledger',
    'before_snapshot',
    'after_snapshot',
    'before_fence',
    'after_fence',
    'before_outcome',
    'before_commit',
  ];

  for (const point of faultPoints) {
    it(`fault at ${point}: rolls back; no partial score; admission stays pending`, async (t) => {
      const pool = await connectOrSkip(t);
      if (!pool) return;
      try {
        await resetSchema(pool);
        const ctx = await bootPg(pool, `pg-fault-${point}`);
        ctx.uow.setFaultHooks({
          inject: async (p) => {
            if (p === point) throw new Error(`injected_fault_${point}`);
          },
        });
        const result = await ctx.service.handleClientCommand(
          legalMoveCmd(`fault-${point}`),
          {
            seriesKeyHint: `pg-fault-${point}`,
            playerIdHint: 'player-1',
            writerGenerationHint: 1,
          },
        );
        assert.equal(result.decision, 'unavailable');
        const fence = await ctx.fence.get(`pg-fault-${point}`);
        assert.equal(fence!.boardRevision, 0);
        assert.equal(fence!.score, 0);
        assert.equal(
          (await ctx.ledger.list(`pg-fault-${point}`, 'player-1', 1)).length,
          0,
        );
        const snap = await ctx.snapshots.get(`pg-fault-${point}`, 'player-1', 1);
        assert.equal(snap!.boardRevision, 0);

        // Clear fault and retry — should apply cleanly (pending admission).
        ctx.uow.clearFaultHooks();
        const retry = await ctx.service.handleClientCommand(
          legalMoveCmd(`fault-${point}`),
          {
            seriesKeyHint: `pg-fault-${point}`,
            playerIdHint: 'player-1',
            writerGenerationHint: 1,
          },
        );
        assert.equal(retry.decision, 'apply');
        assert.equal((await ctx.fence.get(`pg-fault-${point}`))!.boardRevision, 1);
        assert.equal(
          (await ctx.ledger.list(`pg-fault-${point}`, 'player-1', 1)).length,
          1,
        );
      } finally {
        await pool.end();
      }
    });
  }

  it('process restart after commit before response: duplicate returns frozen result', async (t) => {
    const pool = await connectOrSkip(t);
    if (!pool) return;
    try {
      await resetSchema(pool);
      const ctx = await bootPg(pool, 'pg-restart');
      let crashed = false;
      ctx.uow.setFaultHooks({
        afterCommitBeforeResponse: async () => {
          crashed = true;
          throw new Error('crash_before_response');
        },
      });
      const first = await ctx.service.handleClientCommand(legalMoveCmd('rst'), {
        seriesKeyHint: 'pg-restart',
        playerIdHint: 'player-1',
        writerGenerationHint: 1,
      });
      // Service maps post-commit throw... actually afterCommit runs after COMMIT
      // inside UoW; throw propagates to service catch → unavailable, but state committed.
      assert.equal(crashed, true);
      assert.equal(first.decision, 'unavailable');
      assert.equal((await ctx.fence.get('pg-restart'))!.boardRevision, 1);

      ctx.uow.clearFaultHooks();
      // New service instance = process restart
      const service2 = new TrustedGameplayService({
        journal: ctx.journal,
        fence: ctx.fence,
        challenges: ctx.challenges,
        ledger: ctx.ledger,
        snapshots: ctx.snapshots,
        clock: ctx.clock,
        authorization: ctx.authGw,
        postgresUow: ctx.uow,
        resolveActiveOrdinal: async () => 1,
      });
      const dup = await service2.handleClientCommand(legalMoveCmd('rst'), {
        seriesKeyHint: 'pg-restart',
        playerIdHint: 'player-1',
        writerGenerationHint: 1,
      });
      assert.equal(dup.decision, 'apply');
      if (dup.decision === 'apply') {
        assert.equal(dup.duplicateReplay, true);
        assert.equal(dup.boardRevision, 1);
        assert.ok(dup.admissionResult);
      }
      assert.equal(
        (await ctx.ledger.list('pg-restart', 'player-1', 1)).length,
        1,
      );
    } finally {
      await pool.end();
    }
  });

  it('simultaneous moves on separate connections: one apply, no double credit', async (t) => {
    const pool = await connectOrSkip(t);
    if (!pool) return;
    try {
      await resetSchema(pool);
      const ctx = await bootPg(pool, 'pg-race');
      const [a, b] = await Promise.all([
        ctx.service.handleClientCommand(legalMoveCmd('r1'), {
          seriesKeyHint: 'pg-race',
          playerIdHint: 'player-1',
          writerGenerationHint: 1,
        }),
        ctx.service.handleClientCommand(legalMoveCmd('r2'), {
          seriesKeyHint: 'pg-race',
          playerIdHint: 'player-1',
          writerGenerationHint: 1,
        }),
      ]);
      const decisions = [a.decision, b.decision].sort();
      assert.deepEqual(decisions, ['apply', 'reject']);
      assert.equal((await ctx.fence.get('pg-race'))!.boardRevision, 1);
      assert.equal((await ctx.ledger.list('pg-race', 'player-1', 1)).length, 1);
    } finally {
      await pool.end();
    }
  });
});

describe('Stage E — P1-E05 PostgreSQL service V3-48 checkpoint evidence', () => {
  it('authorized PG service rejects forged checkpoint; no ledger/score/revision change', async (t) => {
    const pool = await connectOrSkip(t);
    if (!pool) return;
    try {
      await resetSchema(pool);
      const ctx = await bootPg(pool, 'pg-v348');
      const legal = await ctx.service.handleClientCommand(legalMoveCmd('v1'), {
        seriesKeyHint: 'pg-v348',
        playerIdHint: 'player-1',
        writerGenerationHint: 1,
      });
      assert.equal(legal.decision, 'apply');
      const beforeSnap = await ctx.snapshots.get('pg-v348', 'player-1', 1);
      const beforeFence = await ctx.fence.get('pg-v348');
      const beforeLedger = await ctx.ledger.list('pg-v348', 'player-1', 1);

      const forged = {
        ...stateToJson(ctx.binding.initialState),
        score: 99999,
        cells: [[null]],
      };
      const forgedHash = selfConsistentJsonHash(forged);
      const attack = await ctx.service.rejectCheckpointOverwrite({
        auth: ctx.auth,
        subgameOrdinal: 1,
        attemptedCheckpoint: forged,
        forgedStateHash: forgedHash,
      });
      assert.equal(attack.decision, 'reject');
      if (attack.decision === 'reject') {
        assert.equal(attack.reason, 'CHECKPOINT_OVERWRITE_REJECTED');
        assert.equal(attack.checkpointUnchanged, true);
        assert.equal(attack.ledgerUnchanged, true);
      }
      assert.equal(
        (await ctx.snapshots.get('pg-v348', 'player-1', 1))!.stateHash,
        beforeSnap!.stateHash,
      );
      assert.equal((await ctx.fence.get('pg-v348'))!.score, beforeFence!.score);
      assert.equal(
        (await ctx.fence.get('pg-v348'))!.boardRevision,
        beforeFence!.boardRevision,
      );
      assert.equal(
        (await ctx.ledger.list('pg-v348', 'player-1', 1)).length,
        beforeLedger.length,
      );
    } finally {
      await pool.end();
    }
  });

  it('rejects cross-player/series and stale-writer checkpoint attempts on PG path', async (t) => {
    const pool = await connectOrSkip(t);
    if (!pool) return;
    try {
      await resetSchema(pool);
      const ctx = await bootPg(pool, 'pg-v348-x');
      await ctx.service.handleClientCommand(legalMoveCmd('x1'), {
        seriesKeyHint: 'pg-v348-x',
        playerIdHint: 'player-1',
        writerGenerationHint: 1,
      });
      const before = await ctx.fence.get('pg-v348-x');

      const cross = await ctx.service.rejectCheckpointOverwrite({
        auth: ctx.auth,
        seriesKey: 'other',
        playerId: 'evil',
        subgameOrdinal: 1,
        attemptedCheckpoint: { score: 1 },
      });
      assert.equal(cross.decision, 'reject');

      // Stale writer cannot replace via move path
      const stale = await ctx.service.handleClientCommand(
        legalMoveCmd('stale-w', 1, 9),
        {
          seriesKeyHint: 'pg-v348-x',
          playerIdHint: 'player-1',
          writerGenerationHint: 9,
        },
      );
      assert.equal(stale.decision, 'reject');
      assert.equal((await ctx.fence.get('pg-v348-x'))!.boardRevision, before!.boardRevision);
      assert.equal((await ctx.fence.get('pg-v348-x'))!.score, before!.score);
    } finally {
      await pool.end();
    }
  });

  it('old forged watermark cannot overwrite newer ledger via snapshot put API absence', async (t) => {
    const pool = await connectOrSkip(t);
    if (!pool) return;
    try {
      await resetSchema(pool);
      const ctx = await bootPg(pool, 'pg-wm');
      await ctx.service.handleClientCommand(legalMoveCmd('w1'), {
        seriesKeyHint: 'pg-wm',
        playerIdHint: 'player-1',
        writerGenerationHint: 1,
      });
      const wm = await ctx.ledger.latestWatermark('pg-wm', 'player-1', 1);
      assert.ok(wm);
      assert.equal(wm!.boardRevision, 1);
      // There is no client checkpoint submit API — only rejectCheckpointOverwrite.
      const denied = await ctx.service.rejectCheckpointOverwrite({
        auth: ctx.auth,
        subgameOrdinal: 1,
        attemptedCheckpoint: {
          boardRevision: 0,
          stateHash: '0'.repeat(64),
          score: 0,
        },
      });
      assert.equal(denied.decision, 'reject');
      const wmAfter = await ctx.ledger.latestWatermark('pg-wm', 'player-1', 1);
      assert.deepEqual(wmAfter, wm);
    } finally {
      await pool.end();
    }
  });
});
