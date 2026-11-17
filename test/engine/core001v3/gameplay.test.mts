import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JSON_MAX_SAFE_INTEGER,
  applyMove,
  hasLegalPlacement,
  parseGameState,
  parseMove,
  stateToJson,
} from '../../../src/engine/core001v3/index.mts';
import {
  pieceJson,
  v3AlmostFull,
  v3AllSpentEmptyBoard,
  v3BoardFullEnded,
  v3CascadeReopen,
  v3EmptyStreamPlayable,
  v3LastFuture,
  v3LastMovePlayable,
  v3MatchReady,
  v3OneSpentPlayable,
  v3Playable,
} from './fixtures.mts';

test('offer replacement from future stream', () => {
  const state = parseGameState(v3Playable());
  const result = applyMove(state, parseMove({ offerIndex: 0, tap: [0, 0] }));
  assert.equal(result.kind, 'applied');
  if (result.kind !== 'applied') return;
  assert.equal(result.finalState.offers[0]!.kind, 'piece');
  if (result.finalState.offers[0]!.kind === 'piece') {
    assert.deepEqual(result.finalState.offers[0], {
      kind: 'piece',
      shape: state.futurePieces[0]!.shape,
      direction: state.futurePieces[0]!.direction,
    });
  }
  assert.equal(result.finalState.offers[1]!.kind, state.offers[1]!.kind);
  assert.equal(
    result.finalState.futurePieces.length,
    state.futurePieces.length - 1,
  );
  assert.equal(result.finalState.status, 'in_progress');
  assert.equal(result.finalState.terminalReason, null);
});

test('stream exhaustion writes spent and may continue', () => {
  const withOne = parseGameState(v3LastFuture());
  const drained = applyMove(
    withOne,
    parseMove({ offerIndex: 1, tap: [0, 1] }),
  );
  assert.equal(drained.kind, 'applied');
  if (drained.kind !== 'applied') return;
  assert.equal(drained.finalState.futurePieces.length, 0);
  assert.equal(drained.finalState.offers[1]!.kind, 'piece');
  assert.equal(drained.finalState.status, 'in_progress');

  const emptyStream = parseGameState(v3EmptyStreamPlayable());
  const spent = applyMove(
    emptyStream,
    parseMove({ offerIndex: 1, tap: [0, 1] }),
  );
  assert.equal(spent.kind, 'applied');
  if (spent.kind !== 'applied') return;
  assert.equal(spent.finalState.offers[1]!.kind, 'spent');
  assert.equal(spent.finalState.offers[0]!.kind, 'piece');
  assert.equal(spent.finalState.status, 'in_progress');
});

test('selecting spent offer is unsafe and preserves state', () => {
  const state = parseGameState(v3OneSpentPlayable());
  const before = JSON.stringify(stateToJson(state));
  const result = applyMove(state, parseMove({ offerIndex: 0, tap: [0, 0] }));
  assert.equal(result.kind, 'unsafe');
  if (result.kind !== 'unsafe') return;
  assert.equal(result.reason, 'offer_unavailable');
  assert.equal(JSON.stringify(stateToJson(result.state)), before);
});

test('board-full natural terminal with spent offers', () => {
  const state = parseGameState(v3AlmostFull());
  const result = applyMove(state, parseMove({ offerIndex: 0, tap: [0, 0] }));
  assert.equal(result.kind, 'applied');
  if (result.kind !== 'applied') return;
  assert.equal(result.finalState.status, 'ended');
  assert.equal(result.finalState.terminalReason, 'no_legal_moves');
  assert.equal(result.finalState.offers[0]!.kind, 'spent');
});

test('v3 early board-full empty stream succeeds as natural terminal', () => {
  const state = parseGameState(v3AlmostFull());
  const result = applyMove(state, parseMove({ offerIndex: 0, tap: [0, 0] }));
  assert.equal(result.kind, 'applied');
  if (result.kind !== 'applied') return;
  assert.equal(result.finalState.terminalReason, 'no_legal_moves');
});

test('move limit reached sets terminal reason', () => {
  const state = parseGameState(v3LastMovePlayable());
  const result = applyMove(state, parseMove({ offerIndex: 0, tap: [0, 0] }));
  assert.equal(result.kind, 'applied');
  if (result.kind !== 'applied') return;
  assert.equal(result.finalState.turnsUsed, 1);
  assert.equal(result.finalState.status, 'ended');
  assert.equal(result.finalState.terminalReason, 'move_limit_reached');
});

test('cascade scoring uses wave multiplier (hand-checkable 3*100*1=300)', () => {
  const state = parseGameState(v3MatchReady());
  const result = applyMove(state, parseMove({ offerIndex: 0, tap: [0, 2] }));
  assert.equal(result.kind, 'applied');
  if (result.kind !== 'applied') return;
  assert.equal(result.scoreDelta, 300);
  assert.equal(result.waves.length, 1);
  assert.equal(result.finalState.score, 300);
});

test('cascade clear reopens playable space before terminal', () => {
  const state = parseGameState(v3CascadeReopen());
  const result = applyMove(state, parseMove({ offerIndex: 0, tap: [0, 2] }));
  assert.equal(result.kind, 'applied');
  if (result.kind !== 'applied') return;
  assert.equal(result.scoreDelta, 300);
  assert.equal(result.finalState.status, 'in_progress');
  assert.equal(result.finalState.terminalReason, null);
  assert.equal(hasLegalPlacement(result.finalState), true);
});

test('all spent offers with empty cells ends no_legal_moves', () => {
  const state = parseGameState(v3AllSpentEmptyBoard());
  assert.equal(state.status, 'ended');
  assert.equal(state.terminalReason, 'no_legal_moves');
  assert.equal(hasLegalPlacement(state), false);
});

test('post-terminal in-bounds tap returns game_ended', () => {
  const state = parseGameState(v3BoardFullEnded());
  const before = JSON.stringify(stateToJson(state));
  const result = applyMove(state, parseMove({ offerIndex: 1, tap: [0, 0] }));
  assert.equal(result.kind, 'rejected');
  if (result.kind !== 'rejected') return;
  assert.equal(result.code, 'game_ended');
  assert.equal(JSON.stringify(stateToJson(result.state)), before);
});

test('occupied tap rejects without mutation', () => {
  const json = v3Playable();
  json.cells = [[pieceJson(), null], [null, null]];
  const occupied = parseGameState(json);
  const before = JSON.stringify(stateToJson(occupied));
  const result = applyMove(
    occupied,
    parseMove({ offerIndex: 0, tap: [0, 0] }),
  );
  assert.equal(result.kind, 'rejected');
  if (result.kind !== 'rejected') return;
  assert.equal(result.code, 'occupied_tap');
  assert.equal(JSON.stringify(stateToJson(result.state)), before);
});

test('score overflow fails closed and preserves original state', () => {
  const json = v3MatchReady();
  json.score = JSON_MAX_SAFE_INTEGER - 100;
  const state = parseGameState(json);
  const before = JSON.stringify(stateToJson(state));
  const result = applyMove(state, parseMove({ offerIndex: 0, tap: [0, 2] }));
  assert.equal(result.kind, 'unsafe');
  if (result.kind !== 'unsafe') return;
  assert.equal(result.reason, 'score_overflow');
  assert.equal(JSON.stringify(stateToJson(result.state)), before);
});

test('directional landing prefers free forward cell', () => {
  const state = parseGameState(v3Playable());
  // circle-right at [0,0] lands on [0,1]
  const result = applyMove(state, parseMove({ offerIndex: 0, tap: [0, 0] }));
  assert.equal(result.kind, 'applied');
  if (result.kind !== 'applied') return;
  assert.deepEqual(result.landing, { row: 0, column: 1 });
  assert.ok(result.finalState.cells[0]![1] !== null);
});
