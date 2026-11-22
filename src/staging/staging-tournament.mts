/** Isolated staging tournament composition; no UAT key generation or runtime DDL. */
import { createPublicKey, type KeyObject } from 'node:crypto';
import type pg from 'pg';
import { PostgresTrustedUnitOfWork } from '../tournament/adjudication/postgres-uow.mts';
import { PostgresAcceptedMoveLedger, PostgresAuthoritativeSnapshotStore, PostgresTrustedChallengeStore } from '../tournament/adjudication/postgres-stores.mts';
import { AtomicDeviceHandoffUnitOfWork } from '../tournament/adjudication/atomic-device-handoff.mts';
import { TrustedGameplayService } from '../tournament/adjudication/trusted-gameplay.mts';
import { PinnedRs256JwtVerifier } from '../tournament/auth/pinned-jwt-verifier.mts';
import { PostgresSeriesWriterStore } from '../tournament/auth/series-writer-binding.mts';
import { PostgresVerifiedIdentitySessionStore } from '../tournament/auth/postgres-verified-sessions.mts';
import { PostgresSameDeviceRecovery } from '../tournament/auth/postgres-same-device-recovery.mts';
import { createTournamentHttpHandler } from '../tournament/auth/tournament-http.mts';
import { AtomicDailyClaimBootstrap } from '../tournament/claims/atomic-claim-bootstrap.mts';
import { resolveActiveSubgameOrdinal } from '../tournament/claims/active-ordinal.mts';
import { SystemUtcClock } from '../tournament/ingress/clock.mts';
import { PostgresAdmissionJournal } from '../tournament/ingress/postgres-journal.mts';
import { PostgresSeriesFenceStore } from '../tournament/ingress/series-fence.mts';
import { assertMigrationStartupReady } from '../tournament/migrations/f2-migrator.mts';
import { F2BPublicationService } from '../tournament/results/f2b-publication.mts';
import { F2CRankingService } from '../tournament/results/f2c-rankings.mts';
import { loadUatManifest } from '../tournament/uat/uat-manifest.mts';
import { GUEST_ISSUER, GUEST_AUDIENCE } from './guest-auth-service.mts';

/**
 * This gate must never turn on implicitly and must never bypass the normal
 * JWT/session/writer checks. No runtime migrations or historical backfill.
 */
export function stagingSameDeviceRecoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PZD_RUNTIME_PROFILE === 'staging' &&
    env.PZD_STAGING_TOURNAMENT_ENABLED === 'true' &&
    env.PZD_STAGING_SAME_DEVICE_RECOVERY_ENABLED === 'true' &&
    env.NODE_ENV !== 'production' && env.NODE_ENV !== 'prod';
}

export async function assertStagingRecoverySchemaReady(pool: pg.Pool): Promise<void> {
  const result = await pool.query<{
    device_table: string | null;
    challenge_table: string | null;
    session_column: boolean;
    writer_column: boolean;
  }>(`
    SELECT
      to_regclass('public.tournament_device_credential')::text AS device_table,
      to_regclass('public.tournament_writer_recovery_challenge')::text AS challenge_table,
      EXISTS(SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='tournament_auth_session'
          AND column_name='device_credential_id') AS session_column,
      EXISTS(SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='tournament_series_writer'
          AND column_name='original_device_credential_id') AS writer_column
  `);
  const row = result.rows[0];
  if (!row?.device_table || !row.challenge_table ||
      row.session_column !== true || row.writer_column !== true) {
    throw new Error('STAGING_RECOVERY_SCHEMA_NOT_READY');
  }
}

export async function createStagingTournamentHandler(pool: pg.Pool, privateKey: KeyObject, kid: string, provenanceKey: string) {
  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod') {
    throw new Error('Production process may not mount staging ranked routes');
  }
  if (process.env.PZD_RUNTIME_PROFILE !== 'staging' ||
      process.env.PZD_STAGING_TOURNAMENT_ENABLED !== 'true') {
    throw new Error('Staging tournament opt-in required');
  }
  if (provenanceKey.length < 32) throw new Error('Staging provenance key required');
  await assertMigrationStartupReady(pool);
  const verifier = new PinnedRs256JwtVerifier({
    issuer: GUEST_ISSUER, audience: GUEST_AUDIENCE,
    keys: [{ keyId: kid, rsaPublicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString() }],
    maxTokenAgeSeconds: 900, allowStagingGuestClaims: true,
  });
  const manifests = loadUatManifest();
  const sessions = new PostgresVerifiedIdentitySessionStore(pool);
  const enableRecovery = stagingSameDeviceRecoveryEnabled();
  if (enableRecovery) await assertStagingRecoverySchemaReady(pool);
  const recovery = enableRecovery ? new PostgresSameDeviceRecovery(pool) : undefined;
  const claims = new AtomicDailyClaimBootstrap(pool, manifests, {
    enableUtcDailyManifests: true, anchorOriginalDevice: enableRecovery,
  });
  const writers = new PostgresSeriesWriterStore(pool);
  const fence = new PostgresSeriesFenceStore(pool);
  const journal = new PostgresAdmissionJournal(pool, new SystemUtcClock());
  const uow = new PostgresTrustedUnitOfWork(pool);
  uow.setSixGamePublisher(new F2BPublicationService(pool, {
    provenanceKey, manifests, enableUtcDailyManifests: true,
  }));
  return createTournamentHttpHandler({
    verifier, sessions, claims, writers, fence, pool, provenanceKey,
    ...(recovery ? { sameDeviceRecovery: recovery } : {}),
    rankings: new F2CRankingService(pool, { provenanceKey }),
    rankedHttpGate: { runtimeProfile: 'staging', enableFlag: 'true' },
    gameplayForSession: (gateway) => new TrustedGameplayService({
      journal, fence,
      challenges: new PostgresTrustedChallengeStore(pool),
      ledger: new PostgresAcceptedMoveLedger(pool),
      snapshots: new PostgresAuthoritativeSnapshotStore(pool),
      clock: new SystemUtcClock(),
      authorization: gateway,
      postgresUow: uow,
      deviceHandoffUow: new AtomicDeviceHandoffUnitOfWork(pool),
      resolveActiveOrdinal: (seriesKey, playerId) => resolveActiveSubgameOrdinal(pool, seriesKey, playerId),
    }),
  });
}
