/**
 * The active UAT manifest is six distinct gen-001.v1 boards projected into
 * core-001.v3. The generator itself is not modified.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { applyMove, parseInitialGameState, stateToJson, type GameState } from '../../../src/engine/core001v3/index.mts';
import { generateChallenge } from '../../../src/generator.mts';
import { loadUatManifest, UAT_ACTIVE_CONTENT_VERSION } from '../../../src/tournament/uat/uat-manifest.mts';

const directory = join(import.meta.dirname, '../../../docs/tournament/uat-challenges/v4');

const slots = [
  { file: 'E1.json', label: 'E1', profile: 'easy', seed: 0, boardSize: 5, moveLimit: 15, obstacles: 1 },
  { file: 'E2.json', label: 'E2', profile: 'easy', seed: 1, boardSize: 5, moveLimit: 15, obstacles: 1 },
  { file: 'E3.json', label: 'E3', profile: 'easy', seed: 2, boardSize: 5, moveLimit: 15, obstacles: 1 },
  { file: 'M1.json', label: 'M1', profile: 'medium', seed: 0, boardSize: 6, moveLimit: 12, obstacles: 2 },
  { file: 'M2.json', label: 'M2', profile: 'medium', seed: 1, boardSize: 6, moveLimit: 12, obstacles: 2 },
  { file: 'H1.json', label: 'H1', profile: 'hard', seed: 5, boardSize: 7, moveLimit: 10, obstacles: 4 },
] as const;

function project(challenge: {
  config: { boardSize: number; moveLimit: number };
  blocked: readonly (readonly [number, number])[];
  cells: readonly (readonly ({ shape: string; direction: string } | null)[])[];
  offers: readonly { shape: string; direction: string }[];
  futurePieces: readonly { shape: string; direction: string }[];
}) {
  return {
    rulesVersion: 'core-001.v3',
    boardSize: challenge.config.boardSize,
    moveLimit: challenge.config.moveLimit,
    blocked: challenge.blocked,
    cells: challenge.cells,
    offers: challenge.offers.map((piece) => ({ kind: 'piece', shape: piece.shape, direction: piece.direction })),
    futurePieces: challenge.futurePieces,
    turnsUsed: 0,
    score: 0,
    status: 'in_progress',
    terminalReason: null,
  };
}

test('V4 UAT boards are distinct generator output and can be finished', () => {
  const layouts = new Set<string>();
  for (const slot of slots) {
    const file = JSON.parse(readFileSync(join(directory, slot.file), 'utf8')) as {
      profile: string;
      seed: number;
      generatorVersion: string;
      initialState: unknown;
    };
    assert.equal(file.profile, slot.profile);
    assert.equal(file.seed, slot.seed);
    assert.equal(file.generatorVersion, 'gen-001.v1');
    const generated = generateChallenge(slot.profile, slot.seed);
    assert.equal(generated.ok, true, slot.label);
    if (!generated.ok) continue;
    const initial = parseInitialGameState(project(generated.challenge));
    assert.deepStrictEqual(stateToJson(initial), file.initialState);
    assert.equal(initial.boardSize, slot.boardSize);
    assert.equal(initial.moveLimit, slot.moveLimit);
    assert.equal(initial.blocked.length, slot.obstacles);
    assert.equal(initial.futurePieces.length, slot.moveLimit - 1);
    assert.equal(initial.offers.every((offer) => offer.kind === 'piece'), true);
    const layout = JSON.stringify(stateToJson(initial).cells);
    assert.equal(layouts.has(layout), false, `${slot.label} repeats another board`);
    layouts.add(layout);

    const deltas = new Set<number>();
    let legal = 0;
    for (const offerIndex of [0, 1, 2] as const) {
      for (let row = 0; row < initial.boardSize; row += 1) {
        for (let column = 0; column < initial.boardSize; column += 1) {
          const result = applyMove(initial, { offerIndex, tap: { row, column } });
          if (result.kind === 'applied') {
            legal += 1;
            deltas.add(result.scoreDelta);
          }
        }
      }
    }
    assert.ok(legal > 1, `${slot.label} has only ${legal} opening placements`);
    assert.ok(deltas.size >= 2, `${slot.label} opening scores ${[...deltas].join(',')}`);

    let occupied: { row: number; column: number } | null = null;
    for (let row = 0; row < initial.boardSize && occupied === null; row += 1) {
      for (let column = 0; column < initial.boardSize; column += 1) {
        if (initial.cells[row]?.[column] !== null) {
          occupied = { row, column };
          break;
        }
      }
    }
    assert.ok(occupied, slot.label);
    const rejected = applyMove(initial, { offerIndex: 0, tap: occupied });
    assert.equal(rejected.kind, 'rejected');
    assert.equal(rejected.state.score, 0);

    let cursor: GameState = initial;
    let steps = 0;
    while (cursor.status === 'in_progress' && steps < slot.moveLimit) {
      let advanced = false;
      for (const offerIndex of [0, 1, 2] as const) {
        for (let row = 0; row < cursor.boardSize && !advanced; row += 1) {
          for (let column = 0; column < cursor.boardSize; column += 1) {
            const result = applyMove(cursor, { offerIndex, tap: { row, column } });
            if (result.kind === 'applied') {
              cursor = result.finalState;
              advanced = true;
              break;
            }
          }
        }
        if (advanced) break;
      }
      assert.equal(advanced, true, `${slot.label} stuck after ${steps}`);
      steps += 1;
    }
    assert.equal(cursor.status, 'ended', slot.label);
    assert.equal(cursor.terminalReason, 'move_limit_reached', slot.label);
    assert.equal(cursor.turnsUsed, slot.moveLimit);
  }

  const active = loadUatManifest().requireActive();
  assert.equal(active.contentVersion, UAT_ACTIVE_CONTENT_VERSION);
  assert.deepStrictEqual(
    active.subgames.map((game) => (game.initialState as { boardSize: number }).boardSize),
    [5, 5, 5, 6, 6, 7],
  );
  assert.deepStrictEqual(
    active.subgames.map((game) => (game.initialState as { moveLimit: number }).moveLimit),
    [15, 15, 15, 12, 12, 10],
  );
});
