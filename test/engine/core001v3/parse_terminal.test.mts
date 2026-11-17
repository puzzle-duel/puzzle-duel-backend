import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ValidationFailure,
  deriveTerminalExpectation,
  hasLegalMove,
  hasLegalPlacement,
  parseGameState,
  parseInitialGameState,
} from '../../../src/engine/core001v3/index.mts';
import {
  offerPiece,
  pieceJson,
  v3BoardFullEnded,
  v3MoveLimitReached,
  v3Playable,
} from './fixtures.mts';

function expectCodes(fn: () => void, required: string[]): void {
  try {
    fn();
    assert.fail(`expected ${required.join(', ')}`);
  } catch (error) {
    assert.ok(error instanceof ValidationFailure);
    for (const code of required) {
      assert.ok(
        error.wires.includes(code),
        `missing ${code} in ${error.wires.join(',')}`,
      );
    }
  }
}

test('parses tagged piece and spent slots', () => {
  const state = parseGameState(v3BoardFullEnded());
  assert.equal(state.rulesVersion, 'core-001.v3');
  assert.equal(state.offers[0]!.kind, 'spent');
  assert.equal(state.offers[1]!.kind, 'piece');
  assert.equal(state.terminalReason, 'no_legal_moves');
  assert.equal(state.status, 'ended');
});

test('rejects bare null offer on v3', () => {
  const json = v3Playable();
  json.offers = [null, offerPiece(), offerPiece()];
  expectCodes(() => parseGameState(json), ['null_offer']);
});

test('rejects unknown offer kind', () => {
  const json = v3Playable();
  json.offers = [{ kind: 'bonus' }, offerPiece(), offerPiece()];
  expectCodes(() => parseGameState(json), ['malformed_offer_slot']);
});

test('rejects spent with remaining future pieces', () => {
  const json = v3BoardFullEnded();
  json.futurePieces = [pieceJson()];
  expectCodes(() => parseGameState(json), ['spent_with_future_pieces']);
});

test('rejects playable board falsely marked ended', () => {
  const json = v3Playable();
  json.status = 'ended';
  json.terminalReason = 'no_legal_moves';
  expectCodes(() => parseGameState(json), [
    'inconsistent_status',
    'inconsistent_terminal_reason',
  ]);
});

test('rejects unplayable board falsely marked active', () => {
  const json = v3BoardFullEnded();
  json.status = 'in_progress';
  json.terminalReason = null;
  expectCodes(() => parseGameState(json), [
    'inconsistent_status',
    'inconsistent_terminal_reason',
  ]);
});

test('rejects forged terminal reason on move limit', () => {
  const json = v3MoveLimitReached();
  json.terminalReason = 'no_legal_moves';
  expectCodes(() => parseGameState(json), ['inconsistent_terminal_reason']);
});

test('move-limit precedence over no legal placement', () => {
  const expected = deriveTerminalExpectation({
    turnsUsed: 1,
    moveLimit: 1,
    candidate: parseGameState(v3BoardFullEnded()),
  });
  assert.equal(expected.status, 'ended');
  assert.equal(expected.reason, 'move_limit_reached');
});

test('hasLegalPlacement is status-agnostic; hasLegalMove is not', () => {
  const playable = parseGameState(v3Playable());
  assert.equal(hasLegalPlacement(playable), true);
  assert.equal(hasLegalMove(playable), true);

  const budgetEnded = parseGameState(v3MoveLimitReached());
  assert.equal(hasLegalPlacement(budgetEnded), true);
  assert.equal(hasLegalMove(budgetEnded), false);

  const full = parseGameState(v3BoardFullEnded());
  assert.equal(hasLegalPlacement(full), false);
  assert.equal(hasLegalMove(full), false);
});

test('initial challenge requires live offers and playability', () => {
  const ok = parseInitialGameState(v3Playable());
  assert.equal(ok.terminalReason, null);
  assert.ok(ok.offers.every((s) => s.kind === 'piece'));

  const spent = v3Playable();
  spent.offers = [{ kind: 'spent' }, offerPiece(), offerPiece()];
  expectCodes(() => parseInitialGameState(spent), ['inconsistent_status']);
});

test('rejects unknown rules version', () => {
  const json = v3Playable();
  json.rulesVersion = 'core-001.v2';
  expectCodes(() => parseGameState(json), ['unknown_rules_version']);
});

test('rejects unknown property and missing terminalReason', () => {
  const extra = v3Playable();
  extra.extra = true;
  expectCodes(() => parseGameState(extra), ['unexpected_property']);
  const missing = v3Playable();
  delete missing.terminalReason;
  expectCodes(() => parseGameState(missing), ['missing_field']);
});

test('rejects spent with extra properties', () => {
  const json = v3Playable();
  json.futurePieces = [];
  json.offers = [
    { kind: 'spent', note: 'x' },
    offerPiece('diamond', 'down'),
    offerPiece('triangle', 'left'),
  ];
  json.turnsUsed = 1;
  expectCodes(() => parseGameState(json), ['unexpected_property']);
});

test('rejects integer outside JSON-safe range', () => {
  const json = v3Playable();
  json.score = 9007199254740992;
  expectCodes(() => parseGameState(json), ['integer_out_of_range']);
});

test('rejects float score', () => {
  const json = v3Playable();
  json.score = 1.5;
  expectCodes(() => parseGameState(json), ['malformed_score']);
});
