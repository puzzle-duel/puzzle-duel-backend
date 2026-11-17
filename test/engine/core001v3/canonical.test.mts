import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CanonicalJsonException,
  JSON_MAX_SAFE_INTEGER,
  canonicalJsonV3,
  parseGameState,
  sha256HexOfUtf8,
  stateHashV3,
} from '../../../src/engine/core001v3/index.mts';
import { v3Playable } from './fixtures.mts';

test('CV-01 empty object', () => {
  assert.equal(canonicalJsonV3({}), '{}');
  assert.equal(
    sha256HexOfUtf8('{}'),
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  );
});

test('CV-02 spent', () => {
  const exact = '{"kind":"spent"}';
  assert.equal(canonicalJsonV3({ kind: 'spent' }), exact);
  assert.equal(
    sha256HexOfUtf8(exact),
    '684ab5937663746640cb17fa8b29254454be394376269cdaeca1743a7577fa82',
  );
});

test('CV-03 key order independence', () => {
  const exact = '{"direction":"up","kind":"piece","shape":"circle"}';
  assert.equal(
    canonicalJsonV3({ kind: 'piece', shape: 'circle', direction: 'up' }),
    exact,
  );
  assert.equal(
    canonicalJsonV3({ shape: 'circle', direction: 'up', kind: 'piece' }),
    exact,
  );
  assert.equal(
    sha256HexOfUtf8(exact),
    '1f18d4b9a43e29c7a72d1309f531088c32d792d4e6a31a9a7194637676916186',
  );
});

test('CV-04 null', () => {
  assert.equal(canonicalJsonV3(null), 'null');
  assert.equal(
    sha256HexOfUtf8('null'),
    '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
  );
});

test('CV-05 zero', () => {
  assert.equal(canonicalJsonV3(0), '0');
  assert.equal(
    sha256HexOfUtf8('0'),
    '5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9',
  );
});

test('CV-06 nine hundred', () => {
  assert.equal(canonicalJsonV3(900), '900');
  assert.equal(
    sha256HexOfUtf8('900'),
    'bdc5d8a48c23897906b09a9a3680bd2e9c8b3121edbda36f949800f0959c8d55',
  );
});

test('CV-07 ended string', () => {
  assert.equal(canonicalJsonV3('ended'), '"ended"');
  assert.equal(
    sha256HexOfUtf8('"ended"'),
    '0f27529487e95082cf0bd9f021be1ede2adc650b34db2ba96235d8805ad49bb3',
  );
});

test('CV-08 escaped quote', () => {
  const exact = '"a\\"b"';
  assert.equal(canonicalJsonV3('a"b'), exact);
  assert.equal(
    sha256HexOfUtf8(exact),
    '8bbcb681750af483258c5ca72e83c5c397bf66aa01e7c7787c0d212fc1f6fa1d',
  );
});

test('CV-09 escaped backslash', () => {
  const exact = '"a\\\\b"';
  assert.equal(canonicalJsonV3('a\\b'), exact);
  assert.equal(
    sha256HexOfUtf8(exact),
    'd6b4439bd2d0fecbb8aeb27d4370b0354683ea72adc84cca99b5fe80aa0b62d0',
  );
});

test('rejects non-ASCII, floats, unsafe ints, negative zero', () => {
  assert.throws(() => canonicalJsonV3('ç'), CanonicalJsonException);
  assert.throws(() => canonicalJsonV3(1.5), CanonicalJsonException);
  assert.throws(
    () => canonicalJsonV3(JSON_MAX_SAFE_INTEGER + 1),
    CanonicalJsonException,
  );
  assert.throws(() => canonicalJsonV3(-0), CanonicalJsonException);
});

test('stateHashV3 produces 64-hex digest; self-hash is not ranked authority', () => {
  const state = parseGameState(v3Playable());
  const hash = stateHashV3(state);
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
  const forged = parseGameState({ ...v3Playable(), score: 999 });
  assert.notEqual(stateHashV3(forged), hash);
});
