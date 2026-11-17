import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareReplayToClientReport,
  diagnoseClientReportFields,
  parseGameState,
  replayCore001V3,
  stateHashV3,
  stateToJson,
  structuralEqual,
} from '../../../src/engine/core001v3/index.mts';
import { v3Playable } from './fixtures.mts';

function fullReportFrom(state: ReturnType<typeof parseGameState>) {
  const json = stateToJson(state);
  return {
    score: state.score,
    board: json.cells,
    offers: json.offers,
    turnsUsed: state.turnsUsed,
    status: state.status,
    terminalReason: state.terminalReason,
    stateHash: stateHashV3(state),
  };
}

test('P1-02: empty client report fails full verification', () => {
  const replayed = parseGameState(v3Playable());
  const cmp = compareReplayToClientReport({ replayed, client: {} });
  assert.equal(cmp.ok, false);
  if (cmp.ok) return;
  assert.equal(cmp.mode, 'full');
  assert.ok(cmp.mismatches.includes('missing_report_field'));
  assert.ok((cmp.missingFields?.length ?? 0) >= 7);
});

test('P1-02: hash-only report fails full verification', () => {
  const replayed = parseGameState(v3Playable());
  const cmp = compareReplayToClientReport({
    replayed,
    client: { stateHash: stateHashV3(replayed) },
  });
  assert.equal(cmp.ok, false);
  if (cmp.ok) return;
  assert.ok(cmp.mismatches.includes('missing_report_field'));
});

test('P1-02: score-only report fails full verification', () => {
  const replayed = parseGameState(v3Playable());
  const cmp = compareReplayToClientReport({
    replayed,
    client: { score: 0 },
  });
  assert.equal(cmp.ok, false);
  if (cmp.ok) return;
  assert.ok(cmp.mismatches.includes('missing_report_field'));
});

test('P1-02: missing board / offers / terminal fields fail closed', () => {
  const replayed = parseGameState(v3Playable());
  const base = fullReportFrom(replayed);

  const noBoard = { ...base } as Record<string, unknown>;
  delete noBoard.board;
  let cmp = compareReplayToClientReport({ replayed, client: noBoard });
  assert.equal(cmp.ok, false);
  if (!cmp.ok) assert.ok(cmp.missingFields?.includes('board'));

  const noOffers = { ...base } as Record<string, unknown>;
  delete noOffers.offers;
  cmp = compareReplayToClientReport({ replayed, client: noOffers });
  assert.equal(cmp.ok, false);
  if (!cmp.ok) assert.ok(cmp.missingFields?.includes('offers'));

  const noStatus = { ...base } as Record<string, unknown>;
  delete noStatus.status;
  delete noStatus.terminalReason;
  cmp = compareReplayToClientReport({ replayed, client: noStatus });
  assert.equal(cmp.ok, false);
  if (!cmp.ok) {
    assert.ok(cmp.missingFields?.includes('status'));
    assert.ok(cmp.missingFields?.includes('terminalReason'));
  }
});

test('P1-02: malformed field structures fail closed', () => {
  const replayed = parseGameState(v3Playable());
  const base = fullReportFrom(replayed);
  const cmp = compareReplayToClientReport({
    replayed,
    client: { ...base, board: 'not-an-array', stateHash: 'zz' },
  });
  assert.equal(cmp.ok, false);
  if (cmp.ok) return;
  assert.ok(cmp.mismatches.includes('malformed_report_field'));
});

test('P1-02: fully matching report succeeds with mode full', () => {
  const result = replayCore001V3({
    initialState: v3Playable(),
    moves: [{ offerIndex: 0, tap: [0, 0] }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const cmp = compareReplayToClientReport({
    replayed: result.finalState,
    client: fullReportFrom(result.finalState),
  });
  assert.deepEqual(cmp, { ok: true, mode: 'full' });
});

test('P1-02: forged score with self-consistent hash fails full verification', () => {
  const honest = parseGameState(v3Playable());
  const forged = parseGameState({ ...v3Playable(), score: 999 });
  const report = {
    ...fullReportFrom(honest),
    score: 999,
    stateHash: stateHashV3(forged),
  };
  const cmp = compareReplayToClientReport({ replayed: honest, client: report });
  assert.equal(cmp.ok, false);
  if (cmp.ok) return;
  assert.ok(cmp.mismatches.includes('score_mismatch'));
  assert.ok(cmp.mismatches.includes('state_hash_mismatch'));
});

test('P1-02: board/offer key insertion order does not false-mismatch', () => {
  const replayed = parseGameState(v3Playable());
  const report = fullReportFrom(replayed);
  report.offers = [
    { direction: 'right', shape: 'circle', kind: 'piece' },
    { shape: 'diamond', kind: 'piece', direction: 'down' },
    { kind: 'piece', direction: 'left', shape: 'triangle' },
  ];
  const cmp = compareReplayToClientReport({ replayed, client: report });
  assert.deepEqual(cmp, { ok: true, mode: 'full' });
  assert.equal(
    structuralEqual(
      { kind: 'piece', shape: 'circle', direction: 'right' },
      { direction: 'right', kind: 'piece', shape: 'circle' },
    ),
    true,
  );
});

test('P1-02: partial diagnostic never claims ok:true full verification', () => {
  const replayed = parseGameState(v3Playable());
  const partial = diagnoseClientReportFields({
    replayed,
    client: { score: 0, stateHash: stateHashV3(replayed) },
  });
  assert.equal(partial.mode, 'partial');
  assert.ok(!('ok' in partial));
  assert.deepEqual([...partial.compared].sort(), ['score', 'stateHash']);
  assert.equal(partial.mismatches.length, 0);
});
