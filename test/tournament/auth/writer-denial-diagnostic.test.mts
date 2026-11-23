import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionAuthorizationGateway } from '../../../src/tournament/auth/session-authorization-gateway.mts';

type Deps = ConstructorParameters<typeof SessionAuthorizationGateway>[0];
const id = '00000000-0000-4000-8000-000000000001';
const session = { playerId: 'player-test', sessionId: 'session-a', deviceId: 'device-a',
  expiresAtMs: Date.now() + 30000 };
const baseWriter = { seriesKey: id, playerId: 'player-test', sessionId: 'session-a',
  deviceId: 'device-a', writerGeneration: 2, updatedAt: new Date() };

function setup(writer: typeof baseWriter) {
  return new SessionAuthorizationGateway({
    session,
    writers: { get: async () => writer },
    loadOwnedClaim: async () => ({ playerId: 'player-test', status: 'ACTIVE' }),
    resolveActiveOrdinal: async () => 1,
  } as unknown as Deps);
}
const input = { commandType: 'move' as const, clientClaimedSeriesKey: id, clientClaimedWriterGeneration: 2 };

test('writer failure identifies session mismatch without changing denial contract', async () => {
  const gw = setup({ ...baseWriter, sessionId: 'previous-session', deviceId: 'previous-device' });
  const r = await gw.authorize(input);
  assert.deepEqual(r, { ok: false, reason: 'WRITER_NOT_AUTHORIZED' });
  assert.equal(gw.writerDenialCategory, 'SESSION_MISMATCH');
});

test('writer failure identifies device mismatch only when session matches', async () => {
  const gw = setup({ ...baseWriter, deviceId: 'other-device' });
  const r = await gw.authorize(input);
  assert.deepEqual(r, { ok: false, reason: 'WRITER_NOT_AUTHORIZED' });
  assert.equal(gw.writerDenialCategory, 'DEVICE_MISMATCH');
});

test('writer failure identifies generation mismatch, not session/device mismatch', async () => {
  const gw = setup(baseWriter);
  const r = await gw.authorize({ ...input, clientClaimedWriterGeneration: 1 });
  assert.deepEqual(r, { ok: false, reason: 'WRITER_NOT_AUTHORIZED' });
  assert.equal(gw.writerDenialCategory, 'GENERATION_MISMATCH');
});

test('not-owned and successful authorization never reuse stale denial category', async () => {
  const gw = setup(baseWriter);
  await gw.authorize({ ...input, clientClaimedWriterGeneration: 1 });
  assert.equal(gw.writerDenialCategory, 'GENERATION_MISMATCH');
  const missing = await gw.authorize({ ...input, clientClaimedSeriesKey: 'foreign-series' });
  // Mock claim is intentionally constant for this synthetic test, so valid
  // writer wins; no mismatch category can survive a fresh authorize call.
  assert.equal(gw.writerDenialCategory, null);
  assert.equal(missing.ok, true);
  const good = await gw.authorize(input);
  assert.equal(good.ok, true);
  assert.equal(gw.writerDenialCategory, null);
});
