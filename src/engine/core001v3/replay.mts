import { stateHashV3 } from './canonical.mts';
import type { MoveSafety } from './failure.mts';
import { ValidationFailure } from './failure.mts';
import { parseGameState, parseInitialGameState, parseMove } from './parse.mts';
import { applyMove, type MoveApplied, type MoveResult } from './resolution.mts';
import {
  RULES_VERSION,
  type GameState,
  type Move,
} from './types.mts';

/**
 * Soft resource fence for untrusted move ledgers.
 * Legitimate accepted profiles use moveLimit ≪ this; exceeding it fails closed
 * without inventing a product business rule for board size.
 */
export const REPLAY_HARD_MOVE_CEILING = 10_000;

export type ReplaySuccess = Readonly<{
  ok: true;
  finalState: GameState;
  stateHash: string;
  applied: readonly MoveApplied[];
}>;

export type ReplayFailure = Readonly<{
  ok: false;
  reason:
    | 'invalid_initial'
    | 'rules_version_mismatch'
    | 'invalid_move'
    | 'move_rejected'
    | 'move_unsafe'
    | 'replay_move_limit_exceeded'
    | 'post_terminal_move';
  detail?: string;
  codes?: readonly string[];
  safety?: MoveSafety;
  rejection?: string;
  state?: GameState;
  moveIndex?: number;
}>;

export type ReplayResult = ReplaySuccess | ReplayFailure;

export type ReplayInput = Readonly<{
  /** Trusted immutable initial challenge (caller-authenticated). */
  initialState: unknown;
  /** Ordered accepted move inputs. */
  moves: readonly unknown[];
  /** Explicit pinned rules version. */
  rulesVersion?: string;
  /** When true, require parseInitialGameState invariants. Default true. */
  requireInitialChallenge?: boolean;
}>;

/**
 * Authoritative pure replay from a trusted initial challenge + move ledger.
 * Does not consult clocks, databases, identity, or client hashes for authority.
 */
export function replayCore001V3(input: ReplayInput): ReplayResult {
  const pinned = input.rulesVersion ?? RULES_VERSION;
  if (pinned !== RULES_VERSION) {
    return {
      ok: false,
      reason: 'rules_version_mismatch',
      detail: `pinned ${pinned}; engine supports ${RULES_VERSION}`,
    };
  }

  if (input.moves.length > REPLAY_HARD_MOVE_CEILING) {
    return {
      ok: false,
      reason: 'replay_move_limit_exceeded',
      detail: `moves.length ${input.moves.length} > ${REPLAY_HARD_MOVE_CEILING}`,
    };
  }

  let state: GameState;
  try {
    state =
      input.requireInitialChallenge === false
        ? parseGameState(input.initialState)
        : parseInitialGameState(input.initialState);
  } catch (error) {
    if (error instanceof ValidationFailure) {
      return { ok: false, reason: 'invalid_initial', codes: error.wires };
    }
    throw error;
  }

  if (state.rulesVersion !== RULES_VERSION) {
    return { ok: false, reason: 'rules_version_mismatch' };
  }

  const applied: MoveApplied[] = [];
  for (let moveIndex = 0; moveIndex < input.moves.length; moveIndex++) {
    if (state.status === 'ended') {
      return {
        ok: false,
        reason: 'post_terminal_move',
        moveIndex,
        state,
      };
    }

    let move: Move;
    try {
      move = parseMove(input.moves[moveIndex]);
    } catch (error) {
      if (error instanceof ValidationFailure) {
        return {
          ok: false,
          reason: 'invalid_move',
          codes: error.wires,
          moveIndex,
          state,
        };
      }
      throw error;
    }

    const result: MoveResult = applyMove(state, move);
    if (result.kind === 'rejected') {
      return {
        ok: false,
        reason: 'move_rejected',
        rejection: result.code,
        moveIndex,
        state: result.state,
      };
    }
    if (result.kind === 'unsafe') {
      return {
        ok: false,
        reason: 'move_unsafe',
        safety: result.reason,
        moveIndex,
        state: result.state,
      };
    }
    applied.push(result);
    state = result.finalState;
  }

  return {
    ok: true,
    finalState: state,
    stateHash: stateHashV3(state),
    applied: Object.freeze(applied),
  };
}
