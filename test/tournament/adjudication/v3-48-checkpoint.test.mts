import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  replayCore001V3,
  stateToJson,
} from '../../../src/engine/core001v3/index.mts';
import {
  FailClosedAuthorizationGateway,
  selfConsistentJsonHash,
  validateUntrustedClientCommand,
} from '../../../src/tournament/adjudication/index.mts';
import { TrustedGameplayService } from '../../../src/tournament/adjudication/trusted-gameplay.mts';
import {
  bootMemory,
  FIXTURE,
  legalMoveCmd,
  makeAuth,
} from './helpers.mts';

describe('Stage E — V3-48 trusted checkpoint overwrite (memory+auth)', () => {
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

  it('fail-closed gateway blocks ranked commands without verified auth', async () => {
    const { fence, ledger, snapshots, challenges, journal, clock } =
      await bootMemory();
    const locked = new TrustedGameplayService({
      journal,
      fence,
      challenges,
      ledger,
      snapshots,
      clock,
      authorization: new FailClosedAuthorizationGateway(),
    });
    const r = await locked.handleClientCommand(legalMoveCmd(), {
      seriesKeyHint: 'series-1',
      playerIdHint: 'player-1',
    });
    assert.equal(r.decision, 'reject');
    if (r.decision === 'reject') {
      assert.equal(r.reason, 'AUTH_CONTRACT_UNAVAILABLE');
    }
  });

  it('legitimate move derives score from replay; forged score claim cannot enter command', async () => {
    const { service, fence, snapshots, ledger, hints } = await bootMemory();
    const applied = await service.handleClientCommand(legalMoveCmd('m1'), hints);
    assert.equal(applied.decision, 'apply');
    if (applied.decision !== 'apply') return;
    assert.equal(applied.scoreDelta, 0);
    assert.equal(applied.boardRevision, 1);
    assert.equal((await fence.get('series-1'))!.score, applied.score);
    const snap = await snapshots.get('series-1', 'player-1', 1);
    assert.equal(snap!.stateHash, applied.stateHash);
    assert.equal((await ledger.list('series-1', 'player-1', 1)).length, 1);

    const replay = replayCore001V3({
      initialState: FIXTURE.initialState,
      moves: [{ offerIndex: 0, tap: [0, 0] }],
    });
    assert.equal(replay.ok, true);
    if (replay.ok) assert.equal(replay.stateHash, applied.stateHash);
  });

  it('V3-48: forged board + self-consistent hash cannot overwrite trusted checkpoint or ledger', async () => {
    const { service, fence, snapshots, ledger, binding, hints, auth } =
      await bootMemory();
    const legal = await service.handleClientCommand(legalMoveCmd('m1'), hints);
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
      auth,
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

  it('rejects unknown checkpoint_overwrite command type at closed schema', async () => {
    const { service, snapshots, ledger, hints } = await bootMemory();
    const before = await snapshots.get('series-1', 'player-1', 1);
    const result = await service.handleClientCommand(
      {
        commandType: 'checkpoint_overwrite',
        idempotencyKey: 'atk',
        attemptedCheckpoint: {
          score: 1,
          stateHash: createHash('sha256').update('x').digest('hex'),
        },
      },
      hints,
    );
    assert.equal(result.decision, 'reject');
    if (result.decision === 'reject') {
      // attemptedCheckpoint is a forbidden authority field; unknown commandType
      // would be MALFORMED — either closed-schema rejection is correct.
      assert.ok(
        result.reason === 'MALFORMED_COMMAND' ||
          result.reason === 'FORBIDDEN_AUTHORITY_FIELD',
      );
    }
    assert.deepEqual(await snapshots.get('series-1', 'player-1', 1), before);
    assert.equal((await ledger.list('series-1', 'player-1', 1)).length, 0);
  });

  it('duplicate idempotent move does not double score or ledger rows', async () => {
    const { service, fence, ledger, hints } = await bootMemory();
    const cmd = legalMoveCmd('dup');
    const a = await service.handleClientCommand(cmd, hints);
    const b = await service.handleClientCommand(cmd, hints);
    assert.equal(a.decision, 'apply');
    assert.equal(b.decision, 'apply');
    if (b.decision === 'apply') assert.equal(b.duplicateReplay, true);
    assert.equal((await fence.get('series-1'))!.boardRevision, 1);
    assert.equal((await ledger.list('series-1', 'player-1', 1)).length, 1);
    if (a.decision === 'apply' && b.decision === 'apply') {
      assert.equal(b.admissionResult!.boardRevision, a.admissionResult!.boardRevision);
      assert.equal(b.admissionResult!.stateHash, a.admissionResult!.stateHash);
      assert.equal(b.admissionResult!.subgameOrdinal, 1);
    }
  });

  it('two concurrent revisions: exactly one accepted ledger row', async () => {
    const { service, fence, ledger, hints } = await bootMemory();
    const [a, b] = await Promise.all([
      service.handleClientCommand(legalMoveCmd('c1'), hints),
      service.handleClientCommand(legalMoveCmd('c2'), hints),
    ]);
    const decisions = [a.decision, b.decision].sort();
    assert.deepEqual(decisions, ['apply', 'reject']);
    assert.equal((await fence.get('series-1'))!.boardRevision, 1);
    assert.equal((await ledger.list('series-1', 'player-1', 1)).length, 1);
  });

  it('cross-player checkpoint target is rejected without writes', async () => {
    const { service, snapshots, ledger, auth } = await bootMemory();
    const before = await snapshots.get('series-1', 'player-1', 1);
    const attack = await service.rejectCheckpointOverwrite({
      auth,
      seriesKey: 'other-series',
      playerId: 'attacker',
      subgameOrdinal: 1,
      attemptedCheckpoint: { score: 1 },
    });
    assert.equal(attack.decision, 'reject');
    assert.deepEqual(await snapshots.get('series-1', 'player-1', 1), before);
    assert.equal((await ledger.list('series-1', 'player-1', 1)).length, 0);
  });
});
