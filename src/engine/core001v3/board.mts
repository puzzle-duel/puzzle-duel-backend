import type { Coordinate, Piece } from './types.mts';

export function blockedKey(row: number, column: number): string {
  return `${row},${column}`;
}

export function blockedKeys(blocked: readonly Coordinate[]): ReadonlySet<string> {
  return new Set(blocked.map((c) => blockedKey(c.row, c.column)));
}

export function inBounds(boardSize: number, row: number, column: number): boolean {
  return row >= 0 && column >= 0 && row < boardSize && column < boardSize;
}

export function hasOrthogonalRun(
  cells: readonly (readonly (Piece | null)[])[],
): boolean {
  const size = cells.length;
  for (const row of cells) {
    if (row.length !== size) return false;
  }
  for (let row = 0; row < size; row++) {
    let column = 0;
    while (column < size) {
      const piece = cells[row]![column];
      if (piece === null || piece === undefined) {
        column += 1;
        continue;
      }
      let end = column + 1;
      while (end < size) {
        const next = cells[row]![end];
        if (next === null || next === undefined || next.shape !== piece.shape) break;
        end += 1;
      }
      if (end - column >= 3) return true;
      column = end;
    }
  }
  for (let column = 0; column < size; column++) {
    let row = 0;
    while (row < size) {
      const piece = cells[row]![column];
      if (piece === null || piece === undefined) {
        row += 1;
        continue;
      }
      let end = row + 1;
      while (end < size) {
        const next = cells[end]![column];
        if (next === null || next === undefined || next.shape !== piece.shape) break;
        end += 1;
      }
      if (end - row >= 3) return true;
      row = end;
    }
  }
  return false;
}

export function emptyPlayableCount(
  cells: readonly (readonly (Piece | null)[])[],
  blocked: readonly Coordinate[],
): number {
  const obstacles = blockedKeys(blocked);
  let count = 0;
  for (let row = 0; row < cells.length; row++) {
    for (let column = 0; column < cells[row]!.length; column++) {
      if (cells[row]![column] === null && !obstacles.has(blockedKey(row, column))) {
        count += 1;
      }
    }
  }
  return count;
}

export function occupiedCount(
  cells: readonly (readonly (Piece | null)[])[],
): number {
  let count = 0;
  for (const row of cells) {
    for (const cell of row) {
      if (cell !== null) count += 1;
    }
  }
  return count;
}

export function copyCells(
  cells: readonly (readonly (Piece | null)[])[],
): (Piece | null)[][] {
  return cells.map((row) => row.map((cell) => (cell === null ? null : { ...cell })));
}

export function directionDelta(direction: Piece['direction']): readonly [number, number] {
  switch (direction) {
    case 'up':
      return [-1, 0];
    case 'down':
      return [1, 0];
    case 'left':
      return [0, -1];
    case 'right':
      return [0, 1];
  }
}
