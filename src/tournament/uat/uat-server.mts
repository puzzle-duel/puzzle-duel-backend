/**
 * Local Tournament UAT process.
 *
 * This is not a production entrypoint. It listens only when the existing
 * ranked HTTP gate is enabled for a non-production profile. NODE_ENV=production
 * still hard-denies every route. Ranked HTTP is not enabled globally.
 */
import { createPrivateKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import { buildHttpDiagnostic, emitHttpDiagnostic, resolveRequestId } from '../../diagnostics/http-correlation.mts';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { PostgresTrustedUnitOfWork } from '../adjudication/postgres-uow.mts';
import {
  PostgresAcceptedMoveLedger,
  PostgresAuthoritativeSnapshotStore,
  PostgresTrustedChallengeStore,
} from '../adjudication/postgres-stores.mts';
import { AtomicDeviceHandoffUnitOfWork } from '../adjudication/atomic-device-handoff.mts';
import { TrustedGameplayService } from '../adjudication/trusted-gameplay.mts';
import { PinnedRs256JwtVerifier } from '../auth/pinned-jwt-verifier.mts';
import { PostgresSeriesWriterStore } from '../auth/series-writer-binding.mts';
import { PostgresVerifiedIdentitySessionStore } from '../auth/postgres-verified-sessions.mts';
import {
  rankedHttpGateConfigFromEnv,
  resolveRankedHttpFeatureGate,
  type RankedHttpGateConfig,
} from '../auth/ranked-feature-gate.mts';
import { createTournamentHttpHandler } from '../auth/tournament-http.mts';
import { PostgresSameDeviceRecovery } from '../auth/postgres-same-device-recovery.mts';
import type { SessionAuthorizationGateway } from '../auth/session-authorization-gateway.mts';
import { AtomicDailyClaimBootstrap } from '../claims/atomic-claim-bootstrap.mts';
import { resolveActiveSubgameOrdinal } from '../claims/active-ordinal.mts';
import { SystemUtcClock } from '../ingress/clock.mts';
import { PostgresAdmissionJournal } from '../ingress/postgres-journal.mts';
import { PostgresSeriesFenceStore } from '../ingress/series-fence.mts';
import { applyMigrations, assertMigrationStartupReady } from '../migrations/f2-migrator.mts';
import { F2BPublicationService } from '../results/f2b-publication.mts';
import { F2CRankingService } from '../results/f2c-rankings.mts';
import { loadUatManifest } from './uat-manifest.mts';

export const UAT_ISSUER = 'https://uat.puzzle-duel.local';
export const UAT_AUDIENCE = 'puzzle-duel-api';
export const UAT_SUBJECTS = {
  a: 'uat-player-a',
  b: 'uat-player-b',
} as const;

const KEY_ID = 'uat-local';

export function uatStateDirectory(): string {
  return process.env.PZD_UAT_STATE_DIR?.trim() || join(homedir(), '.pzd-uat');
}

export function loadOrCreateUatKeyPair(directory = uatStateDirectory()): {
  publicKeyPem: string;
  privateKey: KeyObject;
} {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const privatePath = join(directory, 'uat-jwt.pem');
  const publicPath = join(directory, 'uat-jwt.pub.pem');
  if (!existsSync(privatePath) || !existsSync(publicPath)) {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    writeFileSync(privatePath, privatePem, { mode: 0o600 });
    writeFileSync(publicPath, publicPem, { mode: 0o644 });
    chmodSync(privatePath, 0o600);
  }
  const publicKeyPem = readFileSync(publicPath, 'utf8');
  const privatePem = readFileSync(privatePath, 'utf8');
  return { publicKeyPem, privateKey: createPrivateKey(privatePem) };
}

export function signUatBearer(privateKey: KeyObject, subject: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (!Object.values(UAT_SUBJECTS).includes(subject as (typeof UAT_SUBJECTS)[keyof typeof UAT_SUBJECTS])) {
    throw new Error('UAT bearer subjects are limited to the two local players');
  }
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    iss: UAT_ISSUER,
    aud: UAT_AUDIENCE,
    sub: subject,
    iat: nowSeconds - 5,
    exp: nowSeconds + 8 * 60 * 60 - 10,
  })).toString('base64url');
  const message = `${head}.${body}`;
  const signature = sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64url');
  return `Bearer ${message}.${signature}`;
}

export function requireProvenanceKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.PZD_F2B_PROVENANCE_KEY?.trim() ?? '';
  if (key.length < 32) {
    throw new Error('PZD_F2B_PROVENANCE_KEY must be at least 32 characters and is not given a default');
  }
  return key;
}

export async function createUatHandler(pool: pg.Pool, options?: {
  readonly provenanceKey?: string;
  readonly rankedHttpGate?: RankedHttpGateConfig;
  readonly actualRuntimeEnv?: NodeJS.ProcessEnv;
  readonly publicKeyPem?: string;
  readonly privateKey?: KeyObject;
  readonly rateLimit?: { maxPerWindow: number; windowMs: number };
  /** Experimental, production-forbidden writer recovery UAT only. */
  readonly enableSameDeviceRecovery?: boolean;
  /** PZD-48 UAT-only switch; requires versioned migration 0012. */
  readonly enableUtcDailyManifests?: boolean;
  readonly sessionTtlMs?: number;
}) {
  const keys = options?.publicKeyPem && options.privateKey
    ? { publicKeyPem: options.publicKeyPem, privateKey: options.privateKey }
    : loadOrCreateUatKeyPair();
  const provenanceKey = options?.provenanceKey ?? requireProvenanceKey();
  const manifests = loadUatManifest();
  const dailyEnabled = options?.enableUtcDailyManifests === true &&
    process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'prod';
  const verifier = new PinnedRs256JwtVerifier({
    issuer: UAT_ISSUER,
    audience: UAT_AUDIENCE,
    keys: [{ keyId: KEY_ID, rsaPublicKeyPem: keys.publicKeyPem }],
    maxTokenAgeSeconds: 8 * 60 * 60,
  });
  const recoveryEnabled = options?.enableSameDeviceRecovery === true &&
    process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'prod';
  const sessions = new PostgresVerifiedIdentitySessionStore(pool, {
    maximumSessionTtlMs: recoveryEnabled ? options?.sessionTtlMs : undefined,
  });
  await sessions.migrate();
  const sameDeviceRecovery = recoveryEnabled
    ? new PostgresSameDeviceRecovery(pool) : undefined;
  if (sameDeviceRecovery) await sameDeviceRecovery.migrate();
  const claims = new AtomicDailyClaimBootstrap(pool, manifests, {
    anchorOriginalDevice: recoveryEnabled,
    enableUtcDailyManifests: dailyEnabled,
  });
  const writers = new PostgresSeriesWriterStore(pool);
  const fence = new PostgresSeriesFenceStore(pool);
  const journal = new PostgresAdmissionJournal(pool, new SystemUtcClock());
  const uow = new PostgresTrustedUnitOfWork(pool);
  uow.setSixGamePublisher(new F2BPublicationService(pool, {
    provenanceKey, manifests, enableUtcDailyManifests: dailyEnabled,
  }));
  const rankings = new F2CRankingService(pool, { provenanceKey });
  const handler = createTournamentHttpHandler({
    verifier,
    sessions,
    claims,
    writers,
    sameDeviceRecovery,
    fence,
    pool,
    provenanceKey,
    rankings,
    rankedHttpGate: options?.rankedHttpGate ?? rankedHttpGateConfigFromEnv(),
    actualRuntimeEnv: options?.actualRuntimeEnv,
    rateLimit: options?.rateLimit,
    gameplayForSession: (gateway: SessionAuthorizationGateway) =>
      new TrustedGameplayService({
        journal,
        fence,
        challenges: new PostgresTrustedChallengeStore(pool),
        ledger: new PostgresAcceptedMoveLedger(pool),
        snapshots: new PostgresAuthoritativeSnapshotStore(pool),
        clock: new SystemUtcClock(),
        authorization: gateway,
        postgresUow: uow,
        deviceHandoffUow: new AtomicDeviceHandoffUnitOfWork(pool),
        resolveActiveOrdinal: (seriesKey, playerId) =>
          resolveActiveSubgameOrdinal(pool, seriesKey, playerId),
      }),
  });
  return { handler, privateKey: keys.privateKey, provenanceKey };
}

function quoteIdent(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`Unexpected database name ${value}`);
  return value;
}

export function uatDatabaseUrls(env: NodeJS.ProcessEnv = process.env): {
  admin: string;
  target: string;
  name: string;
} {
  const raw = env.PZD_INGRESS_DATABASE_URL?.trim();
  if (!raw) throw new Error('PZD_INGRESS_DATABASE_URL is required');
  const name = env.PZD_UAT_DATABASE?.trim() || 'pzd_uat';
  const admin = new URL(raw);
  const target = new URL(raw);
  admin.pathname = '/postgres';
  target.pathname = `/${quoteIdent(name)}`;
  return { admin: admin.toString(), target: target.toString(), name };
}

async function ensureDatabase(adminUrl: string, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (found.rowCount === 0) {
      await client.query(`CREATE DATABASE ${quoteIdent(name)}`);
    }
  } finally {
    await client.end();
  }
}

async function serve(): Promise<void> {
  const gate = resolveRankedHttpFeatureGate(rankedHttpGateConfigFromEnv());
  if (!gate.enabled) {
    console.error(`UAT server refused to start: ranked HTTP gate is disabled (${gate.denyReason ?? 'disabled'}).`);
    console.error('Set NODE_ENV to development, PZD_RUNTIME_PROFILE=development, and PZD_RANKED_HTTP_ENABLED=true.');
    console.error('NODE_ENV=production cannot enable this server.');
    process.exitCode = 1;
    return;
  }
  const urls = uatDatabaseUrls();
  await ensureDatabase(urls.admin, urls.name);
  const pool = new pg.Pool({ connectionString: urls.target, max: 12 });
  try {
    if (process.env.PZD_UAT_APPLY_MIGRATIONS === '1') {
      await applyMigrations(pool);
      await assertMigrationStartupReady(pool);
    } else {
      await assertMigrationStartupReady(pool);
    }
    const { handler } = await createUatHandler(pool, {
      rankedHttpGate: rankedHttpGateConfigFromEnv(),
      enableSameDeviceRecovery: process.env.PZD_SAME_DEVICE_RECOVERY_ENABLED === 'true',
      enableUtcDailyManifests: process.env.PZD_UAT_DAILY_MANIFESTS_ENABLED === 'true',
      // Explicit test-only session expiry. Does not extend JWT or series deadlines.
      sessionTtlMs: process.env.PZD_SAME_DEVICE_RECOVERY_ENABLED === 'true'
        ? Number(process.env.PZD_UAT_SESSION_TTL_MS ?? 1_800_000)
        : undefined,
    });
    const host = process.env.PZD_UAT_HOST?.trim() || '0.0.0.0';
    const port = Number(process.env.PZD_UAT_PORT ?? '8787');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('PZD_UAT_PORT is not a valid port');
    }
    const server = createServer((req, res) => {
      const requestId = resolveRequestId(req.headers['x-request-id']);
      const started = process.hrtime.bigint();
      res.setHeader('x-request-id', requestId);
      res.once('finish', () => {
        if (res.statusCode < 400) return; // Lite: record failed HTTP requests only.
        try {
          const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
          emitHttpDiagnostic(buildHttpDiagnostic({
            requestId, operation: 'tournament_http',
            method: req.method ?? 'GET', status: res.statusCode, durationMs,
          }), (line) => console.log(line));
        } catch {
          // Observability cannot change gameplay or HTTP responses.
        }
      });
      void handler(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: 'AUTH_UNAVAILABLE' }));
        } else {
          res.destroy();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(port, host, resolve));
    console.log(`Puzzle Duel Tournament UAT listening on http://${host}:${port}`);
    console.log(`Database ${urls.name}. Production ranked HTTP is not enabled by this process.`);
  } catch (error) {
    await pool.end();
    throw error;
  }
}

async function issue(): Promise<void> {
  const { privateKey } = loadOrCreateUatKeyPair();
  const now = Math.floor(Date.now() / 1000);
  console.log(`PZD_UAT_BEARER_A=${signUatBearer(privateKey, UAT_SUBJECTS.a, now)}`);
  console.log(`PZD_UAT_BEARER_B=${signUatBearer(privateKey, UAT_SUBJECTS.b, now)}`);
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const command = process.argv[2] ?? 'serve';
  const fail = (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  };
  if (command === 'issue') issue().catch(fail);
  else if (command === 'serve') serve().catch(fail);
  else {
    console.error('Usage: uat-server.mts [serve|issue]');
    process.exitCode = 1;
  }
}
