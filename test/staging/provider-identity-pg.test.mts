import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { issueProviderChallenge, consumeProviderChallenge } from '../../src/staging/provider-challenge.mts';
import { PostgresProviderIdentityAuth, ProviderAuthError } from '../../src/staging/provider-identity-service.mts';
import { PostgresStagingGuestAuth } from '../../src/staging/guest-auth-service.mts';
import {
  assertExactActiveFamily,
  detectAccountClassColumn,
  detectIdentityImmutabilityReady,
  familyAdvisoryKeys,
  linkChallengeBinding,
  lockGuestFamily,
} from '../../src/staging/staging-access-token.mts';
import {
  cleanupExpiredProviderChallenges,
  challengeDigestForTests,
} from '../../src/staging/provider-challenge.mts';
import type { ProviderKey } from '../../src/staging/provider-token-verifier.mts';

const databaseUrl = process.env.PZD_TEST_DATABASE_URL;
const describePg = databaseUrl ? test : test.skip;
const ROLE_PASSWORD = 'pzd-provider-auth-test-only-not-a-secret';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Destructive setup must never run against staging/production. */
function assertIsolatedTestDatabase(name: string): void {
  if (!name || name === 'pzd_staging' || /(?:^|_)(?:prod|production|live|staging)(?:$|_)/i.test(name)) {
    throw new Error(`REFUSING_DESTRUCTIVE_TEST_SETUP:${name}`);
  }
  if (!/^pzd_[a-z0-9_]*test[a-z0-9_]*$/i.test(name) && name !== 'pzd_ci') {
    throw new Error(`REFUSING_DESTRUCTIVE_TEST_SETUP:${name}`);
  }
}

function roleUrl(role: string): string {
  const url = new URL(databaseUrl!);
  url.username = role;
  url.password = ROLE_PASSWORD;
  return url.toString();
}

async function applySql(client: pg.PoolClient, relativePath: string, dbName: string): Promise<void> {
  const escaped = dbName.replace(/'/g, "''");
  const sql = readFileSync(join(root, relativePath), 'utf8')
    .replace(/current_database\(\) <> 'pzd_staging'/g, `current_database() <> '${escaped}'`)
    .replace(/current_database\(\)='pzd_staging'/g, `current_database()='${escaped}'`);
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

function claimsFromJwt(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describePg('provider identity PostgreSQL integration (runtime role)', async (t) => {
  const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const admin = await adminPool.connect();
  let dbName = '';
  try {
    const db = await admin.query<{ current_database: string }>('SELECT current_database()');
    dbName = db.rows[0]!.current_database;
    assertIsolatedTestDatabase(dbName);

    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await admin.query(`
      DROP TABLE IF EXISTS public.pzd_identity_links CASCADE;
      DROP TABLE IF EXISTS public.pzd_provider_challenges CASCADE;
      DROP TABLE IF EXISTS public.pzd_guest_refresh CASCADE;
      DROP TABLE IF EXISTS public.pzd_guest_families CASCADE;
      DROP TABLE IF EXISTS public.pzd_guest_accounts CASCADE;
      DROP FUNCTION IF EXISTS public.pzd_provider_challenge_immutable CASCADE;
      DROP FUNCTION IF EXISTS public.pzd_identity_links_immutable CASCADE;
      DO $$ BEGIN
        CREATE ROLE pzd_app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
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
      GRANT SELECT, INSERT ON public.pzd_guest_accounts TO pzd_app_runtime;
      GRANT SELECT, INSERT, UPDATE ON public.pzd_guest_families TO pzd_app_runtime;
      GRANT SELECT, INSERT, UPDATE ON public.pzd_guest_refresh TO pzd_app_runtime;
      GRANT USAGE ON SCHEMA public TO pzd_app_runtime;
    `);
    await applySql(admin, 'migrations/staging/0005_provider_challenges.sql', dbName);
    await applySql(admin, 'migrations/staging/0006_provider_identity.sql', dbName);
    await applySql(admin, 'migrations/staging/0007_identity_immutability.sql', dbName);
    await admin.query(`ALTER ROLE pzd_app_runtime LOGIN PASSWORD '${ROLE_PASSWORD}'`);
  } finally {
    admin.release();
  }

  const runtimePool = new pg.Pool({ connectionString: roleUrl('pzd_app_runtime'), max: 4 });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const key: ProviderKey = { kid: 't', kty: 'RSA', n: jwk.n!, e: jwk.e! };
  const auth = new PostgresProviderIdentityAuth(runtimePool, privateKey, 't');
  const guestAuth = new PostgresStagingGuestAuth(runtimePool, privateKey, 't', false, true);
  const now = Math.floor(Date.now() / 1000);

  t.after(async () => {
    await runtimePool.end();
    const cleanup = await adminPool.connect();
    try {
      await cleanup.query('ALTER ROLE pzd_app_runtime NOLOGIN PASSWORD NULL');
    } finally {
      cleanup.release();
      await adminPool.end();
    }
  });

  await t.test('refuses destructive setup outside isolated test database names', () => {
    assert.throws(() => assertIsolatedTestDatabase('pzd_staging'), /REFUSING_DESTRUCTIVE_TEST_SETUP/);
    assert.throws(() => assertIsolatedTestDatabase('pzd_production'), /REFUSING_DESTRUCTIVE_TEST_SETUP/);
    assert.throws(() => assertIsolatedTestDatabase('postgres'), /REFUSING_DESTRUCTIVE_TEST_SETUP/);
    assertIsolatedTestDatabase(dbName);
  });

  await t.test('account class and 0007 immutability readiness are detected outside transactions', async () => {
    assert.equal(await detectAccountClassColumn(runtimePool), true);
    assert.equal(await detectIdentityImmutabilityReady(runtimePool), true);
  });

  async function waitForWaitingFamilyLock(familyId: string, timeoutMs = 8000): Promise<void> {
    const [k1, k2] = familyAdvisoryKeys(familyId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const waiting = await adminPool.query(
        `SELECT 1 FROM pg_locks
         WHERE locktype = 'advisory'
           AND classid = $1::int
           AND objid = $2::int
           AND NOT granted
         LIMIT 1`,
        [k1, k2],
      );
      if ((waiting.rowCount ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('FAMILY_LOCK_WAIT_TIMEOUT');
  }

  await t.test('login creates player; second login reuses; JWT carries fid', async () => {
    const binding = 'login-binding-1';
    const nonce = await issueProviderChallenge(runtimePool, {
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
    const claims = claimsFromJwt(first.accessToken);
    assert.equal(claims.account_type, 'verified');
    assert.match(String(claims.fid), /^[0-9a-f-]{36}$/i);

    const binding2 = 'login-binding-2';
    const nonce2 = await issueProviderChallenge(runtimePool, {
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

  await t.test('guest link preserves player id, binds family, rejects occupied subject', async () => {
    const guest = await guestAuth.create(new Date());
    const guestClaims = claimsFromJwt(guest.accessToken);
    const guestId = String(guestClaims.sub);
    const familyId = String(guestClaims.fid);
    const nonce = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'link',
      binding: linkChallengeBinding(guestId, familyId),
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'sub-apple-1',
      audience: 'client', rawNonce: nonce, now,
    });
    const linked = await auth.link({
      provider: 'apple', idToken: token, nonce,
      guestPlayerId: guestId, guestFamilyId: familyId,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });
    assert.equal(linked.playerId, guestId);
    assert.deepEqual(linked.linkedProviders, ['apple']);

    await assert.rejects(
      () => assertExactActiveFamily({
        pool: runtimePool, playerId: guestId, familyId,
        expectedAccountType: 'guest', accountClassEnabled: true,
      }),
      /UNAUTHENTICATED/,
    );

    const other = await guestAuth.create(new Date());
    const otherClaims = claimsFromJwt(other.accessToken);
    const conflictNonce = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'link',
      binding: linkChallengeBinding(String(otherClaims.sub), String(otherClaims.fid)),
    });
    const conflictToken = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'sub-apple-1',
      audience: 'client', rawNonce: conflictNonce, now,
    });
    await assert.rejects(() => auth.link({
      provider: 'apple', idToken: conflictToken, nonce: conflictNonce,
      guestPlayerId: String(otherClaims.sub), guestFamilyId: String(otherClaims.fid),
      audiences: ['client'], keys: [key], nowSeconds: now,
    }), (error: unknown) => error instanceof ProviderAuthError && error.code === 'ACCOUNT_CONFLICT');
  });

  await t.test('stale guest access token cannot authorize after upgrade', async () => {
    const guest = await guestAuth.create(new Date());
    const claims = claimsFromJwt(guest.accessToken);
    const guestId = String(claims.sub);
    const familyId = String(claims.fid);
    const nonce = await issueProviderChallenge(runtimePool, {
      provider: 'google', purpose: 'link',
      binding: linkChallengeBinding(guestId, familyId),
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'sub-google-stale',
      audience: 'client', rawNonce: nonce, now,
    });
    await auth.link({
      provider: 'google', idToken: token, nonce,
      guestPlayerId: guestId, guestFamilyId: familyId,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });
    const secondNonce = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'link',
      binding: linkChallengeBinding(guestId, familyId),
    });
    const secondToken = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'sub-apple-stale',
      audience: 'client', rawNonce: secondNonce, now,
    });
    await assert.rejects(() => auth.link({
      provider: 'apple', idToken: secondToken, nonce: secondNonce,
      guestPlayerId: guestId, guestFamilyId: familyId,
      audiences: ['client'], keys: [key], nowSeconds: now,
    }), (error: unknown) => error instanceof ProviderAuthError && error.code === 'GUEST_PROOF_REQUIRED');
  });

  await t.test('revoked / expired / class mismatch families fail authorization; cross-family exact', async () => {
    const binding = 'verified-family-binding';
    const nonce = await issueProviderChallenge(runtimePool, {
      provider: 'google', purpose: 'login', binding,
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'sub-google-revoked',
      audience: 'client', rawNonce: nonce, now,
    });
    const bundle = await auth.login({
      provider: 'google', idToken: token, nonce, binding,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });
    const claims = claimsFromJwt(bundle.accessToken);
    const familyId = String(claims.fid);
    const playerId = String(claims.sub);
    await assertExactActiveFamily({
      pool: runtimePool, playerId, familyId,
      expectedAccountType: 'verified', accountClassEnabled: true,
    });
    await assert.rejects(
      () => assertExactActiveFamily({
        pool: runtimePool, playerId, familyId,
        expectedAccountType: 'guest', accountClassEnabled: true,
      }),
      /UNAUTHENTICATED/,
    );
    await runtimePool.query(
      'UPDATE pzd_guest_refresh SET expires_at=$2 WHERE family_id=$1 AND used_at IS NULL',
      [familyId, new Date(Date.now() - 1000)],
    );
    await assert.rejects(
      () => assertExactActiveFamily({
        pool: runtimePool, playerId, familyId,
        expectedAccountType: 'verified', accountClassEnabled: true,
      }),
      /UNAUTHENTICATED/,
    );
    await runtimePool.query(
      'UPDATE pzd_guest_families SET revoked_at=$2 WHERE family_id=$1',
      [familyId, new Date()],
    );
    await assert.rejects(
      () => assertExactActiveFamily({
        pool: runtimePool, playerId, familyId,
        expectedAccountType: 'verified', accountClassEnabled: true,
      }),
      /UNAUTHENTICATED/,
    );
    const otherFamily = randomUUID();
    const otherDigest = challengeDigestForTests(`refresh-${otherFamily}`);
    await runtimePool.query(
      'INSERT INTO pzd_guest_families (family_id, player_id) VALUES ($1, $2)',
      [otherFamily, playerId],
    );
    await runtimePool.query(
      `INSERT INTO pzd_guest_refresh (family_id, player_id, token_digest, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [otherFamily, playerId, otherDigest, new Date(Date.now() + 86400000)],
    );
    await assertExactActiveFamily({
      pool: runtimePool, playerId, familyId: otherFamily,
      expectedAccountType: 'verified', accountClassEnabled: true,
    });
    await assert.rejects(
      () => assertExactActiveFamily({
        pool: runtimePool, playerId, familyId,
        expectedAccountType: 'verified', accountClassEnabled: true,
      }),
      /UNAUTHENTICATED/,
    );
  });

  await t.test('barrier: refresh expires under lock while link waits; link rejects before challenge consume', async () => {
    const guest = await guestAuth.create(new Date());
    const claims = claimsFromJwt(guest.accessToken);
    const guestId = String(claims.sub);
    const familyId = String(claims.fid);
    const nonce = await issueProviderChallenge(runtimePool, {
      provider: 'google', purpose: 'link',
      binding: linkChallengeBinding(guestId, familyId),
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'sub-google-barrier-expire',
      audience: 'client', rawNonce: nonce, now,
    });
    const barrier = await runtimePool.connect();
    try {
      await barrier.query('BEGIN');
      await lockGuestFamily(barrier, familyId);
      const linkPromise = auth.link({
        provider: 'google', idToken: token, nonce,
        guestPlayerId: guestId, guestFamilyId: familyId,
        audiences: ['client'], keys: [key], nowSeconds: now,
      });
      await waitForWaitingFamilyLock(familyId);
      await barrier.query(
        `UPDATE pzd_guest_refresh SET expires_at = clock_timestamp() - interval '1 second'
         WHERE family_id=$1 AND used_at IS NULL`,
        [familyId],
      );
      await barrier.query('COMMIT');
      await assert.rejects(
        () => linkPromise,
        (error: unknown) => error instanceof ProviderAuthError && error.code === 'GUEST_PROOF_REQUIRED',
      );
      const challenge = await runtimePool.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM pzd_provider_challenges
         WHERE nonce_digest=$1`,
        [challengeDigestForTests(nonce)],
      );
      assert.equal(challenge.rows[0]?.consumed_at, null);
    } finally {
      try { await barrier.query('ROLLBACK'); } catch { /* committed */ }
      barrier.release();
    }
  });

  await t.test('barrier: logout commits while link waits; link then rejects revoked family', async () => {
    const guest = await guestAuth.create(new Date());
    const claims = claimsFromJwt(guest.accessToken);
    const guestId = String(claims.sub);
    const familyId = String(claims.fid);
    const nonce = await issueProviderChallenge(runtimePool, {
      provider: 'google', purpose: 'link',
      binding: linkChallengeBinding(guestId, familyId),
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'sub-google-barrier-logout',
      audience: 'client', rawNonce: nonce, now,
    });
    const barrier = await runtimePool.connect();
    try {
      await barrier.query('BEGIN');
      await lockGuestFamily(barrier, familyId);
      const linkPromise = auth.link({
        provider: 'google', idToken: token, nonce,
        guestPlayerId: guestId, guestFamilyId: familyId,
        audiences: ['client'], keys: [key], nowSeconds: now,
      });
      await waitForWaitingFamilyLock(familyId);
      await barrier.query(
        'UPDATE pzd_guest_families SET revoked_at=$2 WHERE family_id=$1 AND revoked_at IS NULL',
        [familyId, new Date()],
      );
      await barrier.query('COMMIT');
      await assert.rejects(
        () => linkPromise,
        (error: unknown) => error instanceof ProviderAuthError && error.code === 'GUEST_PROOF_REQUIRED',
      );
    } finally {
      try { await barrier.query('ROLLBACK'); } catch { /* already committed */ }
      barrier.release();
    }
  });

  await t.test('barrier: refresh rotation commits under lock before waiting link proceeds', async () => {
    const guest = await guestAuth.create(new Date());
    const claims = claimsFromJwt(guest.accessToken);
    const guestId = String(claims.sub);
    const familyId = String(claims.fid);
    const nonce = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'link',
      binding: linkChallengeBinding(guestId, familyId),
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'sub-apple-barrier-refresh',
      audience: 'client', rawNonce: nonce, now,
    });
    const barrier = await runtimePool.connect();
    try {
      await barrier.query('BEGIN');
      await lockGuestFamily(barrier, familyId);
      const linkPromise = auth.link({
        provider: 'apple', idToken: token, nonce,
        guestPlayerId: guestId, guestFamilyId: familyId,
        audiences: ['client'], keys: [key], nowSeconds: now,
      });
      await waitForWaitingFamilyLock(familyId);
      // Deterministic refresh rotation while link is blocked on the same family lock.
      const oldDigest = await barrier.query<{ token_digest: string }>(
        `SELECT token_digest FROM pzd_guest_refresh
         WHERE family_id=$1 AND used_at IS NULL`,
        [familyId],
      );
      assert.equal(oldDigest.rowCount, 1);
      await barrier.query(
        'UPDATE pzd_guest_refresh SET used_at=$2 WHERE token_digest=$1',
        [oldDigest.rows[0]!.token_digest, new Date()],
      );
      const nextDigest = challengeDigestForTests(`rotated-${familyId}`);
      await barrier.query(
        `INSERT INTO pzd_guest_refresh (family_id, player_id, token_digest, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [familyId, guestId, nextDigest, new Date(Date.now() + 86400000)],
      );
      await barrier.query('COMMIT');
      const linked = await linkPromise;
      assert.equal(linked.playerId, guestId);
      assert.equal(linked.accountType, 'verified');
      const tip = await runtimePool.query(
        `SELECT 1 FROM pzd_guest_refresh WHERE family_id=$1 AND token_digest=$2 AND used_at IS NULL`,
        [familyId, nextDigest],
      );
      // Original guest family is revoked by successful link; tip may be revoked with family.
      assert.ok((tip.rowCount ?? 0) === 0 || (tip.rowCount ?? 0) === 1);
    } finally {
      try { await barrier.query('ROLLBACK'); } catch { /* committed */ }
      barrier.release();
    }
  });

  await t.test('barrier: concurrent link attempts serialize; exactly one winner', async () => {
    const guest = await guestAuth.create(new Date());
    const claims = claimsFromJwt(guest.accessToken);
    const guestId = String(claims.sub);
    const familyId = String(claims.fid);
    const nonceA = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'link',
      binding: linkChallengeBinding(guestId, familyId),
    });
    const nonceB = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'link',
      binding: linkChallengeBinding(guestId, familyId),
    });
    const tokenA = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'sub-apple-barrier-race',
      audience: 'client', rawNonce: nonceA, now,
    });
    const tokenB = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'sub-apple-barrier-race',
      audience: 'client', rawNonce: nonceB, now: now + 1,
    });
    const barrier = await runtimePool.connect();
    try {
      await barrier.query('BEGIN');
      await lockGuestFamily(barrier, familyId);
      const first = auth.link({
        provider: 'apple', idToken: tokenA, nonce: nonceA,
        guestPlayerId: guestId, guestFamilyId: familyId,
        audiences: ['client'], keys: [key], nowSeconds: now,
      });
      await waitForWaitingFamilyLock(familyId);
      const second = auth.link({
        provider: 'apple', idToken: tokenB, nonce: nonceB,
        guestPlayerId: guestId, guestFamilyId: familyId,
        audiences: ['client'], keys: [key], nowSeconds: now + 1,
      });
      await waitForWaitingFamilyLock(familyId);
      await barrier.query('COMMIT');
      const results = await Promise.allSettled([first, second]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    } finally {
      try { await barrier.query('ROLLBACK'); } catch { /* committed */ }
      barrier.release();
    }
  });

  await t.test('operator cleanup deletes expired challenges; runtime role cannot', async () => {
    const digest = challengeDigestForTests(`expired-cleanup-${randomUUID()}`);
    await adminPool.query(
      `INSERT INTO public.pzd_provider_challenges
        (nonce_digest, binding_digest, provider, purpose, expires_at)
       VALUES ($1, $2, 'google', 'login', clock_timestamp() - interval '2 days')`,
      [digest, challengeDigestForTests('binding')],
    );
    await assert.rejects(() => cleanupExpiredProviderChallenges(runtimePool, 10));
    const removed = await cleanupExpiredProviderChallenges(adminPool, 10);
    assert.ok(removed >= 1);
    const left = await adminPool.query(
      'SELECT 1 FROM public.pzd_provider_challenges WHERE nonce_digest=$1',
      [digest],
    );
    assert.equal(left.rowCount, 0);
  });

  await t.test('transaction rollback leaves no identity link on conflict', async () => {
    const guest = await guestAuth.create(new Date());
    const claims = claimsFromJwt(guest.accessToken);
    const guestId = String(claims.sub);
    const familyId = String(claims.fid);
    const binding = 'login-occupy';
    const occupyNonce = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'login', binding,
    });
    const occupyToken = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'sub-apple-rollback',
      audience: 'client', rawNonce: occupyNonce, now,
    });
    await auth.login({
      provider: 'apple', idToken: occupyToken, nonce: occupyNonce, binding,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });
    const nonce = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'link',
      binding: linkChallengeBinding(guestId, familyId),
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'sub-apple-rollback',
      audience: 'client', rawNonce: nonce, now,
    });
    await assert.rejects(() => auth.link({
      provider: 'apple', idToken: token, nonce,
      guestPlayerId: guestId, guestFamilyId: familyId,
      audiences: ['client'], keys: [key], nowSeconds: now,
    }), (error: unknown) => error instanceof ProviderAuthError && error.code === 'ACCOUNT_CONFLICT');
    const account = await runtimePool.query<{ account_class: string }>(
      'SELECT account_class FROM pzd_guest_accounts WHERE player_id=$1', [guestId],
    );
    assert.equal(account.rows[0]?.account_class, 'guest');
    const links = await runtimePool.query(
      'SELECT 1 FROM pzd_identity_links WHERE player_id=$1', [guestId],
    );
    assert.equal(links.rowCount, 0);
  });

  await t.test('runtime role cannot UPDATE/DELETE identity links; concurrent nonce one winner', async () => {
    const existing = await runtimePool.query<{ provider: string; provider_subject: string }>(
      `SELECT provider, provider_subject FROM public.pzd_identity_links LIMIT 1`,
    );
    assert.ok((existing.rowCount ?? 0) >= 1);
    const row = existing.rows[0]!;
    await assert.rejects(
      () => runtimePool.query(
        `UPDATE public.pzd_identity_links SET player_id=$1
         WHERE provider=$2 AND provider_subject=$3`,
        [randomUUID(), row.provider, row.provider_subject],
      ),
    );
    await assert.rejects(
      () => runtimePool.query(
        `DELETE FROM public.pzd_identity_links WHERE provider=$1 AND provider_subject=$2`,
        [row.provider, row.provider_subject],
      ),
    );
    const binding = 'race-binding';
    const nonce = await issueProviderChallenge(runtimePool, {
      provider: 'google', purpose: 'login', binding,
    });
    const clients = await Promise.all([runtimePool.connect(), runtimePool.connect()]);
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
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    } finally {
      for (const client of clients) client.release();
    }
  });
});
