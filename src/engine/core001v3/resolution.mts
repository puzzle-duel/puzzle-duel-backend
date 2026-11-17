import { copyCells, hasOrthogonalRun, occupiedCount } from './board.mts';
import { checkedNonNegAdd, checkedNonNegMul } from './checked_int.mts';
import type { GameplayRejection, MoveSafety } from './failure.mts';
import { ValidationFailure } from './failure.mts';
import { applyShift, clearMatches } from './match_shift.mts';
import { parseGameState } from './parse.mts';
import {
  applyPlacement,
  deriveTerminalExpectation,
  type OfferConsumption,
  type PlacementApplied,
} from './placement.mts';
import {
  freezeOffers,
  freezeState,
  statesEqual,
  stateToJson,
  type Coordinate,
  type GameState,
  type Move,
  type OfferSlot,
  type Piece,
  type WaveResult,
} from './types.mts';

export type MoveApplied = Readonly<{
  ok: true;
  kind: 'applied';
  landing: Coordinate;
  turnsUsed: number;
  scoreDelta: number;
  waves: readonly WaveResult[];
  finalState: GameState;
}>;

export type MoveRejected = Readonly<{
  ok: false;
  kind: 'rejected';
  code: GameplayRejection;
  state: GameState;
}>;

export type MoveUnsafe = Readonly<{
  ok: false;
  kind: 'unsafe';
  reason: MoveSafety;
  state: GameState;
}>;

export type MoveResult = MoveApplied | MoveRejected | MoveUnsafe;

type CascadeOk = Readonly<{
  cells: readonly (readonly (Piece | null)[])[];
  waves: readonly WaveResult[];
  scoreDelta: number;
}>;

type OfferCommit = Readonly<{
  offers: readonly [OfferSlot, OfferSlot, OfferSlot];
  futurePieces: readonly Piece[];
}>;

function resolveCascades(args: {
  cells: readonly (readonly (Piece | null)[])[];
  blocked: readonly Coordinate[];
  original: GameState;
}): CascadeOk | MoveUnsafe {
  let board = copyCells(args.cells);
  const waves: WaveResult[] = [];
  const maxWaves = Math.floor(occupiedCount(board) / 3);

  const fail = (reason: MoveSafety): MoveUnsafe => ({
    ok: false,
    kind: 'unsafe',
    reason,
    state: args.original,
  });

  for (;;) {
    let match;
    try {
      match = clearMatches(board);
    } catch (error) {
      if (error instanceof ValidationFailure) return fail('invalid_shift_geometry');
      throw error;
    }
    if (!match.foundMatch) break;

    if (waves.length >= maxWaves) return fail('cascade_bound_exceeded');
    if (match.uniqueClearedCount < 3) return fail('cascade_corrupt');

    const before = occupiedCount(board);
    const afterClear = match.cells;
    if (occupiedCount(afterClear) !== before - match.uniqueClearedCount) {
      return fail('cascade_corrupt');
    }

    let shift;
    try {
      shift = applyShift(afterClear, args.blocked);
    } catch (error) {
      if (error instanceof ValidationFailure) return fail('invalid_shift_geometry');
      if (error instanceof Error) return fail('cascade_corrupt');
      throw error;
    }

    if (occupiedCount(shift.cells) !== before - match.uniqueClearedCount) {
      return fail('cascade_corrupt');
    }

    const waveNumber = waves.length + 1;
    let overflow = false;
    const hundred = checkedNonNegMul(match.uniqueClearedCount, 100, () => {
      overflow = true;
    });
    const waveScore = checkedNonNegMul(hundred, waveNumber, () => {
      overflow = true;
    });
    if (overflow) return fail('score_overflow');

    waves.push(
      Object.freeze({
        wave: waveNumber,
        cleared: match.cleared,
        scoreDelta: waveScore,
        moved: shift.moved,
      }),
    );
    board = copyCells(shift.cells);
  }

  let totalDelta = 0;
  for (const wave of waves) {
    let overflow = false;
    totalDelta = checkedNonNegAdd(totalDelta, wave.scoreDelta, () => {
      overflow = true;
    });
    if (overflow) return fail('score_overflow');
  }

  return {
    cells: board,
    waves: Object.freeze(waves),
    scoreDelta: totalDelta,
  };
}

function commitOffers(args: {
  before: GameState;
  consumption: OfferConsumption;
}): OfferCommit {
  if (args.consumption.kind === 'replace') {
    const offers = [...args.before.offers] as [OfferSlot, OfferSlot, OfferSlot];
    offers[args.consumption.offerIndex] = Object.freeze({
      kind: 'piece',
      shape: args.consumption.replacement.shape,
      direction: args.consumption.replacement.direction,
    });
    return {
      offers: freezeOffers(offers),
      futurePieces: args.consumption.remainingFuture,
    };
  }
  const offers = [...args.before.offers] as [OfferSlot, OfferSlot, OfferSlot];
  offers[args.consumption.offerIndex] = Object.freeze({ kind: 'spent' });
  return {
    offers: freezeOffers(offers),
    futurePieces: Object.freeze([]),
  };
}

function requireResolvedFinal(state: GameState): void {
  if (hasOrthogonalRun(state.cells)) {
    throw new Error('final state still contains a match');
  }
  const parsed = parseGameState(stateToJson(state));
  if (!statesEqual(parsed, state)) {
    throw new Error('final state failed round-trip validation');
  }
}

function finishApplied(args: {
  original: GameState;
  applied: PlacementApplied;
  resolved: CascadeOk;
  committed: OfferCommit;
}): MoveResult {
  const turnsUsed = args.applied.turnsUsed;
  const scoreDelta = args.resolved.scoreDelta;
  let overflow = false;
  const score = checkedNonNegAdd(args.original.score, scoreDelta, () => {
    overflow = true;
  });
  if (overflow) {
    return {
      ok: false,
      kind: 'unsafe',
      reason: 'score_overflow',
      state: args.original,
    };
  }

  const provisional = freezeState({
    rulesVersion: args.original.rulesVersion,
    boardSize: args.original.boardSize,
    moveLimit: args.original.moveLimit,
    blocked: args.original.blocked,
    cells: args.resolved.cells,
    offers: args.committed.offers,
    futurePieces: args.committed.futurePieces,
    turnsUsed,
    score,
    status: 'in_progress',
    terminalReason: null,
  });

  const expected = deriveTerminalExpectation({
    turnsUsed,
    moveLimit: args.original.moveLimit,
    candidate: provisional,
  });

  try {
    const finalState = freezeState({
      ...provisional,
      status: expected.status,
      terminalReason: expected.reason,
    });
    requireResolvedFinal(finalState);
    return {
      ok: true,
      kind: 'applied',
      landing: args.applied.landing,
      turnsUsed,
      scoreDelta,
      waves: args.resolved.waves,
      finalState,
    };
  } catch {
    return {
      ok: false,
      kind: 'unsafe',
      reason: 'invalid_final_state',
      state: args.original,
    };
  }
}

/**
 * Full CORE-001.v3 move: placement → cascades → offer commit → terminal.
 * Never mutates input; rejected/unsafe return the original snapshot.
 */
export function applyMove(state: GameState, move: Move): MoveResult {
  const placement = applyPlacement(state, move);
  if (placement.kind === 'rejected') {
    return {
      ok: false,
      kind: 'rejected',
      code: placement.code,
      state: placement.state,
    };
  }
  if (placement.kind === 'unsafe') {
    return {
      ok: false,
      kind: 'unsafe',
      reason: placement.reason,
      state: placement.state,
    };
  }

  if (hasOrthogonalRun(state.cells)) {
    return {
      ok: false,
      kind: 'unsafe',
      reason: 'unresolved_pre_move_match',
      state,
    };
  }

  const resolved = resolveCascades({
    cells: placement.cells,
    blocked: state.blocked,
    original: state,
  });
  if ('kind' in resolved && resolved.kind === 'unsafe') {
    return resolved;
  }

  const committed = commitOffers({
    before: state,
    consumption: placement.offerConsumption,
  });

  return finishApplied({
    original: state,
    applied: placement,
    resolved: resolved as CascadeOk,
    committed,
  });
}
