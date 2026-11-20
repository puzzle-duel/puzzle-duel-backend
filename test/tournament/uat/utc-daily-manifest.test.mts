import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateUtcDailyManifest } from '../../../src/tournament/uat/utc-daily-manifest.mts';
import { parseInitialGameState } from '../../../src/engine/core001v3/index.mts';

test('PZD-48: same UTC day yields identical six-game manifests for all players', () => {
  const a = generateUtcDailyManifest('2026-11-20');
  const b = generateUtcDailyManifest('2026-11-20');
  assert.deepEqual(a, b);
  assert.equal(a.subgames.length, 6);
  assert.deepEqual(a.subgames.map(s => s.ordinal), [1,2,3,4,5,6]);
  assert.deepEqual(a.subgames.map(s => (s.initialState as {boardSize:number}).boardSize),
    [5,5,5,6,6,7]);
  for (const game of a.subgames) {
    assert.equal(game.generatorVersion, 'gen-001.v1');
    assert.equal((game.initialState as {rulesVersion:string}).rulesVersion, 'core-001.v3');
    assert.ok(parseInitialGameState(game.initialState));
  }
});

test('PZD-48: UTC next day replaces every slot; stable across repeated requests', () => {
  const today = generateUtcDailyManifest('2026-11-20');
  const tomorrow = generateUtcDailyManifest('2026-11-21');
  assert.notEqual(today.digest, tomorrow.digest);
  for (let i=0; i<6; i++) {
    assert.notDeepEqual(today.subgames[i]!.initialState, tomorrow.subgames[i]!.initialState);
  }
  assert.deepEqual(generateUtcDailyManifest('2026-11-21'), tomorrow);
});

test('PZD-48: reject malformed calendar dates, not local timezone interpretations', () => {
  for (const day of ['2026-02-30','2026-11-20T00:00','2026-1-02','2026-13-01']) {
    assert.throws(() => generateUtcDailyManifest(day), /DAILY_MANIFEST_INVALID_DATE/);
  }
});
