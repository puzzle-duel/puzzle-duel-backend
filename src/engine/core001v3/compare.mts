import { canonicalJsonV3 } from './canonical.mts';
import { stateHashV3 } from './canonical.mts';
import { statesEqual, stateToJson, type GameState } from './types.mts';

export type ClientReportField =
  | 'score'
  | 'board'
  | 'offers'
  | 'turnsUsed'
  | 'status'
  | 'terminalReason'
  | 'stateHash';

export const FULL_CLIENT_REPORT_FIELDS: readonly ClientReportField[] = Object.freeze([
  'score',
  'board',
  'offers',
  'turnsUsed',
  'status',
  'terminalReason',
  'stateHash',
]);

export type ClientResultMismatch =
  | 'score_mismatch'
  | 'board_mismatch'
  | 'offer_mismatch'
  | 'turn_mismatch'
  | 'terminal_mismatch'
  | 'state_hash_mismatch'
  | 'missing_report_field'
  | 'malformed_report_field';

export type FullClientReport = Readonly<{
  score: number;
  board: unknown;
  offers: unknown;
  turnsUsed: number;
  status: string;
  terminalReason: string | null;
  stateHash: string;
}>;

export type PartialClientReport = Readonly<{
  score?: unknown;
  board?: unknown;
  offers?: unknown;
  turnsUsed?: unknown;
  status?: unknown;
  terminalReason?: unknown;
  stateHash?: unknown;
}>;

/** Strict full-state verification result. Never returned for partial coverage. */
export type FullCompareResult =
  | { ok: true; mode: 'full' }
  | {
      ok: false;
      mode: 'full';
      mismatches: readonly ClientResultMismatch[];
      missingFields?: readonly ClientReportField[];
    };

/**
 * Partial diagnostic result. Intentionally lacks `ok: true`.
 * Callers must never treat this as ranked / full verification.
 */
export type PartialCompareResult = Readonly<{
  mode: 'partial';
  compared: readonly ClientReportField[];
  mismatches: readonly ClientResultMismatch[];
}>;

/** @deprecated Use FullCompareResult; kept alias for Stage C call sites. */
export type CompareResult = FullCompareResult;

function hasOwnReportField(
  client: object,
  field: ClientReportField,
): boolean {
  return Object.prototype.hasOwnProperty.call(client, field);
}

/**
 * Structural equality independent of object key insertion order.
 * Uses ADR-E01 canonical JSON bytes — not raw JSON.stringify.
 */
export function structuralEqual(a: unknown, b: unknown): boolean {
  try {
    return canonicalJsonV3(a) === canonicalJsonV3(b);
  } catch {
    return false;
  }
}

function validateFieldPresence(
  client: object,
): { missing: ClientReportField[]; malformed: ClientResultMismatch[] } {
  const missing: ClientReportField[] = [];
  const malformed: ClientResultMismatch[] = [];
  for (const field of FULL_CLIENT_REPORT_FIELDS) {
    if (!hasOwnReportField(client, field)) {
      missing.push(field);
      continue;
    }
    const value = (client as Record<string, unknown>)[field];
    switch (field) {
      case 'score':
      case 'turnsUsed':
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
          malformed.push('malformed_report_field');
        }
        break;
      case 'status':
        if (typeof value !== 'string') malformed.push('malformed_report_field');
        break;
      case 'terminalReason':
        if (value !== null && typeof value !== 'string') {
          malformed.push('malformed_report_field');
        }
        break;
      case 'stateHash':
        if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
          malformed.push('malformed_report_field');
        }
        break;
      case 'board':
        if (!Array.isArray(value)) malformed.push('malformed_report_field');
        break;
      case 'offers':
        if (!Array.isArray(value)) malformed.push('malformed_report_field');
        break;
    }
  }
  return { missing, malformed };
}

function collectValueMismatches(
  replayed: GameState,
  client: PartialClientReport,
  fields: readonly ClientReportField[],
): ClientResultMismatch[] {
  const mismatches: ClientResultMismatch[] = [];
  const expected = stateToJson(replayed);

  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(client, field)) continue;
    const value = client[field];
    switch (field) {
      case 'score':
        if (value !== replayed.score) mismatches.push('score_mismatch');
        break;
      case 'turnsUsed':
        if (value !== replayed.turnsUsed) mismatches.push('turn_mismatch');
        break;
      case 'status':
        if (value !== replayed.status) mismatches.push('terminal_mismatch');
        break;
      case 'terminalReason':
        if (value !== replayed.terminalReason) mismatches.push('terminal_mismatch');
        break;
      case 'board':
        if (!structuralEqual(value, expected.cells)) {
          mismatches.push('board_mismatch');
        }
        break;
      case 'offers':
        if (!structuralEqual(value, expected.offers)) {
          mismatches.push('offer_mismatch');
        }
        break;
      case 'stateHash':
        if (value !== stateHashV3(replayed)) {
          mismatches.push('state_hash_mismatch');
        }
        break;
    }
  }
  return [...new Set(mismatches)];
}

/**
 * Strict full client-report verification.
 *
 * Requires every field in FULL_CLIENT_REPORT_FIELDS. Empty / partial reports
 * fail closed. A matching hash still does not establish ranked authority —
 * callers must produce `replayed` via trusted initial-challenge replay.
 */
export function compareReplayToClientReport(args: {
  replayed: GameState;
  client: unknown;
}): FullCompareResult {
  if (args.client === null || typeof args.client !== 'object' || Array.isArray(args.client)) {
    return {
      ok: false,
      mode: 'full',
      mismatches: Object.freeze(['malformed_report_field']),
    };
  }

  const { missing, malformed } = validateFieldPresence(args.client);
  if (missing.length > 0 || malformed.length > 0) {
    const mismatches = [
      ...malformed,
      ...(missing.length > 0 ? (['missing_report_field'] as const) : []),
    ];
    return {
      ok: false,
      mode: 'full',
      mismatches: Object.freeze([...new Set(mismatches)]),
      missingFields: missing.length > 0 ? Object.freeze(missing) : undefined,
    };
  }

  const client = args.client as FullClientReport;
  const valueMismatches = collectValueMismatches(
    args.replayed,
    client,
    FULL_CLIENT_REPORT_FIELDS,
  );
  if (valueMismatches.length > 0) {
    return {
      ok: false,
      mode: 'full',
      mismatches: Object.freeze(valueMismatches),
    };
  }
  return { ok: true, mode: 'full' };
}

/**
 * Partial diagnostic comparison for debugging incomplete client payloads.
 * Result is always `mode: 'partial'` and never claims full verification.
 */
export function diagnoseClientReportFields(args: {
  replayed: GameState;
  client: unknown;
}): PartialCompareResult {
  if (args.client === null || typeof args.client !== 'object' || Array.isArray(args.client)) {
    return {
      mode: 'partial',
      compared: Object.freeze([]),
      mismatches: Object.freeze(['malformed_report_field']),
    };
  }

  const compared = FULL_CLIENT_REPORT_FIELDS.filter((field) =>
    hasOwnReportField(args.client as object, field),
  );
  const mismatches = collectValueMismatches(
    args.replayed,
    args.client as PartialClientReport,
    compared,
  );
  return {
    mode: 'partial',
    compared: Object.freeze(compared),
    mismatches: Object.freeze(mismatches),
  };
}

export function compareStates(a: GameState, b: GameState): boolean {
  return statesEqual(a, b);
}
