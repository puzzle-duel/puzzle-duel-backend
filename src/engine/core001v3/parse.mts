import { isJsonSafeNonNegativeInt } from './checked_int.mts';
import { hasOrthogonalRun } from './board.mts';
import { Issues, ValidationFailure } from './failure.mts';
import { deriveTerminalExpectation, hasLegalPlacement } from './placement.mts';
import {
  RULES_VERSION,
  freezeCoord,
  freezePiece,
  freezeState,
  type Coordinate,
  type Direction,
  type GameState,
  type GameStatus,
  type Move,
  type OfferSlot,
  type Piece,
  type Shape,
  type TerminalReason,
} from './types.mts';

const STATE_KEYS = new Set([
  'rulesVersion',
  'boardSize',
  'moveLimit',
  'blocked',
  'cells',
  'offers',
  'futurePieces',
  'turnsUsed',
  'score',
  'status',
  'terminalReason',
]);

const PIECE_KEYS = new Set(['shape', 'direction']);
const MOVE_KEYS = new Set(['offerIndex', 'tap']);
const SHAPES = new Set<Shape>(['circle', 'diamond', 'triangle']);
const DIRECTIONS = new Set<Direction>(['up', 'right', 'down', 'left']);
const STATUSES = new Set<GameStatus>(['in_progress', 'ended']);
const TERMINAL_REASONS = new Set<TerminalReason>([
  'move_limit_reached',
  'no_legal_moves',
]);

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = entry;
  }
  return result;
}

function closed(
  json: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  issues: Issues,
): void {
  for (const key of Object.keys(json)) {
    if (!allowed.has(key)) issues.add('unexpected_property');
  }
  for (const key of allowed) {
    if (!(key in json)) issues.add('missing_field');
  }
}

/**
 * Reject floats / unsafe ints / -0 before gameplay construction.
 * Distinguishes type errors from JSON-safe range violations.
 */
function asSafeInt(
  value: unknown,
): { ok: true; value: number } | { ok: false; reason: 'type' | 'range' } {
  if (typeof value !== 'number' || Object.is(value, -0) || !Number.isInteger(value)) {
    return { ok: false, reason: 'type' };
  }
  if (!Number.isSafeInteger(value)) {
    return { ok: false, reason: 'range' };
  }
  return { ok: true, value };
}

function parseShape(value: unknown): Shape | null {
  return typeof value === 'string' && SHAPES.has(value as Shape)
    ? (value as Shape)
    : null;
}

function parseDirection(value: unknown): Direction | null {
  return typeof value === 'string' && DIRECTIONS.has(value as Direction)
    ? (value as Direction)
    : null;
}

function parsePiece(value: unknown, issues: Issues): Piece | null {
  if (value === null || value === undefined) {
    issues.add('malformed_piece');
    return null;
  }
  const json = asObject(value);
  if (json === null) {
    issues.add('malformed_piece');
    return null;
  }
  const local = new Issues();
  closed(json, PIECE_KEYS, local);
  const shape = parseShape(json.shape);
  const direction = parseDirection(json.direction);
  if (shape === null) local.add('malformed_shape');
  if (direction === null) local.add('malformed_direction');
  for (const code of local.codes) issues.add(code);
  if (shape === null || direction === null || !local.isEmpty) return null;
  return freezePiece({ shape, direction });
}

function parseCoordinate(
  value: unknown,
  issues: Issues,
  code: 'malformed_coordinate' | 'blocked_out_of_range',
): Coordinate | null {
  if (!Array.isArray(value) || value.length !== 2) {
    issues.add(code);
    return null;
  }
  const row = asSafeInt(value[0]);
  const column = asSafeInt(value[1]);
  if (
    !row.ok ||
    !column.ok ||
    row.value < 0 ||
    column.value < 0
  ) {
    issues.add(code);
    return null;
  }
  return freezeCoord(row.value, column.value);
}

function parseCells(
  value: unknown,
  boardSize: number | null,
  issues: Issues,
): {
  rows: (Piece | null)[][] | null;
  occupied: boolean[][] | null;
} {
  if (boardSize === null || !Array.isArray(value) || value.length !== boardSize) {
    issues.add('malformed_board');
    return { rows: null, occupied: null };
  }
  const rows: (Piece | null)[][] = [];
  const occupied: boolean[][] = [];
  let ok = true;
  for (const rawRow of value) {
    if (!Array.isArray(rawRow) || rawRow.length !== boardSize) {
      issues.add('malformed_board');
      ok = false;
      continue;
    }
    const row: (Piece | null)[] = [];
    const flags: boolean[] = [];
    for (const rawCell of rawRow) {
      flags.push(rawCell !== null);
      if (rawCell === null) {
        row.push(null);
        continue;
      }
      const before = issues.codes.length;
      const piece = parsePiece(rawCell, issues);
      if (piece === null || issues.codes.length !== before) {
        ok = false;
        row.push(null);
      } else {
        row.push(piece);
      }
    }
    rows.push(row);
    occupied.push(flags);
  }
  if (!ok || rows.length !== boardSize) return { rows: null, occupied };
  return { rows, occupied };
}

function parseBlocked(
  value: unknown,
  boardSize: number | null,
  occupied: boolean[][] | null,
  issues: Issues,
): Coordinate[] {
  if (!Array.isArray(value)) {
    issues.add('malformed_board');
    return [];
  }
  const parsed: Coordinate[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const coordinate = parseCoordinate(raw, issues, 'blocked_out_of_range');
    if (coordinate === null) continue;
    const key = `${coordinate.row},${coordinate.column}`;
    if (seen.has(key)) issues.add('duplicate_blocked');
    else seen.add(key);
    if (
      boardSize === null ||
      coordinate.row >= boardSize ||
      coordinate.column >= boardSize
    ) {
      issues.add('blocked_out_of_range');
    } else if (
      occupied !== null &&
      occupied[coordinate.row]?.[coordinate.column] === true
    ) {
      issues.add('blocked_cell_occupied');
    }
    parsed.push(coordinate);
  }
  for (let index = 1; index < parsed.length; index++) {
    const previous = parsed[index - 1]!;
    const current = parsed[index]!;
    const ordered =
      current.row > previous.row ||
      (current.row === previous.row && current.column > previous.column);
    if (!ordered) {
      issues.add('blocked_not_row_major');
      break;
    }
  }
  return parsed;
}

function parseOffers(
  value: unknown,
  issues: Issues,
): { slots: OfferSlot[]; spent: number; ok: boolean } {
  if (!Array.isArray(value) || value.length !== 3) {
    issues.add('malformed_offers');
    return { slots: [], spent: 0, ok: false };
  }
  const slots: OfferSlot[] = [];
  let spent = 0;
  let ok = true;
  for (const raw of value) {
    if (raw === null) {
      issues.add('null_offer');
      ok = false;
      slots.push(Object.freeze({ kind: 'spent' }));
      continue;
    }
    const json = asObject(raw);
    if (json === null) {
      issues.add('malformed_offer_slot');
      ok = false;
      slots.push(Object.freeze({ kind: 'spent' }));
      continue;
    }
    const kind = json.kind;
    if (kind === 'spent') {
      const local = new Issues();
      closed(json, new Set(['kind']), local);
      for (const code of local.codes) issues.add(code);
      if (!local.isEmpty) ok = false;
      spent += 1;
      slots.push(Object.freeze({ kind: 'spent' }));
      continue;
    }
    if (kind === 'piece') {
      const local = new Issues();
      closed(json, new Set(['kind', 'shape', 'direction']), local);
      const shape = parseShape(json.shape);
      const direction = parseDirection(json.direction);
      if (shape === null) local.add('malformed_shape');
      if (direction === null) local.add('malformed_direction');
      for (const code of local.codes) issues.add(code);
      if (shape === null || direction === null || !local.isEmpty) {
        ok = false;
        slots.push(Object.freeze({ kind: 'spent' }));
      } else {
        slots.push(
          Object.freeze({ kind: 'piece' as const, shape, direction }),
        );
      }
      continue;
    }
    issues.add('malformed_offer_slot');
    ok = false;
    slots.push(Object.freeze({ kind: 'spent' }));
  }
  return { slots, spent, ok };
}

function parseFuture(value: unknown, issues: Issues): Piece[] | null {
  if (!Array.isArray(value)) {
    issues.add('malformed_offers');
    return null;
  }
  const pieces: Piece[] = [];
  let ok = true;
  for (const raw of value) {
    const before = issues.codes.length;
    const piece = parsePiece(raw, issues);
    if (piece === null || issues.codes.length !== before) ok = false;
    else pieces.push(piece);
  }
  return ok ? pieces : null;
}

function parseState(json: unknown, initial: boolean): GameState {
  const issues = new Issues();
  const object = asObject(json);
  if (object === null) {
    throw new ValidationFailure(['malformed_board']);
  }
  closed(object, STATE_KEYS, issues);

  if (object.rulesVersion !== RULES_VERSION) {
    if ('rulesVersion' in object) issues.add('unknown_rules_version');
  }

  const boardSizeRaw = asSafeInt(object.boardSize);
  if ('boardSize' in object && !boardSizeRaw.ok && boardSizeRaw.reason === 'range') {
    issues.add('integer_out_of_range');
  }
  const boardSize = boardSizeRaw.ok ? boardSizeRaw.value : null;
  const usableSize = boardSize !== null && boardSize >= 1 ? boardSize : null;
  if ('boardSize' in object && usableSize === null && boardSizeRaw.ok) {
    issues.add('malformed_board');
  } else if ('boardSize' in object && !boardSizeRaw.ok && boardSizeRaw.reason === 'type') {
    issues.add('malformed_board');
  }

  const moveLimitRaw = asSafeInt(object.moveLimit);
  const turnsUsedRaw = asSafeInt(object.turnsUsed);
  if (
    ('moveLimit' in object && !moveLimitRaw.ok && moveLimitRaw.reason === 'range') ||
    ('turnsUsed' in object && !turnsUsedRaw.ok && turnsUsedRaw.reason === 'range')
  ) {
    issues.add('integer_out_of_range');
  }
  const moveLimit = moveLimitRaw.ok ? moveLimitRaw.value : null;
  const turnsUsed = turnsUsedRaw.ok ? turnsUsedRaw.value : null;
  const turnsOk =
    moveLimit !== null &&
    turnsUsed !== null &&
    moveLimit >= 1 &&
    turnsUsed >= 0 &&
    turnsUsed <= moveLimit;
  if ('moveLimit' in object && 'turnsUsed' in object && !turnsOk) {
    issues.add('illegal_turn_count');
  }

  const grid = parseCells(object.cells, usableSize, issues);
  const blocked = parseBlocked(object.blocked, usableSize, grid.occupied, issues);
  const offers = parseOffers(object.offers, issues);
  const futurePieces = parseFuture(object.futurePieces, issues);

  const scoreRaw = asSafeInt(object.score);
  let score: number | null = null;
  if ('score' in object) {
    if (!scoreRaw.ok) {
      if (scoreRaw.reason === 'range') issues.add('integer_out_of_range');
      else issues.add('malformed_score');
    } else if (scoreRaw.value < 0) {
      issues.add('malformed_score');
    } else if (!isJsonSafeNonNegativeInt(scoreRaw.value)) {
      issues.add('integer_out_of_range');
    } else {
      score = scoreRaw.value;
    }
  }

  const statusRaw = object.status;
  const status =
    typeof statusRaw === 'string' && STATUSES.has(statusRaw as GameStatus)
      ? (statusRaw as GameStatus)
      : null;
  if ('status' in object && status === null) issues.add('inconsistent_status');

  let terminalReason: TerminalReason | null = null;
  const rawReason = object.terminalReason;
  if (rawReason === null) {
    terminalReason = null;
  } else if (typeof rawReason === 'string' && TERMINAL_REASONS.has(rawReason as TerminalReason)) {
    terminalReason = rawReason as TerminalReason;
  } else if ('terminalReason' in object) {
    issues.add('inconsistent_terminal_reason');
  }

  if (offers.spent > 0 && futurePieces !== null && futurePieces.length > 0) {
    issues.add('spent_with_future_pieces');
  }

  let candidate: GameState | null = null;
  if (
    object.rulesVersion === RULES_VERSION &&
    usableSize !== null &&
    moveLimit !== null &&
    turnsUsed !== null &&
    score !== null &&
    status !== null &&
    grid.rows !== null &&
    futurePieces !== null &&
    offers.slots.length === 3
  ) {
    candidate = freezeState({
      rulesVersion: RULES_VERSION,
      boardSize: usableSize,
      moveLimit,
      blocked: Object.freeze(blocked),
      cells: grid.rows,
      offers: offers.slots as [OfferSlot, OfferSlot, OfferSlot],
      futurePieces,
      turnsUsed,
      score,
      status,
      terminalReason,
    });
  }

  if (candidate !== null && turnsOk) {
    const expected = deriveTerminalExpectation({
      turnsUsed: candidate.turnsUsed,
      moveLimit: candidate.moveLimit,
      candidate,
    });
    if (status !== expected.status || terminalReason !== expected.reason) {
      issues.add('inconsistent_status');
      if (terminalReason !== expected.reason) {
        issues.add('inconsistent_terminal_reason');
      }
    }
  }

  if (initial && grid.rows !== null && hasOrthogonalRun(grid.rows)) {
    issues.add('unresolved_initial_match');
  }
  if (initial && candidate !== null) {
    if (
      candidate.turnsUsed !== 0 ||
      candidate.score !== 0 ||
      candidate.status !== 'in_progress' ||
      candidate.terminalReason !== null ||
      candidate.offers.some((slot) => slot.kind !== 'piece')
    ) {
      issues.add('inconsistent_status');
    }
    if (!hasLegalPlacement(candidate)) {
      issues.add('no_legal_initial_placement');
    }
  }

  issues.throwIfNeeded();
  return candidate!;
}

/** Structural v3 snapshot. Existing matches are retained. */
export function parseGameState(json: unknown): GameState {
  return parseState(json, false);
}

/** Initial challenge: playable, three live offers, no unresolved match. */
export function parseInitialGameState(json: unknown): GameState {
  return parseState(json, true);
}

export function parseMove(json: unknown): Move {
  const issues = new Issues();
  const object = asObject(json);
  if (object === null) throw new ValidationFailure(['malformed_move']);
  closed(object, MOVE_KEYS, issues);
  const indexRaw = asSafeInt(object.offerIndex);
  const index = indexRaw.ok ? indexRaw.value : null;
  if (
    'offerIndex' in object &&
    (index === null || index < 0 || index > 2)
  ) {
    issues.add('illegal_offer_index');
  }
  const tap = parseCoordinate(object.tap, issues, 'malformed_coordinate');
  issues.throwIfNeeded();
  return Object.freeze({
    offerIndex: index as 0 | 1 | 2,
    tap: tap!,
  });
}

export function tryParseGameState(
  json: unknown,
):
  | { ok: true; state: GameState }
  | { ok: false; codes: readonly string[] } {
  try {
    return { ok: true, state: parseGameState(json) };
  } catch (error) {
    if (error instanceof ValidationFailure) {
      return { ok: false, codes: error.wires };
    }
    throw error;
  }
}
