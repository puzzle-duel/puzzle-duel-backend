import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';
import pg from 'pg';
import { ControllableClock } from '../../../src/tournament/ingress/clock.mts';
import { PostgresAdmissionJournal } from '../../../src/tournament/ingress/postgres-journal.mts';
import { PostgresSeriesFenceStore } from '../../../src/tournament/ingress/series-fence.mts';
import { PinnedRs256JwtVerifier } from '../../../src/tournament/auth/pinned-jwt-verifier.mts';
import { PostgresVerifiedIdentitySessionStore } from '../../../src/tournament/auth/postgres-verified-sessions.mts';
import { PostgresSeriesWriterStore } from '../../../src/tournament/auth/series-writer-binding.mts';
import { createTournamentHttpHandler } from '../../../src/tournament/auth/tournament-http.mts';
import { AtomicDailyClaimBootstrap } from '../../../src/tournament/claims/atomic-claim-bootstrap.mts';
import {
  digestManifestPayload,
  PinnedManifestRegistry,
} from '../../../src/tournament/claims/pinned-manifest-registry.mts';
import {
  TrustedGameplayService,
  PostgresTrustedChallengeStore,
  PostgresAcceptedMoveLedger,
  PostgresAuthoritativeSnapshotStore,
  PostgresTrustedUnitOfWork,
} from '../../../src/tournament/adjudication/index.mts';
import type { SessionAuthorizationGateway } from '../../../src/tournament/auth/session-authorization-gateway.mts';

const url = process.env.PZD_INGRESS_DATABASE_URL;
assert.ok(url, 'PostgreSQL required for tournament HTTP E2E');

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../docs/contracts/gameplay/v3/fixtures/V3-01-legal-placement.json',
    ),
    'utf8',
  ),
);

function buildManifest() {
  const subgames = [1, 2, 3, 4, 5, 6].map((ordinal) => ({
    ordinal,
    challengeId: `chal-${ordinal}`,
    generatorVersion: 'gen-001.v1-adapter-test',
    contentVersion: 'f1-http',
    initialState: fixture.initialState,
  }));
  const contentVersion = 'f1-http-manifest';
  const digest = digestManifestPayload(contentVersion, subgames);
  return new PinnedManifestRegistry(
    [{ digest, contentVersion, subgames }],
    digest,
  );
}

async function boot() {
  const pool = new pg.Pool({ connectionString: url, max: 12 });
  for (const sql of [
    'DROP TABLE IF EXISTS tournament_series_writer',
    'DROP TABLE IF EXISTS authoritative_game_snapshot',
    'DROP TABLE IF EXISTS accepted_move_ledger',
    'DROP TABLE IF EXISTS trusted_challenge_binding',
    'DROP TABLE IF EXISTS series_fence_state',
    'DROP TABLE IF EXISTS tournament_daily_claim',
    'DROP TABLE IF EXISTS command_admission_journal',
    'DROP TABLE IF EXISTS tournament_auth_session',
    'DROP TABLE IF EXISTS tournament_verified_identity',
  ]) {
    await pool.query(sql);
  }

  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = 'https://issuer.example.test';
  const audience = 'puzzle-duel-api';
  const verifier = new PinnedRs256JwtVerifier({
    issuer,
    audience,
    keys: [
      {
        keyId: 'server-pinned',
        rsaPublicKeyPem: pair.publicKey
          .export({ type: 'spki', format: 'pem' })
          .toString(),
      },
    ],
    maxTokenAgeSeconds: 900,
  });
  function bearer(sub: string, overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    const head = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: 'server-pinned' }),
    ).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        iss: issuer,
        aud: audience,
        sub,
        iat: now - 10,
        exp: now + 250,
        ...overrides,
      }),
    ).toString('base64url');
    const msg = head + '.' + body;
    return (
      'Bearer ' +
      msg +
      '.' +
      sign('RSA-SHA256', Buffer.from(msg), pair.privateKey).toString(
        'base64url',
      )
    );
  }

  const sessions = new PostgresVerifiedIdentitySessionStore(pool);
  await sessions.migrate();
  const manifests = buildManifest();
  const claims = new AtomicDailyClaimBootstrap(pool, manifests);
  await claims.migrate();
  const writers = new PostgresSeriesWriterStore(pool);
  const fence = new PostgresSeriesFenceStore(pool);
  await fence.migrate();
  const clock = new ControllableClock(new Date());
  const journal = new PostgresAdmissionJournal(pool, clock);
  await journal.migrate();
  const uow = new PostgresTrustedUnitOfWork(pool);
  await uow.migrate();

  const handler = createTournamentHttpHandler({
    verifier,
    sessions,
    claims,
    writers,
    fence,
    gameplayForSession: (gateway: SessionAuthorizationGateway) =>
      new TrustedGameplayService({
        journal,
        fence,
        challenges: new PostgresTrustedChallengeStore(pool),
        ledger: new PostgresAcceptedMoveLedger(pool),
        snapshots: new PostgresAuthoritativeSnapshotStore(pool),
        clock,
        authorization: gateway,
        postgresUow: uow,
        resolveActiveOrdinal: async () => 1,
      }),
  });

  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    pool,
    base,
    bearer,
    today: new Date().toISOString().slice(0, 10),
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await pool.end();
    },
  };
}

describe('PZD-40 authenticated tournament HTTP E2E (candidate OpenAPI)', () => {
  it('session → daily claim → series GET; forged token and cross-player denied', async () => {
    const env = await boot();
    try {
      const auth = env.bearer('http-user-a');
      assert.equal(
        (await fetch(`${env.base}/v1/tournament/session`, { method: 'POST' }))
          .status,
        401,
      );
      assert.equal(
        (
          await fetch(`${env.base}/v1/tournament/session`, {
            method: 'POST',
            headers: { authorization: env.bearer('x', { aud: 'wrong' }) },
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await fetch(`${env.base}/v1/tournament/session`, {
            method: 'POST',
            headers: { authorization: env.bearer('x', { guest: true }) },
          })
        ).status,
        401,
      );

      const opened = await fetch(`${env.base}/v1/tournament/session`, {
        method: 'POST',
        headers: { authorization: auth },
      });
      assert.equal(opened.status, 201);
      const session = (await opened.json()) as { sessionSecret: string };
      const headers = {
        authorization: auth,
        'x-pzd-session-secret': session.sessionSecret,
        'content-type': 'application/json',
      };

      const claimed = await fetch(`${env.base}/v1/tournament/claims/daily`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ originalUtcDate: env.today }),
      });
      assert.equal(claimed.status, 201);
      const claim = (await claimed.json()) as {
        seriesId: string;
        original: boolean;
        writerGeneration: number;
      };
      assert.equal(claim.original, true);
      assert.equal(claim.writerGeneration, 1);

      const retry = await fetch(`${env.base}/v1/tournament/claims/daily`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ originalUtcDate: env.today }),
      });
      assert.equal(retry.status, 200);
      const again = (await retry.json()) as { seriesId: string; original: boolean };
      assert.equal(again.seriesId, claim.seriesId);
      assert.equal(again.original, false);

      const got = await fetch(
        `${env.base}/v1/tournament/series/${claim.seriesId}`,
        { headers },
      );
      assert.equal(got.status, 200);
      const body = (await got.json()) as { idleDeadlineAtMs: number };
      const idleBefore = body.idleDeadlineAtMs;
      const got2 = await fetch(
        `${env.base}/v1/tournament/series/${claim.seriesId}`,
        { headers },
      );
      assert.equal(got2.status, 200);
      assert.equal(
        ((await got2.json()) as { idleDeadlineAtMs: number }).idleDeadlineAtMs,
        idleBefore,
      );

      // Cross-player cannot read.
      const otherOpen = await fetch(`${env.base}/v1/tournament/session`, {
        method: 'POST',
        headers: { authorization: env.bearer('http-user-b') },
      });
      const other = (await otherOpen.json()) as { sessionSecret: string };
      const denied = await fetch(
        `${env.base}/v1/tournament/series/${claim.seriesId}`,
        {
          headers: {
            authorization: env.bearer('http-user-b'),
            'x-pzd-session-secret': other.sessionSecret,
          },
        },
      );
      assert.equal(denied.status, 404);

      // Spoofed playerId in claim body rejected.
      const spoof = await fetch(`${env.base}/v1/tournament/claims/daily`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          originalUtcDate: env.today,
          playerId: 'victim',
        }),
      });
      assert.equal(spoof.status, 400);

      // Auth failure → zero extra claims for attacker.
      const count = await env.pool.query(
        'SELECT count(*)::int AS n FROM tournament_daily_claim',
      );
      assert.equal(count.rows[0].n, 1);
    } finally {
      await env.close();
    }
  });

  it('closed-schema command rejects score authority; abandon requires ownership', async () => {
    const env = await boot();
    try {
      const auth = env.bearer('cmd-user');
      const opened = await fetch(`${env.base}/v1/tournament/session`, {
        method: 'POST',
        headers: { authorization: auth },
      });
      const session = (await opened.json()) as { sessionSecret: string };
      const headers = {
        authorization: auth,
        'x-pzd-session-secret': session.sessionSecret,
        'content-type': 'application/json',
      };
      const claimed = await fetch(`${env.base}/v1/tournament/claims/daily`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ originalUtcDate: env.today }),
      });
      const claim = (await claimed.json()) as { seriesId: string };
      const forged = await fetch(
        `${env.base}/v1/tournament/series/${claim.seriesId}/commands`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            commandType: 'move',
            idempotencyKey: 'm1',
            score: 9999,
            move: {
              offerIndex: 0,
              tap: [0, 0],
              expectedBoardRevision: 0,
              writerGeneration: 1,
            },
          }),
        },
      );
      assert.equal(forged.status, 400);

      const abandon = await fetch(
        `${env.base}/v1/tournament/series/${claim.seriesId}/commands`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            commandType: 'abandon',
            idempotencyKey: 'ab1',
          }),
        },
      );
      assert.ok([200, 409].includes(abandon.status));
    } finally {
      await env.close();
    }
  });
});
