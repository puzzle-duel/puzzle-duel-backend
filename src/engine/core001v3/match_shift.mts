import {
  blockedKey,
  blockedKeys,
  directionDelta,
  inBounds,
} from './board.mts';
import { Issues, ValidationFailure, type ValidationCode } from './failure.mts';
import {
  freezeCells,
  freezeCoord,
  freezePiece,
  type Coordinate,
  type MovedPiece,
  type Piece,
} from './types.mts';

export type MatchClearResult = Readonly<{
  before: readonly (readonly (Piece | null)[])[];
  cleared: readonly Coordinate[];
  cells: readonly (readonly (Piece | null)[])[];
  uniqueClearedCount: number;
  foundMatch: boolean;
}>;

export type ShiftResult = Readonly<{
  before: readonly (readonly (Piece | null)[])[];
  cells: readonly (readonly (Piece | null)[])[];
  moved: readonly MovedPiece[];
}>;

function requireSquareCells(
  cells: readonly (readonly (Piece | null)[])[],
  issues: Issues,
): void {
  if (cells.length === 0) {
    issues.add('malformed_board');
    return;
  }
  const size = cells.length;
  for (const row of cells) {
    if (row.length !== size) {
      issues.add('malformed_board');
      return;
    }
  }
}

function requireBlockedGeometry(
  cells: readonly (readonly (Piece | null)[])[],
  blocked: readonly Coordinate[],
  issues: Issues,
): void {
  if (cells.length === 0 || issues.codes.includes('malformed_board')) return;
  const size = cells.length;
  const seen = new Set<string>();
  for (let index = 0; index < blocked.length; index++) {
    const cell = blocked[index]!;
    const key = blockedKey(cell.row, cell.column);
    if (seen.has(key)) issues.add('duplicate_blocked');
    else seen.add(key);
    if (cell.row < 0 || cell.column < 0 || cell.row >= size || cell.column >= size) {
      issues.add('blocked_out_of_range');
      continue;
    }
    if (cells[cell.row]![cell.column] !== null) {
      issues.add('blocked_cell_occupied');
    }
    if (index > 0) {
      const previous = blocked[index - 1]!;
      const ordered =
        cell.row > previous.row ||
        (cell.row === previous.row && cell.column > previous.column);
      if (!ordered) issues.add('blocked_not_row_major');
    }
  }
}

function requireMatchBoard(cells: readonly (readonly (Piece | null)[])[]): void {
  const issues = new Issues();
  requireSquareCells(cells, issues);
  issues.throwIfNeeded();
}

function requireShiftBoard(
  cells: readonly (readonly (Piece | null)[])[],
  blocked: readonly Coordinate[],
): void {
  const issues = new Issues();
  requireSquareCells(cells, issues);
  requireBlockedGeometry(cells, blocked, issues);
  issues.throwIfNeeded();
}

/** Unique matching cells in ascending row-major order. Shape only. */
export function findMatches(
  cells: readonly (readonly (Piece | null)[])[],
): readonly Coordinate[] {
  requireMatchBoard(cells);
  const size = cells.length;
  const found = new Set<string>();
  const ordered: Coordinate[] = [];

  const add = (row: number, column: number): void => {
    const key = blockedKey(row, column);
    if (found.has(key)) return;
    found.add(key);
    ordered.push(freezeCoord(row, column));
  };

  for (let row = 0; row < size; row++) {
    let column = 0;
    while (column < size) {
      const piece = cells[row]![column];
      if (piece == null) {
        column += 1;
        continue;
      }
      let end = column + 1;
      while (end < size) {
        const next = cells[row]![end];
        if (next == null || next.shape !== piece.shape) break;
        end += 1;
      }
      if (end - column >= 3) {
        for (let index = column; index < end; index++) add(row, index);
      }
      column = end;
    }
  }

  for (let column = 0; column < size; column++) {
    let row = 0;
    while (row < size) {
      const piece = cells[row]![column];
      if (piece == null) {
        row += 1;
        continue;
      }
      let end = row + 1;
      while (end < size) {
        const next = cells[end]![column];
        if (next == null || next.shape !== piece.shape) break;
        end += 1;
      }
      if (end - row >= 3) {
        for (let index = row; index < end; index++) add(index, column);
      }
      row = end;
    }
  }

  ordered.sort((left, right) => {
    const byRow = left.row - right.row;
    return byRow !== 0 ? byRow : left.column - right.column;
  });
  return Object.freeze(ordered);
}

export function clearMatches(
  cells: readonly (readonly (Piece | null)[])[],
): MatchClearResult {
  requireMatchBoard(cells);
  const before = freezeCells(cells);
  const cleared = findMatches(before);
  if (cleared.length === 0) {
    return {
      before,
      cleared,
      cells: before,
      uniqueClearedCount: 0,
      foundMatch: false,
    };
  }
  const after = cells.map((row) => [...row]);
  for (const cell of cleared) {
    if (after[cell.row]![cell.column] === null) {
      throw new Error('match clear tried to clear an empty cell twice');
    }
    after[cell.row]![cell.column] = null;
  }
  const frozenAfter = freezeCells(after);
  return {
    before,
    cleared,
    cells: frozenAfter,
    uniqueClearedCount: cleared.length,
    foundMatch: true,
  };
}

export function applyShift(
  cells: readonly (readonly (Piece | null)[])[],
  blocked: readonly Coordinate[],
): ShiftResult {
  requireShiftBoard(cells, blocked);
  const size = cells.length;
  const before = freezeCells(cells);
  const obstacles = blockedKeys(blocked);
  const occupied = new Set<string>();
  const pieces: {
    row: number;
    column: number;
    piece: Piece;
    sourceIndex: number;
  }[] = [];

  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const piece = before[row]![column];
      if (piece == null) continue;
      occupied.add(blockedKey(row, column));
      pieces.push({
        row,
        column,
        piece: freezePiece(piece),
        sourceIndex: row * size + column,
      });
    }
  }

  const proposals = pieces.map((item) => {
    const [dr, dc] = directionDelta(item.piece.direction);
    const targetRow = item.row + dr;
    const targetColumn = item.column + dc;
    const ok =
      inBounds(size, targetRow, targetColumn) &&
      !obstacles.has(blockedKey(targetRow, targetColumn)) &&
      !occupied.has(blockedKey(targetRow, targetColumn));
    return { ...item, targetRow, targetColumn, ok };
  });

  const claims = new Map<string, number>();
  for (const proposal of proposals) {
    if (!proposal.ok) continue;
    const key = blockedKey(proposal.targetRow, proposal.targetColumn);
    claims.set(key, (claims.get(key) ?? 0) + 1);
  }

  const accepted = proposals.map((proposal) => ({
    ...proposal,
    ok:
      proposal.ok &&
      (claims.get(blockedKey(proposal.targetRow, proposal.targetColumn)) ?? 0) ===
        1,
  }));

  const after = before.map((row) => [...row]);
  for (const proposal of accepted) {
    if (proposal.ok) after[proposal.row]![proposal.column] = null;
  }
  const moved: MovedPiece[] = [];
  for (const proposal of accepted) {
    if (!proposal.ok) continue;
    if (after[proposal.targetRow]![proposal.targetColumn] !== null) {
      throw new Error('shift destination overwrite');
    }
    after[proposal.targetRow]![proposal.targetColumn] = proposal.piece;
    moved.push(
      Object.freeze({
        sourceIndex: proposal.sourceIndex,
        from: freezeCoord(proposal.row, proposal.column),
        to: freezeCoord(proposal.targetRow, proposal.targetColumn),
        shape: proposal.piece.shape,
        direction: proposal.piece.direction,
      }),
    );
  }
  moved.sort((a, b) => a.sourceIndex - b.sourceIndex);
  return {
    before,
    cells: freezeCells(after),
    moved: Object.freeze(moved),
  };
}

export function validationCodesOf(error: unknown): readonly ValidationCode[] | null {
  if (error instanceof ValidationFailure) return error.codes;
  return null;
}
