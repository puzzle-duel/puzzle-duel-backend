/**
 * Isolated staging bootstrap. Never exposes UAT token issuance or ranked routes.
 * DB migrations are an explicit separate operator action.
 */
import { createServer } from 'node:http';
import { createPrivateKey } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createGuestAuthHttpHandler } from './guest-auth-http.mts';
import { PostgresStagingGuestAuth } from './guest-auth-service.mts';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export function stagingConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.PZD_RUNTIME_PROFILE !== 'staging') throw new Error('PZD_RUNTIME_PROFILE must be staging');
  if (env.PZD_RANKED_HTTP_ENABLED === 'true') throw new Error('Ranked HTTP is not approved for staging bootstrap');
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
  const keyPath = env.PZD_STAGING_GUEST_SIGNING_KEY_FILE;
  const keyId = env.PZD_STAGING_GUEST_SIGNING_KID;
  if (guestAuthEnabled && (!keyPath || !keyPath.startsWith('/') || !keyId || !/^[A-Za-z0-9_-]{1,128}$/.test(keyId))) {
    throw new Error('Staging guest auth requires absolute private key path and pinned kid');
  }
  return { host, port, databaseUrl, guestAuthEnabled, keyPath, keyId };
}

export async function startStagingServer(env: NodeJS.ProcessEnv = process.env) {
  const config = stagingConfig(env);
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 3, connectionTimeoutMillis: 3000 });
  try {
    await pool.query('SELECT 1');
    let guestHandler: ReturnType<typeof createGuestAuthHttpHandler> | undefined;
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
      guestHandler = createGuestAuthHttpHandler(
        new PostgresStagingGuestAuth(pool, privateKey, config.keyId!),
      );
    }
    const server = createServer((req, res) => {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('content-type', 'application/json');
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
