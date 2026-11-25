import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { issueProviderChallenge, consumeProviderChallenge } from '../../src/staging/provider-challenge.mts';
import { PostgresProviderIdentityAuth, ProviderAuthError } from '../../src/staging/provider-identity-service.mts';
import type { ProviderKey } from '../../src/staging/provider-token-verifier.mts';

const databaseUrl = process.env.PZD_TEST_DATABASE_URL;
const describePg = databaseUrl ? test : test.skip;

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

async function applySql(client: pg.PoolClient, relativePath: string): Promise<void> {
  const sql = readFileSync(join(root, relativePath), 'utf8')
    .replace(/current_database\(\) <> 'pzd_staging'/g, 'false')
    .replace(/current_database\(\)='pzd_staging'/g, 'true');
  await client.query(sql);
}

function mintAssertion(input: {
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  kid: string;
  provider: 'apple' | 'google';
  subject: string;
  audience: string;
  rawNonce: string;
  now: number;
}) {
  const nonce = input.provider === 'apple'
    ? createHash('sha256').update(input.rawNonce, 'utf8').digest('hex')
    : input.rawNonce;
  const encode = (x: object) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const msg = encode({ alg: 'RS256', kid: input.kid }) + '.' + encode({
    iss: input.provider === 'apple' ? 'https://appleid.apple.com' : 'https://accounts.google.com',
    aud: input.audience,
    sub: input.subject,
    iat: input.now - 5,
    exp: input.now + 600,
    nonce,
  });
  return msg + '.' + sign('RSA-SHA256', Buffer.from(msg), input.privateKey).toString('base64url');
}

describePg('provider identity PostgreSQL integration', async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const admin = await pool.connect();
  try {
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await admin.query(`
      DROP TABLE IF EXISTS public.pzd_identity_links CASCADE;
      DROP TABLE IF EXISTS public.pzd_provider_challenges CASCADE;
      DROP TABLE IF EXISTS public.pzd_guest_refresh CASCADE;
      DROP TABLE IF EXISTS public.pzd_guest_families CASCADE;
      DROP TABLE IF EXISTS public.pzd_guest_accounts CASCADE;
      DROP FUNCTION IF EXISTS public.pzd_provider_challenge_immutable CASCADE;
      DO $$ BEGIN
        CREATE ROLE pzd_app_runtime;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await admin.query(`
      CREATE TABLE public.pzd_guest_accounts (
        player_id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.pzd_guest_families (
        family_id uuid PRIMARY KEY,
        player_id uuid NOT NULL REFERENCES public.pzd_guest_accounts(player_id),
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.pzd_guest_refresh (
        token_digest char(64) PRIMARY KEY,
        family_id uuid NOT NULL REFERENCES public.pzd_guest_families(family_id),
        player_id uuid NOT NULL REFERENCES public.pzd_guest_accounts(player_id),
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await applySql(admin, 'migrations/staging/0005_provider_challenges.sql');
    await applySql(admin, 'migrations/staging/0006_provider_identity.sql');
  } finally {
    admin.release();
  }

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const key: ProviderKey = { kid: 't', kty: 'RSA', n: jwk.n!, e: jwk.e! };
  const auth = new PostgresProviderIdentityAuth(pool, privateKey, 't');
  const now = Math.floor(Date.now() / 1000);

  t.after(async () => {
    await pool.end();
  });

  await t.test('login creates player; second login reuses; concurrent link conflicts', async () => {
    const binding = 'login-binding-1';
    const nonce = await issueProviderChallenge(pool, {
      provider: 'google', purpose: 'login', binding,
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'sub-google-1',
      audience: 'client', rawNonce: nonce, now,
    });
    const first = await auth.login({
      provider: 'google', idToken: token, nonce, binding,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });
    assert.equal(first.accountType, 'verified');
    assert.match(first.playerId, /^[0-9a-f-]{36}$/i);

    const binding2 = 'login-binding-2';
    const nonce2 = await issueProviderChallenge(pool, {
      provider: 'google', purpose: 'login', binding: binding2,
    });
    const token2 = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'sub-google-1',
      audience: 'client', rawNonce: nonce2, now,
    });
    const second = await auth.login({
      provider: 'google', idToken: token2, nonce: nonce2, binding: binding2,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });
    assert.equal(second.playerId, first.playerId);
  });

  await t.test('guest link preserves player id and rejects occupied provider subject', async () => {
    const guestId = randomUUID();
    const familyId = randomUUID();
    await pool.query('INSERT INTO pzd_guest_accounts (player_id) VALUES ($1)', [guestId]);
    await pool.query(
      'INSERT INTO pzd_guest_families (family_id, player_id) VALUES ($1, $2)',
      [familyId, guestId],
    );
    const nonce = await issueProviderChallenge(pool, {
      provider: 'apple', purpose: 'link', binding: `link:${guestId}`,
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'sub-apple-1',
      audience: 'client', rawNonce: nonce, now,
    });
    const linked = await auth.link({
      provider: 'apple', idToken: token, nonce, guestPlayerId: guestId,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });
    assert.equal(linked.playerId, guestId);
    assert.deepEqual(linked.linkedProviders, ['apple']);

    const otherGuest = randomUUID();
    await pool.query('INSERT INTO pzd_guest_accounts (player_id) VALUES ($1)', [otherGuest]);
    await pool.query(
      'INSERT INTO pzd_guest_families (family_id, player_id) VALUES ($1, $2)',
      [randomUUID(), otherGuest],
    );
    const conflictNonce = await issueProviderChallenge(pool, {
      provider: 'apple', purpose: 'link', binding: `link:${otherGuest}`,
    });
    const conflictToken = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'sub-apple-1',
      audience: 'client', rawNonce: conflictNonce, now,
    });
    await assert.rejects(() => auth.link({
      provider: 'apple', idToken: conflictToken, nonce: conflictNonce,
      guestPlayerId: otherGuest, audiences: ['client'], keys: [key], nowSeconds: now,
    }), (error: unknown) => error instanceof ProviderAuthError && error.code === 'ACCOUNT_CONFLICT');
  });

  await t.test('concurrent nonce consumption allows exactly one winner', async () => {
    const binding = 'race-binding';
    const nonce = await issueProviderChallenge(pool, {
      provider: 'google', purpose: 'login', binding,
    });
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    try {
      const results = await Promise.allSettled(clients.map(async (client) => {
        await client.query('BEGIN');
        try {
          await consumeProviderChallenge(client, {
            provider: 'google', purpose: 'login', binding,
          }, nonce);
          await client.query('COMMIT');
          return 'ok';
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }));
      const wins = results.filter((r) => r.status === 'fulfilled').length;
      const losses = results.filter((r) => r.status === 'rejected').length;
      assert.equal(wins, 1);
      assert.equal(losses, 1);
    } finally {
      for (const client of clients) client.release();
    }
  });
});
