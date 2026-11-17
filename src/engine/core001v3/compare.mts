import { stateHashV3 } from './canonical.mts';
import { statesEqual, stateToJson, type GameState } from './types.mts';

export type ClientResultMismatch =
  | 'score_mismatch'
  | 'board_mismatch'
  | 'offer_mismatch'
  | 'turn_mismatch'
  | 'terminal_mismatch'
  | 'state_hash_mismatch';

export type CompareResult =
  | { ok: true }
  | { ok: false; mismatches: readonly ClientResultMismatch[] };

/**
 * Compare independently replayed state with client-reported fields.
 * A matching hash alone never proves earned score — caller must still trust
 * the replay path that produced `replayed`.
 */
export function compareReplayToClientReport(args: {
  replayed: GameState;
  client: {
    score?: number;
    board?: unknown;
    offers?: unknown;
    turnsUsed?: number;
    status?: string;
    terminalReason?: string | null;
    stateHash?: string;
  };
}): CompareResult {
  const mismatches: ClientResultMismatch[] = [];
  const expected = stateToJson(args.replayed);

  if (args.client.score !== undefined && args.client.score !== args.replayed.score) {
    mismatches.push('score_mismatch');
  }
  if (
    args.client.turnsUsed !== undefined &&
    args.client.turnsUsed !== args.replayed.turnsUsed
  ) {
    mismatches.push('turn_mismatch');
  }
  if (
    args.client.status !== undefined &&
    args.client.status !== args.replayed.status
  ) {
    mismatches.push('terminal_mismatch');
  }
  if (
    args.client.terminalReason !== undefined &&
    args.client.terminalReason !== args.replayed.terminalReason
  ) {
    mismatches.push('terminal_mismatch');
  }
  if (args.client.board !== undefined) {
    if (JSON.stringify(args.client.board) !== JSON.stringify(expected.cells)) {
      mismatches.push('board_mismatch');
    }
  }
  if (args.client.offers !== undefined) {
    if (JSON.stringify(args.client.offers) !== JSON.stringify(expected.offers)) {
      mismatches.push('offer_mismatch');
    }
  }
  if (args.client.stateHash !== undefined) {
    const digest = stateHashV3(args.replayed);
    if (args.client.stateHash !== digest) {
      mismatches.push('state_hash_mismatch');
    }
  }

  // Full-state equality when client supplies a complete candidate state object.
  return mismatches.length === 0
    ? { ok: true }
    : { ok: false, mismatches: Object.freeze([...new Set(mismatches)]) };
}

export function compareStates(a: GameState, b: GameState): boolean {
  return statesEqual(a, b);
}
