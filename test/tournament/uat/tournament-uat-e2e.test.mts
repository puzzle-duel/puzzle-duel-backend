/**
 * PZD-42 local UAT: two authenticated players, six server-adjudicated games,
 * verified publication, and daily/weekly leaderboards.
 * This does not enable production ranked HTTP and does not use pzd_ingress.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { applyMove, parseGameState, type GameState } from '../../../src/engine/core001v3/index.mts';
import { explicitTestRankedHttpGateConfig } from '../../../src/tournament/auth/ranked-feature-gate.mts';
import { applyMigrations } from '../../../src/tournament/migrations/f2-migrator.mts';
import { createUatHandler, signUatBearer, UAT_SUBJECTS } from '../../../src/tournament/uat/uat-server.mts';

const source = process.env.PZD_INGRESS_DATABASE_URL?.trim();
assert.ok(source, 'PostgreSQL required');
const DATABASE = 'pzd_pzd42_uat';
const PROVENANCE_KEY = 'test-only-f2b-provenance-key-not-a-secret';

function urlFor(name: string): string {
  const url = new URL(source!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function recreate(): Promise<void> {
  const admin = new pg.Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
  } finally {
    await admin.end();
  }
}

async function drop(): Promise<void> {
  const admin = new pg.Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
  } finally {
    await admin.end();
  }
}

type Json = Record<string, unknown>;

function client(base: string, bearer: string, secret?: string) {
  return async function request(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json | null }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: bearer,
        ...(secret ? { 'x-pzd-session-secret': secret } : {}),
        ...(body === undefined ? { 'content-length': '0' } : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) as Json : null };
  };
}

describe('PZD-42 tournament UAT', () => {
  it('plays two verified series onto the same daily and weekly boards', async () => {
    await recreate();
    const pool = new pg.Pool({ connectionString: urlFor(DATABASE), max: 8 });
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    let server: ReturnType<typeof createServer> | undefined;
    try {
      await applyMigrations(pool);
      const uat = await createUatHandler(pool, {
        provenanceKey: PROVENANCE_KEY,
        publicKeyPem,
        privateKey: pair.privateKey,
        rankedHttpGate: explicitTestRankedHttpGateConfig(),
        actualRuntimeEnv: { NODE_ENV: 'test' } as NodeJS.ProcessEnv,
        rateLimit: { maxPerWindow: 5000, windowMs: 60_000 },
      });
      server = createServer((req, res) => {
        void uat.handler(req, res);
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      const today = new Date().toISOString().slice(0, 10);
      const bearerA = signUatBearer(pair.privateKey, UAT_SUBJECTS.a);
      const bearerB = signUatBearer(pair.privateKey, UAT_SUBJECTS.b);

      const scoreA = await playSeries(base, bearerA, today, 'high');
      const scoreB = await playSeries(base, bearerB, today, 'low', { conflict: true });
      assert.ok(scoreA.all > scoreB.all, `expected player A ${scoreA.all} to outscore player B ${scoreB.all}`);

      const sessionB = await openSession(base, bearerB);
      const api = client(base, bearerB, sessionB.secret);
      const weeks = await api('GET', '/v1/tournament/leaderboards/weeks');
      assert.equal(weeks.status, 200);
      const weekStart = String((weeks.json?.weeks as string[])[0]);
      for (const category of ['EASY', 'MEDIUM', 'HARD', 'ALL']) {
        const daily = await api('GET', `/v1/tournament/leaderboards/daily?date=${today}&category=${category}&pageSize=50`);
        assert.equal(daily.status, 200, JSON.stringify(daily.json));
        const rows = daily.json?.rows as { rank: number; score: number; self: boolean }[];
        assert.ok(rows.length >= 1);
        if (category === 'ALL') {
          const self = rows.find((row) => row.self);
          assert.ok(self);
          assert.equal(self.score, scoreB.all);
          const leader = rows.find((row) => !row.self);
          assert.ok(leader);
          assert.ok(leader.rank < self.rank);
          assert.ok(leader.score > self.score);
        }
        const weekly = await api('GET', `/v1/tournament/leaderboards/weekly?weekStart=${weekStart}&category=${category}&pageSize=50`);
        assert.equal(weekly.status, 200, JSON.stringify(weekly.json));
        assert.equal(weekly.json?.state, 'PROVISIONAL');
      }

      const again = await client(base, bearerA, (await openSession(base, bearerA)).secret)(
        'POST',
        '/v1/tournament/claims/daily',
        { originalUtcDate: today },
      );
      assert.equal(again.status, 200);
      assert.equal(again.json?.original, false);
    } finally {
      if (server) {
        await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      }
      await pool.end();
      await drop();
    }
  });
});

describe('PZD-48 immutable UTC daily challenge UAT (disposable test DB only)', () => {
  it('pins one daily digest for two players, verifies six-game publication and rejects mutation', async () => {
    await recreate(); // Only pzd_pzd42_uat is dropped, never an owner UAT database.
    const pool = new pg.Pool({ connectionString: urlFor(DATABASE), max: 8 });
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    let server: ReturnType<typeof createServer> | undefined;
    try {
      await applyMigrations(pool);
      const uat = await createUatHandler(pool, {
        provenanceKey: PROVENANCE_KEY, publicKeyPem, privateKey: pair.privateKey,
        rankedHttpGate: explicitTestRankedHttpGateConfig(),
        actualRuntimeEnv: { NODE_ENV: 'test' } as NodeJS.ProcessEnv,
        enableUtcDailyManifests: true,
        rateLimit: { maxPerWindow: 5000, windowMs: 60_000 },
      });
      server = createServer((req, res) => { void uat.handler(req, res); });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const base = 'http://127.0.0.1:' + address.port;
      const utcDate = new Date().toISOString().slice(0, 10);
      const bearerA = signUatBearer(pair.privateKey, UAT_SUBJECTS.a);
      const bearerB = signUatBearer(pair.privateKey, UAT_SUBJECTS.b);

      await playSeries(base, bearerA, utcDate, 'high');
      await playSeries(base, bearerB, utcDate, 'low');

      const claims = await pool.query(
        'SELECT series_id, manifest_digest FROM tournament_daily_claim ORDER BY player_id',
      );
      assert.equal(claims.rows.length, 2);
      assert.equal(claims.rows[0].manifest_digest, claims.rows[1].manifest_digest);

      const rows = await pool.query(
        'SELECT manifest_digest, manifest_text FROM tournament_utc_daily_manifest',
      );
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0].manifest_digest.trim(), claims.rows[0].manifest_digest);
      const bindings = await pool.query(
        `SELECT c.player_id, b.subgame_ordinal, b.initial_state_json
         FROM trusted_challenge_binding b
         JOIN tournament_daily_claim c ON c.series_id=b.series_key
         ORDER BY c.player_id, b.subgame_ordinal`,
      );
      assert.equal(bindings.rows.length, 12);
      for (let i = 0; i < 6; i++) {
        assert.equal(bindings.rows[i].subgame_ordinal, bindings.rows[i + 6].subgame_ordinal);
        assert.deepEqual(bindings.rows[i].initial_state_json, bindings.rows[i + 6].initial_state_json);
      }
      await assert.rejects(
        () => pool.query(
          `UPDATE tournament_utc_daily_manifest SET content_version='forged'
           WHERE manifest_digest=$1`,
          [claims.rows[0].manifest_digest],
        ),
        /IMMUTABLE_UTC_DAILY_MANIFEST/,
      );
    } finally {
      if (server) await new Promise<void>((resolve, reject) =>
        server!.close(error => error ? reject(error) : resolve()));
      await pool.end();
      await drop();
    }
  });
});

async function openSession(base: string, bearer: string): Promise<{ secret: string }> {
  const opened = await client(base, bearer)('POST', '/v1/tournament/session');
  assert.equal(opened.status, 201);
  return { secret: String(opened.json?.sessionSecret) };
}

async function playSeries(
  base: string,
  bearer: string,
  today: string,
  prefer: 'high' | 'low',
  options?: { readonly conflict?: boolean },
): Promise<{ all: number; onTime: boolean }> {
  const first = await openSession(base, bearer);
  const api = client(base, bearer, first.secret);
  const claim = await api('POST', '/v1/tournament/claims/daily', { originalUtcDate: today });
  assert.equal(claim.status, 201, JSON.stringify(claim.json));
  const seriesId = String(claim.json?.seriesId);
  let writerGeneration = Number(claim.json?.writerGeneration);
  assert.equal(writerGeneration, 1);

  if (options?.conflict) {
    const recovered = await client(base, bearer, first.secret)('GET', '/v1/tournament/session');
    assert.equal(recovered.status, 200);
    assert.equal(typeof recovered.json?.sessionId, 'string');
    assert.equal(recovered.json?.sessionSecret, undefined);
    const second = await openSession(base, bearer);
    const other = client(base, bearer, second.secret);
    const conflicted = await other('POST', `/v1/tournament/series/${seriesId}/commands`, {
      commandType: 'move',
      idempotencyKey: `conflict-${seriesId}`,
      move: {
        offerIndex: 0,
        tap: [0, 0],
        expectedBoardRevision: 0,
        writerGeneration: 1,
      },
    });
    assert.equal(conflicted.status, 409);
    assert.equal(conflicted.json?.error, 'WRITER_NOT_AUTHORIZED');
    const seized = await other('POST', `/v1/tournament/series/${seriesId}/commands`, {
      commandType: 'device_handoff',
      idempotencyKey: `handoff-${seriesId}`,
      expectedWriterGeneration: 1,
    });
    assert.equal(seized.status, 409);
    assert.equal(seized.json?.error, 'WRITER_NOT_AUTHORIZED');
  }
  return finish(api, seriesId, writerGeneration, prefer);
}

async function finish(
  api: ReturnType<typeof client>,
  seriesId: string,
  writerGeneration: number,
  prefer: 'high' | 'low',
): Promise<{ all: number; onTime: boolean }> {
  for (let ordinal = 1; ordinal <= 6; ordinal += 1) {
    let revision = ordinal === 1 ? 0 : Number((await api('GET', `/v1/tournament/series/${seriesId}/board`)).json?.boardRevision);
    const expectedSize = [5, 5, 5, 6, 6, 7][ordinal - 1];
    const expectedLimit = [15, 15, 15, 12, 12, 10][ordinal - 1];
    for (let guard = 0; guard < 16; guard += 1) {
      const view = await api('GET', `/v1/tournament/series/${seriesId}/board`);
      assert.equal(view.status, 200, JSON.stringify(view.json));
      if (view.json?.gameStatus === 'ended' || view.json?.awaitAdvance === true) break;
      const state = parseGameState(view.json?.state);
      if (state.turnsUsed === 0) {
        assert.equal(state.boardSize, expectedSize, `ordinal ${ordinal} board`);
        assert.equal(state.moveLimit, expectedLimit, `ordinal ${ordinal} budget`);
      }
      const choice = chooseMove(state, prefer);
      assert.ok(choice, `no legal move at ordinal ${ordinal}`);
      const key = `move-${seriesId}-${ordinal}-${revision}`;
      const body = {
        commandType: 'move',
        idempotencyKey: key,
        move: {
          offerIndex: choice.offerIndex,
          tap: [choice.row, choice.column],
          expectedBoardRevision: Number(view.json?.boardRevision),
          writerGeneration,
        },
      };
      const applied = await api('POST', `/v1/tournament/series/${seriesId}/commands`, body);
      assert.equal(applied.status, 200, JSON.stringify(applied.json));
      const replay = await api('POST', `/v1/tournament/series/${seriesId}/commands`, body);
      assert.equal(replay.status, 200, JSON.stringify(replay.json));
      assert.equal(replay.json?.duplicateReplay, true);
      revision = Number(applied.json?.boardRevision);
    }
    const after = await api('GET', `/v1/tournament/series/${seriesId}/board`);
    if (ordinal < 6) {
      assert.equal(after.json?.awaitAdvance, true, JSON.stringify(after.json));
      const advanced = await api('POST', `/v1/tournament/series/${seriesId}/commands`, {
        commandType: 'advance',
        idempotencyKey: `advance-${seriesId}-${ordinal}`,
      });
      assert.equal(advanced.status, 200, JSON.stringify(advanced.json));
    }
  }
  const results = await api('GET', `/v1/tournament/series/${seriesId}/results`);
  assert.equal(results.status, 200, JSON.stringify(results.json));
  assert.equal((results.json?.games as unknown[]).length, 6);
  return { all: Number(results.json?.all), onTime: results.json?.onTimeAwarded === true };
}

function chooseMove(state: GameState, prefer: 'high' | 'low'): { offerIndex: 0 | 1 | 2; row: number; column: number } | null {
  const found: { offerIndex: 0 | 1 | 2; row: number; column: number; scoreDelta: number }[] = [];
  for (const offerIndex of [0, 1, 2] as const) {
    for (let row = 0; row < state.boardSize; row += 1) {
      for (let column = 0; column < state.boardSize; column += 1) {
        const result = applyMove(state, { offerIndex, tap: { row, column } });
        if (result.kind === 'applied') {
          found.push({ offerIndex, row, column, scoreDelta: result.scoreDelta });
        }
      }
    }
  }
  if (found.length === 0) return null;
  found.sort((left, right) => left.scoreDelta - right.scoreDelta || left.offerIndex - right.offerIndex || left.row - right.row || left.column - right.column);
  return prefer === 'high' ? found[found.length - 1]! : found[0]!;
}
