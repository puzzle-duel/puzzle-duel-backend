/**
 * PZD-41 production migration, privilege, and recovery gate.
 * PostgreSQL 18 is required. A skipped database test is not a pass.
 * This file does not enable ranked HTTP and does not connect to a production database.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  loadMigrationFiles,
  MigrationRefusal,
  rollbackDisposition,
  verifyMigrations,
  type MigrationFile,
} from '../../../src/tournament/migrations/f2-migrator.mts';

const databaseUrl = process.env.PZD_INGRESS_DATABASE_URL?.trim();
const GATE = 'pzd_f2_migration_gate';
const UPGRADE = 'pzd_f2_migration_upgrade';
const BROKEN = 'pzd_f2_migration_broken';
const PROBE = 'pzd_f2_migration_probe';
const RESTORE = 'pzd_f2_migration_restore';
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
    for (const name of [GATE, UPGRADE, BROKEN, PROBE, RESTORE]) {
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

  it('restores a cloned database without changing the committed FINAL identity', async () => {
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
});

function roleUrl(role: string): string {
  const url = new URL(databaseUrl!);
  url.username = role;
  url.password = ROLE_PASSWORD;
  url.pathname = `/${GATE}`;
  return url.toString();
}
