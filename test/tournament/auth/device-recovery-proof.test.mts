import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import {
  canonicalDeviceRecoveryProof,
  verifyDeviceRecoveryProof,
  type DeviceRecoveryProofInput,
} from '../../../src/tournament/auth/device-recovery-proof.mts';

const ids = {
  playerId: '11111111-1111-4111-8111-111111111111',
  seriesId: '22222222-2222-4222-8222-222222222222',
  newSessionId: '33333333-3333-4333-8333-333333333333',
  deviceCredentialId: '44444444-4444-4444-8444-444444444444',
  challengeId: '55555555-5555-4555-8555-555555555555',
};
function fixture(nowMs: number): DeviceRecoveryProofInput {
  return {
    ...ids,
    nonce: 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789',
    expectedWriterGeneration: 2,
    expiresAtMs: nowMs + 30_000,
  };
}
function credentials() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: pair.privateKey,
    publicKeySpki: pair.publicKey.export({ type: 'spki', format: 'der' }),
  };
}
function signed(input: DeviceRecoveryProofInput, privateKey: ReturnType<typeof credentials>['privateKey']) {
  return sign('sha256', Buffer.from(canonicalDeviceRecoveryProof(input)), privateKey).toString('base64url');
}

test('registered P-256 device proves exact new session and series', () => {
  const now = 1_800_000_000_000;
  const keys = credentials();
  const input = fixture(now);
  assert.equal(verifyDeviceRecoveryProof({
    input, registeredPublicKeySpkiDer: keys.publicKeySpki,
    signatureBase64Url: signed(input, keys.privateKey), serverNowMs: now,
  }), true);
});

test('different device cannot reuse legitimate recovery proof', () => {
  const now = 1_800_000_000_000;
  const original = credentials();
  const unrelated = credentials();
  const input = fixture(now);
  assert.equal(verifyDeviceRecoveryProof({
    input, registeredPublicKeySpkiDer: unrelated.publicKeySpki,
    signatureBase64Url: signed(input, original.privateKey), serverNowMs: now,
  }), false);
});

test('signature cannot be moved to another player, session, series or generation', () => {
  const now = 1_800_000_000_000;
  const keys = credentials();
  const input = fixture(now);
  const signatureBase64Url = signed(input, keys.privateKey);
  const altered: DeviceRecoveryProofInput[] = [
    { ...input, playerId: '66666666-6666-4666-8666-666666666666' },
    { ...input, seriesId: '66666666-6666-4666-8666-666666666666' },
    { ...input, newSessionId: '66666666-6666-4666-8666-666666666666' },
    { ...input, expectedWriterGeneration: 3 },
    { ...input, challengeId: '66666666-6666-4666-8666-666666666666' },
  ];
  for (const changed of altered) {
    assert.equal(verifyDeviceRecoveryProof({
      input: changed, registeredPublicKeySpkiDer: keys.publicKeySpki,
      signatureBase64Url, serverNowMs: now,
    }), false);
  }
});

test('expired and excessively long challenges are rejected', () => {
  const now = 1_800_000_000_000;
  const keys = credentials();
  for (const expiresAtMs of [now, now - 1, now + 60_001]) {
    const input = { ...fixture(now), expiresAtMs };
    assert.equal(verifyDeviceRecoveryProof({
      input, registeredPublicKeySpkiDer: keys.publicKeySpki,
      signatureBase64Url: signed(input, keys.privateKey), serverNowMs: now,
    }), false);
  }
});

test('wrong key algorithm, malformed input and noncanonical signature fail closed', () => {
  const now = 1_800_000_000_000;
  const keys = credentials();
  const input = fixture(now);
  const signature = signed(input, keys.privateKey);
  const ec = generateKeyPairSync('ed25519');
  assert.equal(verifyDeviceRecoveryProof({
    input,
    registeredPublicKeySpkiDer: ec.publicKey.export({ type: 'spki', format: 'der' }),
    signatureBase64Url: signature, serverNowMs: now,
  }), false);
  assert.equal(verifyDeviceRecoveryProof({
    input, registeredPublicKeySpkiDer: keys.publicKeySpki,
    signatureBase64Url: signature + '=', serverNowMs: now,
  }), false);
  assert.throws(() => canonicalDeviceRecoveryProof({ ...input, nonce: '' }));
});
