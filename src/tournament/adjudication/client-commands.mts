/**
 * Untrusted client command surface for Stage E.
 *
 * Runtime validation rejects any attempt to authorize score, completion,
 * terminal reason, writer generation ownership, or checkpoint content.
 * Claimed writerGeneration / expectedBoardRevision are consistency inputs only
 * after authenticated session ownership checks (auth layer NOT_RUN in Stage E).
 */

export type UntrustedClientCommandType =
  | 'start'
  | 'move'
  | 'advance'
  | 'thinking_extension'
  | 'device_handoff'
  | 'abandon'
  | 'checkpoint_overwrite';

const FORBIDDEN_AUTHORITY_KEYS = Object.freeze([
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
] as const);

export interface UntrustedMovePayload {
  offerIndex: number;
  tap: [number, number];
  /** Consistency input only — never self-authenticating. */
  expectedBoardRevision: number;
  /** Consistency input only — never self-authenticating. */
  writerGeneration: number;
  /** Diagnostics only — never ranked authority. */
  clientReportedStateHash?: string;
}

export interface UntrustedClientCommand {
  seriesKey: string;
  playerId: string;
  commandType: UntrustedClientCommandType;
  idempotencyKey: string;
  /**
   * Opaque payload hash of the *allowed* client fields only.
   * Callers must not include forbidden authority keys in the hashed payload.
   */
  payloadHash: string;
  move?: UntrustedMovePayload;
  /**
   * Attack surface for V3-48: client-attempted checkpoint replacement.
   * Presence alone is never accepted as authority.
   */
  attemptedCheckpoint?: unknown;
}

export type ClientCommandValidation =
  | { ok: true; command: UntrustedClientCommand }
  | { ok: false; reason: 'FORBIDDEN_AUTHORITY_FIELD' | 'MALFORMED_COMMAND' | 'MISSING_MOVE_GUARDS' };

export function validateUntrustedClientCommand(raw: unknown): ClientCommandValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'MALFORMED_COMMAND' };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of FORBIDDEN_AUTHORITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      return { ok: false, reason: 'FORBIDDEN_AUTHORITY_FIELD' };
    }
  }
  if (typeof obj.seriesKey !== 'string' || typeof obj.playerId !== 'string') {
    return { ok: false, reason: 'MALFORMED_COMMAND' };
  }
  if (typeof obj.commandType !== 'string' || typeof obj.idempotencyKey !== 'string') {
    return { ok: false, reason: 'MALFORMED_COMMAND' };
  }
  if (typeof obj.payloadHash !== 'string') {
    return { ok: false, reason: 'MALFORMED_COMMAND' };
  }

  if (obj.commandType === 'move') {
    const move = obj.move;
    if (move === null || typeof move !== 'object' || Array.isArray(move)) {
      return { ok: false, reason: 'MALFORMED_COMMAND' };
    }
    const m = move as Record<string, unknown>;
    for (const key of FORBIDDEN_AUTHORITY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(m, key)) {
        return { ok: false, reason: 'FORBIDDEN_AUTHORITY_FIELD' };
      }
    }
    if (
      typeof m.offerIndex !== 'number' ||
      !Number.isSafeInteger(m.offerIndex) ||
      !Array.isArray(m.tap) ||
      m.tap.length !== 2 ||
      typeof m.expectedBoardRevision !== 'number' ||
      !Number.isSafeInteger(m.expectedBoardRevision) ||
      typeof m.writerGeneration !== 'number' ||
      !Number.isSafeInteger(m.writerGeneration)
    ) {
      return { ok: false, reason: 'MISSING_MOVE_GUARDS' };
    }
  }

  if (obj.commandType === 'checkpoint_overwrite') {
    // Explicitly rejected at the validation boundary for ranked paths.
    return { ok: false, reason: 'FORBIDDEN_AUTHORITY_FIELD' };
  }

  return { ok: true, command: obj as unknown as UntrustedClientCommand };
}
