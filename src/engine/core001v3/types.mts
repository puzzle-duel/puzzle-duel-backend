export const RULES_VERSION = 'core-001.v3' as const;
export type RulesVersion = typeof RULES_VERSION;

export type Shape = 'circle' | 'diamond' | 'triangle';
export type Direction = 'up' | 'right' | 'down' | 'left';
export type GameStatus = 'in_progress' | 'ended';
export type TerminalReason = 'move_limit_reached' | 'no_legal_moves';

export type Piece = Readonly<{ shape: Shape; direction: Direction }>;

export type OfferLive = Readonly<{
  kind: 'piece';
  shape: Shape;
  direction: Direction;
}>;

export type OfferSpent = Readonly<{ kind: 'spent' }>;

export type OfferSlot = OfferLive | OfferSpent;

export type Coordinate = Readonly<{ row: number; column: number }>;

export type Move = Readonly<{ offerIndex: 0 | 1 | 2; tap: Coordinate }>;

export type GameState = Readonly<{
  rulesVersion: RulesVersion;
  boardSize: number;
  moveLimit: number;
  blocked: readonly Coordinate[];
  cells: readonly (readonly (Piece | null)[])[];
  offers: readonly [OfferSlot, OfferSlot, OfferSlot];
  futurePieces: readonly Piece[];
  turnsUsed: number;
  score: number;
  status: GameStatus;
  terminalReason: TerminalReason | null;
}>;

export type MovedPiece = Readonly<{
  sourceIndex: number;
  from: Coordinate;
  to: Coordinate;
  shape: Shape;
  direction: Direction;
}>;

export type WaveResult = Readonly<{
  wave: number;
  cleared: readonly Coordinate[];
  scoreDelta: number;
  moved: readonly MovedPiece[];
}>;

export function isOfferLive(slot: OfferSlot): slot is OfferLive {
  return slot.kind === 'piece';
}

export function isSelectable(slot: OfferSlot): boolean {
  return slot.kind === 'piece';
}

export function pieceOrNull(slot: OfferSlot): Piece | null {
  return slot.kind === 'piece'
    ? Object.freeze({ shape: slot.shape, direction: slot.direction })
    : null;
}

export function freezePiece(piece: Piece): Piece {
  return Object.freeze({ shape: piece.shape, direction: piece.direction });
}

export function freezeCoord(row: number, column: number): Coordinate {
  return Object.freeze({ row, column });
}

export function freezeCells(
  cells: readonly (readonly (Piece | null)[])[],
): readonly (readonly (Piece | null)[])[] {
  return Object.freeze(
    cells.map((row) =>
      Object.freeze(row.map((cell) => (cell === null ? null : freezePiece(cell)))),
    ),
  );
}

export function freezeOffers(
  offers: readonly OfferSlot[],
): readonly [OfferSlot, OfferSlot, OfferSlot] {
  if (offers.length !== 3) {
    throw new Error('offers length must be 3');
  }
  const frozen = offers.map((slot) =>
    slot.kind === 'spent'
      ? Object.freeze({ kind: 'spent' as const })
      : Object.freeze({
          kind: 'piece' as const,
          shape: slot.shape,
          direction: slot.direction,
        }),
  ) as [OfferSlot, OfferSlot, OfferSlot];
  return Object.freeze(frozen);
}

export function freezeState(state: GameState): GameState {
  return Object.freeze({
    rulesVersion: RULES_VERSION,
    boardSize: state.boardSize,
    moveLimit: state.moveLimit,
    blocked: Object.freeze(state.blocked.map((c) => freezeCoord(c.row, c.column))),
    cells: freezeCells(state.cells),
    offers: freezeOffers(state.offers),
    futurePieces: Object.freeze(state.futurePieces.map(freezePiece)),
    turnsUsed: state.turnsUsed,
    score: state.score,
    status: state.status,
    terminalReason: state.terminalReason,
  });
}

export function stateToJson(state: GameState): Record<string, unknown> {
  return {
    rulesVersion: state.rulesVersion,
    boardSize: state.boardSize,
    moveLimit: state.moveLimit,
    blocked: state.blocked.map((c) => [c.row, c.column]),
    cells: state.cells.map((row) =>
      row.map((cell) =>
        cell === null ? null : { shape: cell.shape, direction: cell.direction },
      ),
    ),
    offers: state.offers.map((slot) =>
      slot.kind === 'spent'
        ? { kind: 'spent' }
        : { kind: 'piece', shape: slot.shape, direction: slot.direction },
    ),
    futurePieces: state.futurePieces.map((p) => ({
      shape: p.shape,
      direction: p.direction,
    })),
    turnsUsed: state.turnsUsed,
    score: state.score,
    status: state.status,
    terminalReason: state.terminalReason,
  };
}

export function statesEqual(a: GameState, b: GameState): boolean {
  return JSON.stringify(stateToJson(a)) === JSON.stringify(stateToJson(b));
}
