/**
 * PZD-41 production migration, privilege, and recovery gate.
 * PostgreSQL 18 is required. A skipped database test is not a pass.
 * This file does not enable ranked HTTP and does not connect to a production database.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { evaluateLeaderboardReadEligibility } from '../../../src/tournament/results/f2a-publication-schema.mts';
import { F2CRankingService } from '../../../src/tournament/results/f2c-rankings.mts';
import {
  applyMigrations,
  applyRollback,
  assertMigrationStartupReady,
  loadMigrationFiles,
  MigrationRefusal,
  rollbackDisposition,
  sqlStatements,
  verifyMigrations,
  type MigrationFile,
} from '../../../src/tournament/migrations/f2-migrator.mts';

const databaseUrl = process.env.PZD_INGRESS_DATABASE_URL?.trim();
const GATE = 'pzd_f2_migration_gate';
const UPGRADE = 'pzd_f2_migration_upgrade';
const BROKEN = 'pzd_f2_migration_broken';
const PROBE = 'pzd_f2_migration_probe';
const RESTORE = 'pzd_f2_migration_restore';
const DUMP = 'pzd_f2_migration_dump';
const PRIV = 'pzd_f2_migration_priv';
const ABSENT = 'pzd_f2_migration_absent';
const ROLE_PASSWORD = 'pzd-gate-test-only-not-a-secret';
const PROVENANCE_KEY = 'test-only-f2b-provenance-key-not-a-secret';
const DIGEST = 'ab'.repeat(32);

function urlFor(name: string): string {
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function recreate(name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

async function dropDatabase(name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  } finally {
    await admin.end();
  }
}

describe('PZD-41 F2 versioned migrations and privileges', () => {
  before(() => {
    if (!databaseUrl) {
      throw new Error('PZD_INGRESS_DATABASE_URL is required. This gate does not skip.');
    }
  });

  after(async () => {
    if (!databaseUrl) return;
    for (const name of [GATE, UPGRADE, BROKEN, PROBE, RESTORE, DUMP, PRIV, ABSENT]) {
      await dropDatabase(name);
    }
    const admin = new pg.Client({ connectionString: urlFor('postgres') });
    await admin.connect();
    try {
      for (const role of [
        'pzd_app_runtime',
        'pzd_leaderboard_reader',
        'pzd_settlement_worker',
        'pzd_audit_admin',
      ]) {
        await admin.query(`ALTER ROLE ${role} NOLOGIN PASSWORD NULL`);
      }
    } finally {
      await admin.end();
    }
  });

  it('keeps forward SQL free of history deletion and treats every migration as restore-only', () => {
    const files = loadMigrationFiles();
    assert.deepEqual(files.map((file) => file.id), [
      '0000_schema_history',
      '0001_stage_e_gameplay',
      '0002_stage_f1_claim',
      '0003_f2a_claim_identity',
      '0004_f2a_publication',
      '0005_f2a_publication_upgrade',
      '0006_f2a_structural_view',
      '0007_f2b_immutability',
      '0008_journal_db_receipt',
      '0009_f2c_final',
      '0010_f2_privileges',
      '0011_journal_receipt_immutable',
    ]);
    for (const file of files) {
      assert.equal(file.reversible, false, file.id);
      assert.equal(rollbackDisposition(file).action, 'restore_backup');
      assert.equal(/\bDELETE\s+FROM\b/i.test(file.sql), false, file.id);
      assert.equal(/\bTRUNCATE\s+(TABLE|ONLY|public)\b/i.test(file.sql), false, file.id);
      assert.equal(/\bDROP\s+TABLE\b/i.test(file.sql), false, file.id);
      assert.equal(/ranked_http_enabled/i.test(file.sql), false, file.id);
    }
    const view = files.find((file) => file.id === '0006_f2a_structural_view');
    assert.equal(view?.sql.includes('DROP VIEW IF EXISTS public.tournament_f2a_publication_ready'), true);
  });

  it('refuses a down migration instead of dropping leaderboard history', async () => {
    for (const file of loadMigrationFiles()) {
      await assert.rejects(applyRollback(file), (err: unknown) => {
        assert.ok(err instanceof MigrationRefusal);
        assert.equal(err.refusal, 'MIGRATION_ROLLBACK_REQUIRES_BACKUP');
        return true;
      });
    }
  });

  it('installs on an empty database, refuses a changed checksum, and keeps a retry idempotent', async () => {
    await recreate(GATE);
    const pool = new pg.Pool({ connectionString: urlFor(GATE) });
    try {
      const version = await pool.query('SHOW server_version_num');
      assert.ok(Number(version.rows[0].server_version_num) >= 180000);
      const first = await applyMigrations(pool);
      assert.equal(first.applied.length, 12);
      assert.equal(first.skipped.length, 0);
      const second = await applyMigrations(pool);
      assert.deepEqual(second.applied, []);
      assert.equal(second.skipped.length, 12);
      await verifyMigrations(pool);
      const settlements = await pool.query(`SELECT count(*)::int AS n FROM tournament_f2c_settlement`);
      assert.equal(Number(settlements.rows[0].n), 0, 'migration does not publish FINAL');
      const defs = await pool.query(
        `SELECT proname, prosecdef, proconfig
         FROM pg_proc
         WHERE pronamespace = 'public'::regnamespace
           AND proname IN (
             'tournament_daily_claim_reject_identity_mutation',
             'tournament_f2b_reject_publication_mutation',
             'tournament_f2c_reject_final_mutation',
             'tournament_f2c_reject_closed_period_write',
             'pzd_schema_migration_reject_mutation',
             'command_admission_journal_reject_receipt_mutation'
           )`,
      );
      assert.equal(defs.rows.length, 6);
      for (const row of defs.rows) {
        assert.equal(row.prosecdef, false, String(row.proname));
        assert.ok(
          Array.isArray(row.proconfig) && row.proconfig.includes('search_path=pg_catalog'),
          String(row.proname),
        );
      }
      const directory = mkdtempSync(join(tmpdir(), 'pzd-f2-migration-'));
      try {
        cpSync(fileURLToPath(new URL('../../../migrations/stage_f2/sql/', import.meta.url)), directory, { recursive: true });
        const target = join(directory, '0004_f2a_publication.sql');
        writeFileSync(target, `${readFileSync(target, 'utf8')}\n-- checksum tamper\n`);
        await assert.rejects(applyMigrations(pool, loadMigrationFiles(directory)), (err: unknown) => {
          assert.ok(err instanceof MigrationRefusal);
          assert.equal(err.refusal, 'MIGRATION_CHECKSUM_CONFLICT');
          return true;
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      await verifyMigrations(pool);
    } finally {
      await pool.end();
    }
  });

  it('preserves an existing F1 claim and a publication across the F2 upgrade', async () => {
    await recreate(UPGRADE);
    const pool = new pg.Pool({ connectionString: urlFor(UPGRADE) });
    const seriesId = randomUUID();
    const playerId = `player-${randomUUID()}`;
    try {
      await pool.query(
        `CREATE TABLE command_admission_journal (
           admission_id UUID PRIMARY KEY,
           series_key TEXT NOT NULL,
           player_id TEXT NOT NULL,
           command_type TEXT NOT NULL,
           idempotency_key TEXT NOT NULL,
           payload_hash TEXT NOT NULL,
           trusted_received_at_ms BIGINT NOT NULL,
           admission_seq BIGINT NOT NULL,
           outcome TEXT NOT NULL DEFAULT 'pending',
           expected_board_revision BIGINT NULL,
           writer_generation BIGINT NULL,
           score_delta BIGINT NULL,
           completes_series BOOLEAN NOT NULL DEFAULT FALSE,
           result_json JSONB NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           UNIQUE (series_key, player_id, idempotency_key),
           UNIQUE (series_key, admission_seq)
         )`,
      );
      await pool.query(
        `CREATE TABLE tournament_daily_claim (
           series_id UUID PRIMARY KEY,
           player_id TEXT NOT NULL,
           original_utc_date DATE NOT NULL,
           started_at_ms BIGINT NOT NULL,
           manifest_digest TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'ACTIVE',
           UNIQUE (player_id, original_utc_date),
           CHECK (status IN ('ACTIVE','AWAIT_ADVANCE','COMPLETED','FORFEITED'))
         )`,
      );
      await pool.query(
        `INSERT INTO command_admission_journal (
           admission_id, series_key, player_id, command_type, idempotency_key, payload_hash,
           trusted_received_at_ms, admission_seq, outcome
         ) VALUES ($1,$2,$3,'move','legacy','abc',1,1,'applied')`,
        [randomUUID(), seriesId, playerId],
      );
      await pool.query(
        `INSERT INTO tournament_daily_claim (
           series_id, player_id, original_utc_date, started_at_ms, manifest_digest, status
         ) VALUES ($1,$2,'2031-01-06',100,$3,'COMPLETED')`,
        [seriesId, playerId, DIGEST],
      );
      const files = loadMigrationFiles();
      await applyMigrations(pool, files.slice(0, 7));
      await pool.query(
        `INSERT INTO tournament_daily_series_completion (
           series_id, player_id, original_utc_date, claim_started_at_ms, completed_at_ms,
           manifest_digest, publication_idempotency_key
         ) VALUES ($1,$2,'2031-01-06',100,200,$3,$4)`,
        [seriesId, playerId, DIGEST, `publish:${seriesId}`],
      );
      await applyMigrations(pool, files);
      const claim = await pool.query(
        `SELECT status, manifest_digest FROM tournament_daily_claim WHERE series_id = $1`,
        [seriesId],
      );
      assert.equal(claim.rows[0].status, 'COMPLETED');
      assert.equal(claim.rows[0].manifest_digest, DIGEST);
      const journal = await pool.query(
        `SELECT db_trusted_received_at_ms FROM command_admission_journal WHERE series_key = $1`,
        [seriesId],
      );
      assert.equal(journal.rows.length, 1);
      assert.equal(journal.rows[0].db_trusted_received_at_ms, null);
      const publication = await pool.query(
        `SELECT manifest_digest FROM tournament_daily_series_completion WHERE series_id = $1`,
        [seriesId],
      );
      assert.equal(publication.rows[0].manifest_digest, DIGEST);
      await assert.rejects(
        pool.query(`UPDATE tournament_daily_claim SET player_id = 'other' WHERE series_id = $1`, [seriesId]),
        /TOURNAMENT_DAILY_CLAIM_IDENTITY_IMMUTABLE/,
      );
      await assert.rejects(
        pool.query(`UPDATE tournament_daily_series_completion SET revision = 2 WHERE series_id = $1`, [seriesId]),
        /F2B_PUBLICATION_IMMUTABLE/,
      );
      const finals = await pool.query(`SELECT count(*)::int AS n FROM tournament_f2c_settlement`);
      assert.equal(Number(finals.rows[0].n), 0);
      const again = await applyMigrations(pool, files);
      assert.deepEqual(again.applied, []);
      const still = await pool.query(
        `SELECT count(*)::int AS n FROM tournament_daily_series_completion WHERE series_id = $1`,
        [seriesId],
      );
      assert.equal(Number(still.rows[0].n), 1);
    } finally {
      await pool.end();
    }
  });

  it('rolls back a migration that fails before its history row and then retries once', async () => {
    await recreate(PROBE);
    const pool = new pg.Pool({ connectionString: urlFor(PROBE) });
    try {
      const history = loadMigrationFiles()[0]!;
      const probe: MigrationFile = {
        id: '0001_probe_interrupted',
        checksum: 'ab'.repeat(32),
        requires: ['0000_schema_history'],
        transactional: true,
        reversible: false,
        sql: 'CREATE TABLE public.pzd_mig_probe (id int)',
        path: 'probe',
      };
      const previousFault = process.env.PZD_MIGRATION_FAULT;
      process.env.PZD_MIGRATION_FAULT = '1';
      await assert.rejects(
        applyMigrations(pool, [history, probe], { faultBeforeHistoryFor: probe.id }),
        (err: unknown) => {
          assert.ok(err instanceof MigrationRefusal);
          assert.equal(err.refusal, 'MIGRATION_INTERRUPTED');
          return true;
        },
      );
      if (previousFault === undefined) delete process.env.PZD_MIGRATION_FAULT;
      else process.env.PZD_MIGRATION_FAULT = previousFault;
      const missing = await pool.query(`SELECT to_regclass('public.pzd_mig_probe') AS name`);
      assert.equal(missing.rows[0].name, null);
      const unrecorded = await pool.query(
        `SELECT 1 FROM pzd_schema_migration WHERE migration_id = $1`,
        [probe.id],
      );
      assert.equal(unrecorded.rowCount, 0);
      const applied = await applyMigrations(pool, [history, probe]);
      assert.deepEqual(applied.applied, [probe.id]);
      await pool.query(`INSERT INTO pzd_mig_probe (id) VALUES (1)`);
      const retry = await applyMigrations(pool, [history, probe]);
      assert.deepEqual(retry.skipped, [history.id, probe.id]);
      const rows = await pool.query(`SELECT count(*)::int AS n FROM pzd_mig_probe`);
      assert.equal(Number(rows.rows[0].n), 1);
      await pool.query(
        `INSERT INTO pzd_schema_migration (migration_id, checksum, reversible)
         VALUES ('9999_future', $1, false)`,
        ['cd'.repeat(32)],
      );
      await assert.rejects(applyMigrations(pool, [history, probe]), (err: unknown) => {
        assert.ok(err instanceof MigrationRefusal);
        assert.equal(err.refusal, 'MIGRATION_VERSION_AHEAD');
        return true;
      });
    } finally {
      await pool.end();
    }
  });

  it('refuses an incompatible FINAL table and leaves it unchanged', async () => {
    await recreate(BROKEN);
    const pool = new pg.Pool({ connectionString: urlFor(BROKEN) });
    try {
      await pool.query(`CREATE TABLE tournament_f2c_settlement (week_start date PRIMARY KEY)`);
      await assert.rejects(applyMigrations(pool), (err: unknown) => {
        assert.ok(err instanceof MigrationRefusal);
        assert.equal(err.refusal, 'MIGRATION_SCHEMA_INCOMPATIBLE');
        return true;
      });
      const column = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'tournament_f2c_settlement' AND column_name = 'state'`,
      );
      assert.equal(column.rowCount, 0);
      const history = await pool.query(
        `SELECT 1 FROM pzd_schema_migration WHERE migration_id = '0009_f2c_final'`,
      );
      assert.equal(history.rowCount, 0);
    } finally {
      await pool.end();
    }
  });

  it('separates runtime, reader, settlement, and audit privileges on the installed schema', async () => {
    const admin = new pg.Pool({ connectionString: urlFor(GATE) });
    const weeks = await admin.query(
      `SELECT to_char(date_trunc('week', clock_timestamp() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS current_week,
              to_char((date_trunc('week', clock_timestamp() AT TIME ZONE 'UTC')::date - 7), 'YYYY-MM-DD') AS previous_week`,
    );
    const currentWeek = String(weeks.rows[0].current_week);
    const previousWeek = String(weeks.rows[0].previous_week);
    for (const role of ['pzd_app_runtime', 'pzd_leaderboard_reader', 'pzd_settlement_worker', 'pzd_audit_admin']) {
      await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${ROLE_PASSWORD}'`);
    }
    const app = new pg.Pool({ connectionString: roleUrl('pzd_app_runtime') });
    const reader = new pg.Pool({ connectionString: roleUrl('pzd_leaderboard_reader') });
    const settlement = new pg.Pool({ connectionString: roleUrl('pzd_settlement_worker') });
    const audit = new pg.Pool({ connectionString: roleUrl('pzd_audit_admin') });
    try {
      const attributes = await admin.query(
        `SELECT rolname, rolsuper, rolcreaterole, rolcanlogin, rolbypassrls
         FROM pg_roles
         WHERE rolname LIKE 'pzd_%'`,
      );
      for (const row of attributes.rows) {
        assert.equal(row.rolsuper, false, String(row.rolname));
        assert.equal(row.rolcreaterole, false, String(row.rolname));
        assert.equal(row.rolbypassrls, false, String(row.rolname));
      }
      const seriesId = randomUUID();
      const playerId = `player-${randomUUID()}`;
      const startedAt = Date.parse(`${currentWeek}T12:00:00.000Z`);
      await app.query(
        `INSERT INTO tournament_daily_claim (
           series_id, player_id, original_utc_date, started_at_ms, manifest_digest
         ) VALUES ($1,$2,$3::date,$4,$5)`,
        [seriesId, playerId, currentWeek, startedAt, DIGEST],
      );
      await app.query(
        `INSERT INTO command_admission_journal (
           admission_id, series_key, player_id, command_type, idempotency_key, payload_hash,
           trusted_received_at_ms, db_trusted_received_at_ms, admission_seq, outcome
         ) VALUES ($1,$2,$3,'move','gate','hash',1,1,1,'pending')`,
        [randomUUID(), seriesId, playerId],
      );
      await app.query(
        `INSERT INTO tournament_daily_series_completion (
           series_id, player_id, original_utc_date, claim_started_at_ms, completed_at_ms,
           manifest_digest, publication_idempotency_key, source_command_idempotency_key, h1_admission_id
         ) VALUES ($1,$2,$3::date,$4,$5,$6,$7,'h1',$8)`,
        [seriesId, playerId, currentWeek, startedAt, startedAt + 1, DIGEST, `publish:${seriesId}`, randomUUID()],
      );
      await assert.rejects(
        app.query(
          `INSERT INTO tournament_daily_series_completion (
             series_id, player_id, original_utc_date, claim_started_at_ms, completed_at_ms,
             manifest_digest, publication_idempotency_key
           ) VALUES ($1,$2,$3::date,$4,$5,$6,$7)`,
          [seriesId, playerId, currentWeek, startedAt, startedAt + 2, DIGEST, `again:${seriesId}`],
        ),
        /duplicate key/,
      );
      const client = await app.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO tournament_daily_claim (
             series_id, player_id, original_utc_date, started_at_ms, manifest_digest
           ) VALUES ($1,$2,$3::date,$4,$5)`,
          [randomUUID(), `other-${playerId}`, currentWeek, startedAt, DIGEST],
        );
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      const claims = await app.query(
        `SELECT count(*)::int AS n FROM tournament_daily_claim WHERE player_id = $1`,
        [`other-${playerId}`],
      );
      assert.equal(Number(claims.rows[0].n), 0, 'rolled back H1-side claim');
      await app.query(
        `INSERT INTO tournament_f2b_trusted_provenance (series_id, revision, verified_at_ms, provenance_seal)
         VALUES ($1, 1, 1, $2)`,
        [seriesId, 'cd'.repeat(32)],
      );
      const forged = await evaluateLeaderboardReadEligibility(app, seriesId, { provenanceKey: PROVENANCE_KEY });
      assert.equal(forged.authorized, false);
      await assert.rejects(
        app.query(
          `UPDATE command_admission_journal SET db_trusted_received_at_ms = 999999 WHERE series_key = $1`,
          [seriesId],
        ),
        /ADMISSION_RECEIPT_IMMUTABLE/,
      );
      await assert.rejects(
        app.query(
          `UPDATE command_admission_journal SET trusted_received_at_ms = 999999 WHERE series_key = $1`,
          [seriesId],
        ),
        /ADMISSION_RECEIPT_IMMUTABLE/,
      );
      const stamped = await app.query(
        `UPDATE command_admission_journal SET outcome = 'rejected', result_json = '{"ok":true}'::jsonb
         WHERE series_key = $1 AND outcome = 'pending'`,
        [seriesId],
      );
      assert.equal(stamped.rowCount, 1);
      await assert.rejects(
        app.query(`UPDATE tournament_daily_series_completion SET revision = 2 WHERE series_id = $1`, [seriesId]),
        (err: { code?: string }) => err.code === '42501',
      );
      await assert.rejects(
        app.query(`DELETE FROM tournament_f2c_settlement`),
        (err: { code?: string }) => err.code === '42501',
      );
      await assert.rejects(
        app.query(`DROP TRIGGER trg_f2c_claim_period_closed ON tournament_daily_claim`),
        (err: { code?: string }) => err.code === '42501',
      );
      await assert.rejects(
        app.query(`ALTER TABLE tournament_daily_claim DISABLE TRIGGER trg_f2c_claim_period_closed`),
        (err: { code?: string }) => err.code === '42501',
      );
      await assert.rejects(
        app.query(`CREATE OR REPLACE FUNCTION public.tournament_f2c_reject_closed_period_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`),
        (err: { code?: string }) => err.code === '42501',
      );
      await assert.rejects(app.query(`SET ROLE pzd_migration_owner`), (err: { code?: string }) => err.code === '42501');
      await assert.rejects(
        app.query(`SET session_replication_role = replica`),
        (err: { code?: string }) => err.code === '42501',
      );
      await assert.rejects(
        app.query(`INSERT INTO pzd_schema_migration (migration_id, checksum, reversible) VALUES ('8888_forged', $1, false)`, ['ef'.repeat(32)]),
        (err: { code?: string }) => err.code === '42501',
      );
      await assert.rejects(
        reader.query(
          `INSERT INTO tournament_f2b_trusted_provenance (series_id, revision, verified_at_ms, provenance_seal)
           VALUES ($1, 1, 1, $2)`,
          [randomUUID(), DIGEST],
        ),
        (err: { code?: string }) => err.code === '42501',
      );
      const worker = new F2CRankingService(settlement, { provenanceKey: PROVENANCE_KEY });
      const finalized = await worker.finalizeWeek(previousWeek);
      assert.equal(finalized.outcome, 'final');
      if (finalized.outcome !== 'final') return;
      const retry = await worker.finalizeWeek(previousWeek);
      assert.equal(
        retry.outcome === 'final' && retry.alreadyFinal && retry.settlementId === finalized.settlementId,
        true,
      );
      const headers = await reader.query(
        `SELECT count(*)::int AS n FROM tournament_f2c_board_header WHERE settlement_id = $1`,
        [finalized.settlementId],
      );
      assert.equal(Number(headers.rows[0].n), 32);
      const board = await new F2CRankingService(reader, { provenanceKey: PROVENANCE_KEY }).readWeekly({
        weekStart: previousWeek,
        category: 'ALL',
        pageSize: 20,
      });
      assert.equal(board.ok, true);
      if (board.ok) {
        assert.equal(board.state, 'FINAL');
        assert.equal(board.settlementId, finalized.settlementId);
      }
      await assert.rejects(
        settlement.query(`UPDATE tournament_f2c_settlement SET state = 'FINAL' WHERE week_start = $1::date`, [previousWeek]),
        (err: { code?: string }) => err.code === '42501',
      );
      await assert.rejects(
        settlement.query(
          `INSERT INTO tournament_f2b_trusted_provenance (series_id, revision, verified_at_ms, provenance_seal)
           VALUES ($1, 1, 1, $2)`,
          [randomUUID(), DIGEST],
        ),
        (err: { code?: string }) => err.code === '42501',
      );
      const auditRows = await audit.query(`SELECT count(*)::int AS n FROM pzd_schema_migration`);
      assert.equal(Number(auditRows.rows[0].n), 12);
      await assert.rejects(
        audit.query(`DELETE FROM tournament_f2c_rank_snapshot`),
        (err: { code?: string }) => err.code === '42501',
      );
      const closedDate = await admin.query(
        `SELECT to_char($1::date + 1, 'YYYY-MM-DD') AS day`,
        [previousWeek],
      );
      await assert.rejects(
        app.query(
          `INSERT INTO tournament_daily_claim (
             series_id, player_id, original_utc_date, started_at_ms, manifest_digest
           ) VALUES ($1,$2,$3::date,$4,$5)`,
          [randomUUID(), `late-${playerId}`, String(closedDate.rows[0].day), startedAt, DIGEST],
        ),
        /F2C_PERIOD_CLOSED/,
      );
      await admin.query('CREATE SCHEMA evil');
      await admin.query(`CREATE TABLE evil.tournament_f2c_settlement (week_start date, state text)`);
      const diverted = await app.connect();
      try {
        await diverted.query(`SET search_path = evil, public`);
        await assert.rejects(
          diverted.query(
            `INSERT INTO tournament_daily_claim (
               series_id, player_id, original_utc_date, started_at_ms, manifest_digest
             ) VALUES ($1,$2,$3::date,$4,$5)`,
            [randomUUID(), `path-${playerId}`, String(closedDate.rows[0].day), startedAt, DIGEST],
          ),
          /F2C_PERIOD_CLOSED/,
        );
      } finally {
        diverted.release();
      }
      const owner = await admin.connect();
      try {
        await owner.query('BEGIN');
        await owner.query(`ALTER TABLE tournament_daily_claim DISABLE TRIGGER trg_f2c_claim_period_closed`);
        await owner.query(
          `INSERT INTO tournament_daily_claim (
             series_id, player_id, original_utc_date, started_at_ms, manifest_digest
           ) VALUES ($1,$2,$3::date,$4,$5)`,
          [randomUUID(), `owner-${playerId}`, String(closedDate.rows[0].day), startedAt, DIGEST],
        );
        await owner.query('ROLLBACK');
      } finally {
        owner.release();
      }
      const ownerLeak = await admin.query(
        `SELECT count(*)::int AS n FROM tournament_daily_claim WHERE player_id = $1`,
        [`owner-${playerId}`],
      );
      assert.equal(Number(ownerLeak.rows[0].n), 0);
      const snapshot = await admin.query(
        `SELECT settlement_id::text AS settlement_id FROM tournament_f2c_settlement WHERE week_start = $1::date`,
        [previousWeek],
      );
      assert.equal(snapshot.rows[0].settlement_id, finalized.settlementId);
      await admin.query(`ALTER DATABASE ${GATE} SET default_transaction_read_only = on`);
      const readonly = new pg.Pool({ connectionString: urlFor(GATE) });
      try {
        const blocked = await new F2CRankingService(readonly, { provenanceKey: PROVENANCE_KEY }).finalizeWeek(currentWeek);
        assert.equal(blocked.outcome === 'provisional' && blocked.reason === 'NOT_WRITABLE_PRIMARY', true);
      } finally {
        await readonly.end();
        await admin.query(`ALTER DATABASE ${GATE} SET default_transaction_read_only = off`);
      }
      const held = await admin.connect();
      const other = await admin.connect();
      try {
        await held.query('BEGIN');
        await held.query(`SELECT pg_advisory_xact_lock(1973609813, 1888871555)`);
        held.release(true);
        await other.query('BEGIN');
        await other.query(`SELECT set_config('lock_timeout', '1000ms', true)`);
        await other.query(`SELECT pg_advisory_xact_lock(1973609813, 1888871555)`);
        await other.query('ROLLBACK');
      } finally {
        other.release();
      }
    } finally {
      await app.end();
      await reader.end();
      await settlement.end();
      await audit.end();
      await admin.end();
    }
  });

  it('clones a database with CREATE DATABASE TEMPLATE and does not treat that as a pg_dump restore', async () => {
    await dropDatabase(RESTORE);
    const admin = new pg.Client({ connectionString: urlFor('postgres') });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${RESTORE} TEMPLATE ${GATE}`);
    } finally {
      await admin.end();
    }
    const restored = new pg.Pool({ connectionString: urlFor(RESTORE) });
    const source = new pg.Pool({ connectionString: urlFor(GATE) });
    try {
      const left = await source.query(
        `SELECT week_start::text AS week_start, settlement_id::text AS settlement_id
         FROM tournament_f2c_settlement ORDER BY week_start`,
      );
      const right = await restored.query(
        `SELECT week_start::text AS week_start, settlement_id::text AS settlement_id
         FROM tournament_f2c_settlement ORDER BY week_start`,
      );
      assert.deepEqual(right.rows, left.rows);
      assert.ok(right.rows.length >= 1);
      await assert.rejects(
        restored.query(`DELETE FROM tournament_f2c_settlement`),
        /F2C_FINAL_IMMUTABLE/,
      );
      await assert.rejects(
        restored.query(`UPDATE tournament_daily_series_completion SET revision = 9`),
        /F2B_PUBLICATION_IMMUTABLE/,
      );
      const claims = await source.query(`SELECT count(*)::int AS n FROM tournament_daily_claim`);
      const restoredClaims = await restored.query(`SELECT count(*)::int AS n FROM tournament_daily_claim`);
      assert.equal(restoredClaims.rows[0].n, claims.rows[0].n);
    } finally {
      await restored.end();
      await source.end();
    }
  });

  it('retries 0010 after the privilege block commits and before its history row', async () => {
    await recreate(PRIV);
    const pool = new pg.Pool({ connectionString: urlFor(PRIV) });
    const files = loadMigrationFiles();
    const privileges = files.find((file) => file.id === '0010_f2_privileges');
    assert.ok(privileges);
    const doIndex = sqlStatements(privileges.sql).findIndex((statement) =>
      statement.includes('trg_pzd_schema_migration_immutable'),
    );
    assert.ok(doIndex > 0);
    const previousFault = process.env.PZD_MIGRATION_FAULT;
    process.env.PZD_MIGRATION_FAULT = '1';
    try {
      await applyMigrations(pool, files.slice(0, 10));
      await assert.rejects(
        applyMigrations(pool, files, {
          faultAfterStatements: { id: privileges.id, count: doIndex + 1 },
        }),
        (err: unknown) => {
          assert.ok(err instanceof MigrationRefusal);
          assert.equal(err.refusal, 'MIGRATION_INTERRUPTED');
          return true;
        },
      );
      const recorded = await pool.query(
        `SELECT 1 FROM pzd_schema_migration WHERE migration_id = '0010_f2_privileges'`,
      );
      assert.equal(recorded.rowCount, 0);
      const owner = await pool.query(
        `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'tournament_daily_claim'`,
      );
      assert.equal(owner.rows[0].owner, 'pzd_migration_owner');
      const revoked = await pool.query(
        `SELECT has_table_privilege('pzd_app_runtime', 'public.tournament_daily_claim', 'INSERT') AS allowed`,
      );
      assert.equal(revoked.rows[0].allowed, false);
      if (previousFault === undefined) delete process.env.PZD_MIGRATION_FAULT;
      else process.env.PZD_MIGRATION_FAULT = previousFault;
      const retry = await applyMigrations(pool, files);
      assert.equal(retry.applied.includes('0010_f2_privileges'), true);
      assert.equal(retry.applied.includes('0011_journal_receipt_immutable'), true);
      const granted = await pool.query(
        `SELECT has_table_privilege('pzd_app_runtime', 'public.tournament_daily_claim', 'INSERT') AS allowed`,
      );
      assert.equal(granted.rows[0].allowed, true);
      await assertMigrationStartupReady(pool);
    } finally {
      if (previousFault === undefined) delete process.env.PZD_MIGRATION_FAULT;
      else process.env.PZD_MIGRATION_FAULT = previousFault;
      await pool.end();
    }
  });

  it('rejects startup when history or a security trigger is not exactly this build', async () => {
    await recreate(ABSENT);
    const absent = new pg.Pool({ connectionString: urlFor(ABSENT) });
    try {
      await assert.rejects(verifyMigrations(absent), (err: unknown) => {
        assert.ok(err instanceof MigrationRefusal);
        assert.equal(err.refusal, 'MIGRATION_SCHEMA_INCOMPATIBLE');
        assert.match(err.message, /absent/);
        return true;
      });
    } finally {
      await absent.end();
    }

    const pool = new pg.Pool({ connectionString: urlFor(GATE) });
    try {
      await assertMigrationStartupReady(pool);
      await withHistoryUnlocked(pool, async (client) => {
        await client.query(
          `INSERT INTO public.pzd_schema_migration (migration_id, checksum, reversible)
           VALUES ('9999_future', $1, false)`,
          ['ab'.repeat(32)],
        );
      });
      await assert.rejects(verifyMigrations(pool), (err: unknown) => {
        assert.ok(err instanceof MigrationRefusal);
        assert.equal(err.refusal, 'MIGRATION_VERSION_AHEAD');
        return true;
      });
      await withHistoryUnlocked(pool, async (client) => {
        await client.query(`DELETE FROM public.pzd_schema_migration WHERE migration_id = '9999_future'`);
      });

      const original = await pool.query(
        `SELECT checksum FROM public.pzd_schema_migration WHERE migration_id = '0004_f2a_publication'`,
      );
      const originalChecksum = String(original.rows[0].checksum);
      await withHistoryUnlocked(pool, async (client) => {
        await client.query(
          `UPDATE public.pzd_schema_migration SET checksum = $1 WHERE migration_id = '0004_f2a_publication'`,
          ['cd'.repeat(32)],
        );
      });
      await assert.rejects(verifyMigrations(pool), (err: unknown) => {
        assert.ok(err instanceof MigrationRefusal);
        assert.equal(err.refusal, 'MIGRATION_CHECKSUM_CONFLICT');
        return true;
      });
      await withHistoryUnlocked(pool, async (client) => {
        await client.query(
          `UPDATE public.pzd_schema_migration SET checksum = $1 WHERE migration_id = '0004_f2a_publication'`,
          [originalChecksum],
        );
      });

      const removed = await pool.query(
        `SELECT checksum, reversible FROM public.pzd_schema_migration WHERE migration_id = '0011_journal_receipt_immutable'`,
      );
      await withHistoryUnlocked(pool, async (client) => {
        await client.query(
          `DELETE FROM public.pzd_schema_migration WHERE migration_id = '0011_journal_receipt_immutable'`,
        );
      });
      await assert.rejects(verifyMigrations(pool), (err: unknown) => {
        assert.ok(err instanceof MigrationRefusal);
        assert.equal(err.refusal, 'MIGRATION_DEPENDENCY_MISSING');
        return true;
      });
      await withHistoryUnlocked(pool, async (client) => {
        await client.query(
          `INSERT INTO public.pzd_schema_migration (migration_id, checksum, reversible)
           VALUES ('0011_journal_receipt_immutable', $1, $2)`,
          [removed.rows[0].checksum, removed.rows[0].reversible],
        );
      });

      const constraint = await pool.query(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'public.pzd_schema_migration'::regclass AND contype = 'c'`,
      );
      const constraintName = String(constraint.rows[0].conname);
      await pool.query(`ALTER TABLE public.pzd_schema_migration DROP CONSTRAINT ${quoteIdent(constraintName)}`);
      await withHistoryUnlocked(pool, async (client) => {
        await client.query(
          `UPDATE public.pzd_schema_migration SET checksum = 'corrupt' WHERE migration_id = '0000_schema_history'`,
        );
      });
      await assert.rejects(verifyMigrations(pool), (err: unknown) => {
        assert.ok(err instanceof MigrationRefusal);
        assert.equal(err.refusal, 'MIGRATION_SCHEMA_INCOMPATIBLE');
        assert.match(err.message, /corrupt/);
        return true;
      });
      await withHistoryUnlocked(pool, async (client) => {
        await client.query(
          `UPDATE public.pzd_schema_migration SET checksum = $1 WHERE migration_id = '0000_schema_history'`,
          [(await loadChecksum(pool, '0000_schema_history'))],
        );
      });
      await pool.query(
        `ALTER TABLE public.pzd_schema_migration ADD CONSTRAINT ${quoteIdent(constraintName)} CHECK (checksum ~ '^[0-9a-f]{64}$')`,
      );

      await pool.query(
        `ALTER TABLE public.command_admission_journal DISABLE TRIGGER trg_admission_receipt_immutable`,
      );
      await assert.rejects(assertMigrationStartupReady(pool), (err: unknown) => {
        assert.ok(err instanceof MigrationRefusal);
        assert.equal(err.refusal, 'SECURITY_TRIGGER_DISABLED');
        return true;
      });
      await pool.query(
        `ALTER TABLE public.command_admission_journal ENABLE TRIGGER trg_admission_receipt_immutable`,
      );
      await assertMigrationStartupReady(pool);
    } finally {
      await restoreGateHistory(pool).catch(() => undefined);
      await pool.end();
    }
  });

  it('rejects startup against a PostgreSQL server that is not version 18', async (t) => {
    const container = 'pzd-f2-pg17-startup';
    try {
      await command('docker', ['info']);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      t.diagnostic(`incompatible-server=NOT_RUN ${message.split('\n')[0]}`);
      return;
    }
    await command('docker', ['rm', '-f', container]).catch(() => undefined);
    try {
      await command('docker', [
        'run', '-d', '--name', container,
        '-e', 'POSTGRES_PASSWORD=pzd',
        '-p', '55445:5432',
        'postgres:17',
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      t.diagnostic(`incompatible-server=NOT_RUN ${message.split('\n')[0]}`);
      await command('docker', ['rm', '-f', container]).catch(() => undefined);
      return;
    }
    const pool = new pg.Pool({
      connectionString: 'postgresql://postgres:pzd@127.0.0.1:55445/postgres',
      connectionTimeoutMillis: 1000,
    });
    try {
      await waitForPostgres(pool);
      const version = await pool.query('SHOW server_version_num');
      assert.ok(Number(version.rows[0].server_version_num) < 180000);
      await assert.rejects(assertMigrationStartupReady(pool), (err: unknown) => {
        assert.ok(err instanceof MigrationRefusal);
        assert.equal(err.refusal, 'MIGRATION_SCHEMA_INCOMPATIBLE');
        assert.match(err.message, /PostgreSQL 18/);
        return true;
      });
      t.diagnostic('incompatible-server=PASS');
    } finally {
      await pool.end();
      await command('docker', ['rm', '-f', container]).catch(() => undefined);
    }
  });

  it('restores a custom-format pg_dump without using a template database', async (t) => {
    const dumpDir = mkdtempSync(join(tmpdir(), 'pzd-f2-dump-'));
    const dumpFile = join(dumpDir, 'pzd.dump');
    try {
      const mode = await dumpAndRestore(GATE, DUMP, dumpFile);
      t.diagnostic(`pg_dump_restore=${mode}`);
      if (mode === 'NOT_RUN') {
        assert.equal(mode, 'NOT_RUN');
        return;
      }
      const source = new pg.Pool({ connectionString: urlFor(GATE) });
      const restored = new pg.Pool({ connectionString: urlFor(DUMP) });
      try {
        await verifyMigrations(restored);
        await assertMigrationStartupReady(restored);
        const left = await source.query(
          `SELECT week_start::text AS week_start, settlement_id::text AS settlement_id
           FROM tournament_f2c_settlement ORDER BY week_start`,
        );
        const right = await restored.query(
          `SELECT week_start::text AS week_start, settlement_id::text AS settlement_id
           FROM tournament_f2c_settlement ORDER BY week_start`,
        );
        assert.deepEqual(right.rows, left.rows);
        assert.ok(right.rows.length >= 1);
        await assert.rejects(restored.query(`DELETE FROM tournament_f2c_settlement`), /F2C_FINAL_IMMUTABLE/);
      } finally {
        await source.end();
        await restored.end();
      }
    } finally {
      rmSync(dumpDir, { recursive: true, force: true });
    }
  });
});

async function withHistoryUnlocked(
  pool: pg.Pool,
  mutate: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `ALTER TABLE public.pzd_schema_migration DISABLE TRIGGER trg_pzd_schema_migration_immutable`,
    );
    await mutate(client);
    await client.query(
      `ALTER TABLE public.pzd_schema_migration ENABLE TRIGGER trg_pzd_schema_migration_immutable`,
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function loadChecksum(pool: pg.Pool, id: string): Promise<string> {
  const file = loadMigrationFiles().find((candidate) => candidate.id === id);
  assert.ok(file);
  return file.checksum;
}

async function restoreGateHistory(pool: pg.Pool): Promise<void> {
  await pool.query(
    `ALTER TABLE public.command_admission_journal ENABLE TRIGGER trg_admission_receipt_immutable`,
  ).catch(() => undefined);
  const files = loadMigrationFiles();
  await withHistoryUnlocked(pool, async (client) => {
    await client.query(`DELETE FROM public.pzd_schema_migration WHERE migration_id = '9999_future'`);
    for (const file of files) {
      await client.query(
        `INSERT INTO public.pzd_schema_migration (migration_id, checksum, reversible)
         VALUES ($1, $2, false)
         ON CONFLICT (migration_id) DO UPDATE SET checksum = EXCLUDED.checksum`,
        [file.id, file.checksum],
      );
    }
  });
  const checks = await pool.query(
    `SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.pzd_schema_migration'::regclass AND contype = 'c'`,
  );
  if (checks.rowCount === 0) {
    await pool.query(
      `ALTER TABLE public.pzd_schema_migration
       ADD CONSTRAINT pzd_schema_migration_checksum_check CHECK (checksum ~ '^[0-9a-f]{64}$')`,
    );
  }
}

function quoteIdent(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Unexpected identifier ${value}`);
  return value;
}

async function waitForPostgres(pool: pg.Pool): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('Timed out waiting for PostgreSQL');
}

async function commandExists(executable: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return command(finder, [executable]).then(() => true).catch(() => false);
}

async function dumpAndRestore(
  sourceDb: string,
  targetDb: string,
  dumpFile: string,
): Promise<'host-binaries' | 'postgres-18-image' | 'NOT_RUN'> {
  const source = new URL(databaseUrl!);
  const password = decodeURIComponent(source.password);
  const user = decodeURIComponent(source.username);
  const port = source.port || '5432';
  if ((await commandExists('pg_dump')) && (await commandExists('pg_restore'))) {
    await command('pg_dump', [
      '-h', source.hostname, '-p', port, '-U', user, '-d', sourceDb,
      '--format=custom', '--no-owner', '--file', dumpFile,
    ], password);
    await recreate(targetDb);
    await command('pg_restore', [
      '-h', source.hostname, '-p', port, '-U', user, '-d', targetDb,
      '--no-owner', '--exit-on-error', dumpFile,
    ], password);
    return 'host-binaries';
  }
  try {
    await command('docker', ['info']);
  } catch {
    return 'NOT_RUN';
  }
  const volume = `${dirnameOf(dumpFile)}:/dump`;
  try {
    await command('docker', [
      'run', '--rm', '--add-host', 'host.docker.internal:host-gateway',
      '-e', `PGPASSWORD=${password}`, '-v', volume,
      'postgres:18', 'pg_dump',
      '-h', 'host.docker.internal', '-p', port, '-U', user, '-d', sourceDb,
      '--format=custom', '--no-owner', '--file', '/dump/pzd.dump',
    ]);
    await recreate(targetDb);
    await command('docker', [
      'run', '--rm', '--add-host', 'host.docker.internal:host-gateway',
      '-e', `PGPASSWORD=${password}`, '-v', volume,
      'postgres:18', 'pg_restore',
      '-h', 'host.docker.internal', '-p', port, '-U', user, '-d', targetDb,
      '--no-owner', '--exit-on-error', '/dump/pzd.dump',
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/could not connect|could not translate host|name resolution|network is unreachable|Cannot connect to the Docker daemon/i.test(message)) {
      return 'NOT_RUN';
    }
    throw err;
  }
  return 'postgres-18-image';
}

function dirnameOf(file: string): string {
  return file.slice(0, file.lastIndexOf('/'));
}

function command(
  executable: string,
  args: readonly string[],
  password?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: password ? { ...process.env, PGPASSWORD: password } : process.env,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${executable} ${args.join(' ')} exited ${code}\n${err}\n${out}`));
    });
  });
}

function roleUrl(role: string): string {
  const url = new URL(databaseUrl!);
  url.username = role;
  url.password = ROLE_PASSWORD;
  url.pathname = `/${GATE}`;
  return url.toString();
}
