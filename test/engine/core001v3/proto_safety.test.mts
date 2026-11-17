import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ValidationFailure,
  parseGameState,
  parseMove,
  tryParseGameState,
} from '../../../src/engine/core001v3/index.mts';
function expectCodes(fn: () => void, required: string[]): void {
  try {
    fn();
    assert.fail(`expected ${required.join(', ')}`);
  } catch (error) {
    assert.ok(error instanceof ValidationFailure, String(error));
    for (const code of required) {
      assert.ok(
        error.wires.includes(code),
        `missing ${code} in ${error.wires.join(',')}`,
      );
    }
  }
}

const PLAYABLE_JSON = `{
  "rulesVersion":"core-001.v3",
  "boardSize":2,
  "moveLimit":5,
  "blocked":[],
  "cells":[[null,null],[null,null]],
  "offers":[
    {"kind":"piece","shape":"circle","direction":"right"},
    {"kind":"piece","shape":"diamond","direction":"down"},
    {"kind":"piece","shape":"triangle","direction":"left"}
  ],
  "futurePieces":[],
  "turnsUsed":0,
  "score":0,
  "status":"in_progress",
  "terminalReason":null
}`;

test('P1-01: JSON __proto__ own key on state is rejected', () => {
  const raw = JSON.parse(
    PLAYABLE_JSON.replace(
      '"terminalReason":null',
      '"terminalReason":null,"__proto__":{"injected":true}',
    ),
  );
  assert.equal(Object.hasOwn(raw, '__proto__'), true);
  expectCodes(() => parseGameState(raw), ['unexpected_property']);
});

test('P1-01: JSON __proto__ on move is rejected', () => {
  const raw = JSON.parse(
    '{"offerIndex":0,"tap":[0,0],"__proto__":{"injected":true}}',
  );
  assert.equal(Object.hasOwn(raw, '__proto__'), true);
  expectCodes(() => parseMove(raw), ['unexpected_property']);
});

test('P1-01: JSON __proto__ on piece and offer objects is rejected', () => {
  const piecePoison = JSON.parse(
    PLAYABLE_JSON.replace(
      '[[null,null],[null,null]]',
      '[[{"shape":"circle","direction":"right","__proto__":{"x":1}},null],[null,null]]',
    ),
  );
  assert.equal(Object.hasOwn(piecePoison.cells[0][0], '__proto__'), true);
  expectCodes(() => parseGameState(piecePoison), ['unexpected_property']);

  const offerPoison = JSON.parse(
    PLAYABLE_JSON.replace(
      '{"kind":"piece","shape":"circle","direction":"right"}',
      '{"kind":"piece","shape":"circle","direction":"right","__proto__":{"y":1}}',
    ),
  );
  assert.equal(Object.hasOwn(offerPoison.offers[0], '__proto__'), true);
  expectCodes(() => parseGameState(offerPoison), ['unexpected_property']);
});

test('P1-01: inherited prototype fields do not satisfy required own keys', () => {
  const proto = JSON.parse(PLAYABLE_JSON);
  const hollow = Object.create(proto);
  assert.equal(Object.getOwnPropertyNames(hollow).length, 0);
  expectCodes(() => parseGameState(hollow), ['missing_field']);
});

test('P1-01: unknown constructor key rejected on state and move', () => {
  const state = { ...JSON.parse(PLAYABLE_JSON), constructor: { name: 'Evil' } };
  expectCodes(() => parseGameState(state), ['unexpected_property']);
  expectCodes(
    () => parseMove({ offerIndex: 0, tap: [0, 0], constructor: {} }),
    ['unexpected_property'],
  );
});

test('P1-01: malformed inputs yield ValidationFailure, not crashes', () => {
  const samples: unknown[] = [
    null,
    undefined,
    42,
    'x',
    [],
    JSON.parse('{"__proto__":{"injected":true}}'),
    Object.create({
      shape: 'circle',
      direction: 'right',
    }),
  ];
  for (const sample of samples) {
    const result = tryParseGameState(sample);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.codes.length > 0);
  }
  for (const sample of samples) {
    try {
      parseMove(sample);
    } catch (error) {
      assert.ok(error instanceof ValidationFailure, String(error));
    }
  }
  // Piece-shaped inherited object used as move still fails closed.
  expectCodes(
    () => parseMove(Object.create({ offerIndex: 0, tap: [0, 0] })),
    ['missing_field'],
  );
});
