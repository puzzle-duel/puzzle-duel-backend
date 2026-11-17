import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootMemory, legalMoveCmd } from './helpers.mts';

describe('Stage E — P1-E04 immutable duplicate admission results', () => {
  it('retry before advance returns original admission result', async () => {
    const { service, hints } = await bootMemory();
    const a = await service.handleClientCommand(legalMoveCmd('d1'), hints);
    assert.equal(a.decision, 'apply');
    const b = await service.handleClientCommand(legalMoveCmd('d1'), hints);
    assert.equal(b.decision, 'apply');
    if (a.decision !== 'apply' || b.decision !== 'apply') return;
    assert.equal(b.duplicateReplay, true);
    assert.deepEqual(b.admissionResult, a.admissionResult);
    assert.equal(b.admissionResult!.subgameOrdinal, 1);
    assert.equal(b.stateHash, a.stateHash);
  });

  it('full flow: move → await → advance → duplicate move returns original', async () => {
    const { service, hints, fence, snapshots, authGw, journal } = await bootMemory();

    const move = await service.handleClientCommand(legalMoveCmd('orig'), hints);
    assert.equal(move.decision, 'apply');
    if (move.decision !== 'apply') return;
    const original = move.admissionResult!;

    // Force subgame terminal + await advance without needing a real terminal move.
    const snap = (await snapshots.get('series-1', 'player-1', 1))!;
    await snapshots.put({
      ...snap,
      status: 'ended',
      terminalReason: 'move_limit_reached',
    });
    const f = (await fence.get('series-1'))!;
    await fence.put({ ...f, status: 'AWAIT_ADVANCE' });

    // Advance is blocked while series auth status is still ACTIVE entitlement —
    // fence is AWAIT_ADVANCE; update gateway series status to match.
    const beforeAdv = authGw.get('series-1')!;
    authGw.update({
      ...beforeAdv,
      series: { ...beforeAdv.series, status: 'AWAIT_ADVANCE' },
    });
    const advanced = await service.handleClientCommand(
      { commandType: 'advance', idempotencyKey: 'adv-1' },
      hints,
    );
    assert.equal(advanced.decision, 'apply', String((advanced as { reason?: string }).reason));

    // Simulate server advancing active ordinal for next subgame.
    const ctx = authGw.get('series-1')!;
    authGw.update({
      ...ctx,
      series: { ...ctx.series, activeSubgameOrdinal: 2, status: 'ACTIVE' },
    });

    // Duplicate of original move must return ordinal 1 result, not ordinal 2.
    const dup = await service.handleClientCommand(legalMoveCmd('orig'), {
      seriesKeyHint: 'series-1',
      playerIdHint: 'player-1',
      writerGenerationHint: 1,
    });
    assert.equal(dup.decision, 'apply');
    if (dup.decision !== 'apply') return;
    assert.equal(dup.duplicateReplay, true);
    assert.equal(dup.admissionResult!.subgameOrdinal, 1);
    assert.equal(dup.admissionResult!.boardRevision, original.boardRevision);
    assert.equal(dup.admissionResult!.stateHash, original.stateHash);
    assert.equal(dup.admissionResult!.score, original.score);
    assert.notEqual(dup.admissionResult!.subgameOrdinal, 2);

    // Process-restart simulation: restore journal snapshot and retry.
    const snapRows = journal.snapshot();
    journal.restoreSnapshot(snapRows);
    const afterRestart = await service.handleClientCommand(legalMoveCmd('orig'), {
      seriesKeyHint: 'series-1',
      playerIdHint: 'player-1',
      writerGenerationHint: 1,
    });
    assert.equal(afterRestart.decision, 'apply');
    if (afterRestart.decision === 'apply') {
      assert.equal(
        afterRestart.admissionResult!.stateHash,
        original.stateHash,
      );
      assert.equal(afterRestart.admissionResult!.subgameOrdinal, 1);
    }
  });

  it('ordinal-6 advance does not complete the series and the H1 result stays immutable', async () => {
    const { service, fence, snapshots, authGw } = await bootMemory({
      ordinal: 6,
    });
    assert.equal(authGw.get('series-1')!.series.activeSubgameOrdinal, 6);

    const move = await service.handleClientCommand(legalMoveCmd('h1'), {
      seriesKeyHint: 'series-1',
      playerIdHint: 'player-1',
      writerGenerationHint: 1,
    });
    assert.equal(move.decision, 'apply');
    if (move.decision !== 'apply') return;

    const snap = (await snapshots.get('series-1', 'player-1', 6))!;
    await snapshots.put({
      ...snap,
      status: 'ended',
      terminalReason: 'move_limit_reached',
    });
    const f = (await fence.get('series-1'))!;
    await fence.put({ ...f, status: 'AWAIT_ADVANCE' });

    const adv = await service.handleClientCommand(
      { commandType: 'advance', idempotencyKey: 'fin' },
      {
        seriesKeyHint: 'series-1',
        playerIdHint: 'player-1',
        writerGenerationHint: 1,
      },
    );
    assert.equal(adv.decision, 'reject');
    if (adv.decision === 'reject') assert.equal(adv.reason, 'NO_NEXT_ORDINAL');
    const afterAdvance = (await fence.get('series-1'))!;
    assert.equal(afterAdvance.status, 'AWAIT_ADVANCE');
    assert.equal(afterAdvance.resultsPublished, false);

    const dup = await service.handleClientCommand(legalMoveCmd('h1'), {
      seriesKeyHint: 'series-1',
      playerIdHint: 'player-1',
      writerGenerationHint: 1,
    });
    assert.equal(dup.decision, 'apply');
    if (dup.decision === 'apply') {
      assert.equal(dup.admissionResult!.subgameOrdinal, 6);
      assert.equal(dup.admissionResult!.stateHash, move.admissionResult!.stateHash);
    }
  });

  it('concurrent duplicate delivery applies once', async () => {
    const { service, hints, ledger, fence } = await bootMemory();
    const cmd = legalMoveCmd('race-dup');
    const [a, b] = await Promise.all([
      service.handleClientCommand(cmd, hints),
      service.handleClientCommand(cmd, hints),
    ]);
    assert.equal(a.decision, 'apply');
    assert.equal(b.decision, 'apply');
    assert.equal((await ledger.list('series-1', 'player-1', 1)).length, 1);
    assert.equal((await fence.get('series-1'))!.boardRevision, 1);
    if (a.decision === 'apply' && b.decision === 'apply') {
      assert.equal(a.admissionResult!.stateHash, b.admissionResult!.stateHash);
    }
  });
});
