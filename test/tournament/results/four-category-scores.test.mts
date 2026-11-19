import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFourCategoryScores } from '../../../src/tournament/results/four-category-scores.mts';

const baseline = [
  { ordinal: 1, score: 100 },
  { ordinal: 2, score: 200 },
  { ordinal: 3, score: 300 },
  { ordinal: 4, score: 400 },
  { ordinal: 5, score: 500 },
  { ordinal: 6, score: 600 },
] as const;

describe('PZD-41 F2 pure category calculation — no publication authority', () => {
  it('sums 3 Easy, 2 Medium, 1 Hard; All is exact sum', () => {
    assert.deepEqual(computeFourCategoryScores(baseline), {
      easy: 600, medium: 900, hard: 600, all: 2100,
    });
  });
  it('is deterministic regardless of input order', () => {
    assert.deepEqual(computeFourCategoryScores([...baseline].reverse()), computeFourCategoryScores(baseline));
  });
  it('rejects missing or partial series; never publishes partial', () => {
    assert.throws(() => computeFourCategoryScores(baseline.slice(0, 5)), /REQUIRES_SIX_COMPLETED_GAMES/);
    assert.throws(() => computeFourCategoryScores([]), /REQUIRES_SIX_COMPLETED_GAMES/);
  });
  it('rejects duplicate ordinals and missing ordinal even when length is six', () => {
    assert.throws(() => computeFourCategoryScores([...baseline.slice(0, 5), baseline[0]]), /DUPLICATE_SUBGAME_ORDINAL/);
  });
  it('rejects unknown ordinal', () => {
    assert.throws(() => computeFourCategoryScores([...baseline.slice(0, 5), { ordinal: 7, score: 1 }]), /INVALID_SUBGAME_ORDINAL/);
  });
  it('rejects negative, fractional, non-finite and unsafe score', () => {
    for (const score of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => computeFourCategoryScores([{ordinal: 1, score}, ...baseline.slice(1)]), /INVALID_VERIFIED_SCORE/);
    }
  });
  it('rejects category and total integer overflow', () => {
    assert.throws(() => computeFourCategoryScores([
      { ordinal: 1, score: Number.MAX_SAFE_INTEGER },
      ...baseline.slice(1),
    ]), /TOTAL_SCORE_OVERFLOW/);
    assert.throws(() => computeFourCategoryScores([
      { ordinal: 1, score: Number.MAX_SAFE_INTEGER-200 },
      { ordinal: 2, score: 100 },
      { ordinal: 3, score: 100 },
      { ordinal: 4, score: 200 },
      { ordinal: 5, score: 0 },
      { ordinal: 6, score: 0 },
    ]), /TOTAL_SCORE_OVERFLOW/);
  });
  it('accepts six valid zero scores but produces no entitlement or ranking side effect', () => {
    assert.deepEqual(computeFourCategoryScores(baseline.map(x=>({ordinal:x.ordinal,score:0}))), {easy:0,medium:0,hard:0,all:0});
  });
  it('does not modify caller input', () => {
    const copy = baseline.map(x=>({...x}));
    computeFourCategoryScores(copy);
    assert.deepEqual(copy, baseline);
  });
});
