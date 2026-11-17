import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FailClosedAuthorizationGateway,
  MemoryVerifiedAuthorizationGateway,
} from '../../../src/tournament/adjudication/index.mts';
import { bootMemory, legalMoveCmd, makeAuth } from './helpers.mts';

describe('Stage E — P0-E02 authenticated ownership boundary', () => {
  it('fail-closed without accepted HTTP auth contract', async () => {
    const gw = new FailClosedAuthorizationGateway();
    const d = await gw.authorize({ commandType: 'move' });
    assert.equal(d.ok, false);
    if (!d.ok) assert.equal(d.reason, 'AUTH_CONTRACT_UNAVAILABLE');
  });

  it('rejects cross-player claim against verified series owner', async () => {
    const { service, hints, fence, ledger } = await bootMemory();
    const r = await service.handleClientCommand(legalMoveCmd(), {
      ...hints,
      playerIdHint: 'attacker-player',
    });
    assert.equal(r.decision, 'reject');
    if (r.decision === 'reject') assert.equal(r.reason, 'PLAYER_MISMATCH');
    assert.equal((await fence.get('series-1'))!.boardRevision, 0);
    assert.equal((await ledger.list('series-1', 'player-1', 1)).length, 0);
  });

  it('rejects cross-series claim when series is not entitled', async () => {
    const { service, hints, fence } = await bootMemory();
    const r = await service.handleClientCommand(legalMoveCmd(), {
      ...hints,
      seriesKeyHint: 'series-foreign',
    });
    assert.equal(r.decision, 'reject');
    if (r.decision === 'reject') assert.equal(r.reason, 'SERIES_NOT_OWNED');
    assert.equal((await fence.get('series-1'))!.boardRevision, 0);
  });

  it('rejects stale device writer generation', async () => {
    const { service, hints, fence } = await bootMemory();
    const r = await service.handleClientCommand(
      legalMoveCmd('stale', 0, 99),
      { ...hints, writerGenerationHint: 99 },
    );
    assert.equal(r.decision, 'reject');
    if (r.decision === 'reject') {
      assert.ok(
        r.reason === 'WRITER_NOT_AUTHORIZED' || r.reason === 'NOT_ACTIVE_WRITER',
      );
    }
    assert.equal((await fence.get('series-1'))!.boardRevision, 0);
  });

  it('unauthorized device_handoff from foreign series fails closed', async () => {
    const { service, hints, fence } = await bootMemory();
    const r = await service.handleClientCommand(
      {
        commandType: 'device_handoff',
        idempotencyKey: 'ho1',
        expectedWriterGeneration: 1,
      },
      { ...hints, seriesKeyHint: 'nope' },
    );
    assert.equal(r.decision, 'reject');
    if (r.decision === 'reject') assert.equal(r.reason, 'SERIES_NOT_OWNED');
    assert.equal((await fence.get('series-1'))!.writerGeneration, 1);
  });

  it('authorized device_handoff advances writer; stale device cannot move', async () => {
    const { service, hints, fence, authGw } = await bootMemory();
    const handoff = await service.handleClientCommand(
      {
        commandType: 'device_handoff',
        idempotencyKey: 'ho-ok',
        expectedWriterGeneration: 1,
      },
      hints,
    );
    assert.equal(handoff.decision, 'apply');
    assert.equal((await fence.get('series-1'))!.writerGeneration, 2);

    const stale = await service.handleClientCommand(legalMoveCmd('m-stale', 0, 1), {
      ...hints,
      writerGenerationHint: 1,
    });
    assert.equal(stale.decision, 'reject');

    const ctx = authGw.get('series-1')!;
    assert.equal(ctx.session.writerGeneration, 2);
    const ok = await service.handleClientCommand(legalMoveCmd('m-new', 0, 2), {
      seriesKeyHint: 'series-1',
      playerIdHint: 'player-1',
      writerGenerationHint: 2,
    });
    assert.equal(ok.decision, 'apply');
  });

  it('abandon / advance / extension / start require verified ownership', async () => {
    const gw = new MemoryVerifiedAuthorizationGateway();
    gw.register(makeAuth());
    for (const commandType of [
      'abandon',
      'advance',
      'thinking_extension',
      'start',
    ] as const) {
      const denied = await gw.authorize({
        commandType,
        clientClaimedSeriesKey: 'missing',
      });
      assert.equal(denied.ok, false);
      const allowed = await gw.authorize({
        commandType,
        clientClaimedSeriesKey: 'series-1',
        clientClaimedPlayerId: 'player-1',
      });
      assert.equal(allowed.ok, true);
    }
  });

  it('unit-test MemoryVerifiedAuthorizationGateway is not HTTP authentication', () => {
    // Explicit documentation assertion for reviewers: this gateway only accepts
    // pre-registered contexts. No bearer/session token verification occurs.
    const gw = new MemoryVerifiedAuthorizationGateway();
    assert.equal(gw.constructor.name, 'MemoryVerifiedAuthorizationGateway');
    assert.notEqual(gw.constructor.name, 'HttpSessionAuthorizationGateway');
  });
});
