/** Explicit, staging-only guest schema migration. Never imported by HTTP runtime. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { stagingConfig } from './staging-server.mts';

export async function applyGuestSchema(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.PZD_STAGING_GUEST_SCHEMA_APPLY !== 'YES') {
    throw new Error('Explicit PZD_STAGING_GUEST_SCHEMA_APPLY=YES required');
  }
  const config = stagingConfig(env);
  const sql = readFileSync(fileURLToPath(new URL('../../docs/staging/PZD-49-GUEST-SCHEMA-CANDIDATE.sql', import.meta.url)), 'utf8');
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 3000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pzd_staging_guest_schema_v1'))");
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  applyGuestSchema().then(() => console.log('Staging guest schema applied')).catch((error: unknown) => {
    console.error('Staging migration refused:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
