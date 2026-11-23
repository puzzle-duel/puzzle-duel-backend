/**
 * Explicit staging-only, recoverable named test-player provisioning.
 * A credential file is never treated as proof until its refresh digest,
 * account and display name are verified in PostgreSQL.
 */
import { createHash, createPrivateKey } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { PostgresStagingGuestAuth } from '../../src/staging/guest-auth-service.mts';

const players = {
  gokhan: { name: 'Gökhan Aydın', file: 'gokhan-test-player.credentials.json' },
  serap: { name: 'Serap Nazlı Aydın', file: 'serap-test-player.credentials.json' },
} as const;
type PlayerSlug = keyof typeof players;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

function parseCredentials(path: string): { refreshToken: string; displayName: string } {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Unsafe credential file');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid credential file');
  const data = parsed as Record<string, unknown>;
  if (typeof data.refreshToken !== 'string' || !/^[A-Za-z0-9_-]{64}$/.test(data.refreshToken) ||
      typeof data.displayName !== 'string') throw new Error('Invalid credential contents');
  return { refreshToken: data.refreshToken, displayName: data.displayName };
}

export async function reconcileExisting(pool: pg.Pool, slug: PlayerSlug, destination: string): Promise<'ready' | 'retry'> {
  if (!existsSync(destination)) {
    const existing = await pool.query('SELECT player_id FROM public.pzd_staging_test_players WHERE slug=$1', [slug]);
    if (existing.rowCount) throw new Error('Database identity exists without credential file: recovery required');
    return 'retry';
  }
  const credentials = parseCredentials(destination);
  if (credentials.displayName !== players[slug].name) throw new Error('Credential name mismatch');
  const result = await pool.query<{ player_id: string; display_name: string; token_digest: string | null }>(
    `SELECT p.player_id, p.display_name, r.token_digest
     FROM public.pzd_staging_test_players p
     JOIN public.pzd_guest_families f ON f.player_id=p.player_id AND f.revoked_at IS NULL
     JOIN public.pzd_guest_refresh r ON r.family_id=f.family_id
     WHERE p.slug=$1 AND r.token_digest=$2 AND r.used_at IS NULL
       AND r.expires_at > now() LIMIT 1`,
    [slug, digest(credentials.refreshToken)],
  );
  if (result.rowCount === 1 && result.rows[0]?.display_name === players[slug].name) return 'ready';
  // A file may have been fsynced before the transaction committed.
  // Delete ONLY if neither named account nor refresh digest exists in DB.
  const named = await pool.query('SELECT 1 FROM public.pzd_staging_test_players WHERE slug=$1', [slug]);
  const refresh = await pool.query('SELECT 1 FROM public.pzd_guest_refresh WHERE token_digest=$1', [digest(credentials.refreshToken)]);
  if (named.rowCount || refresh.rowCount) {
    throw new Error('Existing identity requires manual reconciliation; refusing to rotate or overwrite');
  }
  unlinkSync(destination);
  return 'retry';
}

async function main(): Promise<void> {
  if (process.env.PZD_RUNTIME_PROFILE !== 'staging' ||
      process.env.PZD_RANKED_HTTP_ENABLED === 'true' ||
      process.env.PZD_TEST_PLAYER_CREATE !== 'YES') {
    throw new Error('Explicit staging-only operator approval required');
  }
  const url = process.env.PZD_STAGING_DATABASE_URL;
  if (!url) throw new Error('Missing staging DB');
  const db = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(db.hostname) || db.pathname !== '/pzd_staging') {
    throw new Error('Refusing non-staging DB');
  }
  const keyFile = process.env.PZD_STAGING_GUEST_SIGNING_KEY_FILE;
  const kid = process.env.PZD_STAGING_GUEST_SIGNING_KID;
  if (!keyFile?.startsWith('/') || !kid || !/^[A-Za-z0-9_-]{1,128}$/.test(kid)) {
    throw new Error('Missing staging signer');
  }
  const keyStat = lstatSync(keyFile);
  if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0) throw new Error('Unsafe signing key');
  const slug = process.env.PZD_TEST_PLAYER;
  if (slug !== 'gokhan' && slug !== 'serap') throw new Error('Select gokhan or serap');
  const player = players[slug];
  const destination = resolve('/home/pzd-staging/pzd-staging', player.file);
  const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000 });
  try {
    const ready = await pool.query<{ present: string | null }>(
      "SELECT to_regclass('public.pzd_staging_test_players')::text AS present");
    if (!ready.rows[0]?.present) throw new Error('Named player migration not applied');
    if (await reconcileExisting(pool, slug, destination) === 'ready') {
      console.log('Staging test player already verified');
      return;
    }
    const privateKey = createPrivateKey(readFileSync(keyFile));
    const fd = openSync(destination, 'wx', 0o600);
    let persisted = false;
    try {
      const auth = new PostgresStagingGuestAuth(pool, privateKey, kid);
      await auth.create(new Date(), async (issued, context) => {
        await context.client.query(
          'INSERT INTO public.pzd_staging_test_players (slug, player_id, display_name) VALUES ($1,$2,$3)',
          [slug, context.playerId, player.name],
        );
        writeFileSync(fd, JSON.stringify({
          displayName: player.name,
          accountKind: 'staging-test-guest',
          ...issued,
        }) + '\n');
        fsyncSync(fd);
        persisted = true;
      });
    } catch (error) {
      // If the COMMIT result was lost, the DB may already contain the account.
      // Never delete credentials here; the next run reconciles the digest.
      if (!persisted) {
        // Even an incomplete file is kept for fail-closed operator recovery.
      }
      throw error;
    } finally {
      closeSync(fd);
    }
    console.log('Staging test player created and named in database');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Provisioning failed');
    process.exitCode = 1;
  });
}
