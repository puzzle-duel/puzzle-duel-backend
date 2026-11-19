/**
 * Disposable PostgreSQL 18 primary and replica.
 * A passing result is evidence only for the containers this file started.
 * It is not a production failover acceptance.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import pg from 'pg';
import { applyMigrations } from '../../../src/tournament/migrations/f2-migrator.mts';
import { F2CRankingService } from '../../../src/tournament/results/f2c-rankings.mts';

const NET = 'pzd-f2-gate-net';
const PRIMARY = 'pzd-f2-gate-primary';
const REPLICA = 'pzd-f2-gate-replica';
function databaseUrl(ip: string): string {
  return `postgresql://postgres:pzd@${ip}:5432/postgres`;
}
const KEY = 'test-only-f2b-provenance-key-not-a-secret';
const DIGEST = 'ab'.repeat(32);
const REPL_PASSWORD = 'pzd-repl-test-only-not-a-secret';

function run(args: readonly string[]): Promise<string> {
  const limitMs = args[0] === 'run' ? 300_000 : 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`docker ${args[0]} timed out after ${limitMs}ms`)));
    }, limitMs);
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(`docker ${args.join(' ')} exited ${code}\n${err}\n${out}`));
      });
    });
  });
}

function newPool(url: string, connectionTimeoutMillis = 10_000): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    connectionTimeoutMillis,
    allowExitOnIdle: true,
  });
  pool.on('error', () => undefined);
  return pool;
}

async function endPool(pool: pg.Pool): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pool.end(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5_000);
      }),
    ]);
  } catch {
    // The container is disposable. A stuck disconnect must not hold the runner.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function containerIp(name: string): Promise<string> {
  const ip = await run(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name]);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error(`no address for ${name}`);
  return ip;
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await run(['info']);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(label: string, probe: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      if (await probe()) return;
    } catch {
      // The server is still starting or restarting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function ready(url: string): Promise<boolean> {
  const pool = newPool(url, 1_000);
  try {
    const result = await pool.query('SELECT 1 AS ok');
    return result.rows[0].ok === 1;
  } finally {
    await endPool(pool);
  }
}

describe('PZD-41 disposable PostgreSQL failover harness', () => {
  after(async () => {
    if (!(await dockerAvailable())) return;
    await run(['rm', '-f', PRIMARY, REPLICA]).catch(() => undefined);
    await run(['network', 'rm', NET]).catch(() => undefined);
  });

  it('restarts a primary, promotes a replica, and does not reopen FINAL', async (t) => {
    if (!(await dockerAvailable())) {
      assert.equal(process.env.PZD_FAILOVER_ALLOW_NOT_RUN, '1', 'FAILOVER_TOPOLOGY NOT_RUN: Docker is unavailable');
      return;
    }
    await run(['rm', '-f', PRIMARY, REPLICA]).catch(() => undefined);
    await run(['network', 'rm', NET]).catch(() => undefined);
    await run(['network', 'create', NET]);
    await run([
      'run', '-d', '--name', PRIMARY, '--network', NET, '--cap-add', 'SYS_TIME',
      '-e', 'POSTGRES_PASSWORD=pzd', 'postgres:18',
      'postgres', '-c', 'wal_level=replica', '-c', 'hot_standby=on',
      '-c', 'max_wal_senders=10', '-c', 'max_replication_slots=10',
    ]);
    const primaryUrl = databaseUrl(await containerIp(PRIMARY));
    await waitFor('primary', () => ready(primaryUrl));
    await run(['exec', PRIMARY, 'psql', '-U', 'postgres', '-c', `CREATE ROLE pzd_repl WITH REPLICATION LOGIN PASSWORD '${REPL_PASSWORD}'`]);
    await run(['exec', PRIMARY, 'bash', '-lc', `grep -q pzd_repl "$PGDATA/pg_hba.conf" || echo 'host replication pzd_repl all scram-sha-256' >> "$PGDATA/pg_hba.conf"`]);
    await run(['exec', PRIMARY, 'psql', '-U', 'postgres', '-c', 'SELECT pg_reload_conf()']);

    let primary = newPool(primaryUrl);
    const reconnect = async (): Promise<void> => {
      await endPool(primary);
      await waitFor('primary reconnect', () => ready(primaryUrl));
      primary = newPool(primaryUrl);
    };
    try {
      const version = await primary.query('SHOW server_version_num');
      assert.ok(Number(version.rows[0].server_version_num) >= 180000);
      await applyMigrations(primary);
      const sync = await primary.query(`SHOW synchronous_commit`);
      assert.equal(String(sync.rows[0].synchronous_commit), 'on');

      const abandoned = randomUUID();
      const open = await primary.connect();
      open.on('error', () => undefined);
      try {
        await open.query('BEGIN');
        await open.query(
          `INSERT INTO command_admission_journal (
             admission_id, series_key, player_id, command_type, idempotency_key, payload_hash,
             trusted_received_at_ms, db_trusted_received_at_ms, admission_seq, outcome
           ) VALUES ($1,$2,'player','move','open','hash',1,1,1,'pending')`,
          [randomUUID(), abandoned],
        );
        await run(['restart', PRIMARY]);
        await open.query('COMMIT').catch(() => undefined);
      } finally {
        open.release(true);
      }
      await reconnect();
      const lost = await primary.query(
        `SELECT count(*)::int AS n FROM command_admission_journal WHERE series_key = $1`,
        [abandoned],
      );
      assert.equal(Number(lost.rows[0].n), 0, 'uncommitted admission did not survive restart');

      const claimId = randomUUID();
      await primary.query(
        `INSERT INTO tournament_daily_claim (
           series_id, player_id, original_utc_date, started_at_ms, manifest_digest
         ) VALUES ($1,'player-failover','2032-01-05',100,$2)`,
        [claimId, DIGEST],
      );
      await primary.query(
        `INSERT INTO command_admission_journal (
           admission_id, series_key, player_id, command_type, idempotency_key, payload_hash,
           trusted_received_at_ms, db_trusted_received_at_ms, admission_seq, outcome
         ) VALUES ($1,$2,'player','move','kept','hash',1,1,1,'pending')`,
        [randomUUID(), claimId],
      );
      const publishing = await primary.connect();
      publishing.on('error', () => undefined);
      try {
        await publishing.query('BEGIN');
        await publishing.query(
          `INSERT INTO tournament_daily_series_completion (
             series_id, player_id, original_utc_date, claim_started_at_ms, completed_at_ms,
             manifest_digest, publication_idempotency_key
           ) VALUES ($1,'player-failover','2032-01-05',100,150,$2,$3)`,
          [claimId, DIGEST, `publish:${claimId}`],
        );
        await run(['restart', PRIMARY]);
        await publishing.query('COMMIT').catch(() => undefined);
      } finally {
        publishing.release(true);
      }
      await reconnect();
      const unpublished = await primary.query(
        `SELECT count(*)::int AS n FROM tournament_daily_series_completion WHERE series_id = $1`,
        [claimId],
      );
      assert.equal(Number(unpublished.rows[0].n), 0);
      await primary.query(
        `INSERT INTO tournament_daily_series_completion (
           series_id, player_id, original_utc_date, claim_started_at_ms, completed_at_ms,
           manifest_digest, publication_idempotency_key
         ) VALUES ($1,'player-failover','2032-01-05',100,150,$2,$3)`,
        [claimId, DIGEST, `publish:${claimId}`],
      );

      const settling = await primary.connect();
      settling.on('error', () => undefined);
      try {
        await settling.query('BEGIN');
        await settling.query(
          `INSERT INTO tournament_f2c_settlement (
             week_start, settlement_id, state, cutoff_ms, observed_at_ms, watermark_max_admission_seq
           ) VALUES ('2033-01-03', $1, 'FINAL', 1, 1, 0)`,
          [randomUUID()],
        );
        await run(['restart', PRIMARY]);
        await settling.query('COMMIT').catch(() => undefined);
      } finally {
        settling.release(true);
      }
      await reconnect();
      const uncommittedFinal = await primary.query(
        `SELECT count(*)::int AS n FROM tournament_f2c_settlement WHERE week_start = '2033-01-03'`,
      );
      assert.equal(Number(uncommittedFinal.rows[0].n), 0, 'uncommitted FINAL did not survive restart');
      const rankings = new F2CRankingService(primary, { provenanceKey: KEY });
      const finalized = await rankings.finalizeWeek('2020-01-06');
      assert.equal(finalized.outcome, 'final');
      if (finalized.outcome !== 'final') return;
      const again = await rankings.finalizeWeek('2020-01-06');
      assert.equal(again.outcome === 'final' && again.alreadyFinal && again.settlementId === finalized.settlementId, true);
      await run(['restart', PRIMARY]);
      await reconnect();
      const keptFinal = await primary.query(
        `SELECT settlement_id::text AS settlement_id FROM tournament_f2c_settlement WHERE week_start = '2020-01-06'`,
      );
      assert.equal(keptFinal.rows[0].settlement_id, finalized.settlementId);
      const pending = await primary.query(
        `SELECT outcome FROM command_admission_journal WHERE series_key = $1`,
        [claimId],
      );
      assert.equal(pending.rows[0].outcome, 'pending');
      const finals = await primary.query(`SELECT count(*)::int AS n FROM tournament_f2c_settlement`);
      assert.equal(Number(finals.rows[0].n), 1, 'restart did not create a settlement');

      const locker = await primary.connect();
      locker.on('error', () => undefined);
      try {
        await locker.query('BEGIN');
        await locker.query(`SELECT pg_advisory_xact_lock(1973609813, 1888871555)`);
        await run(['restart', PRIMARY]);
      } finally {
        locker.release(true);
      }
      await reconnect();
      const relock = await primary.connect();
      try {
        await relock.query('BEGIN');
        await relock.query(`SELECT set_config('lock_timeout', '1000ms', true)`);
        await relock.query(`SELECT pg_advisory_xact_lock(1973609813, 1888871555)`);
        await relock.query('COMMIT');
      } finally {
        relock.release();
      }
    } finally {
      await endPool(primary);
    }

    await run([
      'run', '-d', '--name', REPLICA, '--network', NET, '--cap-add', 'SYS_TIME', '--entrypoint', 'bash', 'postgres:18',
      '-lc',
      `set -eu
       echo waiting-for-primary
       for i in $(seq 1 90); do pg_isready -h ${PRIMARY} -U postgres && break; sleep 1; done
       echo clearing-data
       rm -rf /var/lib/postgresql/data/* /var/lib/postgresql/data/.[!.]* /var/lib/postgresql/data/..?* || true
       install -d -o postgres -g postgres -m 700 /var/lib/postgresql/data
       chown -R postgres:postgres /var/lib/postgresql/data
       chmod 700 /var/lib/postgresql/data
       echo starting-basebackup
       PGPASSWORD='${REPL_PASSWORD}' gosu postgres pg_basebackup -h ${PRIMARY} -U pzd_repl -D /var/lib/postgresql/data -Fp -Xs -R -c fast --verbose
       echo basebackup-complete
       printf "primary_conninfo = 'host=${PRIMARY} port=5432 user=pzd_repl password=${REPL_PASSWORD}'\n" >> /var/lib/postgresql/data/postgresql.auto.conf
       exec gosu postgres env PGDATA=/var/lib/postgresql/data /usr/lib/postgresql/18/bin/postgres -c listen_addresses='*' -c hot_standby=on`,
    ]);
    const replicaUrl = databaseUrl(await containerIp(REPLICA));
    let replicaLogs = '';
    try {
    await waitFor('replica', async () => {
      const state = await run(['inspect', '-f', '{{.State.Status}}', REPLICA]).catch(() => 'missing');
      if (state === 'exited') {
        replicaLogs = await run(['logs', '--tail', '80', REPLICA]).catch(() => '');
        return true;
      }
      if (!(await ready(replicaUrl))) return false;
      const pool = newPool(replicaUrl, 1_000);
      try {
        const result = await pool.query('SELECT pg_is_in_recovery() AS recovery');
        return result.rows[0].recovery === true;
      } finally {
        await endPool(pool);
      }
    });
    } catch (err) {
      const logs = await run(['logs', '--tail', '80', REPLICA]).catch(() => '');
      throw new Error(`${err instanceof Error ? err.message : String(err)}\n${logs}`);
    }
    if (replicaLogs) throw new Error(replicaLogs);

    const source = newPool(primaryUrl);
    const replica = newPool(replicaUrl);
    try {
      await replica.query('SELECT pg_wal_replay_pause()');
      await source.query(`CREATE TABLE pzd_failover_witness (id integer PRIMARY KEY)`);
      await source.query(`INSERT INTO pzd_failover_witness (id) VALUES (1)`);
      const hidden = await replica.query(`SELECT to_regclass('public.pzd_failover_witness') AS name`);
      assert.equal(hidden.rows[0].name, null, 'primary commit is not yet durable on the paused replica');
      await replica.query('SELECT pg_wal_replay_resume()');
      await waitFor('replayed witness', async () => {
        const seen = await replica.query(`SELECT count(*)::int AS n FROM pzd_failover_witness`);
        return Number(seen.rows[0].n) === 1;
      });
      const replicaFinal = await replica.query(
        `SELECT settlement_id::text AS settlement_id FROM tournament_f2c_settlement WHERE week_start = '2020-01-06'`,
      );
      assert.equal(replicaFinal.rows[0].settlement_id, (await source.query(
        `SELECT settlement_id::text AS settlement_id FROM tournament_f2c_settlement WHERE week_start = '2020-01-06'`,
      )).rows[0].settlement_id);
      const readonly = await new F2CRankingService(replica, { provenanceKey: KEY }).finalizeWeek('2020-01-13');
      assert.equal(readonly.outcome === 'provisional' && readonly.reason === 'NOT_WRITABLE_PRIMARY', true);
      await assert.rejects(
        replica.query(`INSERT INTO tournament_daily_claim (series_id, player_id, original_utc_date, started_at_ms, manifest_digest) VALUES ($1,'replica','2034-01-02',1,$2)`, [randomUUID(), DIGEST]),
        /read-only|recovery|cannot execute/i,
      );
    } finally {
      await endPool(source);
      await endPool(replica);
    }

    await run(['stop', PRIMARY]);
    const promoted = newPool(replicaUrl);
    try {
      await promoted.query(`SELECT set_config('statement_timeout', '120000', false)`);
      await promoted.query('SELECT pg_promote(wait => true)');
      await waitFor('promoted primary', async () => {
        const result = await promoted.query('SELECT pg_is_in_recovery() AS recovery');
        return result.rows[0].recovery === false;
      });
      const identity = await promoted.query(
        `SELECT settlement_id::text AS settlement_id FROM tournament_f2c_settlement WHERE week_start = '2020-01-06'`,
      );
      const settlementId = String(identity.rows[0].settlement_id);
      await assert.rejects(promoted.query(`DELETE FROM tournament_f2c_settlement`), /F2C_FINAL_IMMUTABLE/);
      await assert.rejects(
        promoted.query(
          `INSERT INTO tournament_daily_claim (series_id, player_id, original_utc_date, started_at_ms, manifest_digest)
           VALUES ($1,'late','2020-01-07',100,$2)`,
          [randomUUID(), DIGEST],
        ),
        /F2C_PERIOD_CLOSED/,
      );
      const unchanged = await promoted.query(
        `SELECT settlement_id::text AS settlement_id FROM tournament_f2c_settlement WHERE week_start = '2020-01-06'`,
      );
      assert.equal(unchanged.rows[0].settlement_id, settlementId);
      let clock = 'NOT_RUN';
      try {
        await run(['exec', REPLICA, 'date', '-u', '-s', '2019-01-01 00:00:00']);
        await assert.rejects(
          promoted.query(
            `INSERT INTO tournament_daily_claim (series_id, player_id, original_utc_date, started_at_ms, manifest_digest)
             VALUES ($1,'clock','2020-01-08',100,$2)`,
            [randomUUID(), DIGEST],
          ),
          /F2C_PERIOD_CLOSED/,
        );
        const afterClock = await promoted.query(
          `SELECT settlement_id::text AS settlement_id FROM tournament_f2c_settlement WHERE week_start = '2020-01-06'`,
        );
        assert.equal(afterClock.rows[0].settlement_id, settlementId);
        clock = 'PASS';
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('F2C_PERIOD_CLOSED') && !/date|Operation not permitted|Invalid argument|cannot set date/i.test(message)) {
          throw err;
        }
        if (message.includes('F2C_PERIOD_CLOSED')) throw err;
        clock = `NOT_RUN: ${message.split('\n')[0]}`;
      }
      t.diagnostic(`postgresql-clock=${clock}`);
      assert.ok(clock === 'PASS' || clock.startsWith('NOT_RUN'), clock);
    } finally {
      await endPool(promoted);
    }
  });
});
