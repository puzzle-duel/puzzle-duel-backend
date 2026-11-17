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
  /**
   * Starting snapshot for deterministic transition replay.
   *
   * Default path (`allowNonInitialTrustedSnapshot` unset/false) requires a
   * valid **initial challenge** via `parseInitialGameState`.
   *
   * The engine never authenticates this value. Tournament callers (PZD-38)
   * must supply a challenge/checkpoint already bound to server-side trust
   * (identity, entitlement, authenticated checkpoint ledger). Passing JSON
   * from the client here does not make it trusted.
   */
  initialState: unknown;
  /** Ordered accepted move inputs. */
  moves: readonly unknown[];
  /** Explicit pinned rules version. */
  rulesVersion?: string;
  /**
   * When true, parse `initialState` with `parseGameState` (non-initial
   * snapshots allowed structurally).
   *
   * **This flag is not checkpoint authentication.** It only relaxes initial
   * challenge invariants for callers that already authenticated a snapshot
   * out-of-band (future PZD-38). Stage C provides no such proof. Prefer the
   * default (`false` / omitted) for trusted challenge + move ledger replay.
   *
   * @deprecated Prefer omitting; use only with explicit external trust proof.
   */
  allowNonInitialTrustedSnapshot?: boolean;
  /**
   * @deprecated Alias of `allowNonInitialTrustedSnapshot`. Kept so existing
   * call sites compile; does not authenticate checkpoints.
   */
  requireInitialChallenge?: boolean;
}>;

function shouldRequireInitialChallenge(input: ReplayInput): boolean {
  if (input.allowNonInitialTrustedSnapshot === true) return false;
  if (input.requireInitialChallenge === false) return false;
  return true;
}

/**
 * Pure transition replay from a caller-supplied starting snapshot + move ledger.
 *
 * Does not consult clocks, databases, identity, or client hashes for authority.
 * Does not authenticate `initialState` — trust is entirely the caller's duty.
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
    state = shouldRequireInitialChallenge(input)
      ? parseInitialGameState(input.initialState)
      : parseGameState(input.initialState);
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
