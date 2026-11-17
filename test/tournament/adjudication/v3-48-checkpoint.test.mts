import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  createHash,
} from 'node:crypto';
import {
  replayCore001V3,
  stateToJson,
} from '../../../src/engine/core001v3/index.mts';
import { ControllableClock } from '../../../src/tournament/ingress/clock.mts';
import { MemoryAdmissionJournal } from '../../../src/tournament/ingress/journal.mts';
import { MemorySeriesFenceStore } from '../../../src/tournament/ingress/series-fence.mts';
import { idleDeadlineFrom } from '../../../src/tournament/ingress/types.mts';
import {
  TrustedGameplayService,
  bindTrustedChallenge,
  MemoryAcceptedMoveLedger,
  MemoryAuthoritativeSnapshotStore,
  MemoryTrustedChallengeStore,
  selfConsistentJsonHash,
  validateUntrustedClientCommand,
} from '../../../src/tournament/adjudication/index.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    join(__dirname, '../../../docs/contracts/gameplay/v3/fixtures/V3-01-legal-placement.json'),
    'utf8',
  ),
);
const T0 = new Date('2026-11-17T12:00:00.000Z');

async function boot() {
  const clock = new ControllableClock(T0);
  const journal = new MemoryAdmissionJournal({ clock });
  const fence = new MemorySeriesFenceStore();
  const challenges = new MemoryTrustedChallengeStore();
  const ledger = new MemoryAcceptedMoveLedger();
  const snapshots = new MemoryAuthoritativeSnapshotStore();
  await fence.put({
    seriesKey: 'series-1',
    boardRevision: 0,
    writerGeneration: 1,
    status: 'ACTIVE',
    idleDeadlineAt: idleDeadlineFrom(T0, 300),
    hardCutoffAt: null,
    score: 0,
    resultsPublished: false,
    lastAppliedAdmissionId: null,
  });
  const binding = bindTrustedChallenge({
    seriesKey: 'series-1',
    playerId: 'player-1',
    subgameOrdinal: 1,
    challengeId: 'chal-v3-01',
    generatorVersion: 'gen-001.v1-adapter-test',
    contentVersion: 'stage-e-test',
    initialStateRaw: fixture.initialState,
    assignedAt: T0,
  });
  await challenges.put(binding);
  await snapshots.put({
    seriesKey: 'series-1',
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
    resolveActiveOrdinal: async () => 1,
  });
  return { service, fence, ledger, snapshots, binding, clock };
}

describe('Stage E — V3-48 trusted checkpoint overwrite', () => {
  it('rejects client authority fields at validation boundary', () => {
    const bad = validateUntrustedClientCommand({
      seriesKey: 'series-1',
      playerId: 'player-1',
      commandType: 'move',
      idempotencyKey: 'x',
      payloadHash: 'h',
      scoreDelta: 100000,
      move: {
        offerIndex: 0,
        tap: [0, 0],
        expectedBoardRevision: 0,
        writerGeneration: 1,
      },
    });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.reason, 'FORBIDDEN_AUTHORITY_FIELD');
  });

  it('legitimate move derives score from replay; forged score claim cannot enter command', async () => {
    const { service, fence, snapshots, ledger } = await boot();
    const applied = await service.handleClientCommand({
      seriesKey: 'series-1',
      playerId: 'player-1',
      commandType: 'move',
      idempotencyKey: 'm1',
      payloadHash: 'legal-1',
      move: {
        offerIndex: 0,
        tap: [0, 0],
        expectedBoardRevision: 0,
        writerGeneration: 1,
        clientReportedStateHash: 'attacker-diagnostic-only',
      },
    });
    assert.equal(applied.decision, 'apply');
    if (applied.decision !== 'apply') return;
    assert.equal(applied.scoreDelta, 0);
    assert.equal(applied.boardRevision, 1);
    assert.equal((await fence.get('series-1'))!.score, applied.score);
    const snap = await snapshots.get('series-1', 'player-1', 1);
    assert.equal(snap!.stateHash, applied.stateHash);
    assert.equal((await ledger.list('series-1', 'player-1', 1)).length, 1);

    // Independent engine check.
    const replay = replayCore001V3({
      initialState: fixture.initialState,
      moves: [{ offerIndex: 0, tap: [0, 0] }],
    });
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.stateHash, applied.stateHash);
  });

  it('V3-48: forged board + self-consistent hash cannot overwrite trusted checkpoint or ledger', async () => {
    const { service, fence, snapshots, ledger, binding } = await boot();
    const legal = await service.handleClientCommand({
      seriesKey: 'series-1',
      playerId: 'player-1',
      commandType: 'move',
      idempotencyKey: 'm1',
      payloadHash: 'legal-1',
      move: {
        offerIndex: 0,
        tap: [0, 0],
        expectedBoardRevision: 0,
        writerGeneration: 1,
      },
    });
    assert.equal(legal.decision, 'apply');
    const beforeSnap = await snapshots.get('series-1', 'player-1', 1);
    const beforeLedger = await ledger.list('series-1', 'player-1', 1);
    const beforeFence = await fence.get('series-1');

    const forgedBoard = [
      [null, null],
      [null, { shape: 'triangle', direction: 'up' }],
    ];
    const baseJson = stateToJson(binding.initialState);
    const forgedState = {
      ...baseJson,
      cells: forgedBoard,
      score: 99999,
      turnsUsed: 1,
      status: 'in_progress',
      terminalReason: null,
    };
    const forgedHash = selfConsistentJsonHash(forgedState);
    assert.notEqual(forgedHash, beforeSnap!.stateHash);

    const attack = await service.rejectCheckpointOverwrite({
      seriesKey: 'series-1',
      playerId: 'player-1',
      subgameOrdinal: 1,
      attemptedCheckpoint: {
        board: forgedBoard,
        score: 99999,
        stateHash: forgedHash,
        offers: baseJson.offers,
        turnsUsed: 1,
        status: 'in_progress',
        terminalReason: null,
      },
      forgedStateHash: forgedHash,
    });
    assert.equal(attack.decision, 'reject');
    if (attack.decision === 'reject') {
      assert.equal(attack.reason, 'CHECKPOINT_OVERWRITE_REJECTED');
      assert.equal(attack.checkpointUnchanged, true);
      assert.equal(attack.ledgerUnchanged, true);
    }

    const afterSnap = await snapshots.get('series-1', 'player-1', 1);
    const afterLedger = await ledger.list('series-1', 'player-1', 1);
    const afterFence = await fence.get('series-1');
    assert.equal(afterSnap!.stateHash, beforeSnap!.stateHash);
    assert.equal(afterSnap!.score, beforeSnap!.score);
    assert.equal(afterFence!.score, beforeFence!.score);
    assert.equal(afterFence!.boardRevision, beforeFence!.boardRevision);
    assert.equal(afterLedger.length, beforeLedger.length);
    assert.equal(afterFence!.resultsPublished, false);
  });

  it('rejects checkpoint_overwrite client command type', async () => {
    const { service, snapshots, ledger } = await boot();
    const before = await snapshots.get('series-1', 'player-1', 1);
    const result = await service.handleClientCommand({
      seriesKey: 'series-1',
      playerId: 'player-1',
      commandType: 'checkpoint_overwrite',
      idempotencyKey: 'atk',
      payloadHash: 'x',
      attemptedCheckpoint: { score: 1, stateHash: createHash('sha256').update('x').digest('hex') },
    });
    assert.equal(result.decision, 'reject');
    assert.deepEqual(await snapshots.get('series-1', 'player-1', 1), before);
    assert.equal((await ledger.list('series-1', 'player-1', 1)).length, 0);
  });

  it('duplicate idempotent move does not double score or ledger rows', async () => {
    const { service, fence, ledger } = await boot();
    const cmd = {
      seriesKey: 'series-1',
      playerId: 'player-1',
      commandType: 'move' as const,
      idempotencyKey: 'dup',
      payloadHash: 'dup-h',
      move: {
        offerIndex: 0,
        tap: [0, 0] as [number, number],
        expectedBoardRevision: 0,
        writerGeneration: 1,
      },
    };
    const a = await service.handleClientCommand(cmd);
    const b = await service.handleClientCommand(cmd);
    assert.equal(a.decision, 'apply');
    assert.equal(b.decision, 'apply');
    if (b.decision === 'apply') assert.equal(b.duplicateReplay, true);
    assert.equal((await fence.get('series-1'))!.boardRevision, 1);
    assert.equal((await ledger.list('series-1', 'player-1', 1)).length, 1);
  });

  it('two concurrent revisions: exactly one accepted ledger row', async () => {
    const { service, fence, ledger } = await boot();
    const [a, b] = await Promise.all([
      service.handleClientCommand({
        seriesKey: 'series-1',
        playerId: 'player-1',
        commandType: 'move',
        idempotencyKey: 'c1',
        payloadHash: 'h1',
        move: {
          offerIndex: 0,
          tap: [0, 0],
          expectedBoardRevision: 0,
          writerGeneration: 1,
        },
      }),
      service.handleClientCommand({
        seriesKey: 'series-1',
        playerId: 'player-1',
        commandType: 'move',
        idempotencyKey: 'c2',
        payloadHash: 'h2',
        move: {
          offerIndex: 0,
          tap: [0, 0],
          expectedBoardRevision: 0,
          writerGeneration: 1,
        },
      }),
    ]);
    const decisions = [a.decision, b.decision].sort();
    assert.deepEqual(decisions, ['apply', 'reject']);
    assert.equal((await fence.get('series-1'))!.boardRevision, 1);
    assert.equal((await ledger.list('series-1', 'player-1', 1)).length, 1);
  });
});
