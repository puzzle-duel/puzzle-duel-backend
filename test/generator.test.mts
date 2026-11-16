import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pcg32, generateChallenge } from '../src/generator.mts';

const fixtureDir = process.env.PZD_GENERATOR_FIXTURES;
const expectedVectors = [
  [0, [903765998,2422751314,1652705799,1618866650,1060317981,2689674566,1577384509,1403947984,255367340,3521512243]],
  [1, [4022946169,586434100,778513971,4210363984,465824167,3279466709,2798243867,2464351017,356655726,566711777]],
  [4294967295, [451480749,2087654271,3085751845,2110723429,2880235874,856832213,2237111505,552382290,1572602624,2704297521]],
] as const;
for (const [seed, expected] of expectedVectors) {
  test(`GEN-01 PCG32 seed ${seed}`, () => {
    const rng = new Pcg32(); rng.seed32(seed);
    assert.deepStrictEqual(Array.from({length: 10}, () => rng.nextU32()), [...expected]);
  });
}
for (const [n, expected] of [[1,0],[2,0],[3,2],[4,2],[5,3],[24,14],[25,23],[32,14],[4294967296,903765998]]) {
  test(`GEN-01 randBound n=${n}`, () => {
    const rng = new Pcg32(); rng.seed32(0);
    assert.equal(rng.randBound(n!), expected);
  });
}
test('n=4 does not loop and consumes exactly one value', () => {
  const rng = new Pcg32(); rng.seed32(0);
  assert.equal(rng.randBound(4),2);
  assert.equal(rng.nextU32(),2422751314);
});
test('GEN-05 continued RNG after retry and exhaustion', () => {
  assert.deepStrictEqual(generateChallenge('medium', 123456789, {maxAttemptsOverride:1}), {ok:false,code:'generation_exhausted'});
  assert.equal(generateChallenge('medium',123456789).ok,true);
});
test('GEN-05 invalid input rejects without generation', () => {
  for (const [profile,seed,options] of [
    ['easy',-1,{}],['easy',4294967296,{}],['monster',0,{}],
    ['easy',0,{rulesVersion:'core-001.v1'}],['easy',0,{generatorVersion:'gen-999.v1'}],
    ['easy',0,{config:{boardSize:5,moveLimit:15,obstacleCount:99,occupiedCount:6}}],
  ] as const) assert.deepStrictEqual(generateChallenge(profile,seed,options), {ok:false,code:'invalid_config'});
});
test('GEN-07 all 15 Python/Dart golden fixtures exact JSON structural parity', () => {
  assert.ok(fixtureDir, 'PZD_GENERATOR_FIXTURES must be configured; never silently skip parity');
  const files = readdirSync(fixtureDir).filter(f => f.endsWith('.json')).sort();
  assert.equal(files.length,15,'all 15 accepted fixtures required');
  for (const file of files) {
    const expected = JSON.parse(readFileSync(join(fixtureDir,file),'utf8'));
    const actual = generateChallenge(expected.profile,expected.seed);
    assert.equal(actual.ok,true,file);
    if (actual.ok) assert.deepStrictEqual(actual.challenge,expected,file);
  }
});
test('output is deeply immutable and reproducible', () => {
  const a=generateChallenge('hard',42),b=generateChallenge('hard',42);
  assert.equal(a.ok,true); assert.equal(b.ok,true);
  if (a.ok && b.ok) {
    assert.deepStrictEqual(a.challenge,b.challenge);
    assert.ok(Object.isFrozen(a.challenge.cells[0]));
    assert.ok(Object.isFrozen(a.challenge.offers));
    assert.ok(Object.isFrozen(a.challenge.futurePieces));
  }
});
