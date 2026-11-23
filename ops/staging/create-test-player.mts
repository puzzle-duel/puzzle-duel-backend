/**
 * One-shot staging test identity bootstrap.
 * Operator-only: never mount as an HTTP route or run during deployment.
 * Uses the existing staging guest issuer until provider-backed test identities exist.
 */
import { createPrivateKey } from 'node:crypto';
import { readFileSync, openSync, writeFileSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { PostgresStagingGuestAuth } from '../../src/staging/guest-auth-service.mts';

async function main(): Promise<void> {
  if (process.env.PZD_RUNTIME_PROFILE !== 'staging' ||
      process.env.PZD_RANKED_HTTP_ENABLED === 'true' ||
      process.env.PZD_TEST_PLAYER_CREATE !== 'YES') {
    throw new Error('Explicit staging-only operator approval required');
  }
  const url = process.env.PZD_STAGING_DATABASE_URL;
  if (!url) throw new Error('Missing staging database configuration');
  const db = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(db.hostname) || db.pathname !== '/pzd_staging') {
    throw new Error('Refusing non-staging database');
  }
  const keyFile = process.env.PZD_STAGING_GUEST_SIGNING_KEY_FILE;
  const kid = process.env.PZD_STAGING_GUEST_SIGNING_KID;
  if (!keyFile?.startsWith('/') || !kid || !/^[A-Za-z0-9_-]{1,128}$/.test(kid)) {
    throw new Error('Missing staging signing configuration');
  }
  if ((statSync(keyFile).mode & 0o077) !== 0) throw new Error('Signing key permissions too broad');
  const selection = process.env.PZD_TEST_PLAYER;
  const players: Record<string, { name: string; file: string }> = {
    gokhan: { name: 'Gökhan Aydın', file: 'gokhan-test-player.credentials.json' },
    serap: { name: 'Serap Nazlı Aydın', file: 'serap-test-player.credentials.json' },
  };
  const player = selection ? players[selection] : undefined;
  if (!player) throw new Error('Select PZD_TEST_PLAYER=gokhan or serap');
  const destination = resolve('/home/pzd-staging/pzd-staging', player.file);
  if (!destination.startsWith('/home/pzd-staging/pzd-staging/')) {
    throw new Error('Credentials must remain in private staging directory');
  }
  // Exclusive creation: do not overwrite or silently rotate an existing identity.
  const fd = openSync(destination, 'wx', 0o600);
  const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 3000 });
  let committed = false;
  try {
    const privateKey = createPrivateKey(readFileSync(keyFile));
    const auth = new PostgresStagingGuestAuth(pool, privateKey, kid);
    const issued = await auth.create();
    committed = true;
    writeFileSync(fd, JSON.stringify({
      displayName: player.name,
      accountKind: 'staging-test-guest',
      note: 'Operator test identity only; NOT Apple/Google verified. Never use in production.',
      ...issued,
    }, null, 2) + '\n');
    console.log('Staging test player created. Credentials written to private file (0600).');
    console.log('Do not paste credentials into chat, CI output or GitHub.');
  } catch (error) {
    if (!committed) unlinkSync(destination);
    throw error;
  } finally {
    closeSync(fd);
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Bootstrap failed');
  process.exitCode = 1;
});
