/**
 * PZD-41 versioned F2 migration runner.
 *
 * Applies the SQL files in migrations/stage_f2/sql in filename order.
 * A re-run with the same checksum is a no-op. A changed checksum, a missing
 * predecessor, an unknown applied id, or a PostgreSQL major other than 18
 * refuses the run. Forward files do not delete claims, journal rows, or
 * leaderboard snapshots. Table drops are not a production rollback.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export class MigrationRefusal extends Error {
  readonly refusal: string;
  constructor(refusal: string, message: string) {
    super(message);
    this.name = 'MigrationRefusal';
    this.refusal = refusal;
  }
}

export interface MigrationFile {
  readonly id: string;
  readonly checksum: string;
  readonly requires: readonly string[];
  readonly transactional: boolean;
  readonly reversible: boolean;
  readonly sql: string;
  readonly path: string;
}

export interface MigrationApplyResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

const HEADER = /^-- pzd-([a-z-]+):\s*(.*)$/;

export function migrationSqlDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../../migrations/stage_f2/sql');
}

export function loadMigrationFiles(directory = migrationSqlDirectory()): MigrationFile[] {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const files = names.map((name) => parseMigration(join(directory, name), readFileSync(join(directory, name))));
  const ids = new Set(files.map((file) => file.id));
  if (ids.size !== files.length) {
    throw new MigrationRefusal('MIGRATION_SCHEMA_INCOMPATIBLE', 'Duplicate migration id');
  }
  return files;
}

export function parseMigration(path: string, bytes: Buffer): MigrationFile {
  const sql = bytes.toString('utf8');
  const header: Record<string, string> = {};
  for (const line of sql.split('\n')) {
    if (line === '') continue;
    if (!line.startsWith('--')) break;
    const match = HEADER.exec(line);
    if (match) header[match[1]!] = match[2]!.trim();
  }
  const id = header.migration;
  if (!id || !/^[0-9]{4}_[a-z0-9_]+$/.test(id)) {
    throw new MigrationRefusal('MIGRATION_SCHEMA_INCOMPATIBLE', `Migration id missing in ${path}`);
  }
  const requires = header.requires === 'none' || !header.requires
    ? []
    : header.requires.split(',').map((item) => item.trim()).filter(Boolean);
  return {
    id,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    requires,
    transactional: header.transactional !== 'false',
    reversible: header.reversible === 'true',
    sql,
    path,
  };
}

export function rollbackDisposition(file: MigrationFile): {
  readonly action: 'restore_backup';
  readonly reason: string;
} {
  if (file.reversible) {
    throw new MigrationRefusal(
      'MIGRATION_SCHEMA_INCOMPATIBLE',
      `${file.id} declares a reversible down path this runner does not execute`,
    );
  }
  return {
    action: 'restore_backup',
    reason: `${file.id} is forward-only. Dropping its objects would discard claims, publication receipts, or FINAL snapshots. Restore a verified backup taken before the migration.`,
  };
}

export async function applyRollback(file: MigrationFile): Promise<never> {
  const plan = rollbackDisposition(file);
  throw new MigrationRefusal('MIGRATION_ROLLBACK_REQUIRES_BACKUP', plan.reason);
}

type Queryable = {
  query: (
    text: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};

export async function applyMigrations(
  pool: Queryable & { connect?: () => Promise<pg.PoolClient> },
  files = loadMigrationFiles(),
  options?: {
    readonly faultBeforeHistoryFor?: string;
    /** Stop a nontransactional migration after this many committed statements and do not record history. */
    readonly faultAfterStatements?: { readonly id: string; readonly count: number };
  },
): Promise<MigrationApplyResult> {
  if (!pool.connect) {
    throw new MigrationRefusal('MIGRATION_SCHEMA_INCOMPATIBLE', 'A connectable pool is required');
  }
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [-1499745247, 424404725]);
    await assertPostgres18(client);
    const history = await readHistory(client);
    for (const appliedId of history.keys()) {
      if (!files.some((file) => file.id === appliedId)) {
        throw new MigrationRefusal(
          'MIGRATION_VERSION_AHEAD',
          `Database has ${appliedId}, which this build does not contain`,
        );
      }
    }
    for (const file of files) {
      const existing = history.get(file.id);
      if (existing) {
        if (existing !== file.checksum) {
          throw new MigrationRefusal(
            'MIGRATION_CHECKSUM_CONFLICT',
            `${file.id} checksum does not match the applied migration`,
          );
        }
        skipped.push(file.id);
        continue;
      }
      for (const requirement of file.requires) {
        if (!history.has(requirement) && !applied.includes(requirement)) {
          throw new MigrationRefusal(
            'MIGRATION_DEPENDENCY_MISSING',
            `${file.id} requires ${requirement}`,
          );
        }
      }
      await applyOne(client, file, {
        beforeHistory: options?.faultBeforeHistoryFor === file.id,
        afterStatements: options?.faultAfterStatements?.id === file.id
          ? options.faultAfterStatements.count
          : undefined,
      });
      applied.push(file.id);
      history.set(file.id, file.checksum);
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [-1499745247, 424404725]);
      client.release();
    } catch {
      client.release(true);
    }
  }
  return { applied, skipped };
}

/**
 * Fail closed unless the applied history is exactly this build's manifest.
 * An id this build does not contain is MIGRATION_VERSION_AHEAD.
 * A missing id is MIGRATION_DEPENDENCY_MISSING.
 * A different checksum is MIGRATION_CHECKSUM_CONFLICT.
 * A missing table, a malformed row, or a broken predecessor is refused too.
 */
export async function verifyMigrations(
  pool: Queryable,
  files = loadMigrationFiles(),
): Promise<void> {
  const history = await readHistoryStrict(pool);
  const known = new Set(files.map((file) => file.id));
  for (const [id, checksum] of history) {
    if (!/^[0-9]{4}_[a-z0-9_]+$/.test(id) || !/^[0-9a-f]{64}$/.test(checksum)) {
      throw new MigrationRefusal(
        'MIGRATION_SCHEMA_INCOMPATIBLE',
        `Migration history row ${id} is corrupt`,
      );
    }
    if (!known.has(id)) {
      throw new MigrationRefusal(
        'MIGRATION_VERSION_AHEAD',
        `Database has ${id}, which this build does not contain`,
      );
    }
  }
  for (const file of files) {
    const checksum = history.get(file.id);
    if (checksum === undefined) {
      throw new MigrationRefusal('MIGRATION_DEPENDENCY_MISSING', `${file.id} is not applied`);
    }
    if (checksum !== file.checksum) {
      throw new MigrationRefusal(
        'MIGRATION_CHECKSUM_CONFLICT',
        `${file.id} checksum does not match the applied migration`,
      );
    }
    for (const requirement of file.requires) {
      if (!history.has(requirement)) {
        throw new MigrationRefusal(
          'MIGRATION_DEPENDENCY_MISSING',
          `${file.id} requires ${requirement}`,
        );
      }
    }
  }
}

/** Triggers that must be enabled before a ranked write or settlement worker starts. */
export const REQUIRED_SECURITY_TRIGGERS = [
  'trg_tournament_daily_claim_identity_immutable',
  'trg_f2b_immutable_tournament_daily_series_completion',
  'trg_f2b_immutable_tournament_verified_subgame_score',
  'trg_f2b_immutable_tournament_daily_result_category',
  'trg_f2b_immutable_tournament_on_time_badge',
  'trg_f2b_immutable_tournament_f2b_trusted_provenance',
  'trg_f2c_immutable_tournament_f2c_settlement',
  'trg_f2c_immutable_tournament_f2c_board_header',
  'trg_f2c_immutable_tournament_f2c_rank_snapshot',
  'trg_f2c_claim_period_closed',
  'trg_f2c_publication_period_closed',
  'trg_pzd_schema_migration_immutable',
  'trg_admission_receipt_immutable',
] as const;

/**
 * Mandatory startup guard. This repository has no production process entrypoint.
 * The deployment contract in migrations/stage_f2/STARTUP.md requires every
 * ranked writer and the settlement worker to call this and abort on refusal.
 */
export async function assertMigrationStartupReady(
  pool: Queryable,
  files = loadMigrationFiles(),
): Promise<void> {
  await assertPostgres18(pool);
  await verifyMigrations(pool, files);
  const found = await pool.query(
    `SELECT tgname, tgenabled::text AS enabled
     FROM pg_trigger
     WHERE NOT tgisinternal AND tgname = ANY($1::text[])`,
    [REQUIRED_SECURITY_TRIGGERS],
  );
  const enabledByName = new Map(found.rows.map((row) => [String(row.tgname), String(row.enabled)]));
  for (const name of REQUIRED_SECURITY_TRIGGERS) {
    const enabled = enabledByName.get(name);
    if (enabled !== 'O' && enabled !== 'A') {
      throw new MigrationRefusal('SECURITY_TRIGGER_DISABLED', `${name} is not an enabled security trigger`);
    }
  }
}

async function assertPostgres18(pool: Queryable): Promise<void> {
  const result = await pool.query('SHOW server_version_num');
  const version = Number(result.rows[0]?.server_version_num);
  if (version < 180000 || version >= 190000) {
    throw new MigrationRefusal(
      'MIGRATION_SCHEMA_INCOMPATIBLE',
      `PostgreSQL 18 is required, server_version_num=${version}`,
    );
  }
}

async function readHistory(pool: Queryable): Promise<Map<string, string>> {
  const present = await pool.query(`SELECT to_regclass('public.pzd_schema_migration') AS name`);
  if (!present.rows[0]?.name) return new Map();
  return historyMap(await pool.query(
    `SELECT migration_id, checksum FROM public.pzd_schema_migration ORDER BY migration_id`,
  ));
}

async function readHistoryStrict(pool: Queryable): Promise<Map<string, string>> {
  const present = await pool.query(`SELECT to_regclass('public.pzd_schema_migration') AS name`);
  if (!present.rows[0]?.name) {
    throw new MigrationRefusal('MIGRATION_SCHEMA_INCOMPATIBLE', 'Migration history is absent');
  }
  const rows = await pool.query(
    `SELECT migration_id, checksum FROM public.pzd_schema_migration ORDER BY migration_id`,
  );
  const history = historyMap(rows);
  if (history.size !== rows.rows.length) {
    throw new MigrationRefusal('MIGRATION_SCHEMA_INCOMPATIBLE', 'Migration history contains duplicate ids');
  }
  return history;
}

function historyMap(result: { rows: Record<string, unknown>[] }): Map<string, string> {
  return new Map(result.rows.map((row) => [String(row.migration_id), String(row.checksum)]));
}

function refuseFault(): void {
  if (process.env.PZD_MIGRATION_FAULT !== '1') {
    throw new MigrationRefusal('MIGRATION_SCHEMA_INCOMPATIBLE', 'Migration fault injection is disabled');
  }
  throw new MigrationRefusal('MIGRATION_INTERRUPTED', 'Migration stopped before its history insert');
}

async function applyOne(
  client: Queryable,
  file: MigrationFile,
  fault: { readonly beforeHistory: boolean; readonly afterStatements: number | undefined },
): Promise<void> {
  try {
    const statements = sqlStatements(file.sql);
    if (file.transactional) {
      await client.query('BEGIN');
      const limit = fault.afterStatements ?? statements.length;
      for (const statement of statements.slice(0, limit)) await client.query(statement);
      if (fault.afterStatements !== undefined || fault.beforeHistory) refuseFault();
      await client.query(
        `INSERT INTO public.pzd_schema_migration (migration_id, checksum, reversible)
         VALUES ($1, $2, $3)`,
        [file.id, file.checksum, file.reversible],
      );
      await client.query('COMMIT');
      return;
    }
    const limit = fault.afterStatements ?? statements.length;
    for (const statement of statements.slice(0, limit)) {
      try {
        await client.query(statement);
      } catch (err) {
        const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : '';
        if (code === '42710' && /^\s*CREATE\s+ROLE\b/i.test(withoutLeadingComments(statement))) continue;
        throw err;
      }
    }
    if (fault.afterStatements !== undefined || fault.beforeHistory) refuseFault();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO public.pzd_schema_migration (migration_id, checksum, reversible)
       VALUES ($1, $2, $3)`,
      [file.id, file.checksum, file.reversible],
    );
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The session may have no open transaction.
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('MIGRATION_SCHEMA_INCOMPATIBLE')) {
      throw new MigrationRefusal('MIGRATION_SCHEMA_INCOMPATIBLE', message);
    }
    throw err;
  }
}

export function sqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let dollar = false;
  for (let index = 0; index < sql.length; index += 1) {
    if (!dollar && sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index);
      const next = end === -1 ? sql.length : end + 1;
      current += sql.slice(index, next);
      index = next - 1;
      continue;
    }
    if (sql.startsWith('$$', index)) {
      dollar = !dollar;
      current += '$$';
      index += 1;
      continue;
    }
    if (!dollar && sql[index] === ';') {
      if (meaningful(current)) statements.push(current.trim());
      current = '';
      continue;
    }
    current += sql[index];
  }
  if (meaningful(current)) statements.push(current.trim());
  return statements;
}

function withoutLeadingComments(statement: string): string {
  return statement
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('--');
    })
    .join('\n')
    .trim();
}

function meaningful(statement: string): boolean {
  return statement
    .split('\n')
    .some((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('--');
    });
}
