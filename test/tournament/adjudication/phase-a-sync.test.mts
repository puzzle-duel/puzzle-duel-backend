/**
 * Stage E × Phase A controlled sync proofs:
 * - one thinking extension per series via TrustedGameplayService
 * - hard-cutoff cap via applyThinkingExtension
 * - same-key idempotent retry does not re-extend
 * - second distinct key rejected after consumption
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyThinkingExtension } from '../../../src/tournament/ingress/types.mts';
import { bootMemory, T0 } from './helpers.mts';

describe('Stage E × Phase A sync — thinking extension (TrustedGameplayService)', () => {
  it('one successful extension; second key rejected; same-key retry is duplicate', async () => {
    const { service, hints, fence, clock } = await bootMemory();
    const idle = new Date(T0.getTime() + 30_000);
    const state0 = await fence.get('series-1');
    assert.ok(state0);
    await fence.put({ ...state0!, idleDeadlineAt: idle });
    clock.set(new Date(idle.getTime() - 15_000));

    const first = await service.handleClientCommand(
      { commandType: 'thinking_extension', idempotencyKey: 'ext-1' },
      hints,
    );
    assert.equal(first.decision, 'apply');
    const afterFirst = await fence.get('series-1');
    assert.equal(afterFirst!.thinkingExtensionConsumed, true);
    assert.equal(afterFirst!.idleDeadlineAt.getTime(), idle.getTime() + 60_000);

    const second = await service.handleClientCommand(
      { commandType: 'thinking_extension', idempotencyKey: 'ext-2' },
      hints,
    );
    assert.equal(second.decision, 'reject');
    if (second.decision === 'reject') {
      assert.equal(second.reason, 'EXTENSION_UNAVAILABLE');
    }
    assert.equal(
      (await fence.get('series-1'))!.idleDeadlineAt.getTime(),
      idle.getTime() + 60_000,
    );

    const retry = await service.handleClientCommand(
      { commandType: 'thinking_extension', idempotencyKey: 'ext-1' },
      hints,
    );
    assert.equal(retry.decision, 'apply');
    if (retry.decision === 'apply') {
      assert.equal(retry.duplicateReplay, true);
    }
    assert.equal((await fence.get('series-1'))!.thinkingExtensionConsumed, true);
    assert.equal(
      (await fence.get('series-1'))!.idleDeadlineAt.getTime(),
      idle.getTime() + 60_000,
    );
  });

  it('hard cutoff caps extension; never exceeds cutoff', async () => {
    const { service, hints, fence, clock } = await bootMemory();
    const idle = new Date(T0.getTime() + 40_000);
    const hard = new Date(T0.getTime() + 70_000);
    const state0 = await fence.get('series-1');
    await fence.put({
      ...state0!,
      idleDeadlineAt: idle,
      hardCutoffAt: hard,
    });
    clock.set(new Date(idle.getTime() - 20_000));

    const r = await service.handleClientCommand(
      { commandType: 'thinking_extension', idempotencyKey: 'ext-cut' },
      hints,
    );
    assert.equal(r.decision, 'apply');
    const after = await fence.get('series-1');
    assert.equal(after!.idleDeadlineAt.getTime(), hard.getTime());
    assert.equal(after!.thinkingExtensionConsumed, true);
    assert.ok(after!.idleDeadlineAt.getTime() <= hard.getTime());
  });

  it('applyThinkingExtension pure helper matches Phase A window + cutoff', () => {
    const idle = new Date('2026-11-17T12:00:40.000Z');
    const hard = new Date('2026-11-17T12:01:20.000Z');
    assert.equal(applyThinkingExtension(idle, 0, null), null);
    assert.equal(applyThinkingExtension(idle, 60_001, null), null);
    const uncapped = applyThinkingExtension(idle, 30_000, null);
    assert.equal(uncapped!.getTime(), idle.getTime() + 60_000);
    const capped = applyThinkingExtension(idle, 30_000, hard);
    assert.equal(capped!.getTime(), hard.getTime());
  });
});
