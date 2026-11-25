import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderJwks } from '../../src/staging/provider-jwks.mts';

function jwk(kid: string) {
  return { kty: 'RSA', kid, n: 'sXEAX73abc', e: 'AQAB', alg: 'RS256', use: 'sig' };
}

function response(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'max-age=120', ...headers },
  });
}

test('caches keys and deduplicates concurrent fetches', async () => {
  let fetches = 0;
  const jwks = new ProviderJwks(async () => {
    fetches += 1;
    await new Promise((r) => setTimeout(r, 20));
    return response({ keys: [jwk('a'), jwk('b')] });
  }, () => 1_000_000);
  const [left, right] = await Promise.all([jwks.keys('apple', 'a'), jwks.keys('google', 'b')]);
  assert.equal(left.some((k) => k.kid === 'a'), true);
  assert.equal(right.some((k) => k.kid === 'b'), true);
  assert.equal(fetches, 2);
  await jwks.keys('apple', 'b');
  assert.equal(fetches, 2);
});

test('unknown kid triggers refresh then fails closed', async () => {
  let fetches = 0;
  const jwks = new ProviderJwks(async () => {
    fetches += 1;
    return response({ keys: [jwk(fetches === 1 ? 'old' : 'rotated')] });
  });
  await jwks.keys('apple', 'old');
  await assert.rejects(() => jwks.keys('apple', 'missing'), /INVALID_PROVIDER_ASSERTION/);
  assert.equal(fetches, 2);
  await jwks.keys('apple', 'rotated');
  assert.equal(fetches, 2);
});

test('throttles repeated fetch failures', async () => {
  let fetches = 0;
  let now = 5_000_000;
  const jwks = new ProviderJwks(async () => {
    fetches += 1;
    throw new Error('network');
  }, () => now);
  await assert.rejects(() => jwks.keys('google', 'a'), /PROVIDER_KEYS_UNAVAILABLE|network/);
  now += 1;
  await assert.rejects(() => jwks.keys('google', 'a'), /PROVIDER_KEYS_UNAVAILABLE/);
  assert.equal(fetches, 1);
  now += 10_001;
  await assert.rejects(() => jwks.keys('google', 'a'), /PROVIDER_KEYS_UNAVAILABLE|network/);
  assert.equal(fetches, 2);
});

test('rejects oversized, malformed, and duplicate JWKS payloads', async () => {
  const oversized = new ProviderJwks(async () =>
    new Response('x'.repeat(70_000), { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(() => oversized.keys('apple', 'a'), /PROVIDER_KEYS_UNAVAILABLE/);

  const malformed = new ProviderJwks(async () => response({ keys: 'nope' }));
  await assert.rejects(() => malformed.keys('apple', 'a'), /PROVIDER_KEYS_UNAVAILABLE/);

  const duplicates = new ProviderJwks(async () => response({ keys: [jwk('dup'), jwk('dup')] }));
  await assert.rejects(() => duplicates.keys('apple', 'dup'), /PROVIDER_KEYS_UNAVAILABLE/);
});

test('isolates providers and rejects redirects', async () => {
  const seen: string[] = [];
  const jwks = new ProviderJwks(async (input, init) => {
    seen.push(String(input));
    assert.equal(init?.redirect, 'error');
    return response({ keys: [jwk('k')] });
  });
  await jwks.keys('apple', 'k');
  await jwks.keys('google', 'k');
  assert.deepEqual(seen, [
    'https://appleid.apple.com/auth/keys',
    'https://www.googleapis.com/oauth2/v3/certs',
  ]);
});
