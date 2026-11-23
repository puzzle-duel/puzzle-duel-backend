/**
 * Isolated staging bootstrap. Never exposes UAT token issuance or ranked routes.
 * DB migrations are an explicit separate operator action.
 */
import { createServer } from 'node:http';
import { buildHttpDiagnostic, diagnosticRoute, resolveRequestId } from '../diagnostics/http-correlation.mts';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, renameSync, statSync } from 'node:fs';
import { createGuestAuthHttpHandler, guestAuthDiagnosticReason } from './guest-auth-http.mts';
import { PostgresStagingGuestAuth, GUEST_ISSUER, GUEST_AUDIENCE } from './guest-auth-service.mts';
import { PinnedRs256JwtVerifier } from '../tournament/auth/pinned-jwt-verifier.mts';
import { PostgresVerifiedIdentitySessionStore } from '../tournament/auth/postgres-verified-sessions.mts';
import { createStagingTournamentHandler } from './staging-tournament.mts';
import { writerDenialDiagnostic } from '../tournament/auth/tournament-http.mts';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

/** Route diagnostic reports through the same verified guest/session handler as ranked moves. */
export function isStagingRankedRoute(url: string | undefined, method: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?', 1)[0] ?? '';
  return (path.startsWith('/v1/tournament/') && path !== '/v1/tournament/session') ||
    (path === '/v1/diagnostics/reports' && method === 'POST');
}

export function stagingConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.PZD_RUNTIME_PROFILE !== 'staging') throw new Error('PZD_RUNTIME_PROFILE must be staging');
  if (env.PZD_RANKED_HTTP_ENABLED === 'true') throw new Error('Global ranked HTTP flag is forbidden in staging');
  if (env.PZD_STAGING_TOURNAMENT_ENABLED === 'true' && env.PZD_STAGING_GUEST_AUTH_ENABLED !== 'true') {
    throw new Error('Staging tournament requires guest authentication');
  }
  if (env.PZD_STAGING_SAME_DEVICE_RECOVERY_ENABLED === 'true' &&
      env.PZD_STAGING_TOURNAMENT_ENABLED !== 'true') {
    throw new Error('Staging recovery requires staging tournament');
  }
  if (env.PZD_UAT_APPLY_MIGRATIONS === '1') throw new Error('Automatic migrations are forbidden');
  const host = env.PZD_STAGING_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1') throw new Error('Staging must bind to loopback only');
  const port = Number(env.PZD_STAGING_PORT ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid staging port');
  const databaseUrl = env.PZD_STAGING_DATABASE_URL;
  if (!databaseUrl) throw new Error('PZD_STAGING_DATABASE_URL is required');
  const url = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/pzd_staging') {
    throw new Error('Staging DB must be the isolated local pzd_staging database');
  }
  const guestAuthEnabled = env.PZD_STAGING_GUEST_AUTH_ENABLED === 'true';
  const guestRetryEnabled = env.PZD_STAGING_GUEST_RETRY_ENABLED === 'true';
  if (guestRetryEnabled && !guestAuthEnabled) throw new Error('Guest retry requires guest auth');
  const keyPath = env.PZD_STAGING_GUEST_SIGNING_KEY_FILE;
  const keyId = env.PZD_STAGING_GUEST_SIGNING_KID;
  if (guestAuthEnabled && (!keyPath || !keyPath.startsWith('/') || !keyId || !/^[A-Za-z0-9_-]{1,128}$/.test(keyId))) {
    throw new Error('Staging guest auth requires absolute private key path and pinned kid');
  }
  return { host, port, databaseUrl, guestAuthEnabled, guestRetryEnabled, keyPath, keyId };
}

export async function startStagingServer(env: NodeJS.ProcessEnv = process.env) {
  const config = stagingConfig(env);
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 3, connectionTimeoutMillis: 3000 });
  try {
    await pool.query('SELECT 1');
    // Shared private staging sink for HTTP and session lifecycle events.
    // Do not let diagnostic I/O affect authentication or tournament behavior.
    const appendStagingDiagnostic = (line: string) => {
      console.log(line);
      const path = '/home/pzd-staging/pzd-staging/http-diagnostics.log';
      try {
        const existing = lstatSync(path, { throwIfNoEntry: false });
        if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
          throw new Error('Unsafe diagnostic log path');
        }
        if (existing && existing.size + Buffer.byteLength(line) + 1 > 5 * 1024 * 1024) {
          renameSync(path, path + '.1');
        }
        appendFileSync(path, line + '\n', { mode: 0o600 });
      } catch {
        console.warn('Staging diagnostic file unavailable');
      }
    };
    let guestHandler: ReturnType<typeof createGuestAuthHttpHandler> | undefined;
    let tournamentHandler: ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>) | undefined;
    let sessionHandler: ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>) | undefined;
    if (config.guestAuthEnabled) {
      // Fail closed if the migration has not been explicitly applied.
      for (const table of ['pzd_guest_accounts', 'pzd_guest_families', 'pzd_guest_refresh']) {
        const result = await pool.query<{ exists: string | null }>('SELECT to_regclass($1) AS exists', [table]);
        if (!result.rows[0]?.exists) throw new Error('Guest auth schema is not ready');
      }
      const keyFile = config.keyPath!;
      if ((statSync(keyFile).mode & 0o077) !== 0) throw new Error('Guest signing key permissions are too broad');
      const privateKey = createPrivateKey(readFileSync(keyFile));
      if (privateKey.asymmetricKeyType !== 'rsa' ||
          (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
        throw new Error('Guest signing key must be RSA 2048 or stronger');
      }
      if (config.guestRetryEnabled) {
        const ready = await pool.query<{ present: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='pzd_guest_refresh'
              AND column_name='rotation_id_digest') AS present`,
        );
        if (ready.rows[0]?.present !== true) throw new Error('Guest retry schema is not ready');
      }
      const enrollmentReady = await pool.query<{ exists: string | null }>(
        "SELECT to_regclass('public.pzd_staging_enrollment_grants')::text AS exists",
      );
      if (!enrollmentReady.rows[0]?.exists) throw new Error('Named enrollment schema not ready');
      guestHandler = createGuestAuthHttpHandler(
        new PostgresStagingGuestAuth(pool, privateKey, config.keyId!, config.guestRetryEnabled),
      );
      const verifier = new PinnedRs256JwtVerifier({
        issuer: GUEST_ISSUER, audience: GUEST_AUDIENCE,
        keys: [{ keyId: config.keyId!, rsaPublicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString() }],
        maxTokenAgeSeconds: 900, allowStagingGuestClaims: true,
      });
      const sessions = new PostgresVerifiedIdentitySessionStore(pool);
      for (const table of ['tournament_verified_identity', 'tournament_auth_session']) {
        const result = await pool.query<{ exists: string | null }>('SELECT to_regclass($1) AS exists', [table]);
        if (!result.rows[0]?.exists) throw new Error('Tournament session schema is not ready');
      }
      if (env.PZD_STAGING_TOURNAMENT_ENABLED === 'true') {
        const provenanceKey = env.PZD_F2B_PROVENANCE_KEY ?? '';
        const rankedHandler = await createStagingTournamentHandler(pool, privateKey, config.keyId!, provenanceKey);
        tournamentHandler = async (req, res) => {
          let identity;
          try { identity = verifier.verifyAuthorizationHeader(req.headers.authorization); }
          catch { res.writeHead(401); res.end(JSON.stringify({ error: 'UNAUTHENTICATED' })); return; }
          const active = await pool.query(
            'SELECT 1 FROM pzd_guest_families WHERE player_id=$1 AND revoked_at IS NULL LIMIT 1',
            [identity.subject],
          );
          if (!active.rowCount) {
            res.writeHead(401); res.end(JSON.stringify({ error: 'UNAUTHENTICATED' })); return;
          }
          await rankedHandler(req, res);
        };
      }
      sessionHandler = async (req, res) => {
        const method = req.method ?? 'GET';
        const trace = (stage: string) => {
          // Fixed stage strings only: no player, device, token or session material.
          // Ingress resolves the ID once and stores it on the response.
          // Never regenerate it here: invalid/missing client IDs must still correlate.
          const requestId = res.getHeader('x-request-id');
          if (typeof requestId !== 'string') return;
          appendStagingDiagnostic(JSON.stringify({
            timestamp: new Date().toISOString(),
            code: 'staging_session_transition',
            requestId,
            operation: 'tournament_session',
            stage,
          }));
        };
        trace('session_request_begin');
        if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
          res.writeHead(404); res.end(JSON.stringify({ error: 'NOT_FOUND' })); return;
        }
        if (req.headers['transfer-encoding'] !== undefined ||
            (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'MALFORMED_REQUEST' })); return;
        }
        let identity;
        try { identity = verifier.verifyAuthorizationHeader(req.headers.authorization); }
        catch { trace('jwt_verification_rejected'); res.writeHead(401); res.end(JSON.stringify({ error: 'UNAUTHENTICATED' })); return; }
        const active = await pool.query(
          'SELECT 1 FROM pzd_guest_families WHERE player_id=$1 AND revoked_at IS NULL LIMIT 1',
          [identity.subject],
        );
        if (!active.rowCount) {
          trace('guest_family_inactive');
          res.writeHead(401); res.end(JSON.stringify({ error: 'UNAUTHENTICATED' })); return;
        }
        if (method === 'POST') {
          trace('new_session_open_begin');
          const opened = await sessions.openAfterVerifiedJwt(identity);
          trace('new_session_open_ok');
          res.writeHead(201); res.end(JSON.stringify(opened)); return;
        }
        const secret = req.headers['x-pzd-session-secret'];
        if (typeof secret !== 'string') {
          trace('session_secret_missing');
          res.writeHead(401); res.end(JSON.stringify({ error: 'UNAUTHENTICATED' })); return;
        }
        if (method === 'DELETE') {
          const revoked = await sessions.revokeSession(identity, secret);
          trace(revoked ? 'session_revoke_ok' : 'session_revoke_rejected');
          res.writeHead(revoked ? 204 : 401);
          res.end(revoked ? '' : JSON.stringify({ error: 'UNAUTHENTICATED' })); return;
        }
        const verified = method === 'PATCH'
          ? await sessions.renewActiveSession(identity, secret)
          : await sessions.authenticateVerifiedSession(identity, secret);
        if (!verified) {
          trace(method === 'PATCH' ? 'session_renew_rejected' : 'session_restore_rejected');
          res.writeHead(401); res.end(JSON.stringify({ error: 'UNAUTHENTICATED' })); return;
        }
        trace(method === 'PATCH' ? 'session_renew_ok' : 'session_restore_ok');
        res.writeHead(200); res.end(JSON.stringify(verified));
      };

    }
    const server = createServer((req, res) => {
      // Staging-only: correlate iOS x-request-id with backend responses.
      // Store only allowlisted status/method/duration metadata, never headers or URLs.
      const requestId = resolveRequestId(req.headers['x-request-id']);
      res.setHeader('x-request-id', requestId);
      if (!(req.method === 'GET' && req.url === '/healthz')) {
        const started = process.hrtime.bigint();
        res.once('finish', () => {
          const entry = buildHttpDiagnostic({
            requestId,
            operation: req.url?.split('?', 1)[0] === '/v1/diagnostics/reports'
              ? 'diagnostic_report' : 'tournament_http',
            route: diagnosticRoute(req.url),
            errorCode: guestAuthDiagnosticReason(res) ?? res.getHeader('x-pzd-error-code'),
            writerDenial: writerDenialDiagnostic(res),
            method: req.method ?? 'OTHER',
            status: res.statusCode,
            durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
          });
          appendStagingDiagnostic(JSON.stringify(entry));
        });
      }
      res.setHeader('cache-control', 'no-store');
      res.setHeader('content-type', 'application/json');
      // Session lifecycle is handled separately; tournament HTTP must not shadow it.
      if (tournamentHandler && isStagingRankedRoute(req.url, req.method)) {
        void tournamentHandler(req, res).catch(() => {
          if (!res.headersSent) {
            res.writeHead(503); res.end(JSON.stringify({ error: 'TOURNAMENT_UNAVAILABLE' }));
          } else { res.destroy(); }
        });
        return;
      }
      if (sessionHandler && req.url === '/v1/tournament/session') {
        void sessionHandler(req, res).catch(() => {
          if (!res.headersSent) {
            res.writeHead(503); res.end(JSON.stringify({ error: 'AUTH_UNAVAILABLE' }));
          } else { res.destroy(); }
        });
        return;
      }
      if (guestHandler && req.url?.startsWith('/v1/auth/')) {
        void guestHandler(req, res).then(handled => {
          if (!handled && !res.headersSent) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'NOT_FOUND' }));
          }
        }).catch(() => {
          if (!res.headersSent) {
            res.writeHead(503);
            res.end(JSON.stringify({ error: 'AUTH_UNAVAILABLE' }));
          }
        });
        return;
      }
      if (req.method !== 'GET' || req.url !== '/healthz') {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'NOT_FOUND' }));
        return;
      }
      void pool.query('SELECT 1').then(() => {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok', service: 'pzd-staging-bootstrap' }));
      }).catch(() => {
        res.writeHead(503);
        res.end(JSON.stringify({ status: 'unavailable' }));
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, resolve);
      });
    } catch (error) {
      throw error;
    }
    const shutdown = () => {
      server.close(() => { void pool.end(); });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    console.log('PZD staging bootstrap listening on loopback');
    return { server, pool };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startStagingServer().catch((error: unknown) => {
    console.error('Staging startup refused:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
