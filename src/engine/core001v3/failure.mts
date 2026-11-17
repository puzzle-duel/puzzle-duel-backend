/** Structural validation codes for CORE-001.v3 (not gameplay rejections). */
export type ValidationCode =
  | 'missing_field'
  | 'unexpected_property'
  | 'unknown_rules_version'
  | 'malformed_board'
  | 'malformed_coordinate'
  | 'blocked_out_of_range'
  | 'duplicate_blocked'
  | 'blocked_not_row_major'
  | 'blocked_cell_occupied'
  | 'malformed_piece'
  | 'malformed_shape'
  | 'malformed_direction'
  | 'malformed_offers'
  | 'null_offer'
  | 'illegal_turn_count'
  | 'malformed_score'
  | 'inconsistent_status'
  | 'unresolved_initial_match'
  | 'malformed_move'
  | 'illegal_offer_index'
  | 'malformed_offer_slot'
  | 'inconsistent_terminal_reason'
  | 'spent_with_future_pieces'
  | 'no_legal_initial_placement'
  | 'integer_out_of_range';

export class ValidationFailure extends Error {
  readonly codes: readonly ValidationCode[];

  constructor(codes: readonly ValidationCode[]) {
    const unique = [...new Set(codes)];
    super(`ValidationFailure(${unique.join(', ')})`);
    this.name = 'ValidationFailure';
    this.codes = Object.freeze(unique);
  }

  get wires(): readonly string[] {
    return this.codes;
  }
}

export type GameplayRejection = 'blocked_tap' | 'occupied_tap' | 'game_ended';

export type MoveSafety =
  | 'tap_out_of_bounds'
  | 'offer_unavailable'
  | 'unresolved_pre_move_match'
  | 'cascade_corrupt'
  | 'cascade_bound_exceeded'
  | 'invalid_shift_geometry'
  | 'invalid_final_state'
  | 'score_overflow'
  | 'integer_overflow'
  | 'rules_version_mismatch'
  | 'replay_move_limit_exceeded';

export class Issues {
  readonly codes: ValidationCode[] = [];

  add(code: ValidationCode): void {
    if (!this.codes.includes(code)) this.codes.push(code);
  }

  get isEmpty(): boolean {
    return this.codes.length === 0;
  }

  throwIfNeeded(): void {
    if (this.codes.length > 0) throw new ValidationFailure(this.codes);
  }
}
