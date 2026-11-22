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
import { explicitTestRankedHttpGateConfig } from '../../../src/tournament/auth/ranked-feature-gate.mts';
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
import { AtomicDeviceHandoffUnitOfWork } from '../../../src/tournament/adjudication/atomic-device-handoff.mts';
import type { SessionAuthorizationGateway } from '../../../src/tournament/auth/session-authorization-gateway.mts';
import { resolveActiveSubgameOrdinal } from '../../../src/tournament/claims/active-ordinal.mts';

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
    'DROP TABLE IF EXISTS tournament_daily_claim CASCADE',
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

  const handoffUow = new AtomicDeviceHandoffUnitOfWork(pool);
  const handler = createTournamentHttpHandler({
    verifier,
    sessions,
    claims,
    writers,
    fence,
    pool,
    // Candidate ranked HTTP enabled only via explicit test gate — never production.
    rankedHttpGate: explicitTestRankedHttpGateConfig(),
    actualRuntimeEnv: { NODE_ENV: 'test' } as NodeJS.ProcessEnv,
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
        deviceHandoffUow: handoffUow,
        resolveActiveOrdinal: (seriesKey, playerId) =>
          resolveActiveSubgameOrdinal(pool, seriesKey, playerId),
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
  it('same-device recovery routes are unavailable unless server explicitly opts in', async () => {
    const env = await boot();
    try {
      const auth = env.bearer('recovery-disabled');
      const opened = await fetch(env.base + '/v1/tournament/session', {
        method: 'POST', headers: { authorization: auth },
      });
      assert.equal(opened.status, 201);
      const session = await opened.json() as {sessionSecret:string};
      const headers = {
        authorization: auth,
        'x-pzd-session-secret': session.sessionSecret,
        'content-type': 'application/json',
      };
      const register = await fetch(env.base + '/v1/tournament/devices/register', {
        method: 'POST', headers, body: JSON.stringify({
          spkiBase64Url:'not-authorized',
          signatureBase64Url:'not-authorized',
        }),
      });
      assert.equal(register.status, 404);
      const recover = await fetch(
        env.base + '/v1/tournament/series/11111111-1111-4111-8111-111111111111/recover-writer',
        {method:'POST',headers,body:JSON.stringify({proof:{},signatureBase64Url:'x'})},
      );
      assert.equal(recover.status, 404);
    } finally { await env.close(); }
  });

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

      // Non-writer same-player session cannot seize via handoff.
      const otherOpen = await fetch(`${env.base}/v1/tournament/session`, {
        method: 'POST',
        headers: { authorization: auth },
      });
      const other = (await otherOpen.json()) as { sessionSecret: string };
      // Re-claim to get a fresh series for handoff negative (prior may be forfeited).
      const claimed2 = await fetch(`${env.base}/v1/tournament/claims/daily`, {
        method: 'POST',
        headers: {
          authorization: auth,
          'x-pzd-session-secret': session.sessionSecret,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ originalUtcDate: env.today }),
      });
      const c2 = (await claimed2.json()) as { seriesId: string };
      const steal = await fetch(
        `${env.base}/v1/tournament/series/${c2.seriesId}/commands`,
        {
          method: 'POST',
          headers: {
            authorization: auth,
            'x-pzd-session-secret': other.sessionSecret,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            commandType: 'device_handoff',
            idempotencyKey: 'steal',
            expectedWriterGeneration: 1,
          }),
        },
      );
      assert.equal(steal.status, 409);
    } finally {
      await env.close();
    }
  });

  it('PZD-45: Player B cannot POST a move onto Player A ranked series', async () => {
    const env = await boot();
    try {
      const authA = env.bearer('pzd45-owner-a');
      const openA = await fetch(`${env.base}/v1/tournament/session`, {
        method: 'POST',
        headers: { authorization: authA },
      });
      assert.equal(openA.status, 201);
      const sessionA = (await openA.json()) as { sessionSecret: string };
      const headersA = {
        authorization: authA,
        'x-pzd-session-secret': sessionA.sessionSecret,
        'content-type': 'application/json',
      };
      const claimed = await fetch(`${env.base}/v1/tournament/claims/daily`, {
        method: 'POST',
        headers: headersA,
        body: JSON.stringify({ originalUtcDate: env.today }),
      });
      assert.equal(claimed.status, 201);
      const claim = (await claimed.json()) as { seriesId: string };

      const authB = env.bearer('pzd45-attacker-b');
      const openB = await fetch(`${env.base}/v1/tournament/session`, {
        method: 'POST',
        headers: { authorization: authB },
      });
      assert.equal(openB.status, 201);
      const sessionB = (await openB.json()) as { sessionSecret: string };
      const steal = await fetch(
        `${env.base}/v1/tournament/series/${claim.seriesId}/commands`,
        {
          method: 'POST',
          headers: {
            authorization: authB,
            'x-pzd-session-secret': sessionB.sessionSecret,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            commandType: 'move',
            idempotencyKey: 'cross-player-steal',
            move: {
              offerIndex: 0,
              tap: [0, 0],
              expectedBoardRevision: 0,
              writerGeneration: 1,
            },
          }),
        },
      );
      assert.ok(
        [404, 409].includes(steal.status),
        `cross-player move must fail closed, got ${steal.status}`,
      );
      const ledger = await env.pool.query(
        'SELECT count(*)::int AS n FROM accepted_move_ledger',
      );
      assert.equal(ledger.rows[0].n, 0);
      const fence = await env.pool.query(
        'SELECT board_revision FROM series_fence_state WHERE series_key = $1',
        [claim.seriesId],
      );
      if (fence.rows.length > 0) {
        assert.equal(Number(fence.rows[0].board_revision), 0);
      }
    } finally {
      await env.close();
    }
  });

  it('PZD-45: expired DB session cannot submit ranked commands (writer fencing intact)', async () => {
    const env = await boot();
    try {
      const auth = env.bearer('pzd45-expired');
      const opened = await fetch(`${env.base}/v1/tournament/session`, {
        method: 'POST',
        headers: { authorization: auth },
      });
      assert.equal(opened.status, 201);
      const session = (await opened.json()) as {
        sessionSecret: string;
        sessionId?: string;
      };
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
      const claim = (await claimed.json()) as { seriesId: string };

      // Expire the verified session row while the JWT remains within exp.
      // Current contract: fail-closed; no silent writer takeover/recovery.
      await env.pool.query(
        'UPDATE tournament_auth_session SET expires_at_ms = 1',
      );

      const afterExpiry = await fetch(
        `${env.base}/v1/tournament/series/${claim.seriesId}/commands`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            commandType: 'move',
            idempotencyKey: 'after-expiry',
            move: {
              offerIndex: 0,
              tap: [0, 0],
              expectedBoardRevision: 0,
              writerGeneration: 1,
            },
          }),
        },
      );
      assert.equal(afterExpiry.status, 401);
      const body = (await afterExpiry.json()) as { error?: string };
      assert.equal(body.error, 'UNAUTHENTICATED');
      const ledger = await env.pool.query(
        'SELECT count(*)::int AS n FROM accepted_move_ledger',
      );
      assert.equal(ledger.rows[0].n, 0);
    } finally {
      await env.close();
    }
  });
  it('accepted move includes owned post-admission board matching GET /board', async () => {
    const env = await boot();
    try {
      const auth = env.bearer('pzd50-latency-authorized');
      const open = await fetch(`${env.base}/v1/tournament/session`, {
        method: 'POST', headers: { authorization: auth },
      });
      assert.equal(open.status, 201);
      const session = (await open.json()) as { sessionSecret: string };
      const headers = {
        authorization: auth,
        'x-pzd-session-secret': session.sessionSecret,
        'content-type': 'application/json',
      };
      const claimResult = await fetch(`${env.base}/v1/tournament/claims/daily`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ originalUtcDate: env.today }),
      });
      assert.equal(claimResult.status, 201);
      const claim = (await claimResult.json()) as { seriesId: string };
      const boardBeforeResponse = await fetch(
        `${env.base}/v1/tournament/series/${claim.seriesId}/board`, { headers });
      assert.equal(boardBeforeResponse.status, 200);
      const before = (await boardBeforeResponse.json()) as {
        boardRevision: number; writerGeneration: number;
      };
      const accepted = await fetch(
        `${env.base}/v1/tournament/series/${claim.seriesId}/commands`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            commandType: 'move',
            idempotencyKey: 'pzd50-embedded-board',
            move: {
              offerIndex: 0,
              tap: [0, 0],
              expectedBoardRevision: before.boardRevision,
              writerGeneration: before.writerGeneration,
            },
          }),
        },
      );
      assert.equal(accepted.status, 200);
      const response = (await accepted.json()) as {
        boardRevision: number; stateHash: string;
        authoritativeBoard?: {
          seriesId: string; boardRevision: number; stateHash: string;
          state: unknown;
        };
      };
      assert.ok(response.authoritativeBoard, 'server should include a verified, owned post-move board');
      assert.equal(response.authoritativeBoard.seriesId, claim.seriesId);
      assert.equal(response.authoritativeBoard.boardRevision, response.boardRevision);
      assert.equal(response.authoritativeBoard.stateHash, response.stateHash);
      assert.deepEqual(response.authoritativeBoard.state, fixture.expected.finalState);
      const fetched = await fetch(
        `${env.base}/v1/tournament/series/${claim.seriesId}/board`, { headers });
      assert.equal(fetched.status, 200);
      const after = (await fetched.json()) as { stateHash: string; boardRevision: number };
      assert.equal(response.authoritativeBoard.stateHash, after.stateHash);
      assert.equal(response.authoritativeBoard.boardRevision, after.boardRevision);
    } finally {
      await env.close();
    }
  });

});
