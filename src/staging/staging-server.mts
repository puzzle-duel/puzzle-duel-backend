/**
 * Isolated staging bootstrap. Never exposes UAT token issuance or ranked routes.
 * DB migrations are an explicit separate operator action.
 */
import { createServer } from 'node:http';
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
  return { host, port, databaseUrl };
}

export async function startStagingServer(env: NodeJS.ProcessEnv = process.env) {
  const config = stagingConfig(env);
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 3, connectionTimeoutMillis: 3000 });
  try {
    await pool.query('SELECT 1');
    const server = createServer((req, res) => {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('content-type', 'application/json');
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
      await pool.end();
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
