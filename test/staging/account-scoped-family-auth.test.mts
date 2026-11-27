/**
 * Phase-1 review: staging account-scoped badge/diagnostic routes must not
 * bypass exact-family validation. Legacy non-staging JWTs remain session-free
 * without family claims.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { PinnedRs256JwtVerifier } from '../../src/tournament/auth/pinned-jwt-verifier.mts';
import { PostgresVerifiedIdentitySessionStore } from '../../src/tournament/auth/postgres-verified-sessions.mts';
import { createTournamentHttpHandler } from '../../src/tournament/auth/tournament-http.mts';
import { explicitTestRankedHttpGateConfig } from '../../src/tournament/auth/ranked-feature-gate.mts';
import { GUEST_AUDIENCE, GUEST_ISSUER } from '../../src/staging/staging-access-token.mts';
import { JwtVerificationError } from '../../src/tournament/auth/pinned-jwt-verifier.mts';

const databaseUrl = process.env.PZD_TEST_DATABASE_URL;
const describePg = databaseUrl ? test : test.skip;

function mintStagingAccess(input: {
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  kid: string;
  sub: string;
  familyId?: string;
  accountType?: 'guest' | 'verified';
  now: number;
}): string {
  const claims: Record<string, unknown> = {
    iss: GUEST_ISSUER,
    aud: GUEST_AUDIENCE,
    sub: input.sub,
    iat: input.now - 5,
    exp: input.now + 600,
  };
  if (input.accountType) claims.account_type = input.accountType;
  if (input.familyId) claims.fid = input.familyId;
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: input.kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const msg = `${head}.${body}`;
  return `Bearer ${msg}.${sign('RSA-SHA256', Buffer.from(msg), input.privateKey).toString('base64url')}`;
}

function mintLegacyAccess(input: {
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  kid: string;
  issuer: string;
  audience: string;
  sub: string;
  now: number;
}): string {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: input.kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    iss: input.issuer,
    aud: input.audience,
    sub: input.sub,
    iat: input.now - 5,
    exp: input.now + 600,
  })).toString('base64url');
  const msg = `${head}.${body}`;
  return `Bearer ${msg}.${sign('RSA-SHA256', Buffer.from(msg), input.privateKey).toString('base64url')}`;
}

describePg('account-scoped routes enforce staging exact-family', async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const db = await pool.query<{ current_database: string }>('SELECT current_database()');
  const dbName = db.rows[0]!.current_database;
  if (!/^pzd_[a-z0-9_]*test[a-z0-9_]*$/i.test(dbName) && dbName !== 'pzd_ci') {
    await pool.end();
    throw new Error(`REFUSING_DESTRUCTIVE_TEST_SETUP:${dbName}`);
  }

  await pool.query(`
    DROP TABLE IF EXISTS tournament_auth_session CASCADE;
    DROP TABLE IF EXISTS tournament_verified_identity CASCADE;
    DROP TABLE IF EXISTS tournament_on_time_badge CASCADE;
    DROP TABLE IF EXISTS tournament_daily_series_completion CASCADE;
    DROP TABLE IF EXISTS public.pzd_guest_refresh CASCADE;
    DROP TABLE IF EXISTS public.pzd_guest_families CASCADE;
    DROP TABLE IF EXISTS public.pzd_guest_accounts CASCADE;
  `);
  await pool.query(`
    CREATE TABLE public.pzd_guest_accounts (
      player_id uuid PRIMARY KEY,
      account_class text NOT NULL DEFAULT 'guest',
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
    CREATE TABLE tournament_daily_series_completion (
      series_id uuid PRIMARY KEY,
      player_id uuid NOT NULL,
      original_utc_date date NOT NULL,
      claim_started_at_ms bigint NOT NULL
    );
    CREATE TABLE tournament_on_time_badge (
      series_id uuid PRIMARY KEY,
      awarded boolean NOT NULL,
      claim_started_at_ms bigint NOT NULL,
      original_utc_date date NOT NULL
    );
  `);

  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'scoped-family';
  const now = Math.floor(Date.now() / 1000);
  const playerId = randomUUID();
  const familyId = randomUUID();
  await pool.query(
    `INSERT INTO public.pzd_guest_accounts (player_id, account_class) VALUES ($1, 'verified')`,
    [playerId],
  );
  await pool.query(
    `INSERT INTO public.pzd_guest_families (family_id, player_id) VALUES ($1, $2)`,
    [familyId, playerId],
  );
  await pool.query(
    `INSERT INTO public.pzd_guest_refresh (token_digest, family_id, player_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    ['a'.repeat(64), familyId, playerId, new Date(Date.now() + 86_400_000)],
  );

  const stagingVerifier = new PinnedRs256JwtVerifier({
    issuer: GUEST_ISSUER,
    audience: GUEST_AUDIENCE,
    keys: [{
      keyId: kid,
      rsaPublicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }],
    maxTokenAgeSeconds: 900,
    allowStagingGuestClaims: true,
  });
  const sessions = new PostgresVerifiedIdentitySessionStore(pool);
  await sessions.migrate();

  const handler = createTournamentHttpHandler({
    verifier: stagingVerifier,
    sessions,
    claims: {
      getClaimForPlayer: async () => null,
      migrate: async () => undefined,
    } as never,
    writers: {} as never,
    fence: {} as never,
    pool,
    rankedHttpGate: explicitTestRankedHttpGateConfig(),
    actualRuntimeEnv: { NODE_ENV: 'test' } as NodeJS.ProcessEnv,
    gameplayForSession: () => {
      throw new Error('gameplay_not_used');
    },
  });

  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    await pool.end();
  });

  await t.test('staging JWT missing/malformed family claims rejected before route', () => {
    assert.throws(
      () => stagingVerifier.verifyAuthorizationHeader(
        mintStagingAccess({
          privateKey: pair.privateKey, kid, sub: playerId, accountType: 'verified', now,
        }),
        now,
      ),
      JwtVerificationError,
    );
    assert.throws(
      () => stagingVerifier.verifyAuthorizationHeader(
        mintStagingAccess({
          privateKey: pair.privateKey, kid, sub: playerId,
          accountType: 'verified', familyId: 'not-a-uuid', now,
        }),
        now,
      ),
      JwtVerificationError,
    );
    assert.throws(
      () => stagingVerifier.verifyAuthorizationHeader(
        mintStagingAccess({
          privateKey: pair.privateKey, kid, sub: playerId, familyId, now,
        }),
        now,
      ),
      JwtVerificationError,
    );
  });

  await t.test('active staging family authorizes account-scoped badges without session', async () => {
    const bearer = mintStagingAccess({
      privateKey: pair.privateKey, kid, sub: playerId,
      accountType: 'verified', familyId, now,
    });
    const res = await fetch(`${base}/v1/profile/me/badges`, {
      headers: { authorization: bearer },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { playerScoped: boolean };
    assert.equal(body.playerScoped, true);
  });

  await t.test('revoked staging family rejects account-scoped badges and diagnostics', async () => {
    await pool.query(
      `UPDATE public.pzd_guest_families SET revoked_at=clock_timestamp() WHERE family_id=$1`,
      [familyId],
    );
    const bearer = mintStagingAccess({
      privateKey: pair.privateKey, kid, sub: playerId,
      accountType: 'verified', familyId, now,
    });
    const badges = await fetch(`${base}/v1/profile/me/badges`, {
      headers: { authorization: bearer },
    });
    assert.equal(badges.status, 401);
    const report = await fetch(`${base}/v1/diagnostics/reports`, {
      method: 'POST',
      headers: {
        authorization: bearer,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ events: [] }),
    });
    assert.equal(report.status, 401);
    await pool.query(
      `UPDATE public.pzd_guest_families SET revoked_at=NULL WHERE family_id=$1`,
      [familyId],
    );
  });

  await t.test('expired refresh tip rejects account-scoped badges', async () => {
    await pool.query(
      `UPDATE public.pzd_guest_refresh SET expires_at=$2 WHERE family_id=$1`,
      [familyId, new Date(Date.now() - 1000)],
    );
    const bearer = mintStagingAccess({
      privateKey: pair.privateKey, kid, sub: playerId,
      accountType: 'verified', familyId, now,
    });
    const res = await fetch(`${base}/v1/tournament/me/badges`, {
      headers: { authorization: bearer },
    });
    assert.equal(res.status, 401);
    await pool.query(
      `UPDATE public.pzd_guest_refresh SET expires_at=$2 WHERE family_id=$1`,
      [familyId, new Date(Date.now() + 86_400_000)],
    );
  });
});

test('legacy non-staging issuer still authorizes badges without family claims', async (t) => {
  if (!process.env.PZD_INGRESS_DATABASE_URL) {
    t.skip('PostgreSQL ingress URL required');
    return;
  }
  const pool = new pg.Pool({ connectionString: process.env.PZD_INGRESS_DATABASE_URL, max: 4 });
  for (const sql of [
    'DROP TABLE IF EXISTS tournament_auth_session',
    'DROP TABLE IF EXISTS tournament_verified_identity',
    'DROP TABLE IF EXISTS tournament_on_time_badge',
    'DROP TABLE IF EXISTS tournament_daily_series_completion',
  ]) {
    await pool.query(sql);
  }
  await pool.query(`
    CREATE TABLE tournament_daily_series_completion (
      series_id uuid PRIMARY KEY,
      player_id uuid NOT NULL,
      original_utc_date date NOT NULL,
      claim_started_at_ms bigint NOT NULL
    );
    CREATE TABLE tournament_on_time_badge (
      series_id uuid PRIMARY KEY,
      awarded boolean NOT NULL,
      claim_started_at_ms bigint NOT NULL,
      original_utc_date date NOT NULL
    );
  `);
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = 'https://issuer.example.test';
  const audience = 'puzzle-duel-api';
  const kid = 'legacy';
  const now = Math.floor(Date.now() / 1000);
  const verifier = new PinnedRs256JwtVerifier({
    issuer,
    audience,
    keys: [{
      keyId: kid,
      rsaPublicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }],
    maxTokenAgeSeconds: 900,
  });
  const sessions = new PostgresVerifiedIdentitySessionStore(pool);
  await sessions.migrate();
  const handler = createTournamentHttpHandler({
    verifier,
    sessions,
    claims: {
      getClaimForPlayer: async () => null,
      migrate: async () => undefined,
    } as never,
    writers: {} as never,
    fence: {} as never,
    pool,
    rankedHttpGate: explicitTestRankedHttpGateConfig(),
    actualRuntimeEnv: { NODE_ENV: 'test' } as NodeJS.ProcessEnv,
    gameplayForSession: () => {
      throw new Error('gameplay_not_used');
    },
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    await pool.end();
  });

  const bearer = mintLegacyAccess({
    privateKey: pair.privateKey, kid, issuer, audience, sub: 'legacy-user', now,
  });
  const opened = await fetch(`${base}/v1/tournament/session`, {
    method: 'POST',
    headers: { authorization: bearer },
  });
  assert.equal(opened.status, 201);
  const badges = await fetch(`${base}/v1/profile/me/badges`, {
    headers: { authorization: bearer },
  });
  assert.equal(badges.status, 200);
});
