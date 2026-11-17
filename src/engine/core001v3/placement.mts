import { checkedNonNegAdd } from './checked_int.mts';
import {
  blockedKey,
  blockedKeys,
  directionDelta,
  inBounds,
} from './board.mts';
import type { GameplayRejection, MoveSafety } from './failure.mts';
import {
  freezeCells,
  freezeCoord,
  freezePiece,
  isSelectable,
  pieceOrNull,
  type Coordinate,
  type GameState,
  type Move,
  type Piece,
} from './types.mts';

export type OfferWillReplace = Readonly<{
  kind: 'replace';
  offerIndex: 0 | 1 | 2;
  replacement: Piece;
  remainingFuture: readonly Piece[];
}>;

export type OfferReplacementDeferred = Readonly<{
  kind: 'deferred';
  offerIndex: 0 | 1 | 2;
}>;

export type OfferConsumption = OfferWillReplace | OfferReplacementDeferred;

export type PlacementRejected = Readonly<{
  ok: false;
  kind: 'rejected';
  code: GameplayRejection;
  state: GameState;
}>;

export type PlacementUnsafe = Readonly<{
  ok: false;
  kind: 'unsafe';
  reason: Extract<
    MoveSafety,
    'tap_out_of_bounds' | 'offer_unavailable' | 'integer_overflow'
  >;
  state: GameState;
}>;

export type PlacementApplied = Readonly<{
  ok: true;
  kind: 'applied';
  before: GameState;
  placedPiece: Piece;
  landing: Coordinate;
  offerIndex: 0 | 1 | 2;
  cells: readonly (readonly (Piece | null)[])[];
  turnsUsed: number;
  score: number;
  offerConsumption: OfferConsumption;
}>;

export type PlacementResult = PlacementRejected | PlacementUnsafe | PlacementApplied;

export function landingCoordinate(
  state: GameState,
  piece: Piece,
  tap: Coordinate,
): Coordinate {
  const obstacles = blockedKeys(state.blocked);
  const [dr, dc] = directionDelta(piece.direction);
  const forwardRow = tap.row + dr;
  const forwardColumn = tap.column + dc;
  if (
    inBounds(state.boardSize, forwardRow, forwardColumn) &&
    !obstacles.has(blockedKey(forwardRow, forwardColumn)) &&
    state.cells[forwardRow]![forwardColumn] === null
  ) {
    return freezeCoord(forwardRow, forwardColumn);
  }
  return freezeCoord(tap.row, tap.column);
}

function withPiece(
  cells: readonly (readonly (Piece | null)[])[],
  landing: Coordinate,
  piece: Piece,
): readonly (readonly (Piece | null)[])[] {
  return freezeCells(
    cells.map((row, r) =>
      row.map((cell, c) =>
        r === landing.row && c === landing.column ? piece : cell,
      ),
    ),
  );
}

/** PZD-18 placement; does not match/clear/score/end. */
export function applyPlacement(state: GameState, move: Move): PlacementResult {
  const tap = move.tap;
  if (!inBounds(state.boardSize, tap.row, tap.column)) {
    return { ok: false, kind: 'unsafe', reason: 'tap_out_of_bounds', state };
  }
  if (state.status !== 'in_progress') {
    return { ok: false, kind: 'rejected', code: 'game_ended', state };
  }
  const obstacles = blockedKeys(state.blocked);
  const key = blockedKey(tap.row, tap.column);
  if (obstacles.has(key)) {
    return { ok: false, kind: 'rejected', code: 'blocked_tap', state };
  }
  if (state.cells[tap.row]![tap.column] !== null) {
    return { ok: false, kind: 'rejected', code: 'occupied_tap', state };
  }
  const slot = state.offers[move.offerIndex]!;
  const selected = pieceOrNull(slot);
  if (!isSelectable(slot) || selected === null) {
    return { ok: false, kind: 'unsafe', reason: 'offer_unavailable', state };
  }

  const land = landingCoordinate(state, selected, tap);
  const placed = withPiece(state.cells, land, selected);
  const consumption: OfferConsumption =
    state.futurePieces.length === 0
      ? { kind: 'deferred', offerIndex: move.offerIndex }
      : {
          kind: 'replace',
          offerIndex: move.offerIndex,
          replacement: freezePiece(state.futurePieces[0]!),
          remainingFuture: Object.freeze(
            state.futurePieces.slice(1).map(freezePiece),
          ),
        };

  let overflow = false;
  const nextTurns = checkedNonNegAdd(state.turnsUsed, 1, () => {
    overflow = true;
  });
  if (overflow) {
    return { ok: false, kind: 'unsafe', reason: 'integer_overflow', state };
  }

  return {
    ok: true,
    kind: 'applied',
    before: state,
    placedPiece: freezePiece(selected),
    landing: land,
    offerIndex: move.offerIndex,
    cells: placed,
    turnsUsed: nextTurns,
    score: state.score,
    offerConsumption: consumption,
  };
}

/** Status-agnostic empty/unblocked tap geometry (ADR-E01 §5.1 / PZD-18 lemma). */
export function canPlaceAt(args: {
  boardSize: number;
  cells: readonly (readonly (Piece | null)[])[];
  blocked: readonly Coordinate[];
  piece: Piece;
  tap: Coordinate;
}): boolean {
  if (!inBounds(args.boardSize, args.tap.row, args.tap.column)) return false;
  const obstacles = blockedKeys(args.blocked);
  if (obstacles.has(blockedKey(args.tap.row, args.tap.column))) return false;
  if (args.cells[args.tap.row]![args.tap.column] !== null) return false;
  return true;
}

export function hasLegalPlacement(state: GameState): boolean {
  for (let offerIndex = 0; offerIndex < state.offers.length; offerIndex++) {
    const slot = state.offers[offerIndex]!;
    const piece = pieceOrNull(slot);
    if (!isSelectable(slot) || piece === null) continue;
    for (let row = 0; row < state.boardSize; row++) {
      for (let column = 0; column < state.boardSize; column++) {
        if (
          canPlaceAt({
            boardSize: state.boardSize,
            cells: state.cells,
            blocked: state.blocked,
            piece,
            tap: freezeCoord(row, column),
          })
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

export function hasLegalMove(state: GameState): boolean {
  return (
    state.status === 'in_progress' &&
    state.turnsUsed < state.moveLimit &&
    hasLegalPlacement(state)
  );
}

export function deriveTerminalExpectation(args: {
  turnsUsed: number;
  moveLimit: number;
  candidate: GameState;
}): { status: GameState['status']; reason: GameState['terminalReason'] } {
  if (args.turnsUsed >= args.moveLimit) {
    return { status: 'ended', reason: 'move_limit_reached' };
  }
  if (!hasLegalPlacement(args.candidate)) {
    return { status: 'ended', reason: 'no_legal_moves' };
  }
  return { status: 'in_progress', reason: null };
}
