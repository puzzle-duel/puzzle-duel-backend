/**
 * PZD-26/27 unified continue — real PostgreSQL integration (0005–0008).
 * Requires PZD_TEST_DATABASE_URL against an isolated disposable database.
 * Never targets pzd_staging / production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { issueProviderChallenge } from '../../src/staging/provider-challenge.mts';
import {
  PostgresProviderIdentityAuth,
  ProviderAuthError,
} from '../../src/staging/provider-identity-service.mts';
import { PostgresStagingGuestAuth } from '../../src/staging/guest-auth-service.mts';
import {
  continueChallengeBinding,
  detectProviderContinueSchemaReady,
  familyAdvisoryKeys,
  lockGuestFamily,
} from '../../src/staging/staging-access-token.mts';
import type { ProviderKey } from '../../src/staging/provider-token-verifier.mts';

const databaseUrl = process.env.PZD_TEST_DATABASE_URL;
const describePg = databaseUrl ? test : test.skip;
const ROLE_PASSWORD = 'pzd-provider-continue-test-only-not-a-secret';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

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

describePg('unified provider continue PostgreSQL (0005–0008)', async (t) => {
  const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const admin = await adminPool.connect();
  let dbName = '';
  try {
    const db = await admin.query<{ current_database: string }>('SELECT current_database()');
    dbName = db.rows[0]!.current_database;
    assertIsolatedTestDatabase(dbName);

    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await admin.query(`
      DROP TABLE IF EXISTS public.pzd_provider_auth_receipts CASCADE;
      DROP TABLE IF EXISTS public.pzd_provider_continuations CASCADE;
      DROP TABLE IF EXISTS public.pzd_identity_links CASCADE;
      DROP TABLE IF EXISTS public.pzd_provider_challenges CASCADE;
      DROP TABLE IF EXISTS public.pzd_guest_refresh CASCADE;
      DROP TABLE IF EXISTS public.pzd_guest_families CASCADE;
      DROP TABLE IF EXISTS public.pzd_guest_accounts CASCADE;
      DROP TABLE IF EXISTS public.tournament_daily_claim CASCADE;
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
      CREATE TABLE public.tournament_daily_claim (
        player_id uuid NOT NULL,
        claim_id uuid PRIMARY KEY DEFAULT gen_random_uuid()
      );
      GRANT SELECT, INSERT ON public.pzd_guest_accounts TO pzd_app_runtime;
      GRANT SELECT, INSERT, UPDATE ON public.pzd_guest_families TO pzd_app_runtime;
      GRANT SELECT, INSERT, UPDATE ON public.pzd_guest_refresh TO pzd_app_runtime;
      GRANT SELECT ON public.tournament_daily_claim TO pzd_app_runtime;
      GRANT USAGE ON SCHEMA public TO pzd_app_runtime;
    `);
    await applySql(admin, 'migrations/staging/0005_provider_challenges.sql', dbName);
    await applySql(admin, 'migrations/staging/0006_provider_identity.sql', dbName);
    await applySql(admin, 'migrations/staging/0007_identity_immutability.sql', dbName);
    assert.equal(await detectProviderContinueSchemaReady(adminPool), false);
    await applySql(admin, 'migrations/staging/0008_provider_continue.sql', dbName);
    assert.equal(await detectProviderContinueSchemaReady(adminPool), true);
    await applySql(admin, 'migrations/staging/0009_provider_auth_receipts.sql', dbName);
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

  await t.test('0008 verify.sql returns PASS and runtime lacks DELETE', async () => {
    const verifySql = readFileSync(
      join(root, 'migrations/staging/0008_provider_continue.verify.sql'),
      'utf8',
    )
      .replace(/^BEGIN READ ONLY;\s*/i, '')
      .replace(/\s*ROLLBACK;\s*$/i, '');
    const client = await adminPool.connect();
    try {
      const result = await client.query(verifySql);
      assert.equal(String(Object.values(result.rows[0] ?? {})[0] ?? ''), 'PASS');
      const del = await client.query<{ has: boolean }>(
        `SELECT has_table_privilege('pzd_app_runtime','public.pzd_provider_continuations','DELETE') AS has`,
      );
      assert.equal(del.rows[0]?.has, false);
    } finally {
      client.release();
    }
  });

  await t.test('new provider + valid guest → same player id verified (link_guest)', async () => {
    const guest = await guestAuth.create(new Date());
    const claims = claimsFromJwt(guest.accessToken);
    const guestId = String(claims.sub);
    const familyId = String(claims.fid);
    const binding = continueChallengeBinding(guestId, familyId);
    const nonce = await issueProviderChallenge(runtimePool, {
      provider: 'google', purpose: 'continue', binding,
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'cont-new-google',
      audience: 'client', rawNonce: nonce, now,
    });
    const bundle = await auth.continue({
      provider: 'google', idToken: token, nonce, binding,
      guestPlayerId: guestId, guestFamilyId: familyId,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });
    assert.equal(bundle.resolution, 'link_guest');
    assert.equal(bundle.playerId, guestId);
  });

  await t.test('existing provider + empty guest → original verified player', async () => {
    const bindingLogin = 'cont-existing-login';
    const nonceLogin = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'login', binding: bindingLogin,
    });
    const tokenLogin = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'cont-existing-apple',
      audience: 'client', rawNonce: nonceLogin, now,
    });
    const original = await auth.login({
      provider: 'apple', idToken: tokenLogin, nonce: nonceLogin, binding: bindingLogin,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });

    const guest = await guestAuth.create(new Date());
    const claims = claimsFromJwt(guest.accessToken);
    const guestId = String(claims.sub);
    const familyId = String(claims.fid);
    const binding = continueChallengeBinding(guestId, familyId);
    const nonce = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'continue', binding,
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'cont-existing-apple',
      audience: 'client', rawNonce: nonce, now,
    });
    const bundle = await auth.continue({
      provider: 'apple', idToken: token, nonce, binding,
      guestPlayerId: guestId, guestFamilyId: familyId,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });
    assert.equal(bundle.resolution, 'existing_account');
    assert.equal(bundle.playerId, original.playerId);
    assert.notEqual(bundle.playerId, guestId);
  });

  await t.test('progressed guest requires confirmation; cancel leaves guest; confirm switches', async () => {
    const bindingLogin = 'cont-progress-login';
    const nonceLogin = await issueProviderChallenge(runtimePool, {
      provider: 'google', purpose: 'login', binding: bindingLogin,
    });
    const tokenLogin = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'cont-progress-google',
      audience: 'client', rawNonce: nonceLogin, now,
    });
    const original = await auth.login({
      provider: 'google', idToken: tokenLogin, nonce: nonceLogin, binding: bindingLogin,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });

    const guest = await guestAuth.create(new Date());
    const claims = claimsFromJwt(guest.accessToken);
    const guestId = String(claims.sub);
    const familyId = String(claims.fid);
    await adminPool.query(
      'INSERT INTO public.tournament_daily_claim (player_id) VALUES ($1)',
      [guestId],
    );

    const binding = continueChallengeBinding(guestId, familyId);
    const nonce = await issueProviderChallenge(runtimePool, {
      provider: 'google', purpose: 'continue', binding,
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'cont-progress-google',
      audience: 'client', rawNonce: nonce, now,
    });
    let continuation = '';
    await assert.rejects(
      () => auth.continue({
        provider: 'google', idToken: token, nonce, binding,
        guestPlayerId: guestId, guestFamilyId: familyId,
        audiences: ['client'], keys: [key], nowSeconds: now,
      }),
      (error: unknown) => {
        if (!(error instanceof ProviderAuthError)) return false;
        if (error.code !== 'ACCOUNT_SWITCH_CONFIRMATION_REQUIRED') return false;
        continuation = error.continuationToken ?? '';
        assert.equal(error.targetPlayerId, original.playerId);
        return continuation.length > 0;
      },
    );

    // Cancel: guest family still active; no verified family for guest.
    const guestClass = await runtimePool.query<{ account_class: string }>(
      'SELECT account_class FROM public.pzd_guest_accounts WHERE player_id=$1',
      [guestId],
    );
    assert.equal(guestClass.rows[0]?.account_class, 'guest');

    const switched = await auth.confirmContinue({ continuationToken: continuation });
    assert.equal(switched.resolution, 'existing_account');
    assert.equal(switched.playerId, original.playerId);

    await assert.rejects(
      () => auth.confirmContinue({ continuationToken: continuation }),
      (error: unknown) => error instanceof ProviderAuthError && error.code === 'INVALID_CONTINUATION',
    );
  });

  await t.test('logout/revocation before confirmation rejects; continuation not consumed', async () => {
    const bindingLogin = 'cont-revoke-login';
    const nonceLogin = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'login', binding: bindingLogin,
    });
    const tokenLogin = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'cont-revoke-apple',
      audience: 'client', rawNonce: nonceLogin, now,
    });
    const original = await auth.login({
      provider: 'apple', idToken: tokenLogin, nonce: nonceLogin, binding: bindingLogin,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });

    const guest = await guestAuth.create(new Date());
    const claims = claimsFromJwt(guest.accessToken);
    const guestId = String(claims.sub);
    const familyId = String(claims.fid);
    const binding = continueChallengeBinding(guestId, familyId);
    const nonce = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'continue', binding,
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'cont-revoke-apple',
      audience: 'client', rawNonce: nonce, now,
    });
    let continuation = '';
    await assert.rejects(
      () => auth.continue({
        provider: 'apple', idToken: token, nonce, binding,
        guestPlayerId: guestId, guestFamilyId: familyId,
        localProgressProtected: true,
        audiences: ['client'], keys: [key], nowSeconds: now,
      }),
      (error: unknown) => {
        if (!(error instanceof ProviderAuthError)) return false;
        continuation = error.continuationToken ?? '';
        return error.code === 'ACCOUNT_SWITCH_CONFIRMATION_REQUIRED' && continuation.length > 0;
      },
    );

    await runtimePool.query(
      'UPDATE public.pzd_guest_families SET revoked_at=clock_timestamp() WHERE family_id=$1',
      [familyId],
    );

    await assert.rejects(
      () => auth.confirmContinue({ continuationToken: continuation }),
      (error: unknown) => error instanceof ProviderAuthError && error.code === 'GUEST_PROOF_REQUIRED',
    );

    // Token remains usable only after guest restored — prove not consumed.
    await runtimePool.query(
      'UPDATE public.pzd_guest_families SET revoked_at=NULL WHERE family_id=$1',
      [familyId],
    );
    const restored = await auth.confirmContinue({ continuationToken: continuation });
    assert.equal(restored.playerId, original.playerId);
  });

  await t.test('guest-bound continue without guest proof fails closed (no create)', async () => {
    const guestId = randomUUID();
    const familyId = randomUUID();
    const binding = continueChallengeBinding(guestId, familyId);
    const nonce = await issueProviderChallenge(runtimePool, {
      provider: 'google', purpose: 'continue', binding,
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'cont-no-guest-proof',
      audience: 'client', rawNonce: nonce, now,
    });
    await assert.rejects(
      () => auth.continue({
        provider: 'google', idToken: token, nonce, binding,
        audiences: ['client'], keys: [key], nowSeconds: now,
      }),
      (error: unknown) => error instanceof ProviderAuthError && error.code === 'GUEST_PROOF_REQUIRED',
    );
    const links = await runtimePool.query(
      `SELECT 1 FROM public.pzd_identity_links
       WHERE provider='google' AND provider_subject='cont-no-guest-proof'`,
    );
    assert.equal(links.rowCount, 0);
  });

  await t.test('recoverLinked requires committed continue receipt; unconfirmed switch fails', async () => {
    const bindingLogin = 'cont-recover-login';
    const nonceLogin = await issueProviderChallenge(runtimePool, {
      provider: 'google', purpose: 'login', binding: bindingLogin,
    });
    const tokenLogin = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'cont-recover-google',
      audience: 'client', rawNonce: nonceLogin, now,
    });
    const original = await auth.login({
      provider: 'google', idToken: tokenLogin, nonce: nonceLogin, binding: bindingLogin,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });

    // Link alone (login) is insufficient without a continue/confirm receipt.
    const preBinding = 'cont-recover-pre';
    const preNonce = await issueProviderChallenge(runtimePool, {
      provider: 'google', purpose: 'login', binding: preBinding,
    });
    const preToken = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'cont-recover-google',
      audience: 'client', rawNonce: preNonce, now,
    });
    await assert.rejects(
      () => auth.recoverLinked({
        provider: 'google', idToken: preToken, nonce: preNonce, binding: preBinding,
        audiences: ['client'], keys: [key], nowSeconds: now,
      }),
      (error: unknown) =>
        error instanceof ProviderAuthError && error.code === 'RECOVERY_OPERATION_INCOMPLETE',
    );

    // Empty guest continue commits existing_account + receipt.
    const guest = await guestAuth.create(new Date());
    const claims = claimsFromJwt(guest.accessToken);
    const binding = continueChallengeBinding(String(claims.sub), String(claims.fid));
    const nonceCont = await issueProviderChallenge(runtimePool, {
      provider: 'google', purpose: 'continue', binding,
    });
    const tokenCont = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'cont-recover-google',
      audience: 'client', rawNonce: nonceCont, now,
    });
    const continued = await auth.continue({
      provider: 'google', idToken: tokenCont, nonce: nonceCont, binding,
      guestPlayerId: String(claims.sub), guestFamilyId: String(claims.fid),
      audiences: ['client'], keys: [key], nowSeconds: now,
    });
    assert.equal(continued.playerId, original.playerId);

    const recoverBinding = 'cont-recover-binding';
    const nonce = await issueProviderChallenge(runtimePool, {
      provider: 'google', purpose: 'login', binding: recoverBinding,
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'cont-recover-google',
      audience: 'client', rawNonce: nonce, now,
    });
    const recovered = await auth.recoverLinked({
      provider: 'google', idToken: token, nonce, binding: recoverBinding,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });
    assert.equal(recovered.playerId, original.playerId);

    const unknownBinding = 'cont-recover-unknown';
    const unknownNonce = await issueProviderChallenge(runtimePool, {
      provider: 'google', purpose: 'login', binding: unknownBinding,
    });
    const unknownToken = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'cont-recover-unknown-sub',
      audience: 'client', rawNonce: unknownNonce, now,
    });
    await assert.rejects(
      () => auth.recoverLinked({
        provider: 'google', idToken: unknownToken, nonce: unknownNonce, binding: unknownBinding,
        audiences: ['client'], keys: [key], nowSeconds: now,
      }),
      (error: unknown) => error instanceof ProviderAuthError && error.code === 'RECOVERY_NOT_LINKED',
    );
  });

  await t.test('confirmation-required writes no receipt; confirm writes receipt for recovery', async () => {
    const bindingLogin = 'cont-consent-login';
    const nonceLogin = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'login', binding: bindingLogin,
    });
    const tokenLogin = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'cont-consent-apple',
      audience: 'client', rawNonce: nonceLogin, now,
    });
    const original = await auth.login({
      provider: 'apple', idToken: tokenLogin, nonce: nonceLogin, binding: bindingLogin,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });

    const guest = await guestAuth.create(new Date());
    const claims = claimsFromJwt(guest.accessToken);
    const guestId = String(claims.sub);
    const familyId = String(claims.fid);
    const binding = continueChallengeBinding(guestId, familyId);
    const nonce = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'continue', binding,
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'cont-consent-apple',
      audience: 'client', rawNonce: nonce, now,
    });
    let continuation = '';
    await assert.rejects(
      () => auth.continue({
        provider: 'apple', idToken: token, nonce, binding,
        guestPlayerId: guestId, guestFamilyId: familyId,
        localProgressProtected: true,
        audiences: ['client'], keys: [key], nowSeconds: now,
      }),
      (error: unknown) => {
        if (!(error instanceof ProviderAuthError)) return false;
        continuation = error.continuationToken ?? '';
        return error.code === 'ACCOUNT_SWITCH_CONFIRMATION_REQUIRED';
      },
    );

    const incompleteBinding = 'cont-consent-incomplete';
    const incompleteNonce = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'login', binding: incompleteBinding,
    });
    const incompleteToken = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'cont-consent-apple',
      audience: 'client', rawNonce: incompleteNonce, now,
    });
    await assert.rejects(
      () => auth.recoverLinked({
        provider: 'apple', idToken: incompleteToken, nonce: incompleteNonce,
        binding: incompleteBinding,
        audiences: ['client'], keys: [key], nowSeconds: now,
      }),
      (error: unknown) =>
        error instanceof ProviderAuthError && error.code === 'RECOVERY_OPERATION_INCOMPLETE',
    );

    const switched = await auth.confirmContinue({ continuationToken: continuation });
    assert.equal(switched.playerId, original.playerId);

    const okBinding = 'cont-consent-ok';
    const okNonce = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'login', binding: okBinding,
    });
    const okToken = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject: 'cont-consent-apple',
      audience: 'client', rawNonce: okNonce, now,
    });
    const recovered = await auth.recoverLinked({
      provider: 'apple', idToken: okToken, nonce: okNonce, binding: okBinding,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });
    assert.equal(recovered.playerId, original.playerId);
  });

  await t.test('concurrent continue registration does not duplicate players', async () => {
    const guestA = await guestAuth.create(new Date());
    const guestB = await guestAuth.create(new Date());
    const a = claimsFromJwt(guestA.accessToken);
    const b = claimsFromJwt(guestB.accessToken);
    const subject = 'cont-concurrent-sub';
    const bindingA = continueChallengeBinding(String(a.sub), String(a.fid));
    const bindingB = continueChallengeBinding(String(b.sub), String(b.fid));
    const nonceA = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'continue', binding: bindingA,
    });
    const nonceB = await issueProviderChallenge(runtimePool, {
      provider: 'apple', purpose: 'continue', binding: bindingB,
    });
    const tokenA = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject,
      audience: 'client', rawNonce: nonceA, now,
    });
    const tokenB = mintAssertion({
      privateKey, kid: 't', provider: 'apple', subject,
      audience: 'client', rawNonce: nonceB, now,
    });
    const results = await Promise.allSettled([
      auth.continue({
        provider: 'apple', idToken: tokenA, nonce: nonceA, binding: bindingA,
        guestPlayerId: String(a.sub), guestFamilyId: String(a.fid),
        audiences: ['client'], keys: [key], nowSeconds: now,
      }),
      auth.continue({
        provider: 'apple', idToken: tokenB, nonce: nonceB, binding: bindingB,
        guestPlayerId: String(b.sub), guestFamilyId: String(b.fid),
        audiences: ['client'], keys: [key], nowSeconds: now,
      }),
    ]);
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof auth.continue>>> =>
        r.status === 'fulfilled',
    );
    // One may link the empty guest; the other authenticates the same linked player.
    // Unique provider subject ownership must still hold — never two link rows.
    assert.ok(fulfilled.length >= 1);
    const playerIds = new Set(fulfilled.map((r) => r.value.playerId));
    assert.equal(playerIds.size, 1);
    const links = await runtimePool.query(
      `SELECT player_id FROM public.pzd_identity_links
       WHERE provider='apple' AND provider_subject=$1`,
      [subject],
    );
    assert.equal(links.rowCount, 1);
    assert.equal(links.rows[0]!.player_id, [...playerIds][0]);
  });

  await t.test('concurrent duplicate confirmation: only one succeeds', async () => {
    const bindingLogin = 'cont-dup-confirm-login';
    const nonceLogin = await issueProviderChallenge(runtimePool, {
      provider: 'google', purpose: 'login', binding: bindingLogin,
    });
    const tokenLogin = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'cont-dup-confirm',
      audience: 'client', rawNonce: nonceLogin, now,
    });
    const original = await auth.login({
      provider: 'google', idToken: tokenLogin, nonce: nonceLogin, binding: bindingLogin,
      audiences: ['client'], keys: [key], nowSeconds: now,
    });
    const guest = await guestAuth.create(new Date());
    const claims = claimsFromJwt(guest.accessToken);
    const guestId = String(claims.sub);
    const familyId = String(claims.fid);
    const binding = continueChallengeBinding(guestId, familyId);
    const nonce = await issueProviderChallenge(runtimePool, {
      provider: 'google', purpose: 'continue', binding,
    });
    const token = mintAssertion({
      privateKey, kid: 't', provider: 'google', subject: 'cont-dup-confirm',
      audience: 'client', rawNonce: nonce, now,
    });
    let continuation = '';
    await assert.rejects(
      () => auth.continue({
        provider: 'google', idToken: token, nonce, binding,
        guestPlayerId: guestId, guestFamilyId: familyId,
        localProgressProtected: true,
        audiences: ['client'], keys: [key], nowSeconds: now,
      }),
      (error: unknown) => {
        if (!(error instanceof ProviderAuthError)) return false;
        continuation = error.continuationToken ?? '';
        return error.code === 'ACCOUNT_SWITCH_CONFIRMATION_REQUIRED';
      },
    );

    // Hold family lock so both confirms queue for serialization.
    const barrier = await runtimePool.connect();
    try {
      await barrier.query('BEGIN');
      await lockGuestFamily(barrier, familyId);
      const p1 = auth.confirmContinue({ continuationToken: continuation });
      const p2 = auth.confirmContinue({ continuationToken: continuation });
      const [k1, k2] = familyAdvisoryKeys(familyId);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const waiting = await adminPool.query(
          `SELECT count(*)::int AS n FROM pg_locks
           WHERE locktype='advisory' AND classid=$1::int AND objid=$2::int AND NOT granted`,
          [k1, k2],
        );
        if ((waiting.rows[0]?.n ?? 0) >= 1) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await barrier.query('COMMIT');
      const settled = await Promise.allSettled([p1, p2]);
      const ok = settled.filter((s) => s.status === 'fulfilled');
      const bad = settled.filter((s) => s.status === 'rejected');
      assert.equal(ok.length, 1);
      assert.equal(bad.length, 1);
      if (ok[0]?.status === 'fulfilled') {
        assert.equal(ok[0].value.playerId, original.playerId);
      }
    } finally {
      barrier.release();
    }
  });
});
