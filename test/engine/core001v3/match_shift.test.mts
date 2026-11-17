import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyShift,
  clearMatches,
  findMatches,
} from '../../../src/engine/core001v3/index.mts';
import type { Piece } from '../../../src/engine/core001v3/index.mts';

const C = (shape: Piece['shape'], direction: Piece['direction'] = 'up'): Piece =>
  Object.freeze({ shape, direction });

test('findMatches unions overlapping runs row-major', () => {
  const cells = [
    [C('circle'), C('circle'), C('circle')],
    [null, null, null],
    [null, null, null],
  ];
  const matches = findMatches(cells);
  assert.deepEqual(
    matches.map((m) => [m.row, m.column]),
    [
      [0, 0],
      [0, 1],
      [0, 2],
    ],
  );
});

test('clearMatches clears unique cells without shifting', () => {
  const cells = [
    [C('circle'), C('circle'), C('circle')],
    [C('triangle', 'down'), null, null],
    [null, null, null],
  ];
  const result = clearMatches(cells);
  assert.equal(result.uniqueClearedCount, 3);
  assert.equal(result.cells[0]![0], null);
  assert.equal(result.cells[1]![0]?.shape, 'triangle');
});

test('contested shift: two claimants neither move', () => {
  const cells = [
    [null, null, null, null, null],
    [null, null, null, null, null],
    [null, C('circle', 'right'), null, C('diamond', 'left'), null],
    [null, null, null, null, null],
    [null, null, null, null, null],
  ];
  const shift = applyShift(cells, []);
  assert.equal(shift.moved.length, 0);
  assert.equal(shift.cells[2]![1]?.shape, 'circle');
  assert.equal(shift.cells[2]![3]?.shape, 'diamond');
});

test('blocked destination prevents shift', () => {
  const cells = [
    [null, null, null],
    [C('circle', 'right'), null, null],
    [null, null, null],
  ];
  const shift = applyShift(cells, [{ row: 1, column: 1 }]);
  assert.equal(shift.moved.length, 0);
});
