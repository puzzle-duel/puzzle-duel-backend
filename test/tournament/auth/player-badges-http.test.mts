/**
 * PZD-43 — GET /v1/tournament/me/badges auth and isolation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import pg from 'pg';
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
import { PostgresSeriesFenceStore } from '../../../src/tournament/ingress/series-fence.mts';
import { ControllableClock } from '../../../src/tournament/ingress/clock.mts';
import { PostgresAdmissionJournal } from '../../../src/tournament/ingress/postgres-journal.mts';
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
import { DAILY_CLAIM_DDL } from '../../../src/tournament/claims/postgres-daily-claim.mts';
import {
  F2A_PUBLICATION_DROP_DDL,
  migrateF2APublicationSchema,
  publicationIdempotencyKey,
} from '../../../src/tournament/results/f2a-publication-schema.mts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.PZD_INGRESS_DATABASE_URL;

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

describe('PZD-43 GET /v1/tournament/me/badges', () => {
  it('requires auth and isolates players', async (t) => {
    if (!url) {
      t.skip('PostgreSQL required');
      return;
    }

    const pool = new pg.Pool({ connectionString: url, max: 8 });
    for (const sql of [
      'DROP TABLE IF EXISTS tournament_series_writer',
      'DROP TABLE IF EXISTS authoritative_game_snapshot',
      'DROP TABLE IF EXISTS accepted_move_ledger',
      'DROP TABLE IF EXISTS trusted_challenge_binding',
      'DROP TABLE IF EXISTS series_fence_state',
      'DROP TABLE IF EXISTS command_admission_journal',
      'DROP TABLE IF EXISTS tournament_auth_session',
      'DROP TABLE IF EXISTS tournament_verified_identity',
    ]) {
      await pool.query(sql);
    }
    await pool.query(F2A_PUBLICATION_DROP_DDL);
    await pool.query('DROP TABLE IF EXISTS tournament_daily_claim CASCADE');
    await pool.query(DAILY_CLAIM_DDL);
    await migrateF2APublicationSchema(pool);

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
    function bearer(sub: string) {
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

    const subgames = [1, 2, 3, 4, 5, 6].map((ordinal) => ({
      ordinal,
      challengeId: `chal-${ordinal}`,
      generatorVersion: 'gen-001.v1-adapter-test',
      contentVersion: 'f1-http',
      initialState: fixture.initialState,
    }));
    const contentVersion = 'f1-http-manifest';
    const digest = digestManifestPayload(contentVersion, subgames);
    const manifests = new PinnedManifestRegistry(
      [{ digest, contentVersion, subgames }],
      digest,
    );

    const sessions = new PostgresVerifiedIdentitySessionStore(pool);
    await sessions.migrate();
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

    t.after(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await pool.query(F2A_PUBLICATION_DROP_DDL);
      await pool.end();
    });

    assert.equal((await fetch(`${base}/v1/tournament/me/badges`)).status, 401);

    const openA = await fetch(`${base}/v1/tournament/session`, {
      method: 'POST',
      headers: { authorization: bearer('badge-user-a') },
    });
    assert.equal(openA.status, 201);
    const sessionA = (await openA.json()) as {
      sessionSecret: string;
      playerId: string;
    };
    assert.match(
      sessionA.playerId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const headersA = {
      authorization: bearer('badge-user-a'),
      'x-pzd-session-secret': sessionA.sessionSecret,
    };

    const openB = await fetch(`${base}/v1/tournament/session`, {
      method: 'POST',
      headers: { authorization: bearer('badge-user-b') },
    });
    const sessionB = (await openB.json()) as { sessionSecret: string };
    const headersB = {
      authorization: bearer('badge-user-b'),
      'x-pzd-session-secret': sessionB.sessionSecret,
    };

    const idA = await pool.query(
      `SELECT player_id FROM tournament_verified_identity WHERE subject = $1`,
      ['badge-user-a'],
    );
    const idB = await pool.query(
      `SELECT player_id FROM tournament_verified_identity WHERE subject = $1`,
      ['badge-user-b'],
    );
    const playerA = String(idA.rows[0]?.player_id);
    const playerB = String(idB.rows[0]?.player_id);
    const seriesA = randomUUID();
    const seriesB = randomUUID();
    const started = Date.parse('2026-11-17T12:00:00.000Z');

    async function seed(playerId: string, seriesId: string, date: string) {
      await pool.query(
        `INSERT INTO tournament_daily_claim
           (series_id, player_id, original_utc_date, started_at_ms, manifest_digest, status)
         VALUES ($1,$2,$3::date,$4,$5,'COMPLETED')`,
        [seriesId, playerId, date, started, 'a'.repeat(64)],
      );
      await pool.query(
        `INSERT INTO tournament_daily_series_completion
           (series_id, player_id, original_utc_date, claim_started_at_ms, completed_at_ms,
            manifest_digest, publication_idempotency_key, revision)
         VALUES ($1,$2,$3::date,$4,$5,$6,$7,1)`,
        [
          seriesId,
          playerId,
          date,
          started,
          started + 60_000,
          'a'.repeat(64),
          publicationIdempotencyKey(seriesId),
        ],
      );
      await pool.query(
        `INSERT INTO tournament_on_time_badge
           (series_id, awarded, claim_started_at_ms, original_utc_date)
         VALUES ($1,true,$2,$3::date)`,
        [seriesId, started, date],
      );
    }

    await seed(playerA, seriesA, '2026-11-17');
    await seed(playerB, seriesB, '2026-11-17');

    const forA = await fetch(`${base}/v1/tournament/me/badges`, {
      headers: headersA,
    });
    assert.equal(forA.status, 200);
    const bodyA = (await forA.json()) as {
      badges: Array<{ earnedCount: number; grants: Array<{ seriesId: string }> }>;
    };
    assert.equal(bodyA.badges[0]?.earnedCount, 1);
    assert.equal(bodyA.badges[0]?.grants[0]?.seriesId, seriesA);

    // Account-scoped: bearer alone (no tournament session secret) must succeed.
    const bearerOnly = await fetch(`${base}/v1/profile/me/badges`, {
      headers: { authorization: bearer('badge-user-a') },
    });
    assert.equal(bearerOnly.status, 200);
    const bearerBody = (await bearerOnly.json()) as {
      badges: Array<{ earnedCount: number; grants: Array<{ seriesId: string }> }>;
    };
    assert.equal(bearerBody.badges[0]?.earnedCount, 1);
    assert.equal(bearerBody.badges[0]?.grants[0]?.seriesId, seriesA);

    const legacyBearerOnly = await fetch(`${base}/v1/tournament/me/badges`, {
      headers: { authorization: bearer('badge-user-a') },
    });
    assert.equal(legacyBearerOnly.status, 200);

    const forB = await fetch(`${base}/v1/tournament/me/badges`, {
      headers: headersB,
    });
    const bodyB = (await forB.json()) as {
      badges: Array<{ grants: Array<{ seriesId: string }> }>;
    };
    assert.equal(bodyB.badges[0]?.grants[0]?.seriesId, seriesB);
    assert.notEqual(bodyB.badges[0]?.grants[0]?.seriesId, seriesA);

    const badLimit = await fetch(`${base}/v1/tournament/me/badges?grantLimit=0`, {
      headers: headersA,
    });
    assert.equal(badLimit.status, 400);
  });
});
