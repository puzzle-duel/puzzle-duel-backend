/**
 * PZD-40 F1 independent re-review P1-R01 / P1-R02 / P1-R03
 * PostgreSQL 18 transactional integrity proofs.
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
import {
  OrdinalIntegrityError,
  resolveActiveSubgameOrdinal,
} from '../../../src/tournament/claims/active-ordinal.mts';
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
    contentVersion: 'f1-r2',
    initialState: fixture.initialState,
  }));
  const contentVersion = 'f1-r2-manifest';
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

  async function claimSeries(sub: string) {
    const a = await sessions.openAfterVerifiedJwt(identity(sub));
    const claimed = await claims.claimAndBootstrap({
      session: {
        playerId: a.playerId,
        sessionId: a.sessionId,
        deviceId: a.deviceId,
        expiresAtMs: a.expiresAtMs,
      },
      originalUtcDate: today,
    });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) throw new Error('claim_failed');
    return { session: a, claim: claimed.claim };
  }

  async function bindingState(seriesKey: string, playerId: string) {
    const writer = await writers.get(seriesKey);
    const f = await fence.get(seriesKey);
    const snap = await pool.query(
      `SELECT writer_generation, status, subgame_ordinal
       FROM authoritative_game_snapshot
       WHERE series_key=$1 AND player_id=$2
       ORDER BY subgame_ordinal`,
      [seriesKey, playerId],
    );
    const adm = await pool.query(
      `SELECT admission_id, outcome, result_json IS NOT NULL AS has_result
       FROM command_admission_journal
       WHERE series_key=$1
       ORDER BY trusted_received_at_ms, admission_id`,
      [seriesKey],
    );
    return {
      writerGen: writer?.writerGeneration ?? null,
      writerSession: writer?.sessionId ?? null,
      fenceGen: f?.writerGeneration ?? null,
      fenceLast: f?.lastAppliedAdmissionId ?? null,
      snaps: snap.rows.map((r) => ({
        ordinal: Number(r.subgame_ordinal),
        gen: Number(r.writer_generation),
        status: String(r.status),
      })),
      admissions: adm.rows.map((r) => ({
        id: String(r.admission_id),
        outcome: String(r.outcome),
        hasResult: Boolean(r.has_result),
      })),
    };
  }

  async function admitPendingHandoff(args: {
    seriesKey: string;
    playerId: string;
    idempotencyKey: string;
  }) {
    const admit = await journal.admit({
      seriesKey: args.seriesKey,
      playerId: args.playerId,
      commandType: 'device_handoff',
      idempotencyKey: args.idempotencyKey,
      payloadHash: `hash-${args.idempotencyKey}`,
      writerGeneration: 1,
    });
    assert.equal(admit.ok, true);
    if (!admit.ok) throw new Error('admit_failed');
    return admit.command.admissionId;
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
    claimSeries,
    bindingState,
    admitPendingHandoff,
  };
}

describe('P1-R01 — atomic snapshot integrity', () => {
  it('missing snapshot rolls back writer/fence/admission unchanged', async () => {
    const env = await setup();
    try {
      const { session, claim } = await env.claimSeries('r01-miss');
      const before = await env.bindingState(claim.seriesId, session.playerId);
      assert.equal(before.writerGen, 1);
      assert.equal(before.snaps.length, 1);

      await env.pool.query(
        `DELETE FROM authoritative_game_snapshot
         WHERE series_key=$1 AND subgame_ordinal=1`,
        [claim.seriesId],
      );
      const admissionId = await env.admitPendingHandoff({
        seriesKey: claim.seriesId,
        playerId: session.playerId,
        idempotencyKey: 'r01-miss-ho',
      });

      await assert.rejects(
        () =>
          env.handoffUow.commit({
            seriesKey: claim.seriesId,
            playerId: session.playerId,
            subgameOrdinal: 1,
            admissionId,
            trustedReceivedAt: new Date(),
            callerSessionId: session.sessionId,
            callerDeviceId: session.deviceId,
            expectedWriterGeneration: 1,
          }),
        (err: unknown) =>
          err instanceof Error && err.message === 'HANDOFF_UNAVAILABLE',
      );

      const after = await env.bindingState(claim.seriesId, session.playerId);
      assert.equal(after.writerGen, 1);
      assert.equal(after.fenceGen, 1);
      assert.equal(after.fenceLast, null);
      assert.equal(after.snaps.length, 0);
      const pending = after.admissions.find((a) => a.id === admissionId);
      assert.ok(pending);
      assert.equal(pending!.outcome, 'pending');
      assert.equal(pending!.hasResult, false);
    } finally {
      await env.pool.end();
    }
  });

  it('mismatched subgame ordinal snapshot miss rolls back', async () => {
    const env = await setup();
    try {
      const { session, claim } = await env.claimSeries('r01-ord');
      const admissionId = await env.admitPendingHandoff({
        seriesKey: claim.seriesId,
        playerId: session.playerId,
        idempotencyKey: 'r01-ord-ho',
      });
      await assert.rejects(
        () =>
          env.handoffUow.commit({
            seriesKey: claim.seriesId,
            playerId: session.playerId,
            subgameOrdinal: 3, // only ordinal 1 exists
            admissionId,
            trustedReceivedAt: new Date(),
            callerSessionId: session.sessionId,
            callerDeviceId: session.deviceId,
            expectedWriterGeneration: 1,
          }),
        (err: unknown) =>
          err instanceof Error && err.message === 'HANDOFF_UNAVAILABLE',
      );
      const after = await env.bindingState(claim.seriesId, session.playerId);
      assert.equal(after.writerGen, 1);
      assert.equal(after.fenceGen, 1);
      assert.equal(after.snaps[0]!.gen, 1);
      assert.equal(
        after.admissions.find((a) => a.id === admissionId)!.outcome,
        'pending',
      );
    } finally {
      await env.pool.end();
    }
  });
});

describe('P1-R02 — admission outcome integrity', () => {
  it('non-pending admission without durable result rejects with zero mutations', async () => {
    const env = await setup();
    try {
      const { session, claim } = await env.claimSeries('r02-np');
      const admissionId = await env.admitPendingHandoff({
        seriesKey: claim.seriesId,
        playerId: session.playerId,
        idempotencyKey: 'r02-np-ho',
      });
      // Tamper: mark applied without result_json (corrupt journal).
      await env.pool.query(
        `UPDATE command_admission_journal
         SET outcome='applied', result_json=NULL
         WHERE admission_id=$1`,
        [admissionId],
      );
      const before = await env.bindingState(claim.seriesId, session.playerId);
      const out = await env.handoffUow.commit({
        seriesKey: claim.seriesId,
        playerId: session.playerId,
        subgameOrdinal: 1,
        admissionId,
        trustedReceivedAt: new Date(),
        callerSessionId: session.sessionId,
        callerDeviceId: session.deviceId,
        expectedWriterGeneration: 1,
      });
      assert.equal(out.decision, 'reject');
      if (out.decision === 'reject') {
        assert.equal(out.reason, 'SERIES_TERMINAL');
      }
      const after = await env.bindingState(claim.seriesId, session.playerId);
      assert.deepEqual(
        { writerGen: after.writerGen, fenceGen: after.fenceGen, snaps: after.snaps },
        {
          writerGen: before.writerGen,
          fenceGen: before.fenceGen,
          snaps: before.snaps,
        },
      );
    } finally {
      await env.pool.end();
    }
  });

  it('same-key replay returns original outcome without re-bump', async () => {
    const env = await setup();
    try {
      const { session, claim } = await env.claimSeries('r02-replay');
      const svc = env.gameplay({
        playerId: session.playerId,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        expiresAtMs: session.expiresAtMs,
      });
      const first = await svc.handleClientCommand(
        {
          commandType: 'device_handoff',
          idempotencyKey: 'r02-idem',
          expectedWriterGeneration: 1,
        },
        {
          seriesKeyHint: claim.seriesId,
          playerIdHint: session.playerId,
          writerGenerationHint: 1,
        },
      );
      assert.equal(first.decision, 'apply');
      const mid = await env.bindingState(claim.seriesId, session.playerId);
      assert.equal(mid.writerGen, 2);

      const replay = await svc.handleClientCommand(
        {
          commandType: 'device_handoff',
          idempotencyKey: 'r02-idem',
          expectedWriterGeneration: 1,
        },
        {
          seriesKeyHint: claim.seriesId,
          playerIdHint: session.playerId,
          writerGenerationHint: 2,
        },
      );
      assert.equal(replay.decision, 'apply');
      if (replay.decision === 'apply') assert.equal(replay.duplicateReplay, true);
      const after = await env.bindingState(claim.seriesId, session.playerId);
      assert.equal(after.writerGen, 2);
      assert.equal(after.fenceGen, 2);
      assert.equal(after.snaps[0]!.gen, 2);
    } finally {
      await env.pool.end();
    }
  });

  it('fault: pending row deleted mid-flight → rollback, no writer bump', async () => {
    const env = await setup();
    try {
      const { session, claim } = await env.claimSeries('r02-del');
      const admissionId = await env.admitPendingHandoff({
        seriesKey: claim.seriesId,
        playerId: session.playerId,
        idempotencyKey: 'r02-del-ho',
      });
      // Simulate concurrent journal deletion after SELECT would see the row:
      // force outcome update to match zero rows by flipping away from pending
      // then restoring a non-pending row so writeOutcome rowCount=0.
      // Direct approach: delete the pending row so FOR UPDATE finds nothing.
      await env.pool.query(
        `DELETE FROM command_admission_journal WHERE admission_id=$1`,
        [admissionId],
      );
      const out = await env.handoffUow.commit({
        seriesKey: claim.seriesId,
        playerId: session.playerId,
        subgameOrdinal: 1,
        admissionId,
        trustedReceivedAt: new Date(),
        callerSessionId: session.sessionId,
        callerDeviceId: session.deviceId,
        expectedWriterGeneration: 1,
      });
      assert.equal(out.decision, 'reject');
      assert.equal((await env.writers.get(claim.seriesId))!.writerGeneration, 1);
      assert.equal((await env.fence.get(claim.seriesId))!.writerGeneration, 1);
    } finally {
      await env.pool.end();
    }
  });
});

describe('P1-R03 — fail-closed ordinal resolution', () => {
  it('missing fence throws OrdinalIntegrityError (no ordinal-1 fallback)', async () => {
    const env = await setup();
    try {
      const { session, claim } = await env.claimSeries('r03-fence');
      await env.pool.query(`DELETE FROM series_fence_state WHERE series_key=$1`, [
        claim.seriesId,
      ]);
      await assert.rejects(
        () =>
          resolveActiveSubgameOrdinal(env.pool, claim.seriesId, session.playerId),
        (err: unknown) =>
          err instanceof OrdinalIntegrityError &&
          err.code === 'SERIES_STATE_CORRUPT',
      );
      const gw = new SessionAuthorizationGateway({
        session: {
          playerId: session.playerId,
          sessionId: session.sessionId,
          deviceId: session.deviceId,
          expiresAtMs: session.expiresAtMs,
        },
        writers: env.writers,
        loadOwnedClaim: (p, k) => env.claims.getClaimForPlayer(p, k),
        resolveActiveOrdinal: (k, p) =>
          resolveActiveSubgameOrdinal(env.pool, k, p),
      });
      const auth = await gw.authorize({
        commandType: 'move',
        clientClaimedSeriesKey: claim.seriesId,
        clientClaimedPlayerId: session.playerId,
        clientClaimedWriterGeneration: 1,
      });
      assert.equal(auth.ok, false);
      if (!auth.ok) assert.equal(auth.reason, 'SERIES_STATE_CORRUPT');
    } finally {
      await env.pool.end();
    }
  });

  it('ended ordinal gap rejects', async () => {
    const env = await setup();
    try {
      const { session, claim } = await env.claimSeries('r03-gap');
      // Fabricate gap: mark ordinal 1 ended and insert ordinal 3 ended without 2.
      await env.pool.query(
        `UPDATE authoritative_game_snapshot SET status='ended'
         WHERE series_key=$1 AND subgame_ordinal=1`,
        [claim.seriesId],
      );
      await env.pool.query(
        `INSERT INTO authoritative_game_snapshot (
           series_key, player_id, subgame_ordinal, challenge_id,
           board_revision, move_cursor, state_hash, score, status,
           terminal_reason, state_json, ledger_admission_seq,
           writer_generation, produced_by_admission_id
         ) VALUES ($1,$2,3,'chal-3',0,0,'x',0,'ended',NULL,'{}'::jsonb,0,1,NULL)`,
        [claim.seriesId, session.playerId],
      );
      await assert.rejects(
        () =>
          resolveActiveSubgameOrdinal(env.pool, claim.seriesId, session.playerId),
        OrdinalIntegrityError,
      );
    } finally {
      await env.pool.end();
    }
  });

  it('snapshot challenge mismatch rejects', async () => {
    const env = await setup();
    try {
      const { session, claim } = await env.claimSeries('r03-chal');
      await env.pool.query(
        `UPDATE authoritative_game_snapshot SET challenge_id='forged'
         WHERE series_key=$1 AND subgame_ordinal=1`,
        [claim.seriesId],
      );
      await assert.rejects(
        () =>
          resolveActiveSubgameOrdinal(env.pool, claim.seriesId, session.playerId),
        OrdinalIntegrityError,
      );
    } finally {
      await env.pool.end();
    }
  });

  it('walks E1→E2→E3→M1→M2→H1 and terminal COMPLETED', async () => {
    const env = await setup();
    try {
      const { session, claim } = await env.claimSeries('r03-six');
      const svc = env.gameplay({
        playerId: session.playerId,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        expiresAtMs: session.expiresAtMs,
      });
      assert.equal(
        await resolveActiveSubgameOrdinal(
          env.pool,
          claim.seriesId,
          session.playerId,
        ),
        1,
      );

      for (let completed = 1; completed <= 5; completed++) {
        await env.pool.query(
          `UPDATE authoritative_game_snapshot SET status='ended'
           WHERE series_key=$1 AND subgame_ordinal=$2`,
          [claim.seriesId, completed],
        );
        await env.pool.query(
          `UPDATE series_fence_state SET status='AWAIT_ADVANCE' WHERE series_key=$1`,
          [claim.seriesId],
        );
        assert.equal(
          await resolveActiveSubgameOrdinal(
            env.pool,
            claim.seriesId,
            session.playerId,
          ),
          completed,
        );
        const adv = await svc.handleClientCommand(
          {
            commandType: 'advance',
            idempotencyKey: `adv-r03-${completed}`,
          },
          {
            seriesKeyHint: claim.seriesId,
            playerIdHint: session.playerId,
            writerGenerationHint: 1,
          },
        );
        assert.equal(adv.decision, 'apply', `advance after ${completed}`);
        assert.equal(
          await resolveActiveSubgameOrdinal(
            env.pool,
            claim.seriesId,
            session.playerId,
          ),
          completed + 1,
        );
      }

      await env.pool.query(
        `UPDATE authoritative_game_snapshot SET status='ended'
         WHERE series_key=$1 AND subgame_ordinal=6`,
        [claim.seriesId],
      );
      await env.pool.query(
        `UPDATE series_fence_state SET status='COMPLETED' WHERE series_key=$1`,
        [claim.seriesId],
      );
      assert.equal(
        await resolveActiveSubgameOrdinal(
          env.pool,
          claim.seriesId,
          session.playerId,
        ),
        6,
      );
    } finally {
      await env.pool.end();
    }
  });
});

describe('P1 re-review — concurrent handoff + HTTP takeover + cutoff', () => {
  it('concurrent handoffs: exactly one advances generation', async () => {
    const env = await setup();
    try {
      const { session, claim } = await env.claimSeries('conc-ho');
      const idA = await env.admitPendingHandoff({
        seriesKey: claim.seriesId,
        playerId: session.playerId,
        idempotencyKey: 'conc-a',
      });
      const idB = await env.admitPendingHandoff({
        seriesKey: claim.seriesId,
        playerId: session.playerId,
        idempotencyKey: 'conc-b',
      });
      const args = {
        seriesKey: claim.seriesId,
        playerId: session.playerId,
        subgameOrdinal: 1,
        trustedReceivedAt: new Date(),
        callerSessionId: session.sessionId,
        callerDeviceId: session.deviceId,
        expectedWriterGeneration: 1,
      };
      const [ra, rb] = await Promise.all([
        env.handoffUow.commit({ ...args, admissionId: idA }),
        env.handoffUow.commit({ ...args, admissionId: idB }),
      ]);
      const applied = [ra, rb].filter((r) => r.decision === 'apply');
      const rejected = [ra, rb].filter((r) => r.decision === 'reject');
      assert.equal(applied.length, 1);
      assert.equal(rejected.length, 1);
      if (rejected[0]!.decision === 'reject') {
        assert.equal(rejected[0]!.reason, 'STALE_WRITER');
      }
      const after = await env.bindingState(claim.seriesId, session.playerId);
      assert.equal(after.writerGen, 2);
      assert.equal(after.fenceGen, 2);
      assert.equal(after.snaps[0]!.gen, 2);
    } finally {
      await env.pool.end();
    }
  });

  it('HTTP path: non-writer same-player session cannot seize writer', async () => {
    const env = await setup();
    try {
      const { session: a, claim } = await env.claimSeries('http-steal');
      const b = await env.sessions.openAfterVerifiedJwt(env.identity('http-steal'));
      const svcB = env.gameplay({
        playerId: b.playerId,
        sessionId: b.sessionId,
        deviceId: b.deviceId,
        expiresAtMs: b.expiresAtMs,
      });
      const steal = await svcB.handleClientCommand(
        {
          commandType: 'device_handoff',
          idempotencyKey: 'http-steal-1',
          expectedWriterGeneration: 1,
        },
        {
          seriesKeyHint: claim.seriesId,
          playerIdHint: b.playerId,
          writerGenerationHint: 1,
        },
      );
      assert.equal(steal.decision, 'reject');
      if (steal.decision === 'reject') {
        assert.equal(steal.reason, 'WRITER_NOT_AUTHORIZED');
      }
      assert.equal((await env.writers.get(claim.seriesId))!.sessionId, a.sessionId);
      assert.equal((await env.writers.get(claim.seriesId))!.writerGeneration, 1);
    } finally {
      await env.pool.end();
    }
  });

  it('hard-cutoff exact −1 / equality / +1 boundaries', () => {
    const originalUtcDate = '2026-11-17';
    const startedAtMs = Date.parse('2026-11-17T15:00:00.000Z');
    const cutoff = computeSeriesHardCutoffMs({ originalUtcDate, startedAtMs });
    assert.ok(cutoff !== null);
    const weekMon = utcWeekMondayMs(parseUtcDateMs(originalUtcDate)!);
    const weekEnd = weekMon + 7 * 86400000 + 3600000;
    assert.equal(cutoff, weekEnd);
    assert.equal(isTimely(new Date(cutoff! - 1), new Date(cutoff!)), true);
    assert.equal(isTimely(new Date(cutoff!), new Date(cutoff!)), false);
    assert.equal(isTimely(new Date(cutoff! + 1), new Date(cutoff!)), false);
  });
});
