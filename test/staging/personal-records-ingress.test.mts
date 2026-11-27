/**
 * PZD-53: exercise staging ingress gate (isStagingRankedRoute) for personal-records.
 * Must forward exact GET/POST paths to tournament-http; never rely on handler-only tests.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import pg from 'pg';
import { PinnedRs256JwtVerifier } from '../../src/tournament/auth/pinned-jwt-verifier.mts';
import { PostgresVerifiedIdentitySessionStore } from '../../src/tournament/auth/postgres-verified-sessions.mts';
import { createTournamentHttpHandler } from '../../src/tournament/auth/tournament-http.mts';
import { explicitTestRankedHttpGateConfig } from '../../src/tournament/auth/ranked-feature-gate.mts';
import { GUEST_AUDIENCE, GUEST_ISSUER } from '../../src/staging/staging-access-token.mts';
import { isStagingRankedRoute } from '../../src/staging/staging-server.mts';
import { diagnosticRoute } from '../../src/diagnostics/http-correlation.mts';

const databaseUrl = process.env.PZD_TEST_DATABASE_URL;
const describePg = databaseUrl ? test : test.skip;
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

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

async function applyPersonalBestMigration(client: pg.PoolClient, dbName: string): Promise<void> {
  const escaped = dbName.replace(/'/g, "''");
  const sql = readFileSync(
    join(root, 'migrations/staging/0010_player_personal_best.sql'),
    'utf8',
  )
    .replace(/current_database\(\) <> 'pzd_staging'/g, `current_database() <> '${escaped}'`)
    .replace(/current_database\(\)='pzd_staging'/g, `current_database()='${escaped}'`);
  const ddlOnly = sql.replace(/\nREVOKE ALL[\s\S]*$/m, '\n');
  await client.query(ddlOnly);
}

describePg('staging ingress personal-records forwarding', async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const admin = await pool.connect();
  let dbName = '';
  try {
    const db = await admin.query<{ current_database: string }>('SELECT current_database()');
    dbName = db.rows[0]!.current_database;
    if (!/^pzd_[a-z0-9_]*test[a-z0-9_]*$/i.test(dbName) && dbName !== 'pzd_ci') {
      throw new Error(`REFUSING_DESTRUCTIVE_TEST_SETUP:${dbName}`);
    }
    await admin.query(`
      DROP TABLE IF EXISTS public.player_personal_best CASCADE;
      DROP TABLE IF EXISTS tournament_auth_session CASCADE;
      DROP TABLE IF EXISTS tournament_verified_identity CASCADE;
      DROP TABLE IF EXISTS tournament_on_time_badge CASCADE;
      DROP TABLE IF EXISTS tournament_verified_subgame_score CASCADE;
      DROP TABLE IF EXISTS trusted_challenge_binding CASCADE;
      DROP TABLE IF EXISTS tournament_daily_series_completion CASCADE;
      DROP TABLE IF EXISTS public.pzd_guest_refresh CASCADE;
      DROP TABLE IF EXISTS public.pzd_guest_families CASCADE;
      DROP TABLE IF EXISTS public.pzd_guest_accounts CASCADE;
    `);
    await admin.query(`
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
      -- Completion table columns cover badge reads + personal-best derive-merge.
      CREATE TABLE tournament_daily_series_completion (
        series_id uuid PRIMARY KEY,
        player_id text NOT NULL,
        completed_at_ms bigint NOT NULL DEFAULT 0,
        original_utc_date date NOT NULL DEFAULT CURRENT_DATE,
        claim_started_at_ms bigint NOT NULL DEFAULT 0
      );
      CREATE TABLE tournament_verified_subgame_score (
        series_id uuid NOT NULL,
        subgame_ordinal int NOT NULL,
        score bigint NOT NULL,
        PRIMARY KEY (series_id, subgame_ordinal)
      );
      CREATE TABLE trusted_challenge_binding (
        series_key uuid NOT NULL,
        subgame_ordinal int NOT NULL,
        rules_version text,
        generator_version text,
        PRIMARY KEY (series_key, subgame_ordinal)
      );
      CREATE TABLE tournament_on_time_badge (
        series_id uuid PRIMARY KEY,
        awarded boolean NOT NULL,
        claim_started_at_ms bigint NOT NULL,
        original_utc_date date NOT NULL
      );
    `);
    await applyPersonalBestMigration(admin, dbName);
  } finally {
    admin.release();
  }

  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'ingress-pb';
  const now = Math.floor(Date.now() / 1000);
  const verifiedPlayerId = randomUUID();
  const guestPlayerId = randomUUID();
  const verifiedFamilyId = randomUUID();
  const guestFamilyId = randomUUID();

  await pool.query(
    `INSERT INTO public.pzd_guest_accounts (player_id, account_class) VALUES ($1, 'verified'), ($2, 'guest')`,
    [verifiedPlayerId, guestPlayerId],
  );
  await pool.query(
    `INSERT INTO public.pzd_guest_families (family_id, player_id) VALUES ($1, $2), ($3, $4)`,
    [verifiedFamilyId, verifiedPlayerId, guestFamilyId, guestPlayerId],
  );
  await pool.query(
    `INSERT INTO public.pzd_guest_refresh (token_digest, family_id, player_id, expires_at)
     VALUES ($1, $2, $3, $4), ($5, $6, $7, $4)`,
    [
      'b'.repeat(64), verifiedFamilyId, verifiedPlayerId, new Date(Date.now() + 86_400_000),
      'c'.repeat(64), guestFamilyId, guestPlayerId,
    ],
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

  const tournamentHandler = createTournamentHttpHandler({
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

  // Mirror staging-server.mts ingress dispatch for ranked/account-scoped routes.
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (isStagingRankedRoute(req.url, req.method)) {
      void tournamentHandler(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'TOURNAMENT_UNAVAILABLE' }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    await pool.query('DROP TABLE IF EXISTS public.player_personal_best CASCADE');
    await pool.end();
  });

  const verifiedBearer = () => mintStagingAccess({
    privateKey: pair.privateKey,
    kid,
    sub: verifiedPlayerId,
    accountType: 'verified',
    familyId: verifiedFamilyId,
    now,
  });
  const guestBearer = () => mintStagingAccess({
    privateKey: pair.privateKey,
    kid,
    sub: guestPlayerId,
    accountType: 'guest',
    familyId: guestFamilyId,
    now,
  });

  await t.test('inspector route classification is profile_personal_records', () => {
    assert.equal(
      diagnosticRoute('/v1/profile/me/personal-records'),
      'profile_personal_records',
    );
    assert.equal(
      diagnosticRoute('/v1/profile/me/personal-records/practice/sync'),
      'profile_personal_records',
    );
  });

  await t.test('verified GET personal-records returns 200 through ingress', async () => {
    const res = await fetch(`${base}/v1/profile/me/personal-records`, {
      headers: { authorization: verifiedBearer() },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      schemaReady?: boolean;
      records?: unknown[];
    };
    assert.equal(body.schemaReady, true);
    assert.ok(Array.isArray(body.records));
  });

  await t.test('verified Practice sync returns 200 through ingress', async () => {
    const res = await fetch(`${base}/v1/profile/me/personal-records/practice/sync`, {
      method: 'POST',
      headers: {
        authorization: verifiedBearer(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        records: [{
          difficulty: 'easy',
          score: 1200,
          rulesVersion: 'core-001.v2',
          generatorVersion: 'gen-001.v1',
          achievedAt: '2026-11-27T00:00:00.000Z',
          completionId: 'ingress-sync-1',
          localRevision: 1,
        }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      schemaReady?: boolean;
      acknowledgements?: unknown[];
    };
    assert.equal(body.schemaReady, true);
    assert.ok(Array.isArray(body.acknowledgements));
    assert.equal((body.acknowledgements as unknown[]).length, 1);
  });

  await t.test('missing authentication returns 401 through ingress', async () => {
    const get = await fetch(`${base}/v1/profile/me/personal-records`);
    assert.equal(get.status, 401);
    const post = await fetch(`${base}/v1/profile/me/personal-records/practice/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ records: [] }),
    });
    assert.equal(post.status, 401);
  });

  await t.test('revoked family returns 401 through ingress', async () => {
    await pool.query(
      `UPDATE public.pzd_guest_families SET revoked_at=clock_timestamp() WHERE family_id=$1`,
      [verifiedFamilyId],
    );
    const res = await fetch(`${base}/v1/profile/me/personal-records`, {
      headers: { authorization: verifiedBearer() },
    });
    assert.equal(res.status, 401);
    await pool.query(
      `UPDATE public.pzd_guest_families SET revoked_at=NULL WHERE family_id=$1`,
      [verifiedFamilyId],
    );
  });

  await t.test('guest authentication returns 403 through ingress', async () => {
    const get = await fetch(`${base}/v1/profile/me/personal-records`, {
      headers: { authorization: guestBearer() },
    });
    assert.equal(get.status, 403);
    const body = await get.json() as { error?: string };
    assert.equal(body.error, 'RANKED_AUTH_REQUIRED');

    const post = await fetch(`${base}/v1/profile/me/personal-records/practice/sync`, {
      method: 'POST',
      headers: {
        authorization: guestBearer(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        records: [{
          difficulty: 'easy',
          score: 1,
          rulesVersion: 'core-001.v2',
          generatorVersion: 'gen-001.v1',
          achievedAt: '2026-11-27T00:00:00.000Z',
          completionId: 'guest-denied',
          localRevision: 1,
        }],
      }),
    });
    assert.equal(post.status, 403);
  });

  await t.test('unknown routes and unsupported methods stay rejected', async () => {
    const unknown = await fetch(`${base}/v1/profile/me/personal-records/extra`, {
      headers: { authorization: verifiedBearer() },
    });
    assert.equal(unknown.status, 404);

    const wrongMethod = await fetch(`${base}/v1/profile/me/personal-records`, {
      method: 'POST',
      headers: {
        authorization: verifiedBearer(),
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(wrongMethod.status, 404);

    const wrongSyncMethod = await fetch(
      `${base}/v1/profile/me/personal-records/practice/sync`,
      { headers: { authorization: verifiedBearer() } },
    );
    assert.equal(wrongSyncMethod.status, 404);
  });

  await t.test('badges route remains unaffected through same ingress', async () => {
    const res = await fetch(`${base}/v1/profile/me/badges`, {
      headers: { authorization: verifiedBearer() },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { playerScoped?: boolean; badges?: unknown[] };
    assert.equal(body.playerScoped, true);
    assert.ok(Array.isArray(body.badges));
  });

  await t.test('migration absence returns SCHEMA_NOT_READY for practice sync', async () => {
    await pool.query('DROP TABLE IF EXISTS public.player_personal_best CASCADE');
    const get = await fetch(`${base}/v1/profile/me/personal-records`, {
      headers: { authorization: verifiedBearer() },
    });
    assert.equal(get.status, 200);
    const getBody = await get.json() as { schemaReady?: boolean; records?: unknown[] };
    assert.equal(getBody.schemaReady, false);

    const post = await fetch(`${base}/v1/profile/me/personal-records/practice/sync`, {
      method: 'POST',
      headers: {
        authorization: verifiedBearer(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        records: [{
          difficulty: 'medium',
          score: 9,
          rulesVersion: 'core-001.v2',
          generatorVersion: 'gen-001.v1',
          achievedAt: '2026-11-27T00:00:00.000Z',
          completionId: 'schema-missing',
          localRevision: 1,
        }],
      }),
    });
    assert.equal(post.status, 503);
    const postBody = await post.json() as { error?: string };
    assert.equal(postBody.error, 'SCHEMA_NOT_READY');

    // Restore for cleanup path.
    const restore = await pool.connect();
    try {
      await applyPersonalBestMigration(restore, dbName);
    } finally {
      restore.release();
    }
  });
});
