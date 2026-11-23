/**
 * PZD-41 F2-C — PostgreSQL 18 daily/weekly ranks and immutable FINAL.
 * Skipped database tests are not a pass. This file requires PostgreSQL 18.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { claimWindowClosed } from '../../../src/tournament/claims/atomic-claim-bootstrap.mts';
import { DAILY_CLAIM_DDL } from '../../../src/tournament/claims/postgres-daily-claim.mts';
import {
  digestManifestPayload,
  PinnedManifestRegistry,
  type PinnedDailyManifest,
} from '../../../src/tournament/claims/pinned-manifest-registry.mts';
import { SERIES_WRITER_DDL } from '../../../src/tournament/auth/series-writer-binding.mts';
import {
  parseInitialGameState,
  replayCore001V3,
  stateHashV3,
  stateToJson,
} from '../../../src/engine/core001v3/index.mts';
import { TRUSTED_GAMEPLAY_DDL } from '../../../src/tournament/adjudication/postgres-stores.mts';
import { PostgresTrustedUnitOfWork } from '../../../src/tournament/adjudication/postgres-uow.mts';
import { ADMISSION_JOURNAL_DDL } from '../../../src/tournament/ingress/postgres-journal.mts';
import {
  lockSeriesForTransaction,
  lockWeeklySettlement,
  SERIES_FENCE_DDL,
  seriesAdvisoryKeys,
} from '../../../src/tournament/ingress/series-fence.mts';
import { F2A_PUBLICATION_DROP_DDL } from '../../../src/tournament/results/f2a-publication-schema.mts';
import { F2BPublicationService } from '../../../src/tournament/results/f2b-publication.mts';
import {
  addSafeScore,
  competitionRanks,
  F2C_PAGE_SIZE_LIMIT,
  F2C_RANKING_DROP_DDL,
  F2CRankingService,
  type F2CSettlementResult,
  f2cSnapshotLabels,
  formatUtcDate,
  visibleWeekStarts,
  weekDates,
  weeklyFinalCutoffMs,
  type F2CRankRow,
} from '../../../src/tournament/results/f2c-rankings.mts';

const url =
  process.env.PZD_INGRESS_DATABASE_URL ??
  'postgresql://pzd:pzd@127.0.0.1:55432/pzd_ingress';
const KEY = 'test-only-f2b-provenance-key-not-a-secret';
const __dirname = dirname(fileURLToPath(import.meta.url));
const scoringFixture = JSON.parse(
  readFileSync(join(__dirname, '../../../docs/contracts/gameplay/v3/fixtures/V3-02-single-wave.json'), 'utf8'),
);
const zeroFixture = JSON.parse(
  readFileSync(join(__dirname, '../../../docs/contracts/gameplay/v3/fixtures/V3-09-move-limit.json'), 'utf8'),
);
const scoringInitial = { ...scoringFixture.initialState, moveLimit: 1 };
const zeroInitial = zeroFixture.initialState;
type GamePlan = { readonly initial: unknown; readonly moves: readonly unknown[] };
const mixedGames: GamePlan[] = [0, 1, 2, 3, 4, 5].map((index) =>
  index % 2 === 0
    ? { initial: scoringInitial, moves: scoringFixture.moves }
    : { initial: zeroInitial, moves: zeroFixture.moves },
);
const zeroGames: GamePlan[] = [0, 1, 2, 3, 4, 5].map(() => ({ initial: zeroInitial, moves: zeroFixture.moves }));

function buildManifest(contentVersion: string, games: readonly GamePlan[]): PinnedDailyManifest {
  const subgames = games.map((game, index) => ({
    ordinal: index + 1,
    challengeId: `${contentVersion}-chal-${index + 1}`,
    generatorVersion: 'gen-001.v1-adapter-test',
    contentVersion: 'f2c-subgame',
    initialState: game.initial,
  }));
  return { digest: digestManifestPayload(contentVersion, subgames), contentVersion, subgames };
}

const mixedManifest = buildManifest('f2c-mixed', mixedGames);
const zeroManifest = buildManifest('f2c-zero', zeroGames);
const manifests = new PinnedManifestRegistry([mixedManifest, zeroManifest], mixedManifest.digest);
const plans = new Map<string, readonly GamePlan[]>([
  [mixedManifest.digest, mixedGames],
  [zeroManifest.digest, zeroGames],
]);

let pool: pg.Pool;
let rankings: F2CRankingService;
let publisher: F2BPublicationService;
let currentWeek = '';
let previousWeek = '';
let faultWeek = '';

before(async () => {
  pool = new pg.Pool({ connectionString: url, max: 6 });
  const version = await pool.query('SHOW server_version_num');
  const num = Number(version.rows[0].server_version_num);
  assert.ok(num >= 180000 && num < 190000, `PostgreSQL 18 required, got ${num}`);
  await pool.query(F2C_RANKING_DROP_DDL);
  await pool.query(F2A_PUBLICATION_DROP_DDL);
  await pool.query('DROP TABLE IF EXISTS authoritative_game_snapshot');
  await pool.query('DROP TABLE IF EXISTS accepted_move_ledger');
  await pool.query('DROP TABLE IF EXISTS trusted_challenge_binding');
  await pool.query('DROP TABLE IF EXISTS tournament_series_writer');
  await pool.query('DROP TABLE IF EXISTS series_fence_state');
  await pool.query('DROP TABLE IF EXISTS command_admission_journal');
  await pool.query('DROP TABLE IF EXISTS tournament_daily_claim CASCADE');
  await pool.query(DAILY_CLAIM_DDL);
  await pool.query(SERIES_FENCE_DDL);
  await pool.query(TRUSTED_GAMEPLAY_DDL);
  await pool.query(ADMISSION_JOURNAL_DDL);
  await pool.query(SERIES_WRITER_DDL);
  publisher = new F2BPublicationService(pool, { provenanceKey: KEY, manifests });
  await publisher.migrate();
  rankings = new F2CRankingService(pool, { provenanceKey: KEY });
  await rankings.migrate();
  const now = await dbNow();
  const weeks = visibleWeekStarts(now);
  currentWeek = weeks[0]!;
  // At Monday 00:00–01:00 UTC the immediately preceding week has not yet
  // reached its established FINAL cutoff. Use the latest *settled* visible
  // previous week so these integration cases remain independent of CI time.
  previousWeek = weeks.find((week, index) =>
    index > 0 && now >= weeklyFinalCutoffMs(week))!;
  faultWeek = weeks[3]!;
  assert.ok(now >= weeklyFinalCutoffMs(previousWeek));
  assert.ok(now < weeklyFinalCutoffMs(currentWeek));
});

after(async () => {
  await pool.query(F2C_RANKING_DROP_DDL);
  await pool.query(F2A_PUBLICATION_DROP_DDL);
  await pool.end();
});

async function dbNow(): Promise<number> {
  const result = await pool.query(
    `SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS ms`,
  );
  return Number(result.rows[0].ms);
}

async function settlementCount(weekStart: string): Promise<number> {
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM tournament_f2c_settlement WHERE week_start = $1::date`,
    [weekStart],
  );
  return Number(result.rows[0].n);
}

function closedReason(result: F2CSettlementResult): string {
  assert.equal(result.outcome, 'provisional');
  if (result.outcome !== 'provisional') throw new Error('expected provisional');
  return result.reason;
}

function rowsOf(page: { ok: true; rows: readonly F2CRankRow[] } | { ok: false }): F2CRankRow[] {
  assert.equal(page.ok, true);
  if (!page.ok) throw new Error('unread');
  return [...page.rows];
}

async function seedSeries(args: {
  date: string;
  manifest?: PinnedDailyManifest;
  mode?: 'complete' | 'five';
  claimStatus?: 'ACTIVE' | 'FORFEITED';
  hardCutoffAtMs?: number | null;
  playerId?: string;
  startedAtMs?: number;
}): Promise<{ seriesId: string; playerId: string }> {
  const manifest = args.manifest ?? mixedManifest;
  const plan = plans.get(manifest.digest);
  if (!plan) throw new Error('missing plan');
  const mode = args.mode ?? 'complete';
  const seriesId = randomUUID();
  const playerId = args.playerId ?? randomUUID();
  const startedAtMs = args.startedAtMs ?? Date.parse(`${args.date}T12:00:00.000Z`);
  const h1ReceivedAtMs = startedAtMs + 60_000;
  await pool.query(
    `INSERT INTO tournament_daily_claim
       (series_id, player_id, original_utc_date, started_at_ms, manifest_digest, status)
     VALUES ($1,$2,$3::date,$4,$5,$6)`,
    [seriesId, playerId, args.date, startedAtMs, manifest.digest, args.claimStatus ?? 'ACTIVE'],
  );
  let running = 0;
  let h1AdmissionId: string | null = null;
  const played: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    const ordinal = index + 1;
    const game = plan[index]!;
    const sub = manifest.subgames[index]!;
    const initial = parseInitialGameState(game.initial);
    const initialDigest = stateHashV3(initial);
    await pool.query(
      `INSERT INTO trusted_challenge_binding (
         series_key, player_id, subgame_ordinal, challenge_id, rules_version,
         generator_version, content_version, initial_state_digest, initial_state_json, assigned_at_ms
       ) VALUES ($1,$2,$3,$4,'core-001.v3',$5,$6,$7,$8::jsonb,$9)`,
      [
        seriesId, playerId, ordinal, sub.challengeId, sub.generatorVersion, sub.contentVersion,
        initialDigest, JSON.stringify(stateToJson(initial)), startedAtMs,
      ],
    );
    if (mode === 'five' && ordinal === 6) continue;
    const replayed = replayCore001V3({ initialState: game.initial, moves: game.moves });
    if (!replayed.ok || replayed.finalState.status !== 'ended') throw new Error(`ordinal ${ordinal} did not end`);
    const admissionId = randomUUID();
    if (ordinal === 6) h1AdmissionId = admissionId;
    const delta = replayed.applied.reduce((sum, item) => sum + item.scoreDelta, 0);
    running += delta;
    const move = game.moves[0] as { offerIndex: 0 | 1 | 2; tap: [number, number] };
    await pool.query(
      `INSERT INTO accepted_move_ledger (
         series_key, player_id, subgame_ordinal, challenge_id, admission_id, admission_seq,
         board_revision_after, move_json, score_delta, score_after, state_hash_before,
         state_hash_after, rules_version, trusted_received_at_ms, terminal_after, terminal_reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,'core-001.v3',$13,TRUE,$14)`,
      [
        seriesId, playerId, ordinal, sub.challengeId, admissionId, ordinal, ordinal,
        JSON.stringify({ offerIndex: move.offerIndex, tap: { row: move.tap[0], column: move.tap[1] } }),
        delta, running, initialDigest, replayed.stateHash,
        ordinal === 6 ? h1ReceivedAtMs : startedAtMs + ordinal * 1000,
        replayed.finalState.terminalReason,
      ],
    );
    await pool.query(
      `INSERT INTO authoritative_game_snapshot (
         series_key, player_id, subgame_ordinal, challenge_id, board_revision, move_cursor,
         state_hash, score, status, terminal_reason, state_json, ledger_admission_seq,
         writer_generation, produced_by_admission_id
       ) VALUES ($1,$2,$3,$4,$5,1,$6,$7,'ended',$8,$9::jsonb,$10,1,$11)`,
      [
        seriesId, playerId, ordinal, sub.challengeId, ordinal, replayed.stateHash, running,
        replayed.finalState.terminalReason, JSON.stringify(stateToJson(replayed.finalState)),
        ordinal, admissionId,
      ],
    );
    await pool.query(
      `INSERT INTO command_admission_journal (
         admission_id, series_key, player_id, command_type, idempotency_key, payload_hash,
         trusted_received_at_ms, admission_seq, outcome, expected_board_revision, writer_generation
       ) VALUES ($1,$2,$3,'move',$4,$5,$6,$7,'applied',$8,1)`,
      [
        admissionId, seriesId, playerId, `move-${ordinal}`,
        createHash('sha256').update(admissionId).digest('hex'),
        ordinal === 6 ? h1ReceivedAtMs : startedAtMs + ordinal * 1000,
        ordinal, ordinal - 1,
      ],
    );
    played.push(ordinal);
  }
  await pool.query(
    `INSERT INTO series_fence_state (
       series_key, board_revision, writer_generation, status, idle_deadline_at_ms,
       hard_cutoff_at_ms, score, results_published, last_applied_admission_id, thinking_extension_consumed
     ) VALUES ($1,$2,1,$3,$4,$5,$6,FALSE,$7,FALSE)`,
    [
      seriesId, played.length, mode === 'five' ? 'ACTIVE' : 'AWAIT_ADVANCE',
      h1ReceivedAtMs + 300_000, args.hardCutoffAtMs === undefined ? null : args.hardCutoffAtMs,
      running, h1AdmissionId,
    ],
  );
  await pool.query(
    `INSERT INTO tournament_series_writer
       (series_key, player_id, session_id, device_id, writer_generation, updated_at_ms)
     VALUES ($1,$2,$3,$4,1,$5)`,
    [seriesId, playerId, randomUUID(), randomUUID(), startedAtMs],
  );
  return { seriesId, playerId };
}

async function publishCompleted(
  date: string,
  manifest = mixedManifest,
  playerId?: string,
  startedAtMs?: number,
): Promise<{ seriesId: string; playerId: string }> {
  const seeded = await seedSeries({ date, manifest, playerId, startedAtMs });
  const published = await publisher.publish({
    seriesId: seeded.seriesId,
    playerId: seeded.playerId,
    writerGeneration: 1,
    commandIdempotencyKey: `h1:${seeded.seriesId}`,
    event: 'h1_terminal_move',
  });
  assert.equal(published.outcome, 'published');
  if (published.outcome === 'published') {
    assert.equal(published.all, manifest === zeroManifest ? 0 : 900);
    assert.equal(published.easy, manifest === zeroManifest ? 0 : 600);
  }
  return seeded;
}

async function eraseUnpublished(seriesId: string): Promise<void> {
  await pool.query('DELETE FROM command_admission_journal WHERE series_key = $1', [seriesId]);
  await pool.query('DELETE FROM accepted_move_ledger WHERE series_key = $1', [seriesId]);
  await pool.query('DELETE FROM authoritative_game_snapshot WHERE series_key = $1', [seriesId]);
  await pool.query('DELETE FROM trusted_challenge_binding WHERE series_key = $1', [seriesId]);
  await pool.query('DELETE FROM tournament_series_writer WHERE series_key = $1', [seriesId]);
  await pool.query('DELETE FROM series_fence_state WHERE series_key = $1', [seriesId]);
  await pool.query('DELETE FROM tournament_daily_claim WHERE series_id = $1', [seriesId]);
}

describe('F2-C ranking math and Monday window', () => {
  it('assigns competition ranks 1/1/3 and sorts display by player id', () => {
    const ranked = competitionRanks([
      { playerId: 'player-c', score: 450 },
      { playerId: 'player-b', score: 500 },
      { playerId: 'player-a', score: 500 },
    ]);
    assert.deepEqual(
      ranked.map((row) => [row.playerId, row.score, row.rank, row.displayPosition]),
      [
        ['player-a', 500, 1, 1],
        ['player-b', 500, 1, 2],
        ['player-c', 450, 3, 3],
      ],
    );
  });

  it('rejects a weekly sum that overflows a safe integer', () => {
    assert.equal(addSafeScore(0, 0), 0);
    assert.throws(() => addSafeScore(Number.MAX_SAFE_INTEGER, 1), /WEEKLY_SCORE_OVERFLOW/);
  });

  it('closes a previous-week claim at Monday 00:00 UTC and keeps the new week open', () => {
    const monday = Date.parse('2026-11-16T00:00:00.000Z');
    assert.equal(claimWindowClosed(monday, '2026-11-15'), true);
    assert.equal(claimWindowClosed(monday, '2026-11-16'), false);
    assert.equal(claimWindowClosed(Date.parse('2026-11-15T23:59:59.999Z'), '2026-11-15'), false);
    assert.equal(weeklyFinalCutoffMs('2026-11-09'), Date.parse('2026-11-16T01:00:00.000Z'));
    assert.equal(weekDates('2026-11-09')[0], '2026-11-09');
    assert.equal(weekDates('2026-11-09')[6], '2026-11-15');
    assert.equal(visibleWeekStarts(monday).length, 6);
    assert.equal(F2C_PAGE_SIZE_LIMIT > 100, true);
  });
});

describe('F2-C PostgreSQL rankings and FINAL', { concurrency: false }, () => {
  it('credits retrospective completed series to weekly only, never the original daily board', async () => {
    const monday = currentWeek;
    const thursdayClaimMs = Date.parse(`${currentWeek}T00:00:00.000Z`) + 3 * 86_400_000 + 12 * 3_600_000;
    const late = await publishCompleted(monday, mixedManifest, undefined, thursdayClaimMs);
    const mondayDaily = rowsOf(await rankings.readDaily({ date: monday, category: 'ALL', pageSize: 50 }));
    assert.equal(mondayDaily.some((row) => row.playerId === late.playerId), false);
    const weekly = rowsOf(await rankings.readWeekly({ weekStart: currentWeek, category: 'ALL', pageSize: 50 }));
    assert.equal(weekly.find((row) => row.playerId === late.playerId)?.score, 900);
    const badge = await pool.query('SELECT awarded FROM tournament_on_time_badge WHERE series_id = $1', [late.seriesId]);
    assert.equal(badge.rows[0]?.awarded, false);
  });

  it('ranks authorized daily categories, ties, zero scores, and excludes partial or forfeited series', async () => {
    const tuesday = formatUtcDate(Date.parse(`${currentWeek}T00:00:00.000Z`) + 86_400_000);
    const highA = await publishCompleted(tuesday);
    const highB = await publishCompleted(tuesday);
    const zero = await publishCompleted(tuesday, zeroManifest);
    const partial = await seedSeries({
      date: tuesday,
      mode: 'five',
      hardCutoffAtMs: weeklyFinalCutoffMs(currentWeek),
    });
    await pool.query(`UPDATE series_fence_state SET results_published = TRUE WHERE series_key = $1`, [partial.seriesId]);
    const forfeited = await seedSeries({
      date: tuesday,
      claimStatus: 'FORFEITED',
      hardCutoffAtMs: weeklyFinalCutoffMs(currentWeek),
    });
    const rejected = await publisher.publish({
      seriesId: forfeited.seriesId,
      playerId: forfeited.playerId,
      writerGeneration: 1,
      commandIdempotencyKey: `h1:${forfeited.seriesId}`,
      event: 'h1_terminal_move',
    });
    assert.equal(rejected.outcome, 'rejected');

    for (const category of ['EASY', 'MEDIUM', 'HARD', 'ALL'] as const) {
      const page = await rankings.readDaily({ date: tuesday, category, pageSize: 50 });
      const rows = rowsOf(page);
      assert.equal(rows.some((row) => row.playerId === partial.playerId), false);
      assert.equal(rows.some((row) => row.playerId === forfeited.playerId), false);
      assert.equal(rows.some((row) => row.playerId === zero.playerId), true);
      const scores = new Map(rows.map((row) => [row.playerId, row]));
      const expectedHigh = category === 'EASY' ? 600 : category === 'MEDIUM' ? 300 : category === 'HARD' ? 0 : 900;
      assert.equal(scores.get(highA.playerId)?.score, expectedHigh);
      assert.equal(scores.get(highB.playerId)?.score, expectedHigh);
      assert.equal(scores.get(zero.playerId)?.score, 0);
      if (category === 'HARD') {
        assert.equal(scores.get(highA.playerId)?.rank, 1);
        assert.equal(scores.get(zero.playerId)?.rank, 1);
      } else {
        assert.equal(scores.get(highA.playerId)?.rank, 1);
        assert.equal(scores.get(highB.playerId)?.rank, 1);
        assert.equal(scores.get(zero.playerId)?.rank, 3);
      }
      const ordered = [...rows].sort((left, right) => right.score - left.score || (left.playerId < right.playerId ? -1 : 1));
      assert.deepEqual(rows.map((row) => row.playerId), ordered.map((row) => row.playerId));
      assert.equal(page.ok && page.state, 'PROVISIONAL');
    }
    const again = await publisher.publish({
      seriesId: highA.seriesId,
      playerId: highA.playerId,
      writerGeneration: 1,
      commandIdempotencyKey: 'different-command-key',
      event: 'h1_terminal_move',
    });
    assert.equal(again.outcome, 'duplicate');
    const afterDuplicate = rowsOf(await rankings.readDaily({ date: tuesday, category: 'ALL', pageSize: 50 }));
    assert.equal(afterDuplicate.filter((row) => row.playerId === highA.playerId).length, 1);
    const wrongKey = new F2CRankingService(pool, { provenanceKey: 'forged-key-that-is-long-enough-for-hmac' });
    const hidden = rowsOf(await wrongKey.readDaily({ date: tuesday, category: 'ALL', pageSize: 50 }));
    assert.equal(hidden.length, 0);
    const page = await rankings.readDaily({ date: tuesday, category: 'ALL', pageSize: 50 });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    const encoded = JSON.stringify(page);
    for (const secret of ['email', 'session', 'token', 'device', 'provider', 'provenance']) {
      assert.equal(encoded.includes(secret), false);
    }
    for (const row of page.rows) {
      assert.deepEqual(Object.keys(row).sort(), ['displayPosition', 'onTimeAwarded', 'playerId', 'rank', 'score']);
    }
    assert.equal(page.rows.every((row) => row.onTimeAwarded === true), true);
  });

  it('paginates inside one revision and rejects a stale cursor after the board changes', async () => {
    const tuesday = formatUtcDate(Date.parse(`${currentWeek}T00:00:00.000Z`) + 86_400_000);
    const first = await rankings.readDaily({ date: tuesday, category: 'ALL', pageSize: 1 });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.ok(first.nextCursor);
    const second = await rankings.readDaily({ date: tuesday, category: 'ALL', pageSize: 1, cursor: first.nextCursor! });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(first.rows[0]?.playerId === second.rows[0]?.playerId, false);
    assert.equal(first.revision, second.revision);
    const added = await publishCompleted(tuesday);
    const stale = await rankings.readDaily({ date: tuesday, category: 'ALL', pageSize: 1, cursor: first.cursor });
    assert.deepEqual(stale, { ok: false, reason: 'SNAPSHOT_CHANGED' });
    const fresh = rowsOf(await rankings.readDaily({ date: tuesday, category: 'ALL', pageSize: 50 }));
    assert.equal(fresh.some((row) => row.playerId === added.playerId), true);
    assert.deepEqual(
      await rankings.readDaily({ date: tuesday, category: 'ALL', pageSize: 0 }),
      { ok: false, reason: 'INVALID_PAGE_SIZE' },
    );
    const wide = await rankings.readDaily({ date: tuesday, category: 'ALL', pageSize: 101 });
    assert.equal(wide.ok, true);
    assert.deepEqual(
      await rankings.readDaily({ date: tuesday, category: 'ALL', pageSize: 50, cursor: 'not-a-cursor' }),
      { ok: false, reason: 'INVALID_CURSOR' },
    );
  });

  it('does not show an uncommitted publication to a concurrent ranking read', async () => {
    const wednesday = formatUtcDate(Date.parse(`${currentWeek}T00:00:00.000Z`) + 2 * 86_400_000);
    const seeded = await seedSeries({ date: wednesday });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pausing = new F2BPublicationService(pool, {
      provenanceKey: KEY,
      manifests,
      hooks: {
        observe: async (point) => {
          if (point === 'before_commit') {
            entered();
            await gate;
          }
        },
      },
    });
    const pending = pausing.publish({
      seriesId: seeded.seriesId,
      playerId: seeded.playerId,
      writerGeneration: 1,
      commandIdempotencyKey: `h1:${seeded.seriesId}`,
      event: 'h1_terminal_move',
    });
    await started;
    const during = rowsOf(await rankings.readDaily({ date: wednesday, category: 'ALL', pageSize: 50 }));
    assert.equal(during.some((row) => row.playerId === seeded.playerId), false);
    release();
    const published = await pending;
    assert.equal(published.outcome, 'published');
    const after = rowsOf(await rankings.readDaily({ date: wednesday, category: 'ALL', pageSize: 50 }));
    const row = after.find((item) => item.playerId === seeded.playerId);
    assert.equal(row?.score, 900);
    assert.equal(row?.rank, 1);
  });

  it('sums seven eligible days, omits a missing day, and keeps Sunday out of the next week', async () => {
    const dates = weekDates(previousWeek);
    let sevenPlayer = '';
    for (const date of dates) {
      const row = await publishCompleted(date, mixedManifest, sevenPlayer || undefined);
      sevenPlayer = row.playerId;
    }
    let sixPlayer = '';
    for (const date of dates) {
      if (date === dates[2]) continue;
      const row = await publishCompleted(date, mixedManifest, sixPlayer || undefined);
      sixPlayer = row.playerId;
    }
    const weekly = rowsOf(await rankings.readWeekly({ weekStart: previousWeek, category: 'ALL', pageSize: 50 }));
    assert.equal(weekly.find((row) => row.playerId === sevenPlayer)?.score, 900 * 7);
    assert.equal(weekly.find((row) => row.playerId === sixPlayer)?.score, 900 * 6);
    assert.equal(weekly.find((row) => row.playerId === sixPlayer)?.onTimeAwarded, null);
    const wednesday = rowsOf(await rankings.readDaily({ date: dates[2]!, category: 'ALL', pageSize: 50 }));
    assert.equal(wednesday.some((row) => row.playerId === sevenPlayer), true);
    assert.equal(wednesday.some((row) => row.playerId === sixPlayer), false);
    assert.equal(wednesday.some((row) => row.playerId === sixPlayer && row.score === 0), false);
    const monday = currentWeek;
    const nextWeekPlayer = await publishCompleted(monday);
    const current = rowsOf(await rankings.readWeekly({ weekStart: currentWeek, category: 'ALL', pageSize: 50 }));
    const previous = rowsOf(await rankings.readWeekly({ weekStart: previousWeek, category: 'ALL', pageSize: 50 }));
    assert.equal(current.some((row) => row.playerId === nextWeekPlayer.playerId), true);
    assert.equal(previous.some((row) => row.playerId === nextWeekPlayer.playerId), false);
    assert.equal(current.some((row) => row.playerId === sevenPlayer), false);
    const backfillCursor = await rankings.readWeekly({ weekStart: currentWeek, category: 'ALL', pageSize: 50 });
    assert.equal(backfillCursor.ok, true);
    if (!backfillCursor.ok) return;
    const thursday = formatUtcDate(Date.parse(`${currentWeek}T00:00:00.000Z`) + 3 * 86_400_000);
    await publishCompleted(thursday);
    const stale = await rankings.readWeekly({
      weekStart: currentWeek,
      category: 'ALL',
      pageSize: 50,
      cursor: backfillCursor.cursor,
    });
    assert.deepEqual(stale, { ok: false, reason: 'SNAPSHOT_CHANGED' });
  });

  it('keeps FINAL provisional when the cutoff, watermark, admission, or snapshot write is incomplete', async () => {
    assert.deepEqual(await rankings.finalizeWeek(currentWeek), { outcome: 'provisional', reason: 'CUTOFF_NOT_REACHED' });
    assert.equal(await settlementCount(currentWeek), 0);
    const monday = weekDates(previousWeek)[0]!;
    const uncertain = await seedSeries({ date: monday, mode: 'five' });
    assert.equal(closedReason(await rankings.finalizeWeek(previousWeek)), 'UNCERTAIN_SERIES');
    await pool.query(
      `UPDATE series_fence_state SET hard_cutoff_at_ms = $2 WHERE series_key = $1`,
      [uncertain.seriesId, (await dbNow()) + 3_600_000],
    );
    assert.equal(closedReason(await rankings.finalizeWeek(previousWeek)), 'ELIGIBLE_SESSION_OPEN');
    await pool.query(
      `UPDATE series_fence_state SET hard_cutoff_at_ms = $2, status = 'ACTIVE' WHERE series_key = $1`,
      [uncertain.seriesId, weeklyFinalCutoffMs(previousWeek)],
    );
    await pool.query(`UPDATE tournament_daily_claim SET status = 'ACTIVE' WHERE series_id = $1`, [uncertain.seriesId]);
    const cutoff = weeklyFinalCutoffMs(previousWeek);
    await pool.query(
      `INSERT INTO command_admission_journal (
         admission_id, series_key, player_id, command_type, idempotency_key, payload_hash,
         trusted_received_at_ms, admission_seq, outcome, writer_generation
       ) VALUES ($1,$2,$3,'move',$4,$5,$6,99,'pending',1)`,
      [
        randomUUID(), uncertain.seriesId, randomUUID(), 'pending-h1',
        createHash('sha256').update('pending-h1').digest('hex'), cutoff - 1,
      ],
    );
    assert.equal(closedReason(await rankings.finalizeWeek(previousWeek)), 'PENDING_ADMISSION');
    await pool.query(
      `UPDATE command_admission_journal SET outcome = 'mystery' WHERE series_key = $1 AND admission_seq = 99`,
      [uncertain.seriesId],
    );
    assert.equal(closedReason(await rankings.finalizeWeek(previousWeek)), 'UNKNOWN_OUTCOME');
    await pool.query(`DELETE FROM command_admission_journal WHERE series_key = $1 AND admission_seq = 99`, [uncertain.seriesId]);
    await eraseUnpublished(uncertain.seriesId);

    const holderSeries = randomUUID();
    const holderPlayer = randomUUID();
    await pool.query(
      `INSERT INTO tournament_daily_claim
         (series_id, player_id, original_utc_date, started_at_ms, manifest_digest, status)
       VALUES ($1,$2,$3::date,$4,$5,'ACTIVE')`,
      [holderSeries, holderPlayer, monday, Date.parse(`${monday}T12:00:00.000Z`), mixedManifest.digest],
    );
    await pool.query(
      `INSERT INTO series_fence_state (
         series_key, board_revision, writer_generation, status, idle_deadline_at_ms,
         hard_cutoff_at_ms, score, results_published, thinking_extension_consumed
       ) VALUES ($1,0,1,'ACTIVE',$2,$3,0,FALSE,FALSE)`,
      [holderSeries, cutoff, cutoff],
    );
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await lockSeriesForTransaction(holder, holderSeries);
      const blocked = await rankings.finalizeWeek(previousWeek, { lockTimeoutMs: 400 });
      assert.equal(closedReason(blocked), 'LOCK_NOT_ACQUIRED');
      assert.equal(await settlementCount(previousWeek), 0);
      await holder.query(
        `INSERT INTO command_admission_journal (
           admission_id, series_key, player_id, command_type, idempotency_key, payload_hash,
           trusted_received_at_ms, admission_seq, outcome, writer_generation
         ) VALUES ($1,$2,$3,'move',$4,$5,$6,1,'pending',1)`,
        [
          randomUUID(), holderSeries, holderPlayer, 'held-h1',
          createHash('sha256').update('held-h1').digest('hex'), cutoff - 1,
        ],
      );
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    assert.equal(closedReason(await rankings.finalizeWeek(previousWeek)), 'PENDING_ADMISSION');
    await eraseUnpublished(holderSeries);

    const claimHolder = await pool.connect();
    try {
      await claimHolder.query('BEGIN');
      await lockWeeklySettlement(claimHolder);
      const blockedClaim = await rankings.finalizeWeek(previousWeek, { lockTimeoutMs: 400 });
      assert.equal(closedReason(blockedClaim), 'LOCK_NOT_ACQUIRED');
      assert.equal(await settlementCount(previousWeek), 0);
      await claimHolder.query('ROLLBACK');
    } finally {
      claimHolder.release();
    }

    await pool.query('ALTER TABLE command_admission_journal RENAME TO command_admission_journal_hidden');
    try {
      assert.equal(closedReason(await rankings.finalizeWeek(previousWeek)), 'WATERMARK_UNAVAILABLE');
      assert.equal(await settlementCount(previousWeek), 0);
    } finally {
      await pool.query('ALTER TABLE command_admission_journal_hidden RENAME TO command_admission_journal');
    }

    const completed = randomUUID();
    await pool.query(
      `INSERT INTO tournament_daily_claim
         (series_id, player_id, original_utc_date, started_at_ms, manifest_digest, status)
       VALUES ($1,$2,$3::date,$4,$5,'COMPLETED')`,
      [completed, randomUUID(), monday, Date.parse(`${monday}T12:00:00.000Z`), mixedManifest.digest],
    );
    await pool.query(
      `INSERT INTO series_fence_state (
         series_key, board_revision, writer_generation, status, idle_deadline_at_ms,
         hard_cutoff_at_ms, score, results_published, thinking_extension_consumed
       ) VALUES ($1,6,1,'COMPLETED',$2,$3,0,TRUE,FALSE)`,
      [completed, cutoff, cutoff],
    );
    assert.equal(closedReason(await rankings.finalizeWeek(previousWeek)), 'AUTHORIZATION_FAILED');
    await eraseUnpublished(completed);

    const unpublished = await seedSeries({
      date: monday,
      hardCutoffAtMs: cutoff,
    });
    assert.equal(closedReason(await rankings.finalizeWeek(previousWeek)), 'PUBLICATION_UNSETTLED');
    assert.equal(await settlementCount(previousWeek), 0);
    await eraseUnpublished(unpublished.seriesId);

    const lateDb = randomUUID();
    const latePlayer = randomUUID();
    await pool.query(
      `INSERT INTO tournament_daily_claim
         (series_id, player_id, original_utc_date, started_at_ms, manifest_digest, status)
       VALUES ($1,$2,$3::date,$4,$5,'ACTIVE')`,
      [lateDb, latePlayer, monday, Date.parse(`${monday}T12:00:00.000Z`), mixedManifest.digest],
    );
    await pool.query(
      `INSERT INTO series_fence_state (
         series_key, board_revision, writer_generation, status, idle_deadline_at_ms,
         hard_cutoff_at_ms, score, results_published, thinking_extension_consumed
       ) VALUES ($1,0,1,'ACTIVE',$2,$3,0,FALSE,FALSE)`,
      [lateDb, cutoff + 86_400_000, cutoff],
    );
    const lateHolder = await pool.connect();
    try {
      await lateHolder.query('BEGIN');
      await lockSeriesForTransaction(lateHolder, lateDb);
      assert.equal(closedReason(await rankings.finalizeWeek(previousWeek, { lockTimeoutMs: 400 })), 'LOCK_NOT_ACQUIRED');
      await lateHolder.query(
        `INSERT INTO command_admission_journal (
           admission_id, series_key, player_id, command_type, idempotency_key, payload_hash,
           trusted_received_at_ms, db_trusted_received_at_ms, admission_seq, outcome, writer_generation
         ) VALUES ($1,$2,$3,'move',$4,$5,$6,NULL,1,'pending',1)`,
        [
          randomUUID(), lateDb, latePlayer, 'late-db',
          createHash('sha256').update('late-db').digest('hex'), cutoff + 1,
        ],
      );
      await lateHolder.query('COMMIT');
    } finally {
      lateHolder.release();
    }
    assert.equal(closedReason(await rankings.finalizeWeek(previousWeek)), 'PENDING_ADMISSION');
    assert.equal(await settlementCount(previousWeek), 0);
    await eraseUnpublished(lateDb);

    for (const label of f2cSnapshotLabels(faultWeek)) {
      await assert.rejects(
        () => rankings.finalizeWeek(faultWeek, {
          inject: (point) => {
            if (point === label) throw new Error(`inject ${label}`);
          },
        }),
        new RegExp(`inject ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      );
      assert.equal(await settlementCount(faultWeek), 0);
    }
    const recovered = await rankings.finalizeWeek(faultWeek);
    assert.equal(recovered.outcome, 'final');
    if (recovered.outcome !== 'final') return;
    await assert.rejects(
      pool.query(`UPDATE tournament_f2c_settlement SET cutoff_ms = 0 WHERE settlement_id = $1`, [recovered.settlementId]),
      /F2C_FINAL_IMMUTABLE/,
    );
    const repeat = await rankings.finalizeWeek(faultWeek);
    assert.equal(repeat.outcome, 'final');
    if (repeat.outcome === 'final') assert.equal(repeat.alreadyFinal, true);
    assert.equal(repeat.outcome === 'final' && repeat.settlementId, recovered.settlementId);
  });

  it('does not apply an H1 when the database receipt is outside the hard cutoff', async () => {
    const date = weekDates(previousWeek)[0]!;
    const cutoff = weeklyFinalCutoffMs(previousWeek);
    const seeded = await seedSeries({ date, mode: 'five', hardCutoffAtMs: cutoff });
    await pool.query(
      `UPDATE series_fence_state SET idle_deadline_at_ms = $2 WHERE series_key = $1`,
      [seeded.seriesId, cutoff + 86_400_000],
    );
    const admissionId = randomUUID();
    const early = cutoff - 1;
    await pool.query(
      `INSERT INTO command_admission_journal (
         admission_id, series_key, player_id, command_type, idempotency_key, payload_hash,
         trusted_received_at_ms, db_trusted_received_at_ms, admission_seq, outcome, writer_generation
       ) VALUES ($1,$2,$3,'move',$4,$5,$6,$7,99,'pending',1)`,
      [
        admissionId, seeded.seriesId, seeded.playerId, 'db-late',
        createHash('sha256').update(admissionId).digest('hex'), early, cutoff,
      ],
    );
    const decision = await new PostgresTrustedUnitOfWork(pool).adjudicateAcceptedMove({
      seriesKey: seeded.seriesId,
      playerId: seeded.playerId,
      subgameOrdinal: 6,
      admissionId,
      admissionSeq: 99,
      trustedReceivedAt: new Date(early),
      move: {
        offerIndex: 0,
        tap: [0, 0],
        expectedBoardRevision: 5,
        writerGeneration: 1,
      },
    });
    assert.equal(decision.decision, 'reject');
    if (decision.decision === 'reject') assert.equal(decision.reason, 'HARD_CUTOFF_EXPIRED');
    const outcome = await pool.query(
      `SELECT outcome FROM command_admission_journal WHERE admission_id = $1`,
      [admissionId],
    );
    assert.equal(String(outcome.rows[0].outcome), 'rejected');
    await eraseUnpublished(seeded.seriesId);
  });

  it('keeps a finalized week closed across connections, orphans, and settlement retries', async () => {
    assert.deepEqual(seriesAdvisoryKeys('pzd:f2c:weekly-settlement'), [1973609813, 1888871555]);
    const weeks = visibleWeekStarts(await dbNow());
    const week = weeks[4]!;
    const cutoff = weeklyFinalCutoffMs(week);
    const primary = await pool.query(
      `SELECT pg_is_in_recovery() AS recovery, current_setting('transaction_read_only') AS read_only`,
    );
    assert.equal(primary.rows[0].recovery, false);
    assert.equal(String(primary.rows[0].read_only), 'off');

    const orphanSeries = randomUUID();
    await pool.query(
      `INSERT INTO command_admission_journal (
         admission_id, series_key, player_id, command_type, idempotency_key, payload_hash,
         trusted_received_at_ms, db_trusted_received_at_ms, admission_seq, outcome
       ) VALUES ($1,$2,$3,'move',$4,$5,$6,$7,1,'pending')`,
      [
        randomUUID(), orphanSeries, randomUUID(), 'orphan',
        createHash('sha256').update(orphanSeries).digest('hex'), cutoff - 1, cutoff - 1,
      ],
    );
    assert.equal(closedReason(await rankings.finalizeWeek(week)), 'ORPHAN_ADMISSION', 'orphan admission');
    assert.equal(await settlementCount(week), 0);
    await pool.query(`DELETE FROM command_admission_journal WHERE series_key = $1`, [orphanSeries]);

    const admission = await pool.connect();
    try {
      await admission.query('BEGIN');
      await lockWeeklySettlement(admission);
      assert.equal(
        closedReason(await rankings.finalizeWeek(week, { lockTimeoutMs: 400 })),
        'LOCK_NOT_ACQUIRED',
        'uncommitted admission',
      );
      assert.equal(await settlementCount(week), 0);
      await admission.query('ROLLBACK');
    } finally {
      admission.release();
    }

    const stale = await pool.connect();
    let settlementId = '';
    try {
      await stale.query('BEGIN');
      const seen = await stale.query(
        `SELECT 1 FROM tournament_f2c_settlement WHERE week_start = $1::date`,
        [week],
      );
      assert.equal(seen.rowCount, 0);
      const raced = await Promise.all([rankings.finalizeWeek(week), rankings.finalizeWeek(week)]);
      assert.equal(raced[0]?.outcome, 'final');
      assert.equal(raced[1]?.outcome, 'final');
      if (raced[0]?.outcome === 'final' && raced[1]?.outcome === 'final') {
        assert.equal(raced[0].settlementId, raced[1].settlementId, 'concurrent finalization');
        settlementId = raced[0].settlementId;
      }
      await assert.rejects(
        stale.query(
          `INSERT INTO tournament_daily_claim
             (series_id, player_id, original_utc_date, started_at_ms, manifest_digest)
           VALUES ($1,$2,$3::date,$4,$5)`,
          [randomUUID(), randomUUID(), week, Date.parse(`${week}T12:00:00.000Z`), mixedManifest.digest],
        ),
        /F2C_PERIOD_CLOSED/,
        'stale worker claim',
      );
      await stale.query('ROLLBACK');
    } finally {
      stale.release();
    }

    const retry = await rankings.finalizeWeek(week);
    assert.equal(retry.outcome === 'final' && retry.alreadyFinal, true, 'lost commit acknowledgement');
    if (retry.outcome === 'final') assert.equal(retry.settlementId, settlementId);
    const headers = await pool.query(
      `SELECT count(*)::int AS n FROM tournament_f2c_board_header WHERE settlement_id = $1`,
      [settlementId],
    );
    assert.equal(Number(headers.rows[0].n), 32, '32 board snapshots');
    const firstRead = rowsOf(await rankings.readWeekly({ weekStart: week, category: 'ALL', pageSize: 50 }));
    const secondRead = rowsOf(await rankings.readWeekly({ weekStart: week, category: 'ALL', pageSize: 50 }));
    assert.deepEqual(secondRead, firstRead, 'no result loss after retry');

    const seriesLock = await pool.connect();
    const settlementLock = await pool.connect();
    try {
      await seriesLock.query('BEGIN');
      await seriesLock.query(`SELECT set_config('lock_timeout', '400ms', true)`);
      await lockWeeklySettlement(seriesLock);
      await lockSeriesForTransaction(seriesLock, randomUUID());
      await settlementLock.query('BEGIN');
      await settlementLock.query(`SELECT set_config('lock_timeout', '400ms', true)`);
      await assert.rejects(lockWeeklySettlement(settlementLock), (err: { code?: string }) => {
        assert.equal(err.code, '55P03');
        assert.notEqual(err.code, '40P01');
        return true;
      }, 'no deadlock');
      await settlementLock.query('ROLLBACK');
      await seriesLock.query('ROLLBACK');
    } finally {
      seriesLock.release();
      settlementLock.release();
    }
  });

  it('freezes the previous week atomically and does not recompute FINAL after a later publication', async () => {
    const dates = weekDates(previousWeek);
    const held = await seedSeries({
      date: dates[1]!,
      mode: 'five',
      hardCutoffAtMs: weeklyFinalCutoffMs(previousWeek),
    });
    const before = rowsOf(await rankings.readWeekly({ weekStart: previousWeek, category: 'ALL', pageSize: 50 }));
    const finalized = await rankings.finalizeWeek(previousWeek);
    assert.equal(finalized.outcome, 'final');
    if (finalized.outcome !== 'final') return;
    assert.equal(finalized.alreadyFinal, false);
    const frozen = await rankings.readWeekly({ weekStart: previousWeek, category: 'ALL', pageSize: 50 });
    assert.equal(frozen.ok, true);
    if (!frozen.ok) return;
    assert.equal(frozen.state, 'FINAL');
    assert.equal(frozen.settlementId, finalized.settlementId);
    assert.deepEqual(frozen.rows.map((row) => [row.playerId, row.score, row.rank]), before.map((row) => [row.playerId, row.score, row.rank]));
    const headers = await pool.query(
      `SELECT count(*)::int AS n FROM tournament_f2c_board_header WHERE settlement_id = $1`,
      [finalized.settlementId],
    );
    assert.equal(Number(headers.rows[0].n), 32);
    const latePublish = await publisher.publish({
      seriesId: held.seriesId,
      playerId: held.playerId,
      writerGeneration: 1,
      commandIdempotencyKey: `h1:${held.seriesId}`,
      event: 'h1_terminal_move',
    });
    assert.equal(latePublish.outcome, 'rejected');
    if (latePublish.outcome === 'rejected') assert.equal(latePublish.reason, 'PERIOD_CLOSED');
    await assert.rejects(
      pool.query(
        `INSERT INTO tournament_daily_claim
           (series_id, player_id, original_utc_date, started_at_ms, manifest_digest)
         VALUES ($1,$2,$3::date,$4,$5)`,
        [randomUUID(), randomUUID(), dates[0], Date.parse(`${dates[0]}T12:00:00.000Z`), mixedManifest.digest],
      ),
      /F2C_PERIOD_CLOSED/,
    );
    const still = rowsOf(await rankings.readWeekly({ weekStart: previousWeek, category: 'ALL', pageSize: 50 }));
    assert.equal(still.some((row) => row.playerId === held.playerId), false);
    assert.deepEqual(still.map((row) => row.playerId), frozen.rows.map((row) => row.playerId));
    const daily = await rankings.readDaily({ date: dates[0]!, category: 'EASY', pageSize: 50 });
    assert.equal(daily.ok && daily.state, 'FINAL');
    await assert.rejects(
      pool.query(`DELETE FROM tournament_f2c_rank_snapshot WHERE settlement_id = $1`, [finalized.settlementId]),
      /F2C_FINAL_IMMUTABLE/,
    );
    const again = await rankings.finalizeWeek(previousWeek);
    assert.equal(again.outcome === 'final' && again.alreadyFinal, true);
    const hiddenWeek = formatUtcDate(Date.parse(`${currentWeek}T00:00:00.000Z`) - 7 * 6 * 86_400_000);
    assert.deepEqual(
      await rankings.readWeekly({ weekStart: hiddenWeek, category: 'ALL', pageSize: 50 }),
      { ok: false, reason: 'PERIOD_NOT_VISIBLE' },
    );
  });
});
