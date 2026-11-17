import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPLAY_HARD_MOVE_CEILING,
  applyMove,
  compareReplayToClientReport,
  parseGameState,
  parseMove,
  replayCore001V3,
  stateHashV3,
  stateToJson,
} from '../../../src/engine/core001v3/index.mts';
import { v3MatchReady, v3Playable } from './fixtures.mts';

test('replay succeeds from trusted initial + legal moves', () => {
  const result = replayCore001V3({
    initialState: v3Playable(),
    moves: [{ offerIndex: 0, tap: [0, 0] }],
    rulesVersion: 'core-001.v3',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.finalState.turnsUsed, 1);
  assert.equal(result.stateHash, stateHashV3(result.finalState));
});

test('wrong rules version pin rejected', () => {
  const result = replayCore001V3({
    initialState: v3Playable(),
    moves: [],
    rulesVersion: 'core-001.v2',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'rules_version_mismatch');
});

test('post-terminal extra move rejected', () => {
  const first = replayCore001V3({
    initialState: {
      ...v3Playable(),
      boardSize: 1,
      cells: [[null]],
      futurePieces: [],
      moveLimit: 1,
    },
    moves: [{ offerIndex: 0, tap: [0, 0] }],
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.finalState.status, 'ended');

  const second = replayCore001V3({
    initialState: {
      ...v3Playable(),
      boardSize: 1,
      cells: [[null]],
      futurePieces: [],
      moveLimit: 1,
    },
    moves: [
      { offerIndex: 0, tap: [0, 0] },
      { offerIndex: 1, tap: [0, 0] },
    ],
  });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, 'post_terminal_move');
});

test('invalid offer index fails closed', () => {
  const result = replayCore001V3({
    initialState: v3Playable(),
    moves: [{ offerIndex: 9, tap: [0, 0] }],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'invalid_move');
});

test('forged score with self-consistent hash is not ranked proof', () => {
  const honest = parseGameState(v3Playable());
  const forgedJson = { ...v3Playable(), score: 999 };
  const forged = parseGameState(forgedJson);
  const forgedHash = stateHashV3(forged);
  assert.equal(forgedHash.length, 64);
  assert.notEqual(stateHashV3(honest), forgedHash);

  const replayed = replayCore001V3({
    initialState: v3Playable(),
    moves: [],
  });
  assert.equal(replayed.ok, true);
  if (!replayed.ok) return;
  const cmp = compareReplayToClientReport({
    replayed: replayed.finalState,
    client: { score: 999, stateHash: forgedHash },
  });
  assert.equal(cmp.ok, false);
  if (cmp.ok) return;
  assert.ok(cmp.mismatches.includes('score_mismatch'));
  assert.ok(cmp.mismatches.includes('state_hash_mismatch'));
});

test('forged board rejected by replay comparison', () => {
  const replayed = replayCore001V3({
    initialState: v3Playable(),
    moves: [{ offerIndex: 0, tap: [0, 0] }],
  });
  assert.equal(replayed.ok, true);
  if (!replayed.ok) return;
  const cmp = compareReplayToClientReport({
    replayed: replayed.finalState,
    client: {
      board: [
        [null, null],
        [null, null],
      ],
    },
  });
  assert.equal(cmp.ok, false);
  if (cmp.ok) return;
  assert.ok(cmp.mismatches.includes('board_mismatch'));
});

test('reordered moves diverge from claimed score path', () => {
  const a = replayCore001V3({
    initialState: v3Playable(),
    moves: [
      { offerIndex: 0, tap: [0, 0] },
      { offerIndex: 1, tap: [1, 0] },
    ],
  });
  const b = replayCore001V3({
    initialState: v3Playable(),
    moves: [
      { offerIndex: 1, tap: [1, 0] },
      { offerIndex: 0, tap: [0, 0] },
    ],
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  // Different offer consumption order → different trays / boards.
  assert.notEqual(
    JSON.stringify(stateToJson(a.finalState)),
    JSON.stringify(stateToJson(b.finalState)),
  );
});

test('structurally pretty spent does not prove provenance without replay', () => {
  // Snapshot may parse; legitimacy of spent history requires trusted ledger.
  const snapshot = parseGameState({
    ...v3Playable(),
    futurePieces: [],
    offers: [
      { kind: 'spent' },
      { kind: 'piece', shape: 'diamond', direction: 'down' },
      { kind: 'piece', shape: 'triangle', direction: 'left' },
    ],
    turnsUsed: 1,
  });
  assert.equal(snapshot.offers[0]!.kind, 'spent');
  // Replay from honest initial with no moves never produces that spent tray.
  const replayed = replayCore001V3({
    initialState: v3Playable(),
    moves: [],
  });
  assert.equal(replayed.ok, true);
  if (!replayed.ok) return;
  assert.notEqual(
    JSON.stringify(stateToJson(replayed.finalState).offers),
    JSON.stringify(stateToJson(snapshot).offers),
  );
});

test('hand-checkable cascade score via replay', () => {
  const result = replayCore001V3({
    initialState: v3MatchReady(),
    moves: [{ offerIndex: 0, tap: [0, 2] }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.finalState.score, 300);
  assert.equal(result.applied[0]!.scoreDelta, 300);
});

test('excessively large move ledger rejected', () => {
  const moves = Array.from({ length: REPLAY_HARD_MOVE_CEILING + 1 }, () => ({
    offerIndex: 0,
    tap: [0, 0],
  }));
  const result = replayCore001V3({
    initialState: v3Playable(),
    moves,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'replay_move_limit_exceeded');
});

test('applyMove does not mutate caller state object graph identity fields', () => {
  const state = parseGameState(v3Playable());
  const before = JSON.stringify(stateToJson(state));
  applyMove(state, parseMove({ offerIndex: 0, tap: [0, 0] }));
  assert.equal(JSON.stringify(stateToJson(state)), before);
});
