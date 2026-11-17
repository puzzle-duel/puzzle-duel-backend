/**
 * Closed-schema untrusted client command parsing (P1-E03).
 *
 * Rejects unknown top-level/nested keys, prototype-sensitive names,
 * unsafe integers, and malformed taps. Never trusts client payloadHash —
 * callers must use computeAuthoritativePayloadDigest().
 */

import { createHash } from 'node:crypto';
import type { TrustedAuthorizationContext } from './authorization.mts';

export type UntrustedClientCommandType =
  | 'start'
  | 'move'
  | 'advance'
  | 'thinking_extension'
  | 'device_handoff'
  | 'abandon';

const TOP_LEVEL_KEYS = new Set([
  'commandType',
  'idempotencyKey',
  'move',
  'clientReportedStateHash',
]);

const MOVE_KEYS = new Set([
  'offerIndex',
  'tap',
  'expectedBoardRevision',
  'writerGeneration',
  'clientReportedStateHash',
]);

const PROTOTYPE_SENSITIVE = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const FORBIDDEN_AUTHORITY = new Set([
  'scoreDelta',
  'score',
  'completesSeries',
  'terminalReason',
  'resultsPublished',
  'checkpoint',
  'initialState',
  'board',
  'offers',
  'turnsUsed',
  'status',
  'stateHash',
  'forgedStateHash',
  'seriesKey',
  'playerId',
  'payloadHash',
  'attemptedCheckpoint',
]);

const COMMAND_TYPES = new Set<UntrustedClientCommandType>([
  'start',
  'move',
  'advance',
  'thinking_extension',
  'device_handoff',
  'abandon',
]);

export interface UntrustedMovePayload {
  offerIndex: 0 | 1 | 2;
  tap: [number, number];
  expectedBoardRevision: number;
  writerGeneration: number;
  clientReportedStateHash?: string;
}

export interface UntrustedClientCommand {
  commandType: UntrustedClientCommandType;
  idempotencyKey: string;
  move?: UntrustedMovePayload;
  clientReportedStateHash?: string;
}

export type ClientCommandValidation =
  | { ok: true; command: UntrustedClientCommand }
  | {
      ok: false;
      reason:
        | 'FORBIDDEN_AUTHORITY_FIELD'
        | 'MALFORMED_COMMAND'
        | 'UNKNOWN_PROPERTY'
        | 'PROTOTYPE_KEY'
        | 'MISSING_MOVE_GUARDS'
        | 'INVALID_INTEGER'
        | 'INVALID_HASH';
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function ownKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj);
}

function asSafeNonNegInt(
  value: unknown,
): { ok: true; value: number } | { ok: false } {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false };
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return { ok: false };
  }
  return { ok: true, value };
}

function parseOptionalHash(
  value: unknown,
): { ok: true; value?: string } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    return { ok: false };
  }
  return { ok: true, value };
}

export function validateUntrustedClientCommand(
  raw: unknown,
): ClientCommandValidation {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: 'MALFORMED_COMMAND' };
  }

  for (const key of ownKeys(raw)) {
    if (PROTOTYPE_SENSITIVE.has(key)) {
      return { ok: false, reason: 'PROTOTYPE_KEY' };
    }
    if (FORBIDDEN_AUTHORITY.has(key)) {
      return { ok: false, reason: 'FORBIDDEN_AUTHORITY_FIELD' };
    }
    if (!TOP_LEVEL_KEYS.has(key)) {
      return { ok: false, reason: 'UNKNOWN_PROPERTY' };
    }
  }

  const commandType = raw.commandType;
  if (typeof commandType !== 'string' || !COMMAND_TYPES.has(commandType as UntrustedClientCommandType)) {
    return { ok: false, reason: 'MALFORMED_COMMAND' };
  }
  if (typeof raw.idempotencyKey !== 'string' || raw.idempotencyKey.length === 0 || raw.idempotencyKey.length > 128) {
    return { ok: false, reason: 'MALFORMED_COMMAND' };
  }

  const topHash = parseOptionalHash(raw.clientReportedStateHash);
  if (!topHash.ok) return { ok: false, reason: 'INVALID_HASH' };

  let move: UntrustedMovePayload | undefined;
  if (commandType === 'move') {
    if (!isPlainObject(raw.move)) {
      return { ok: false, reason: 'MISSING_MOVE_GUARDS' };
    }
    for (const key of ownKeys(raw.move)) {
      if (PROTOTYPE_SENSITIVE.has(key)) {
        return { ok: false, reason: 'PROTOTYPE_KEY' };
      }
      if (FORBIDDEN_AUTHORITY.has(key)) {
        return { ok: false, reason: 'FORBIDDEN_AUTHORITY_FIELD' };
      }
      if (!MOVE_KEYS.has(key)) {
        return { ok: false, reason: 'UNKNOWN_PROPERTY' };
      }
    }
    const offer = asSafeNonNegInt(raw.move.offerIndex);
    if (!offer.ok || (offer.value !== 0 && offer.value !== 1 && offer.value !== 2)) {
      return { ok: false, reason: 'INVALID_INTEGER' };
    }
    if (!Array.isArray(raw.move.tap) || raw.move.tap.length !== 2) {
      return { ok: false, reason: 'MISSING_MOVE_GUARDS' };
    }
    const r = asSafeNonNegInt(raw.move.tap[0]);
    const c = asSafeNonNegInt(raw.move.tap[1]);
    if (!r.ok || !c.ok) {
      return { ok: false, reason: 'INVALID_INTEGER' };
    }
    const rev = asSafeNonNegInt(raw.move.expectedBoardRevision);
    const wr = asSafeNonNegInt(raw.move.writerGeneration);
    if (!rev.ok || !wr.ok) {
      return { ok: false, reason: 'INVALID_INTEGER' };
    }
    const moveHash = parseOptionalHash(raw.move.clientReportedStateHash);
    if (!moveHash.ok) return { ok: false, reason: 'INVALID_HASH' };
    move = {
      offerIndex: offer.value as 0 | 1 | 2,
      tap: [r.value, c.value],
      expectedBoardRevision: rev.value,
      writerGeneration: wr.value,
      ...(moveHash.value !== undefined
        ? { clientReportedStateHash: moveHash.value }
        : {}),
    };
  } else if (raw.move !== undefined) {
    return { ok: false, reason: 'UNKNOWN_PROPERTY' };
  }

  return {
    ok: true,
    command: {
      commandType: commandType as UntrustedClientCommandType,
      idempotencyKey: raw.idempotencyKey,
      ...(move ? { move } : {}),
      ...(topHash.value !== undefined
        ? { clientReportedStateHash: topHash.value }
        : {}),
    },
  };
}

/** Stable JSON with recursively sorted object keys (arrays preserve order). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeys(obj[key]);
  }
  return out;
}

/**
 * Authoritative idempotency payload digest from validated command +
 * authenticated actor context. Client-supplied hashes are ignored.
 */
export function computeAuthoritativePayloadDigest(args: {
  auth: TrustedAuthorizationContext;
  command: UntrustedClientCommand;
}): string {
  // Omit mutable series.activeSubgameOrdinal so post-advance retries of the
  // same command still match the original idempotency digest (P1-E04).
  const body: Record<string, unknown> = {
    authProofId: args.auth.authProofId,
    playerId: args.auth.principal.playerId,
    seriesKey: args.auth.series.seriesKey,
    sessionId: args.auth.session.sessionId,
    deviceId: args.auth.session.deviceId,
    writerGeneration: args.auth.session.writerGeneration,
    commandType: args.command.commandType,
    idempotencyKey: args.command.idempotencyKey,
  };
  if (args.command.move) {
    body.move = {
      offerIndex: args.command.move.offerIndex,
      tap: args.command.move.tap,
      expectedBoardRevision: args.command.move.expectedBoardRevision,
      writerGeneration: args.command.move.writerGeneration,
    };
  }
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}
