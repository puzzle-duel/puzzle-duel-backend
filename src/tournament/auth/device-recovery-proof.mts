/**
 * Candidate same-device recovery proof verification.
 *
 * This module has no HTTP registration or writer mutation surface. A verified
 * (issuer, subject, playerId) session and an already-registered device key
 * belonging to the ORIGINAL writer are prerequisites at the service layer.
 *
 * PZD-40 P0-F11 remains unchanged; do NOT use a fresh JWT or playerId alone
 * to authorize writer recovery.
 */
import { createPublicKey, verify } from 'node:crypto';

export type DeviceRecoveryProofInput = Readonly<{
  playerId: string;
  seriesId: string;
  newSessionId: string;
  deviceCredentialId: string;
  challengeId: string;
  nonce: string;
  expectedWriterGeneration: number;
  expiresAtMs: number;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** Canonical representation independent of JSON field ordering. */
export function canonicalDeviceRecoveryProof(input: DeviceRecoveryProofInput): string {
  const ids = [
    input.playerId, input.seriesId, input.newSessionId,
    input.deviceCredentialId, input.challengeId,
  ];
  if (ids.some((id) => !UUID.test(id))) throw new Error('INVALID_RECOVERY_PROOF');
  if (!B64URL.test(input.nonce) || input.nonce.length < 32 || input.nonce.length > 128) {
    throw new Error('INVALID_RECOVERY_PROOF');
  }
  if (!Number.isSafeInteger(input.expectedWriterGeneration) ||
      input.expectedWriterGeneration < 1 ||
      !Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= 0) {
    throw new Error('INVALID_RECOVERY_PROOF');
  }
  return [
    'PZD-RECOVER-WRITER-V1',
    ...ids.map((id) => id.toLowerCase()),
    input.nonce,
    String(input.expectedWriterGeneration),
    String(input.expiresAtMs),
  ].join('\n');
}

/**
 * Validates a registered Ed25519 SPKI key against a short-lived challenge.
 * Reuse prevention (challenge CAS), writer generation and original-device
 * binding MUST be enforced in the same PostgreSQL recovery transaction.
 */
export function verifyDeviceRecoveryProof(args: {
  input: DeviceRecoveryProofInput;
  registeredPublicKeySpkiDer: Buffer;
  signatureBase64Url: string;
  serverNowMs: number;
  maximumChallengeLifetimeMs?: number;
}): boolean {
  const { input, registeredPublicKeySpkiDer, signatureBase64Url, serverNowMs } = args;
  const ttl = args.maximumChallengeLifetimeMs ?? 60_000;
  if (!Number.isSafeInteger(serverNowMs) || !Number.isSafeInteger(ttl) ||
      ttl < 1 || ttl > 60_000 ||
      input.expiresAtMs <= serverNowMs ||
      input.expiresAtMs - serverNowMs > ttl ||
      !B64URL.test(signatureBase64Url) ||
      signatureBase64Url.length !== 86 ||
      registeredPublicKeySpkiDer.length > 128) return false;
  try {
    const key = createPublicKey({ key: registeredPublicKeySpkiDer, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const signature = Buffer.from(signatureBase64Url, 'base64url');
    if (signature.length !== 64 ||
        signature.toString('base64url') !== signatureBase64Url) return false;
    return verify(null, Buffer.from(canonicalDeviceRecoveryProof(input), 'utf8'), key, signature);
  } catch {
    return false;
  }
}
