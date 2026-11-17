import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeAuthoritativePayloadDigest,
  validateUntrustedClientCommand,
} from '../../../src/tournament/adjudication/index.mts';
import { bootMemory, legalMoveCmd, makeAuth } from './helpers.mts';

describe('Stage E — P1-E03 closed schema + authoritative payload digest', () => {
  it('rejects unknown top-level and nested move properties', () => {
    assert.equal(
      validateUntrustedClientCommand({
        commandType: 'move',
        idempotencyKey: 'k',
        extra: true,
        move: {
          offerIndex: 0,
          tap: [0, 0],
          expectedBoardRevision: 0,
          writerGeneration: 1,
        },
      }).ok,
      false,
    );
    assert.equal(
      validateUntrustedClientCommand({
        commandType: 'move',
        idempotencyKey: 'k',
        move: {
          offerIndex: 0,
          tap: [0, 0],
          expectedBoardRevision: 0,
          writerGeneration: 1,
          sneaky: 1,
        },
      }).ok,
      false,
    );
  });

  it('rejects prototype-sensitive keys', () => {
    const raw = JSON.parse(
      '{"commandType":"start","idempotencyKey":"k","__proto__":{"x":1}}',
    );
    // JSON.parse may pollute; ensure our validator rejects if key present via assign
    const obj: Record<string, unknown> = {
      commandType: 'start',
      idempotencyKey: 'k',
    };
    Object.defineProperty(obj, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
    });
    const r = validateUntrustedClientCommand(obj);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'PROTOTYPE_KEY');
    void raw;
  });

  it('requires exactly two valid tap coordinates and safe integers', () => {
    assert.equal(
      validateUntrustedClientCommand({
        commandType: 'move',
        idempotencyKey: 'k',
        move: {
          offerIndex: 0,
          tap: [0],
          expectedBoardRevision: 0,
          writerGeneration: 1,
        },
      }).ok,
      false,
    );
    assert.equal(
      validateUntrustedClientCommand({
        commandType: 'move',
        idempotencyKey: 'k',
        move: {
          offerIndex: 0,
          tap: [0.5, 0],
          expectedBoardRevision: 0,
          writerGeneration: 1,
        },
      }).ok,
      false,
    );
    assert.equal(
      validateUntrustedClientCommand({
        commandType: 'move',
        idempotencyKey: 'k',
        move: {
          offerIndex: 3,
          tap: [0, 0],
          expectedBoardRevision: 0,
          writerGeneration: 1,
        },
      }).ok,
      false,
    );
    assert.equal(
      validateUntrustedClientCommand({
        commandType: 'move',
        idempotencyKey: 'k',
        move: {
          offerIndex: 0,
          tap: [0, 0],
          expectedBoardRevision: Number.MAX_SAFE_INTEGER + 1,
          writerGeneration: 1,
        },
      }).ok,
      false,
    );
  });

  it('rejects client seriesKey/playerId/payloadHash as authority fields', () => {
    for (const field of ['seriesKey', 'playerId', 'payloadHash']) {
      const r = validateUntrustedClientCommand({
        commandType: 'start',
        idempotencyKey: 'k',
        [field]: 'x',
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, 'FORBIDDEN_AUTHORITY_FIELD');
    }
  });

  it('rejects malformed client hash values', () => {
    const r = validateUntrustedClientCommand({
      commandType: 'move',
      idempotencyKey: 'k',
      clientReportedStateHash: 'not-a-hash',
      move: {
        offerIndex: 0,
        tap: [0, 0],
        expectedBoardRevision: 0,
        writerGeneration: 1,
      },
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'INVALID_HASH');
  });

  it('same idempotency key with changed move/player/series conflicts', async () => {
    const { service, hints, auth } = await bootMemory();
    const cmd = legalMoveCmd('idem-1');
    const first = await service.handleClientCommand(cmd, hints);
    assert.equal(first.decision, 'apply');

    // Same key, different tap → different authoritative digest → conflict
    const changedTap = await service.handleClientCommand(
      {
        commandType: 'move',
        idempotencyKey: 'idem-1',
        move: {
          offerIndex: 0,
          tap: [1, 0],
          expectedBoardRevision: 0,
          writerGeneration: 1,
        },
      },
      hints,
    );
    assert.equal(changedTap.decision, 'reject');
    if (changedTap.decision === 'reject') {
      assert.equal(changedTap.reason, 'IDEMPOTENCY_PAYLOAD_CONFLICT');
    }

    // Digest differs when actor context differs
    const d1 = computeAuthoritativePayloadDigest({ auth, command: cmd });
    const otherAuth = makeAuth({ playerId: 'other', seriesKey: 'series-1' });
    // series entitlement still series-1 but principal other — digest must differ
    const d2 = computeAuthoritativePayloadDigest({
      auth: otherAuth,
      command: cmd,
    });
    assert.notEqual(d1, d2);

    const d3 = computeAuthoritativePayloadDigest({
      auth,
      command: {
        commandType: 'move',
        idempotencyKey: 'idem-1',
        move: {
          offerIndex: 0,
          tap: [0, 0],
          expectedBoardRevision: 1,
          writerGeneration: 1,
        },
      },
    });
    assert.notEqual(d1, d3);
  });

  it('does not trust a client-supplied payloadHash field (rejected at parse)', () => {
    const r = validateUntrustedClientCommand({
      commandType: 'move',
      idempotencyKey: 'k',
      payloadHash: 'a'.repeat(64),
      move: {
        offerIndex: 0,
        tap: [0, 0],
        expectedBoardRevision: 0,
        writerGeneration: 1,
      },
    });
    assert.equal(r.ok, false);
  });
});
