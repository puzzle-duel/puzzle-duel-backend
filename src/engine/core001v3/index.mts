/**
 * Independent pure TypeScript CORE-001.v3 gameplay / replay engine (PZD-39 Stage C).
 *
 * No Flutter/Dart, DB, HTTP, clock, or tournament writer dependencies.
 * Client-supplied stateHash is never ranked authority.
 */

export {
  JSON_MAX_SAFE_INTEGER,
  checkedNonNegAdd,
  checkedNonNegMul,
  isJsonSafeInteger,
  isJsonSafeNonNegativeInt,
} from './checked_int.mts';

export {
  ValidationFailure,
  type ValidationCode,
  type GameplayRejection,
  type MoveSafety,
} from './failure.mts';

export {
  RULES_VERSION,
  freezeState,
  stateToJson,
  statesEqual,
  isOfferLive,
  isSelectable,
  pieceOrNull,
  type RulesVersion,
  type Shape,
  type Direction,
  type GameStatus,
  type TerminalReason,
  type Piece,
  type OfferSlot,
  type OfferLive,
  type OfferSpent,
  type Coordinate,
  type Move,
  type GameState,
  type MovedPiece,
  type WaveResult,
} from './types.mts';

export {
  parseGameState,
  parseInitialGameState,
  parseMove,
  tryParseGameState,
} from './parse.mts';

export {
  applyPlacement,
  canPlaceAt,
  hasLegalPlacement,
  hasLegalMove,
  deriveTerminalExpectation,
  landingCoordinate,
  type PlacementResult,
  type PlacementApplied,
  type OfferConsumption,
} from './placement.mts';

export {
  findMatches,
  clearMatches,
  applyShift,
  type MatchClearResult,
  type ShiftResult,
} from './match_shift.mts';

export {
  applyMove,
  type MoveResult,
  type MoveApplied,
  type MoveRejected,
  type MoveUnsafe,
} from './resolution.mts';

export {
  CanonicalJsonException,
  canonicalJsonV3,
  sha256HexOfUtf8,
  stateHashV3,
} from './canonical.mts';

export {
  replayCore001V3,
  REPLAY_HARD_MOVE_CEILING,
  type ReplayInput,
  type ReplayResult,
  type ReplaySuccess,
  type ReplayFailure,
} from './replay.mts';

export {
  FULL_CLIENT_REPORT_FIELDS,
  compareReplayToClientReport,
  diagnoseClientReportFields,
  structuralEqual,
  compareStates,
  type CompareResult,
  type FullCompareResult,
  type PartialCompareResult,
  type ClientResultMismatch,
  type ClientReportField,
  type FullClientReport,
} from './compare.mts';
