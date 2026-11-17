/**
 * PZD-40 P0-F11/F12 and P1-F13/F14/F15 adversarial PostgreSQL proofs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';
import pg from 'pg';
import { ControllableClock } from '../../../src/tournament/ingress/clock.mts';
import { PostgresAdmissionJournal } from '../../../src/tournament/ingress/postgres-journal.mts';
import { PostgresSeriesFenceStore } from '../../../src/tournament/ingress/series-fence.mts';
import { isTimely } from '../../../src/tournament/ingress/types.mts';
import { PinnedRs256JwtVerifier } from '../../../src/tournament/auth/pinned-jwt-verifier.mts';
import { PostgresVerifiedIdentitySessionStore } from '../../../src/tournament/auth/postgres-verified-sessions.mts';
import { PostgresSeriesWriterStore } from '../../../src/tournament/auth/series-writer-binding.mts';
import { SessionAuthorizationGateway } from '../../../src/tournament/auth/session-authorization-gateway.mts';
import { AtomicDailyClaimBootstrap } from '../../../src/tournament/claims/atomic-claim-bootstrap.mts';
import {
  digestManifestPayload,
  PinnedManifestRegistry,
} from '../../../src/tournament/claims/pinned-manifest-registry.mts';
import {
  computeSeriesHardCutoffMs,
  parseUtcDateMs,
  utcWeekMondayMs,
} from '../../../src/tournament/claims/hard-cutoff.mts';
import { resolveActiveSubgameOrdinal } from '../../../src/tournament/claims/active-ordinal.mts';
import { AtomicDeviceHandoffUnitOfWork } from '../../../src/tournament/adjudication/atomic-device-handoff.mts';
import {
  TrustedGameplayService,
  PostgresTrustedChallengeStore,
  PostgresAcceptedMoveLedger,
  PostgresAuthoritativeSnapshotStore,
  PostgresTrustedUnitOfWork,
} from '../../../src/tournament/adjudication/index.mts';

const url = process.env.PZD_INGRESS_DATABASE_URL;
assert.ok(url, 'PostgreSQL required — do not skip');

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
    contentVersion: 'f1-rem',
    initialState: fixture.initialState,
  }));
  const contentVersion = 'f1-rem-manifest';
  const digest = digestManifestPayload(contentVersion, subgames);
  return new PinnedManifestRegistry(
    [{ digest, contentVersion, subgames }],
    digest,
  );
}

async function setup() {
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
        keyId: 'k1',
        rsaPublicKeyPem: pair.publicKey
          .export({ type: 'spki', format: 'pem' })
          .toString(),
      },
    ],
    maxTokenAgeSeconds: 900,
  });
  function identity(sub: string) {
    const now = Math.floor(Date.now() / 1000);
    const head = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: 'k1' }),
    ).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        iss: issuer,
        aud: audience,
        sub,
        iat: now - 5,
        exp: now + 400,
      }),
    ).toString('base64url');
    const msg = head + '.' + body;
    return verifier.verifyAuthorizationHeader(
      'Bearer ' +
        msg +
        '.' +
        sign('RSA-SHA256', Buffer.from(msg), pair.privateKey).toString(
          'base64url',
        ),
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
  const today = new Date().toISOString().slice(0, 10);

  function gameplay(session: {
    playerId: string;
    sessionId: string;
    deviceId: string;
    expiresAtMs: number;
  }) {
    const gateway = new SessionAuthorizationGateway({
      session,
      writers,
      loadOwnedClaim: (p, k) => claims.getClaimForPlayer(p, k),
      resolveActiveOrdinal: (k, p) => resolveActiveSubgameOrdinal(pool, k, p),
    });
    return new TrustedGameplayService({
      journal,
      fence,
      challenges: new PostgresTrustedChallengeStore(pool),
      ledger: new PostgresAcceptedMoveLedger(pool),
      snapshots: new PostgresAuthoritativeSnapshotStore(pool),
      clock,
      authorization: gateway,
      postgresUow: uow,
      deviceHandoffUow: handoffUow,
      resolveActiveOrdinal: (k, p) => resolveActiveSubgameOrdinal(pool, k, p),
    });
  }

  return {
    pool,
    sessions,
    claims,
    writers,
    fence,
    journal,
    handoffUow,
    identity,
    gameplay,
    today,
    clock,
  };
}

describe('PZD-40 P0-F11 — stale non-writer cannot seize writer', () => {
  it('only active writer session may handoff; other same-player session rejected', async () => {
    const env = await setup();
    try {
      const a = await env.sessions.openAfterVerifiedJwt(env.identity('w1'));
      const claimed = await env.claims.claimAndBootstrap({
        session: {
          playerId: a.playerId,
          sessionId: a.sessionId,
          deviceId: a.deviceId,
          expiresAtMs: a.expiresAtMs,
        },
        originalUtcDate: env.today,
      });
      assert.equal(claimed.ok, true);
      if (!claimed.ok) return;
      const b = await env.sessions.openAfterVerifiedJwt(env.identity('w1'));
      const svcB = env.gameplay({
        playerId: b.playerId,
        sessionId: b.sessionId,
        deviceId: b.deviceId,
        expiresAtMs: b.expiresAtMs,
      });
      const steal = await svcB.handleClientCommand(
        {
          commandType: 'device_handoff',
          idempotencyKey: 'steal-1',
          expectedWriterGeneration: 1,
        },
        {
          seriesKeyHint: claimed.claim.seriesId,
          playerIdHint: b.playerId,
          writerGenerationHint: 1,
        },
      );
      assert.equal(steal.decision, 'reject');
      if (steal.decision === 'reject') {
        assert.equal(steal.reason, 'WRITER_NOT_AUTHORIZED');
      }
      const writer = await env.writers.get(claimed.claim.seriesId);
      assert.equal(writer!.sessionId, a.sessionId);
      assert.equal(writer!.writerGeneration, 1);
      const fence = await env.fence.get(claimed.claim.seriesId);
      assert.equal(fence!.writerGeneration, 1);
    } finally {
      await env.pool.end();
    }
  });
});

describe('PZD-40 P0-F12 / P1-F15 — atomic handoff + idempotency', () => {
  it('handoff advances writer+fence+snapshot together; same-key retry does not re-bump', async () => {
    const env = await setup();
    try {
      const a = await env.sessions.openAfterVerifiedJwt(env.identity('h1'));
      const claimed = await env.claims.claimAndBootstrap({
        session: {
          playerId: a.playerId,
          sessionId: a.sessionId,
          deviceId: a.deviceId,
          expiresAtMs: a.expiresAtMs,
        },
        originalUtcDate: env.today,
      });
      assert.equal(claimed.ok, true);
      if (!claimed.ok) return;
      const svc = env.gameplay({
        playerId: a.playerId,
        sessionId: a.sessionId,
        deviceId: a.deviceId,
        expiresAtMs: a.expiresAtMs,
      });
      const first = await svc.handleClientCommand(
        {
          commandType: 'device_handoff',
          idempotencyKey: 'ho-1',
          expectedWriterGeneration: 1,
        },
        {
          seriesKeyHint: claimed.claim.seriesId,
          playerIdHint: a.playerId,
          writerGenerationHint: 1,
        },
      );
      assert.equal(first.decision, 'apply');
      const writer = await env.writers.get(claimed.claim.seriesId);
      const fence = await env.fence.get(claimed.claim.seriesId);
      const snap = await env.pool.query(
        `SELECT writer_generation FROM authoritative_game_snapshot
         WHERE series_key=$1 AND subgame_ordinal=1`,
        [claimed.claim.seriesId],
      );
      assert.equal(writer!.writerGeneration, 2);
      assert.equal(fence!.writerGeneration, 2);
      assert.equal(Number(snap.rows[0].writer_generation), 2);

      const retry = await svc.handleClientCommand(
        {
          commandType: 'device_handoff',
          idempotencyKey: 'ho-1',
          expectedWriterGeneration: 1,
        },
        {
          seriesKeyHint: claimed.claim.seriesId,
          playerIdHint: a.playerId,
          writerGenerationHint: 2,
        },
      );
      assert.equal(retry.decision, 'apply');
      if (retry.decision === 'apply') assert.equal(retry.duplicateReplay, true);
      assert.equal((await env.writers.get(claimed.claim.seriesId))!.writerGeneration, 2);
      assert.equal((await env.fence.get(claimed.claim.seriesId))!.writerGeneration, 2);

      const conflict = await svc.handleClientCommand(
        {
          commandType: 'device_handoff',
          idempotencyKey: 'ho-1',
          expectedWriterGeneration: 2,
        },
        {
          seriesKeyHint: claimed.claim.seriesId,
          playerIdHint: a.playerId,
          writerGenerationHint: 2,
        },
      );
      assert.equal(conflict.decision, 'reject');
      if (conflict.decision === 'reject') {
        assert.equal(conflict.reason, 'IDEMPOTENCY_PAYLOAD_CONFLICT');
      }
    } finally {
      await env.pool.end();
    }
  });

  it('stale expected generation rejects with zero mutations', async () => {
    const env = await setup();
    try {
      const a = await env.sessions.openAfterVerifiedJwt(env.identity('h2'));
      const claimed = await env.claims.claimAndBootstrap({
        session: {
          playerId: a.playerId,
          sessionId: a.sessionId,
          deviceId: a.deviceId,
          expiresAtMs: a.expiresAtMs,
        },
        originalUtcDate: env.today,
      });
      assert.equal(claimed.ok, true);
      if (!claimed.ok) return;
      const svc = env.gameplay({
        playerId: a.playerId,
        sessionId: a.sessionId,
        deviceId: a.deviceId,
        expiresAtMs: a.expiresAtMs,
      });
      const bad = await svc.handleClientCommand(
        {
          commandType: 'device_handoff',
          idempotencyKey: 'ho-stale',
          expectedWriterGeneration: 99,
        },
        {
          seriesKeyHint: claimed.claim.seriesId,
          playerIdHint: a.playerId,
          writerGenerationHint: 1,
        },
      );
      assert.equal(bad.decision, 'reject');
      assert.equal((await env.writers.get(claimed.claim.seriesId))!.writerGeneration, 1);
      assert.equal((await env.fence.get(claimed.claim.seriesId))!.writerGeneration, 1);
    } finally {
      await env.pool.end();
    }
  });
});

describe('PZD-40 P1-F13 — trusted hard cutoff R-01', () => {
  it('same-day claim uses min(next-day 00:15, week Monday+7d 01:00)', () => {
    const originalUtcDate = '2026-11-17'; // Tuesday
    const startedAtMs = Date.parse('2026-11-17T15:00:00.000Z');
    const cutoff = computeSeriesHardCutoffMs({ originalUtcDate, startedAtMs });
    assert.ok(cutoff !== null);
    const nextDay0015 = Date.parse('2026-11-18T00:15:00.000Z');
    const weekMon = utcWeekMondayMs(parseUtcDateMs(originalUtcDate)!);
    const weekEnd = weekMon + 7 * 86400000 + 3600000;
    assert.equal(cutoff, Math.min(nextDay0015, weekEnd));
    assert.equal(isTimely(new Date(cutoff! - 1), new Date(cutoff!)), true);
    assert.equal(isTimely(new Date(cutoff!), new Date(cutoff!)), false);
    assert.equal(isTimely(new Date(cutoff! + 1), new Date(cutoff!)), false);
  });

  it('retrospective same-week claim is NOT bound by original+1 00:15', () => {
    const originalUtcDate = '2026-11-16'; // Monday
    const startedAtMs = Date.parse('2026-11-18T12:00:00.000Z'); // Wed claim of Mon date
    const cutoff = computeSeriesHardCutoffMs({ originalUtcDate, startedAtMs });
    const nextDay0015 = Date.parse('2026-11-17T00:15:00.000Z');
    const weekMon = utcWeekMondayMs(parseUtcDateMs(originalUtcDate)!);
    const weekEnd = weekMon + 7 * 86400000 + 3600000;
    assert.equal(cutoff, weekEnd);
    assert.ok(cutoff! > nextDay0015);
  });

  it('bootstrap persists non-null hard_cutoff_at_ms', async () => {
    const env = await setup();
    try {
      const a = await env.sessions.openAfterVerifiedJwt(env.identity('cut'));
      const claimed = await env.claims.claimAndBootstrap({
        session: {
          playerId: a.playerId,
          sessionId: a.sessionId,
          deviceId: a.deviceId,
          expiresAtMs: a.expiresAtMs,
        },
        originalUtcDate: env.today,
      });
      assert.equal(claimed.ok, true);
      if (!claimed.ok) return;
      const fence = await env.fence.get(claimed.claim.seriesId);
      assert.ok(fence!.hardCutoffAt);
      assert.ok(fence!.hardCutoffAt!.getTime() > claimed.claim.startedAtMs);
    } finally {
      await env.pool.end();
    }
  });
});

describe('PZD-40 P1-F14 — canonical ordinal progression', () => {
  it('starts at 1; after ended+advance becomes 2; client ordinal not accepted', async () => {
    const env = await setup();
    try {
      const a = await env.sessions.openAfterVerifiedJwt(env.identity('ord'));
      const claimed = await env.claims.claimAndBootstrap({
        session: {
          playerId: a.playerId,
          sessionId: a.sessionId,
          deviceId: a.deviceId,
          expiresAtMs: a.expiresAtMs,
        },
        originalUtcDate: env.today,
      });
      assert.equal(claimed.ok, true);
      if (!claimed.ok) return;
      assert.equal(
        await resolveActiveSubgameOrdinal(
          env.pool,
          claimed.claim.seriesId,
          a.playerId,
        ),
        1,
      );
      // Six challenge bindings pinned at claim.
      const n = await env.pool.query(
        `SELECT count(*)::int AS n FROM trusted_challenge_binding WHERE series_key=$1`,
        [claimed.claim.seriesId],
      );
      assert.equal(n.rows[0].n, 6);

      // Simulate E1 terminal + AWAIT_ADVANCE.
      await env.pool.query(
        `UPDATE authoritative_game_snapshot SET status='ended' WHERE series_key=$1 AND subgame_ordinal=1`,
        [claimed.claim.seriesId],
      );
      await env.pool.query(
        `UPDATE series_fence_state SET status='AWAIT_ADVANCE' WHERE series_key=$1`,
        [claimed.claim.seriesId],
      );
      assert.equal(
        await resolveActiveSubgameOrdinal(
          env.pool,
          claimed.claim.seriesId,
          a.playerId,
        ),
        1,
      );

      const svc = env.gameplay({
        playerId: a.playerId,
        sessionId: a.sessionId,
        deviceId: a.deviceId,
        expiresAtMs: a.expiresAtMs,
      });
      const adv = await svc.handleClientCommand(
        { commandType: 'advance', idempotencyKey: 'adv-1' },
        {
          seriesKeyHint: claimed.claim.seriesId,
          playerIdHint: a.playerId,
          writerGenerationHint: 1,
        },
      );
      assert.equal(adv.decision, 'apply');
      assert.equal(
        await resolveActiveSubgameOrdinal(
          env.pool,
          claimed.claim.seriesId,
          a.playerId,
        ),
        2,
      );
      const snap2 = await env.pool.query(
        `SELECT status FROM authoritative_game_snapshot
         WHERE series_key=$1 AND subgame_ordinal=2`,
        [claimed.claim.seriesId],
      );
      assert.equal(snap2.rows[0].status, 'in_progress');

      // Illegal skip: advance again without ending ordinal 2.
      const skip = await svc.handleClientCommand(
        { commandType: 'advance', idempotencyKey: 'adv-2' },
        {
          seriesKeyHint: claimed.claim.seriesId,
          playerIdHint: a.playerId,
          writerGenerationHint: 1,
        },
      );
      assert.equal(skip.decision, 'reject');
      if (skip.decision === 'reject') {
        assert.equal(skip.reason, 'ADVANCE_NOT_ELIGIBLE');
      }
    } finally {
      await env.pool.end();
    }
  });
});
