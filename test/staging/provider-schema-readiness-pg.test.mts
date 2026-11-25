import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresStagingGuestAuth } from '../../src/staging/guest-auth-service.mts';
import {
  detectIdentityImmutabilityReady,
  detectProviderSchemaReady,
} from '../../src/staging/staging-access-token.mts';

const databaseUrl = process.env.PZD_TEST_DATABASE_URL;
const describePg = databaseUrl ? test : test.skip;
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function assertIsolatedTestDatabase(name: string): void {
  if (!name || name === 'pzd_staging' || /(?:^|_)(?:prod|production|live|staging)(?:$|_)/i.test(name)) {
    throw new Error(`REFUSING_DESTRUCTIVE_TEST_SETUP:${name}`);
  }
  if (!/^pzd_[a-z0-9_]*test[a-z0-9_]*$/i.test(name) && name !== 'pzd_ci') {
    throw new Error(`REFUSING_DESTRUCTIVE_TEST_SETUP:${name}`);
  }
}

async function applySql(client: pg.PoolClient, relativePath: string, dbName: string): Promise<void> {
  const escaped = dbName.replace(/'/g, "''");
  const sql = readFileSync(join(root, relativePath), 'utf8')
    .replace(/current_database\(\) <> 'pzd_staging'/g, `current_database() <> '${escaped}'`)
    .replace(/current_database\(\)='pzd_staging'/g, `current_database()='${escaped}'`);
  await client.query(sql);
}

describePg('provider schema readiness across migration stages', async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const admin = await pool.connect();
  let dbName = '';
  try {
    const db = await admin.query<{ current_database: string }>('SELECT current_database()');
    dbName = db.rows[0]!.current_database;
    assertIsolatedTestDatabase(dbName);

    await admin.query(`
      DROP TABLE IF EXISTS public.pzd_identity_links CASCADE;
      DROP TABLE IF EXISTS public.pzd_provider_challenges CASCADE;
      DROP TABLE IF EXISTS public.pzd_guest_refresh CASCADE;
      DROP TABLE IF EXISTS public.pzd_guest_families CASCADE;
      DROP TABLE IF EXISTS public.pzd_guest_accounts CASCADE;
      DROP FUNCTION IF EXISTS public.pzd_provider_challenge_immutable CASCADE;
      DROP FUNCTION IF EXISTS public.pzd_identity_links_immutable CASCADE;
      DO $$ BEGIN
        CREATE ROLE pzd_app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await admin.query(`
      CREATE TABLE public.pzd_guest_accounts (
        player_id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.pzd_guest_families (
        family_id uuid PRIMARY KEY,
        player_id uuid NOT NULL REFERENCES public.pzd_guest_accounts(player_id),
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.pzd_guest_refresh (
        token_digest char(64) PRIMARY KEY,
        family_id uuid NOT NULL REFERENCES public.pzd_guest_families(family_id),
        player_id uuid NOT NULL REFERENCES public.pzd_guest_accounts(player_id),
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      GRANT SELECT, INSERT ON public.pzd_guest_accounts TO pzd_app_runtime;
      GRANT SELECT, INSERT, UPDATE ON public.pzd_guest_families TO pzd_app_runtime;
      GRANT SELECT, INSERT, UPDATE ON public.pzd_guest_refresh TO pzd_app_runtime;
      GRANT USAGE ON SCHEMA public TO pzd_app_runtime;
    `);
  } finally {
    admin.release();
  }

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const guestAuth = new PostgresStagingGuestAuth(pool, privateKey, 'ready', false, false);

  t.after(async () => {
    await pool.end();
  });

  await t.test('pre-0006: immutability ready is false without 42P01; guest auth works', async () => {
    assert.equal(await detectProviderSchemaReady(pool), false);
    assert.equal(await detectIdentityImmutabilityReady(pool), false);
    const created = await guestAuth.create(new Date());
    assert.match(created.accessToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  await t.test('post-0006: provider schema ready, immutability still false', async () => {
    const client = await pool.connect();
    try {
      await applySql(client, 'migrations/staging/0005_provider_challenges.sql', dbName);
      await applySql(client, 'migrations/staging/0006_provider_identity.sql', dbName);
    } finally {
      client.release();
    }
    assert.equal(await detectProviderSchemaReady(pool), true);
    assert.equal(await detectIdentityImmutabilityReady(pool), false);
  });

  await t.test('post-0007: immutability ready true only while triggers enabled', async () => {
    const client = await pool.connect();
    try {
      await applySql(client, 'migrations/staging/0007_identity_immutability.sql', dbName);
    } finally {
      client.release();
    }
    assert.equal(await detectIdentityImmutabilityReady(pool), true);

    await pool.query('ALTER TABLE public.pzd_identity_links DISABLE TRIGGER pzd_identity_links_immutable_upd');
    assert.equal(await detectIdentityImmutabilityReady(pool), false);
    await pool.query('ALTER TABLE public.pzd_identity_links ENABLE TRIGGER pzd_identity_links_immutable_upd');
    assert.equal(await detectIdentityImmutabilityReady(pool), true);
  });
});
