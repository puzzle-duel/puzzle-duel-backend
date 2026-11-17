/**
 * PZD-41 F2-B — PostgreSQL 18 atomic six-game publication.
 * Proves persisted rows, rollback, concurrency and seal authorization.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  MemoryVerifiedAuthorizationGateway,
  PostgresAcceptedMoveLedger,
  PostgresAuthoritativeSnapshotStore,
  PostgresTrustedChallengeStore,
  PostgresTrustedUnitOfWork,
  TrustedGameplayService,
} from '../../../src/tournament/adjudication/index.mts';
import { makeAuth } from '../adjudication/helpers.mts';
import { ControllableClock } from '../../../src/tournament/ingress/clock.mts';
import {
  ADMISSION_JOURNAL_DDL,
  PostgresAdmissionJournal,
} from '../../../src/tournament/ingress/postgres-journal.mts';
import {
  lockSeriesForTransaction,
  PostgresSeriesFenceStore,
  SERIES_FENCE_DDL,
  seriesAdvisoryKeys,
} from '../../../src/tournament/ingress/series-fence.mts';
import { TRUSTED_GAMEPLAY_DDL } from '../../../src/tournament/adjudication/postgres-stores.mts';
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
import { computeFourCategoryScores } from '../../../src/tournament/results/four-category-scores.mts';
import {
  F2A_PUBLICATION_DROP_DDL,
  evaluateLeaderboardReadEligibility,
  evaluateStructuralReadiness,
  rejectInMemoryProvenanceAttestation,
} from '../../../src/tournament/results/f2a-publication-schema.mts';
import {
  F2B_FAULT_POINTS,
  F2BPublicationService,
  type F2BPublishResult,
} from '../../../src/tournament/results/f2b-publication.mts';

const url =
  process.env.PZD_INGRESS_DATABASE_URL ??
  'postgresql://pzd:pzd@127.0.0.1:55432/pzd_ingress';
const KEY = 'test-only-f2b-provenance-key-not-a-secret';
const __dirname = dirname(fileURLToPath(import.meta.url));

const scoringFixture = JSON.parse(
  readFileSync(
    join(__dirname, '../../../docs/contracts/gameplay/v3/fixtures/V3-02-single-wave.json'),
    'utf8',
  ),
);
const zeroFixture = JSON.parse(
  readFileSync(
    join(__dirname, '../../../docs/contracts/gameplay/v3/fixtures/V3-09-move-limit.json'),
    'utf8',
  ),
);
const scoringInitial = { ...scoringFixture.initialState, moveLimit: 1 };
const zeroInitial = zeroFixture.initialState;

type GamePlan = { readonly initial: unknown; readonly moves: readonly unknown[] };

function buildManifest(contentVersion: string, games: readonly GamePlan[]): PinnedDailyManifest {
  const subgames = games.map((game, index) => ({
    ordinal: index + 1,
    challengeId: `${contentVersion}-chal-${index + 1}`,
    generatorVersion: 'gen-001.v1-adapter-test',
    contentVersion: 'f2b-subgame',
    initialState: game.initial,
  }));
  return {
    digest: digestManifestPayload(contentVersion, subgames),
    contentVersion,
    subgames,
  };
}

const mixedGames: GamePlan[] = [0, 1, 2, 3, 4, 5].map((index) =>
  index % 2 === 0
    ? { initial: scoringInitial, moves: scoringFixture.moves }
    : { initial: zeroInitial, moves: zeroFixture.moves },
);
const zeroGames: GamePlan[] = [0, 1, 2, 3, 4, 5].map(() => ({
  initial: zeroInitial,
  moves: zeroFixture.moves,
}));
const mixedManifest = buildManifest('f2b-mixed', mixedGames);
const zeroManifest = buildManifest('f2b-zero', zeroGames);
const manifests = new PinnedManifestRegistry(
  [mixedManifest, zeroManifest],
  mixedManifest.digest,
);
const plans = new Map<string, readonly GamePlan[]>([
  [mixedManifest.digest, mixedGames],
  [zeroManifest.digest, zeroGames],
]);

let pool: pg.Pool;

before(async () => {
  pool = new pg.Pool({ connectionString: url, max: 8 });
  const version = await pool.query('SHOW server_version_num');
  const num = Number(version.rows[0].server_version_num);
  assert.ok(num >= 180000 && num < 190000, `PostgreSQL 18 required, got ${num}`);
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
  await new F2BPublicationService(pool, { provenanceKey: KEY, manifests }).migrate();
});

after(async () => {
  await pool.query(F2A_PUBLICATION_DROP_DDL);
  await pool.end();
});

function service(hooks?: ConstructorParameters<typeof F2BPublicationService>[1]['hooks']) {
  return new F2BPublicationService(pool, { provenanceKey: KEY, manifests, hooks });
}

async function counts(seriesId: string) {
  const n = async (sql: string) =>
    Number((await pool.query(sql, [seriesId])).rows[0].n);
  return {
    completion: await n(
      'SELECT count(*)::int AS n FROM tournament_daily_series_completion WHERE series_id=$1',
    ),
    scores: await n(
      'SELECT count(*)::int AS n FROM tournament_verified_subgame_score WHERE series_id=$1',
    ),
    categories: await n(
      'SELECT count(*)::int AS n FROM tournament_daily_result_category WHERE series_id=$1',
    ),
    badge: await n('SELECT count(*)::int AS n FROM tournament_on_time_badge WHERE series_id=$1'),
    provenance: await n(
      'SELECT count(*)::int AS n FROM tournament_f2b_trusted_provenance WHERE series_id=$1',
    ),
  };
}

type SeedMode = 'complete' | 'five' | 'h1_open';

async function seed(args?: {
  manifest?: PinnedDailyManifest;
  mode?: SeedMode;
  startedAtMs?: number;
  originalUtcDate?: string;
  h1ReceivedAtMs?: number;
  fenceStatus?: 'ACTIVE' | 'AWAIT_ADVANCE' | 'COMPLETED' | 'FORFEITED';
  claimStatus?: 'ACTIVE' | 'AWAIT_ADVANCE' | 'COMPLETED' | 'FORFEITED';
  writerGeneration?: number;
  fenceScore?: 'sum' | 'wrong';
  manifestDigest?: string;
  completesSeries?: boolean;
  hardCutoffAtMs?: number | null;
  h1JournalOutcome?: 'applied' | 'pending';
}) {
  const manifest = args?.manifest ?? mixedManifest;
  const plan = plans.get(manifest.digest);
  if (!plan) throw new Error('missing plan');
  const mode = args?.mode ?? 'complete';
  const seriesId = randomUUID();
  const playerId = randomUUID();
  const sessionId = randomUUID();
  const deviceId = randomUUID();
  const writerGeneration = args?.writerGeneration ?? 1;
  const originalUtcDate = args?.originalUtcDate ?? '2026-11-17';
  const startedAtMs = args?.startedAtMs ?? Date.parse('2026-11-17T12:00:00.000Z');
  const h1ReceivedAtMs = args?.h1ReceivedAtMs ?? startedAtMs + 60_000;
  const claimStatus = args?.claimStatus ?? 'ACTIVE';
  const fenceStatus =
    args?.fenceStatus ?? (mode === 'h1_open' ? 'ACTIVE' : mode === 'complete' ? 'AWAIT_ADVANCE' : 'ACTIVE');

  await pool.query(
    `INSERT INTO tournament_daily_claim
       (series_id, player_id, original_utc_date, started_at_ms, manifest_digest, status)
     VALUES ($1,$2,$3::date,$4,$5,$6)`,
    [
      seriesId,
      playerId,
      originalUtcDate,
      startedAtMs,
      args?.manifestDigest ?? manifest.digest,
      claimStatus,
    ],
  );

  const played: { ordinal: number; score: number; admissionId: string }[] = [];
  let running = 0;
  let h1AdmissionId = randomUUID();
  for (let index = 0; index < 6; index += 1) {
    const ordinal = index + 1;
    const game = plan[index]!;
    const sub = manifest.subgames[index]!;
    const initial = parseInitialGameState(game.initial);
    const initialJson = stateToJson(initial);
    const initialDigest = stateHashV3(initial);
    await pool.query(
      `INSERT INTO trusted_challenge_binding (
         series_key, player_id, subgame_ordinal, challenge_id, rules_version,
         generator_version, content_version, initial_state_digest, initial_state_json,
         assigned_at_ms
       ) VALUES ($1,$2,$3,$4,'core-001.v3',$5,$6,$7,$8::jsonb,$9)`,
      [
        seriesId,
        playerId,
        ordinal,
        sub.challengeId,
        sub.generatorVersion,
        sub.contentVersion,
        initialDigest,
        JSON.stringify(initialJson),
        startedAtMs,
      ],
    );

    const includeTerminal = mode === 'complete' || (mode === 'five' && ordinal <= 5) || (mode === 'h1_open' && ordinal <= 5);
    if (!includeTerminal) {
      if (mode === 'h1_open' && ordinal === 6) {
        await pool.query(
          `INSERT INTO authoritative_game_snapshot (
             series_key, player_id, subgame_ordinal, challenge_id, board_revision,
             move_cursor, state_hash, score, status, terminal_reason, state_json,
             ledger_admission_seq, writer_generation, produced_by_admission_id
           ) VALUES ($1,$2,6,$3,0,0,$4,0,'in_progress',NULL,$5::jsonb,0,$6,NULL)`,
          [
            seriesId,
            playerId,
            sub.challengeId,
            initialDigest,
            JSON.stringify(initialJson),
            writerGeneration,
          ],
        );
      }
      continue;
    }

    const replayed = replayCore001V3({ initialState: game.initial, moves: game.moves });
    if (!replayed.ok || replayed.finalState.status !== 'ended') {
      throw new Error(`fixture ordinal ${ordinal} did not end`);
    }
    const admissionId = randomUUID();
    if (ordinal === 6) h1AdmissionId = admissionId;
    const seq = ordinal;
    const revision = ordinal;
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
        seriesId,
        playerId,
        ordinal,
        sub.challengeId,
        admissionId,
        seq,
        revision,
        JSON.stringify({
          offerIndex: move.offerIndex,
          tap: { row: move.tap[0], column: move.tap[1] },
        }),
        delta,
        running,
        initialDigest,
        replayed.stateHash,
        ordinal === 6 ? h1ReceivedAtMs : startedAtMs + ordinal * 1000,
        replayed.finalState.terminalReason,
      ],
    );
    await pool.query(
      `INSERT INTO authoritative_game_snapshot (
         series_key, player_id, subgame_ordinal, challenge_id, board_revision, move_cursor,
         state_hash, score, status, terminal_reason, state_json, ledger_admission_seq,
         writer_generation, produced_by_admission_id
       ) VALUES ($1,$2,$3,$4,$5,1,$6,$7,'ended',$8,$9::jsonb,$10,$11,$12)`,
      [
        seriesId,
        playerId,
        ordinal,
        sub.challengeId,
        revision,
        replayed.stateHash,
        running,
        replayed.finalState.terminalReason,
        JSON.stringify(stateToJson(replayed.finalState)),
        seq,
        writerGeneration,
        admissionId,
      ],
    );
    const journalOutcome = ordinal === 6 ? (args?.h1JournalOutcome ?? 'applied') : 'applied';
    await pool.query(
      `INSERT INTO command_admission_journal (
         admission_id, series_key, player_id, command_type, idempotency_key, payload_hash,
         trusted_received_at_ms, admission_seq, outcome, expected_board_revision,
         writer_generation, score_delta, completes_series
       ) VALUES ($1,$2,$3,'move',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        admissionId,
        seriesId,
        playerId,
        `move-${ordinal}`,
        createHash('sha256').update(admissionId).digest('hex'),
        ordinal === 6 ? h1ReceivedAtMs : startedAtMs + ordinal * 1000,
        seq,
        journalOutcome,
        revision - 1,
        writerGeneration,
        args?.completesSeries ? 999_999 : null,
        args?.completesSeries === true,
      ],
    );
    played.push({ ordinal, score: replayed.finalState.score, admissionId });
  }

  const fenceScore = args?.fenceScore === 'wrong' ? running + 50 : running;
  const boardRevision = mode === 'h1_open' ? 5 : played.length;
  await pool.query(
    `INSERT INTO series_fence_state (
       series_key, board_revision, writer_generation, status, idle_deadline_at_ms,
       hard_cutoff_at_ms, score, results_published, last_applied_admission_id,
       thinking_extension_consumed
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,$8,FALSE)`,
    [
      seriesId,
      boardRevision,
      writerGeneration,
      fenceStatus,
      h1ReceivedAtMs + 300_000,
      args?.hardCutoffAtMs === undefined ? null : args.hardCutoffAtMs,
      fenceScore,
      mode === 'complete' ? h1AdmissionId : null,
    ],
  );
  await pool.query(
    `INSERT INTO tournament_series_writer
       (series_key, player_id, session_id, device_id, writer_generation, updated_at_ms)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [seriesId, playerId, sessionId, deviceId, writerGeneration, startedAtMs],
  );

  if (mode === 'h1_open') {
    h1AdmissionId = randomUUID();
    await pool.query(
      `INSERT INTO command_admission_journal (
         admission_id, series_key, player_id, command_type, idempotency_key, payload_hash,
         trusted_received_at_ms, admission_seq, outcome, expected_board_revision,
         writer_generation, score_delta, completes_series
       ) VALUES ($1,$2,$3,'move',$4,$5,$6,6,'pending',5,$7,NULL,FALSE)`,
      [
        h1AdmissionId,
        seriesId,
        playerId,
        'move-h1-open',
        createHash('sha256').update(h1AdmissionId).digest('hex'),
        h1ReceivedAtMs,
        writerGeneration,
      ],
    );
  }

  return {
    seriesId,
    playerId,
    writerGeneration,
    h1AdmissionId,
    h1ReceivedAtMs,
    startedAtMs,
    played,
    running,
    manifest,
  };
}

function advanceHarness(row: {
  seriesId: string;
  playerId: string;
  writerGeneration: number;
  h1ReceivedAtMs: number;
  ordinal: number;
}) {
  const clock = new ControllableClock(new Date(row.h1ReceivedAtMs + 1_000));
  const authGw = new MemoryVerifiedAuthorizationGateway();
  authGw.register(
    makeAuth({
      seriesKey: row.seriesId,
      playerId: row.playerId,
      writerGeneration: row.writerGeneration,
      ordinal: row.ordinal,
      status: 'AWAIT_ADVANCE',
    }),
  );
  const uow = new PostgresTrustedUnitOfWork(pool);
  const gameplay = new TrustedGameplayService({
    journal: new PostgresAdmissionJournal(pool, clock),
    fence: new PostgresSeriesFenceStore(pool),
    challenges: new PostgresTrustedChallengeStore(pool),
    ledger: new PostgresAcceptedMoveLedger(pool),
    snapshots: new PostgresAuthoritativeSnapshotStore(pool),
    clock,
    authorization: authGw,
    postgresUow: uow,
  });
  return {
    gameplay,
    uow,
    hints: {
      seriesKeyHint: row.seriesId,
      playerIdHint: row.playerId,
      writerGenerationHint: row.writerGeneration,
    },
  };
}

function publishedScores(result: F2BPublishResult) {
  assert.equal(result.outcome === 'rejected', false, JSON.stringify(result));
  if (result.outcome === 'rejected') throw new Error('unreachable');
  return result;
}

describe('PZD-41 F2-B atomic six-game publication', () => {
  it('publishes six replay-derived scores, four categories, badge and seal once', async () => {
    const row = await seed({ completesSeries: true });
    let lockHeld = false;
    const keys = seriesAdvisoryKeys(row.seriesId);
    const result = publishedScores(
      await service({
        observe: async (point, client) => {
          if (point !== 'after_lock') return;
          const locks = await client.query(
            `SELECT classid::int4 AS classid, objid::int4 AS objid
             FROM pg_locks
             WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted`,
          );
          lockHeld = locks.rows.some(
            (held) => Number(held.classid) === keys[0] && Number(held.objid) === keys[1],
          );
        },
      }).publish({
        seriesId: row.seriesId,
        playerId: row.playerId,
        writerGeneration: row.writerGeneration,
        commandIdempotencyKey: 'cmd-original',
        event: 'h1_terminal_move',
      }),
    );
    assert.equal(lockHeld, true);
    assert.equal(result.outcome, 'published');
    assert.equal(result.revision, 1);
    assert.deepEqual(
      result.subgameScores.map((game) => game.score),
      row.played.map((game) => game.score),
    );
    assert.ok(result.subgameScores.every((game) => game.score !== result.all));
    const categories = computeFourCategoryScores(
      row.played.map((game) => ({ ordinal: game.ordinal, score: game.score })),
    );
    assert.equal(result.easy, categories.easy);
    assert.equal(result.medium, categories.medium);
    assert.equal(result.hard, categories.hard);
    assert.equal(result.all, categories.all);
    assert.equal(result.onTimeAwarded, true);
    assert.equal(result.commandIdempotencyKey, 'cmd-original');
    assert.deepEqual(await counts(row.seriesId), {
      completion: 1,
      scores: 6,
      categories: 4,
      badge: 1,
      provenance: 1,
    });
    const stored = await pool.query(
      `SELECT score FROM tournament_verified_subgame_score
       WHERE series_id=$1 ORDER BY subgame_ordinal`,
      [row.seriesId],
    );
    assert.deepEqual(
      stored.rows.map((item) => Number(item.score)),
      row.played.map((game) => game.score),
    );
    const fence = await pool.query(
      `SELECT status, results_published FROM series_fence_state WHERE series_key=$1`,
      [row.seriesId],
    );
    assert.equal(fence.rows[0].status, 'COMPLETED');
    assert.equal(fence.rows[0].results_published, true);
    const claim = await pool.query(
      `SELECT status FROM tournament_daily_claim WHERE series_id=$1`,
      [row.seriesId],
    );
    assert.equal(claim.rows[0].status, 'COMPLETED');
    const structural = await evaluateStructuralReadiness(pool, row.seriesId);
    assert.equal(structural.structurallyComplete, true);
    const flags = await pool.query(
      `SELECT publication_authorized, replay_verified
       FROM tournament_f2a_structural_readiness WHERE series_id=$1`,
      [row.seriesId],
    );
    assert.equal(flags.rows[0].publication_authorized, false);
    assert.equal(flags.rows[0].replay_verified, false);
    const closed = await evaluateLeaderboardReadEligibility(pool, row.seriesId);
    assert.deepEqual(closed, {
      authorized: false,
      reason: 'F2B_PROVENANCE_SEAL_UNVERIFIED',
    });
    const open = await evaluateLeaderboardReadEligibility(pool, row.seriesId, {
      provenanceKey: KEY,
    });
    assert.equal(open.authorized, true);
    if (open.authorized) {
      assert.equal(open.easy, categories.easy);
      assert.equal(open.all, categories.all);
      assert.equal(open.onTimeAwarded, true);
    }
  });

  it('publishes a completed series whose six games all scored zero', async () => {
    const row = await seed({ manifest: zeroManifest });
    const result = publishedScores(
      await service().publish({
        seriesId: row.seriesId,
        playerId: row.playerId,
        writerGeneration: 1,
        commandIdempotencyKey: 'zero',
        event: 'h1_terminal_move',
      }),
    );
    assert.deepEqual(
      result.subgameScores.map((game) => game.score),
      [0, 0, 0, 0, 0, 0],
    );
    assert.equal(result.easy, 0);
    assert.equal(result.medium, 0);
    assert.equal(result.hard, 0);
    assert.equal(result.all, 0);
    assert.equal((await counts(row.seriesId)).completion, 1);
  });

  it('does not publish five games', async () => {
    const row = await seed({ mode: 'five' });
    const result = await service().publish({
      seriesId: row.seriesId,
      playerId: row.playerId,
      writerGeneration: 1,
      commandIdempotencyKey: 'five',
      event: 'h1_terminal_move',
    });
    assert.equal(result.outcome, 'rejected');
    if (result.outcome === 'rejected') {
      assert.equal(result.reason, 'MISSING_OR_DUPLICATE_ORDINAL');
    }
    assert.deepEqual(await counts(row.seriesId), {
      completion: 0,
      scores: 0,
      categories: 0,
      badge: 0,
      provenance: 0,
    });
  });

  it('rejects a missing ordinal and a duplicate terminal ledger row', async () => {
    const dup = await seed();
    await pool.query(
      `INSERT INTO accepted_move_ledger (
         series_key, player_id, subgame_ordinal, challenge_id, admission_id, admission_seq,
         board_revision_after, move_json, score_delta, score_after, state_hash_before,
         state_hash_after, rules_version, trusted_received_at_ms, terminal_after, terminal_reason
       )
       SELECT series_key, player_id, subgame_ordinal, challenge_id, $2, admission_seq + 10,
              board_revision_after + 10, move_json, score_delta, score_after, state_hash_before,
              state_hash_after, rules_version, trusted_received_at_ms, TRUE, terminal_reason
       FROM accepted_move_ledger
       WHERE series_key=$1 AND subgame_ordinal=3`,
      [dup.seriesId, randomUUID()],
    );
    const rejected = await service().publish({
      seriesId: dup.seriesId,
      playerId: dup.playerId,
      writerGeneration: 1,
      commandIdempotencyKey: 'dup-ordinal',
      event: 'h1_terminal_move',
    });
    assert.equal(rejected.outcome, 'rejected');
    if (rejected.outcome === 'rejected') {
      assert.equal(rejected.reason, 'MISSING_OR_DUPLICATE_ORDINAL');
    }
    assert.equal((await counts(dup.seriesId)).completion, 0);

    const row = await seed();
    const snap = await pool.query(
      `SELECT * FROM authoritative_game_snapshot WHERE series_key=$1 AND subgame_ordinal=1`,
      [row.seriesId],
    );
    const existing = snap.rows[0];
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO authoritative_game_snapshot (
             series_key, player_id, subgame_ordinal, challenge_id, board_revision, move_cursor,
             state_hash, score, status, terminal_reason, state_json, ledger_admission_seq,
             writer_generation, produced_by_admission_id
           ) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,
          [
            existing.series_key,
            existing.player_id,
            existing.challenge_id,
            existing.board_revision,
            existing.move_cursor,
            existing.state_hash,
            existing.score,
            existing.status,
            existing.terminal_reason,
            JSON.stringify(existing.state_json),
            existing.ledger_admission_seq,
            existing.writer_generation,
            existing.produced_by_admission_id,
          ],
        ),
      /duplicate|unique/i,
    );
  });

  it('rejects a forged challenge digest', async () => {
    const row = await seed();
    await pool.query(
      `UPDATE trusted_challenge_binding
       SET initial_state_digest=$2
       WHERE series_key=$1 AND subgame_ordinal=2`,
      [row.seriesId, 'ab'.repeat(32)],
    );
    const result = await service().publish({
      seriesId: row.seriesId,
      playerId: row.playerId,
      writerGeneration: 1,
      commandIdempotencyKey: 'forged-digest',
      event: 'h1_terminal_move',
    });
    assert.equal(result.outcome, 'rejected');
    if (result.outcome === 'rejected') assert.equal(result.reason, 'CHALLENGE_DIGEST_MISMATCH');
    assert.equal((await counts(row.seriesId)).completion, 0);
  });

  it('rejects an unpinned manifest digest', async () => {
    const row = await seed({ manifestDigest: 'cd'.repeat(32) });
    const result = await service().publish({
      seriesId: row.seriesId,
      playerId: row.playerId,
      writerGeneration: 1,
      commandIdempotencyKey: 'forged-manifest',
      event: 'h1_terminal_move',
    });
    assert.equal(result.outcome, 'rejected');
    if (result.outcome === 'rejected') assert.equal(result.reason, 'MANIFEST_UNPINNED');
    assert.equal((await counts(row.seriesId)).completion, 0);
  });

  it('rejects a forged terminal state hash', async () => {
    const row = await seed();
    await pool.query(
      `UPDATE authoritative_game_snapshot SET state_hash=$2
       WHERE series_key=$1 AND subgame_ordinal=6`,
      [row.seriesId, 'ef'.repeat(32)],
    );
    const result = await service().publish({
      seriesId: row.seriesId,
      playerId: row.playerId,
      writerGeneration: 1,
      commandIdempotencyKey: 'forged-hash',
      event: 'h1_terminal_move',
    });
    assert.equal(result.outcome, 'rejected');
    if (result.outcome === 'rejected') assert.equal(result.reason, 'REPLAY_MISMATCH');
    assert.equal((await counts(row.seriesId)).scores, 0);
  });

  it('rejects a ledger/snapshot score mismatch', async () => {
    const row = await seed();
    await pool.query(
      `UPDATE authoritative_game_snapshot SET score = score + 1
       WHERE series_key=$1 AND subgame_ordinal=4`,
      [row.seriesId],
    );
    const result = await service().publish({
      seriesId: row.seriesId,
      playerId: row.playerId,
      writerGeneration: 1,
      commandIdempotencyKey: 'forged-score',
      event: 'h1_terminal_move',
    });
    assert.equal(result.outcome, 'rejected');
    if (result.outcome === 'rejected') {
      assert.equal(result.reason, 'LEDGER_SNAPSHOT_SCORE_MISMATCH');
    }
    assert.equal((await counts(row.seriesId)).categories, 0);
  });

  it('rejects in-memory provenance and a caller verified flag', async () => {
    assert.throws(
      () =>
        rejectInMemoryProvenanceAttestation({
          verified: true,
          provenanceSeal: 'a'.repeat(64),
        }),
      /IN_MEMORY_PROVENANCE_FORBIDDEN/,
    );
    const row = await seed();
    await assert.rejects(
      () =>
        service().publish({
          seriesId: row.seriesId,
          playerId: row.playerId,
          writerGeneration: 1,
          commandIdempotencyKey: 'mint',
          event: 'h1_terminal_move',
          verified: true,
        } as never),
      /CLIENT_AUTHORITY_FORBIDDEN/,
    );
    assert.equal((await counts(row.seriesId)).completion, 0);
  });

  it('rejects a forged provenance row and keeps the structural view unauthorized', async () => {
    const row = await seed();
    const published = publishedScores(
      await service().publish({
        seriesId: row.seriesId,
        playerId: row.playerId,
        writerGeneration: 1,
        commandIdempotencyKey: 'seal',
        event: 'h1_terminal_move',
      }),
    );
    await assert.rejects(
      () =>
        pool.query(
          `UPDATE tournament_f2b_trusted_provenance SET provenance_seal=$2 WHERE series_id=$1`,
          [row.seriesId, 'd'.repeat(64)],
        ),
      /F2B_PUBLICATION_IMMUTABLE|integrity/i,
    );
    const still = await evaluateLeaderboardReadEligibility(pool, row.seriesId, {
      provenanceKey: KEY,
    });
    assert.equal(still.authorized, true);

    const synthetic = randomUUID();
    const started = Date.parse('2026-11-17T08:00:00.000Z');
    await pool.query(
      `INSERT INTO tournament_daily_claim
         (series_id, player_id, original_utc_date, started_at_ms, manifest_digest, status)
       VALUES ($1,$2,'2026-11-17',$3,$4,'COMPLETED')`,
      [synthetic, 'synthetic-player', started, 'a'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO tournament_daily_series_completion (
         series_id, player_id, original_utc_date, claim_started_at_ms, completed_at_ms,
         manifest_digest, publication_idempotency_key, revision
       ) VALUES ($1,$2,'2026-11-17',$3,$4,$5,$6,1)`,
      [
        synthetic,
        'synthetic-player',
        started,
        started + 1000,
        'a'.repeat(64),
        `f2-publish:${synthetic}`,
      ],
    );
    for (let ordinal = 1; ordinal <= 6; ordinal += 1) {
      await pool.query(
        `INSERT INTO tournament_verified_subgame_score
           (series_id, subgame_ordinal, challenge_id, state_hash, score, ledger_admission_seq)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [synthetic, ordinal, `c-${ordinal}`, 'c'.repeat(64), ordinal * 10, ordinal],
      );
    }
    const cats = computeFourCategoryScores(
      [1, 2, 3, 4, 5, 6].map((ordinal) => ({ ordinal, score: ordinal * 10 })),
    );
    for (const [category, score] of [
      ['EASY', cats.easy],
      ['MEDIUM', cats.medium],
      ['HARD', cats.hard],
      ['ALL', cats.all],
    ] as const) {
      await pool.query(
        `INSERT INTO tournament_daily_result_category (series_id, category, score)
         VALUES ($1,$2,$3)`,
        [synthetic, category, score],
      );
    }
    await pool.query(
      `INSERT INTO tournament_on_time_badge
         (series_id, awarded, claim_started_at_ms, original_utc_date)
       VALUES ($1,TRUE,$2,'2026-11-17')`,
      [synthetic, started],
    );
    await pool.query(
      `INSERT INTO tournament_f2b_trusted_provenance
         (series_id, revision, verified_at_ms, provenance_seal)
       VALUES ($1,1,$2,$3)`,
      [synthetic, started, 'd'.repeat(64)],
    );
    const forged = await evaluateLeaderboardReadEligibility(pool, synthetic, {
      provenanceKey: KEY,
    });
    assert.equal(forged.authorized, false);
    assert.equal(forged.reason, 'F2B_PROVENANCE_SEAL_UNVERIFIED');
    assert.notEqual(published.provenanceSeal, 'd'.repeat(64));
  });

  it('serializes two connections onto one publication', async () => {
    const row = await seed();
    const input = {
      seriesId: row.seriesId,
      playerId: row.playerId,
      writerGeneration: 1,
      commandIdempotencyKey: 'race',
      event: 'h1_terminal_move' as const,
    };
    const [a, b] = await Promise.all([service().publish(input), service().publish(input)]);
    const outcomes = [a.outcome, b.outcome].sort();
    assert.deepEqual(outcomes, ['duplicate', 'published']);
    assert.equal((await counts(row.seriesId)).completion, 1);
    assert.equal((await counts(row.seriesId)).scores, 6);
    if (a.outcome !== 'rejected' && b.outcome !== 'rejected') {
      assert.equal(a.provenanceSeal, b.provenanceSeal);
      assert.equal(a.revision, 1);
      assert.equal(b.revision, 1);
    }
  });

  it('returns the original result for the same key and for a different key', async () => {
    const row = await seed();
    const first = publishedScores(
      await service().publish({
        seriesId: row.seriesId,
        playerId: row.playerId,
        writerGeneration: 1,
        commandIdempotencyKey: 'same-key',
        event: 'h1_terminal_move',
      }),
    );
    const same = publishedScores(
      await service().publish({
        seriesId: row.seriesId,
        playerId: row.playerId,
        writerGeneration: 1,
        commandIdempotencyKey: 'same-key',
        event: 'h1_terminal_move',
      }),
    );
    const other = publishedScores(
      await service().publish({
        seriesId: row.seriesId,
        playerId: row.playerId,
        writerGeneration: 2,
        commandIdempotencyKey: 'different-key',
        event: 'h1_terminal_move',
      }),
    );
    assert.equal(same.outcome, 'duplicate');
    assert.equal(other.outcome, 'duplicate');
    assert.equal(same.provenanceSeal, first.provenanceSeal);
    assert.equal(other.provenanceSeal, first.provenanceSeal);
    assert.equal(same.commandIdempotencyKey, 'same-key');
    assert.equal(other.commandIdempotencyKey, 'same-key');
    assert.equal((await counts(row.seriesId)).completion, 1);
    assert.equal((await counts(row.seriesId)).provenance, 1);
    const storedKey = await pool.query(
      `SELECT source_command_idempotency_key, revision
       FROM tournament_daily_series_completion WHERE series_id=$1`,
      [row.seriesId],
    );
    assert.equal(storedKey.rows[0].source_command_idempotency_key, 'same-key');
    assert.equal(Number(storedKey.rows[0].revision), 1);
  });

  it('rejects a stale writer before any publication row exists', async () => {
    const row = await seed({ writerGeneration: 2 });
    const result = await service().publish({
      seriesId: row.seriesId,
      playerId: row.playerId,
      writerGeneration: 1,
      commandIdempotencyKey: 'stale',
      event: 'h1_terminal_move',
    });
    assert.equal(result.outcome, 'rejected');
    if (result.outcome === 'rejected') assert.equal(result.reason, 'STALE_WRITER');
    assert.equal((await counts(row.seriesId)).completion, 0);
  });

  it('does not publish a forfeited series', async () => {
    const row = await seed({ claimStatus: 'FORFEITED', fenceStatus: 'FORFEITED' });
    const result = await service().publish({
      seriesId: row.seriesId,
      playerId: row.playerId,
      writerGeneration: 1,
      commandIdempotencyKey: 'forfeit',
      event: 'h1_terminal_move',
    });
    assert.equal(result.outcome, 'rejected');
    if (result.outcome === 'rejected') assert.equal(result.reason, 'FORFEITED_SERIES');
    assert.equal((await counts(row.seriesId)).completion, 0);
  });

  it('does not publish a nonterminal H1 or a between-game Advance', async () => {
    const open = await seed({ mode: 'h1_open' });
    const early = await service().publish({
      seriesId: open.seriesId,
      playerId: open.playerId,
      writerGeneration: 1,
      commandIdempotencyKey: 'early-h1',
      event: 'h1_terminal_move',
    });
    assert.equal(early.outcome, 'rejected');
    if (early.outcome === 'rejected') assert.equal(early.reason, 'H1_NOT_TERMINAL');
    assert.equal((await counts(open.seriesId)).completion, 0);

    const ready = await seed();
    const advance = await service().publish({
      seriesId: ready.seriesId,
      playerId: ready.playerId,
      writerGeneration: 1,
      commandIdempotencyKey: 'advance',
      event: 'between_game_advance',
    });
    assert.equal(advance.outcome, 'rejected');
    if (advance.outcome === 'rejected') {
      assert.equal(advance.reason, 'COMPLETION_EVENT_BLOCKED');
    }
    assert.equal((await counts(ready.seriesId)).completion, 0);
  });

  it('awards On-Time from the claim start across UTC midnight, not the finish time', async () => {
    const beforeMidnight = Date.parse('2026-11-17T23:59:59.999Z');
    const afterMidnight = Date.parse('2026-11-18T00:05:00.000Z');
    const onTime = await seed({
      manifest: zeroManifest,
      startedAtMs: beforeMidnight,
      h1ReceivedAtMs: afterMidnight,
    });
    const onResult = publishedScores(
      await service().publish({
        seriesId: onTime.seriesId,
        playerId: onTime.playerId,
        writerGeneration: 1,
        commandIdempotencyKey: 'badge-on',
        event: 'h1_terminal_move',
      }),
    );
    assert.equal(onResult.onTimeAwarded, true);
    assert.equal(onResult.completedAtMs, afterMidnight);

    const lateStart = Date.parse('2026-11-18T00:00:00.000Z');
    const late = await seed({
      manifest: zeroManifest,
      startedAtMs: lateStart,
      h1ReceivedAtMs: lateStart + 60_000,
    });
    const lateResult = publishedScores(
      await service().publish({
        seriesId: late.seriesId,
        playerId: late.playerId,
        writerGeneration: 1,
        commandIdempotencyKey: 'badge-off',
        event: 'h1_terminal_move',
      }),
    );
    assert.equal(lateResult.onTimeAwarded, false);
  });

  it('publishes a timely terminal H1 whose hard cutoff is already in the past', async () => {
    const started = Date.parse('2026-11-17T12:00:00.000Z');
    const received = started + 10_000;
    const row = await seed({
      startedAtMs: started,
      h1ReceivedAtMs: received,
      hardCutoffAtMs: received - 1,
    });
    const result = publishedScores(
      await service().publish({
        seriesId: row.seriesId,
        playerId: row.playerId,
        writerGeneration: 1,
        commandIdempotencyKey: 'after-cutoff-processing',
        event: 'h1_terminal_move',
      }),
    );
    assert.equal(result.completedAtMs, received);
    assert.equal((await counts(row.seriesId)).completion, 1);
  });

  it('hides partial rows until commit and leaves nothing after rollback', async () => {
    const hidden = await seed();
    let visibleDuring = -1;
    await service({
      observe: async (point) => {
        if (point !== 'after_category_ALL') return;
        visibleDuring = Number(
          (
            await pool.query(
              `SELECT count(*)::int AS n FROM tournament_daily_result_category WHERE series_id=$1`,
              [hidden.seriesId],
            )
          ).rows[0].n,
        );
      },
    }).publish({
      seriesId: hidden.seriesId,
      playerId: hidden.playerId,
      writerGeneration: 1,
      commandIdempotencyKey: 'visible',
      event: 'h1_terminal_move',
    });
    assert.equal(visibleDuring, 0);
    assert.equal((await counts(hidden.seriesId)).categories, 4);

    const rolled = await seed();
    await assert.rejects(
      () =>
        service({
          inject: (point) => {
            if (point === 'before_commit') throw new Error('FAULT:before_commit');
          },
        }).publish({
          seriesId: rolled.seriesId,
          playerId: rolled.playerId,
          writerGeneration: 1,
          commandIdempotencyKey: 'rollback',
          event: 'h1_terminal_move',
        }),
      /FAULT:before_commit/,
    );
    assert.deepEqual(await counts(rolled.seriesId), {
      completion: 0,
      scores: 0,
      categories: 0,
      badge: 0,
      provenance: 0,
    });
    const again = publishedScores(
      await service().publish({
        seriesId: rolled.seriesId,
        playerId: rolled.playerId,
        writerGeneration: 1,
        commandIdempotencyKey: 'rollback',
        event: 'h1_terminal_move',
      }),
    );
    assert.equal(again.outcome, 'published');
    assert.equal((await counts(rolled.seriesId)).categories, 4);
  });

  for (const point of F2B_FAULT_POINTS) {
    it(`rolls back every publication row when ${point} faults`, async () => {
      const row = await seed();
      await assert.rejects(
        () =>
          service({
            inject: (current) => {
              if (current === point) throw new Error(`FAULT:${point}`);
            },
          }).publish({
            seriesId: row.seriesId,
            playerId: row.playerId,
            writerGeneration: 1,
            commandIdempotencyKey: `fault-${point}`,
            event: 'h1_terminal_move',
          }),
        new RegExp(`FAULT:${point}`),
      );
      assert.deepEqual(await counts(row.seriesId), {
        completion: 0,
        scores: 0,
        categories: 0,
        badge: 0,
        provenance: 0,
      });
      const fence = await pool.query(
        `SELECT results_published, status FROM series_fence_state WHERE series_key=$1`,
        [row.seriesId],
      );
      assert.equal(fence.rows[0].results_published, false);
      assert.notEqual(fence.rows[0].status, 'COMPLETED');
    });
  }

  it('reconciles the original publication after the response is lost', async () => {
    const row = await seed();
    await assert.rejects(
      () =>
        service({
          afterCommit: () => {
            throw new Error('LOST_RESPONSE');
          },
        }).publish({
          seriesId: row.seriesId,
          playerId: row.playerId,
          writerGeneration: 1,
          commandIdempotencyKey: 'lost',
          event: 'h1_terminal_move',
        }),
      /LOST_RESPONSE/,
    );
    assert.equal((await counts(row.seriesId)).completion, 1);
    const replay = publishedScores(
      await service().publish({
        seriesId: row.seriesId,
        playerId: row.playerId,
        writerGeneration: 1,
        commandIdempotencyKey: 'lost',
        event: 'h1_terminal_move',
      }),
    );
    assert.equal(replay.outcome, 'duplicate');
    assert.equal((await counts(row.seriesId)).scores, 6);
    assert.equal((await counts(row.seriesId)).categories, 4);
  });

  it('publishes inside the terminal H1 move transaction and rolls it back together', async () => {
    const uow = new PostgresTrustedUnitOfWork(pool);
    const open = await seed({ mode: 'h1_open' });
    uow.setSixGamePublisher(service());
    const applied = await uow.adjudicateAcceptedMove({
      seriesKey: open.seriesId,
      playerId: open.playerId,
      subgameOrdinal: 6,
      admissionId: open.h1AdmissionId,
      admissionSeq: 6,
      trustedReceivedAt: new Date(open.h1ReceivedAtMs),
      move: {
        offerIndex: 0,
        tap: [0, 0],
        expectedBoardRevision: 5,
        writerGeneration: 1,
      },
    });
    assert.equal(applied.decision, 'apply');
    if (applied.decision === 'apply') {
      assert.equal(applied.fence.status, 'COMPLETED');
      assert.equal(applied.fence.resultsPublished, true);
      assert.equal(applied.result.awaitAdvance, false);
    }
    const persisted = await pool.query(
      `SELECT score FROM tournament_verified_subgame_score
       WHERE series_id=$1 AND subgame_ordinal=6`,
      [open.seriesId],
    );
    assert.equal(Number(persisted.rows[0].score), 0);
    assert.notEqual(Number(persisted.rows[0].score), open.running);
    assert.equal((await counts(open.seriesId)).scores, 6);

    const again = await uow.adjudicateAcceptedMove({
      seriesKey: open.seriesId,
      playerId: open.playerId,
      subgameOrdinal: 6,
      admissionId: open.h1AdmissionId,
      admissionSeq: 6,
      trustedReceivedAt: new Date(open.h1ReceivedAtMs),
      move: {
        offerIndex: 0,
        tap: [0, 0],
        expectedBoardRevision: 5,
        writerGeneration: 1,
      },
    });
    assert.equal(again.decision, 'apply');
    if (again.decision === 'apply') assert.equal(again.duplicateReplay, true);
    assert.equal((await counts(open.seriesId)).completion, 1);

    const crashed = await seed({ mode: 'h1_open' });
    uow.setSixGamePublisher(
      service({
        inject: (point) => {
          if (point === 'after_completion') throw new Error('FAULT:move-tx');
        },
      }),
    );
    await assert.rejects(
      () =>
        uow.adjudicateAcceptedMove({
          seriesKey: crashed.seriesId,
          playerId: crashed.playerId,
          subgameOrdinal: 6,
          admissionId: crashed.h1AdmissionId,
          admissionSeq: 6,
          trustedReceivedAt: new Date(crashed.h1ReceivedAtMs),
          move: {
            offerIndex: 0,
            tap: [0, 0],
            expectedBoardRevision: 5,
            writerGeneration: 1,
          },
        }),
      /FAULT:move-tx/,
    );
    assert.equal((await counts(crashed.seriesId)).completion, 0);
    const ledger = await pool.query(
      `SELECT count(*)::int AS n FROM accepted_move_ledger
       WHERE series_key=$1 AND subgame_ordinal=6`,
      [crashed.seriesId],
    );
    assert.equal(ledger.rows[0].n, 0);
    const pending = await pool.query(
      `SELECT outcome FROM command_admission_journal WHERE admission_id=$1`,
      [crashed.h1AdmissionId],
    );
    assert.equal(pending.rows[0].outcome, 'pending');
    uow.setSixGamePublisher(service());
    const recovered = await uow.adjudicateAcceptedMove({
      seriesKey: crashed.seriesId,
      playerId: crashed.playerId,
      subgameOrdinal: 6,
      admissionId: crashed.h1AdmissionId,
      admissionSeq: 6,
      trustedReceivedAt: new Date(crashed.h1ReceivedAtMs),
      move: {
        offerIndex: 0,
        tap: [0, 0],
        expectedBoardRevision: 5,
        writerGeneration: 1,
      },
    });
    assert.equal(recovered.decision, 'apply');
    assert.equal((await counts(crashed.seriesId)).categories, 4);
  });

  it('rejects ordinal-6 advance without a publication-less COMPLETED fence', async () => {
    const row = await seed();
    const { gameplay, hints } = advanceHarness({ ...row, ordinal: 6 });
    const forged = await gameplay.handleClientCommand(
      {
        commandType: 'advance',
        idempotencyKey: 'forged-ordinal',
        completesSeries: true,
        subgameOrdinal: 6,
      },
      hints,
    );
    assert.equal(forged.decision, 'reject');
    if (forged.decision === 'reject') {
      assert.equal(forged.reason, 'FORBIDDEN_AUTHORITY_FIELD');
    }
    const before = await pool.query(
      `SELECT count(*)::int AS n FROM command_admission_journal
       WHERE series_key=$1 AND command_type='advance'`,
      [row.seriesId],
    );
    assert.equal(before.rows[0].n, 0);

    const adv = await gameplay.handleClientCommand(
      { commandType: 'advance', idempotencyKey: 'h1-advance' },
      hints,
    );
    assert.equal(adv.decision, 'reject');
    if (adv.decision === 'reject') assert.equal(adv.reason, 'NO_NEXT_ORDINAL');
    const again = await gameplay.handleClientCommand(
      { commandType: 'advance', idempotencyKey: 'h1-advance' },
      hints,
    );
    assert.equal(again.decision, 'reject');
    if (again.decision === 'reject') {
      assert.equal(again.reason, 'NO_NEXT_ORDINAL');
      assert.equal(again.admissionResult?.decision, 'reject');
    }
    const other = await gameplay.handleClientCommand(
      { commandType: 'advance', idempotencyKey: 'h1-advance-other' },
      hints,
    );
    assert.equal(other.decision, 'reject');
    if (other.decision === 'reject') assert.equal(other.reason, 'NO_NEXT_ORDINAL');

    const fence = await pool.query(
      `SELECT status, results_published, writer_generation
       FROM series_fence_state WHERE series_key=$1`,
      [row.seriesId],
    );
    assert.equal(fence.rows[0].status, 'AWAIT_ADVANCE');
    assert.equal(fence.rows[0].results_published, false);
    assert.equal(Number(fence.rows[0].writer_generation), 1);
    assert.deepEqual(await counts(row.seriesId), {
      completion: 0,
      scores: 0,
      categories: 0,
      badge: 0,
      provenance: 0,
    });
    const published = publishedScores(
      await service().publish({
        seriesId: row.seriesId,
        playerId: row.playerId,
        writerGeneration: 1,
        commandIdempotencyKey: 'after-rejected-advance',
        event: 'h1_terminal_move',
      }),
    );
    assert.equal(published.outcome, 'published');
    assert.equal((await counts(row.seriesId)).categories, 4);
  });

  it('rejects a stale writer on ordinal-6 advance without fence or publication writes', async () => {
    const row = await seed();
    await pool.query(
      `UPDATE series_fence_state SET writer_generation=2 WHERE series_key=$1`,
      [row.seriesId],
    );
    const { gameplay, hints } = advanceHarness({ ...row, writerGeneration: 1, ordinal: 6 });
    const adv = await gameplay.handleClientCommand(
      { commandType: 'advance', idempotencyKey: 'stale-h1-advance' },
      hints,
    );
    assert.equal(adv.decision, 'reject');
    if (adv.decision === 'reject') assert.equal(adv.reason, 'STALE_WRITER');
    const fence = await pool.query(
      `SELECT status, results_published, writer_generation, last_applied_admission_id
       FROM series_fence_state WHERE series_key=$1`,
      [row.seriesId],
    );
    assert.equal(fence.rows[0].status, 'AWAIT_ADVANCE');
    assert.equal(fence.rows[0].results_published, false);
    assert.equal(Number(fence.rows[0].writer_generation), 2);
    assert.equal((await counts(row.seriesId)).completion, 0);
  });

  it('serializes a terminal H1 move against a concurrent ordinal-6 advance', async () => {
    const open = await seed({ mode: 'h1_open' });
    const { gameplay, uow, hints } = advanceHarness({ ...open, ordinal: 6 });
    uow.setSixGamePublisher(service());
    const [moved, advanced] = await Promise.all([
      uow.adjudicateAcceptedMove({
        seriesKey: open.seriesId,
        playerId: open.playerId,
        subgameOrdinal: 6,
        admissionId: open.h1AdmissionId,
        admissionSeq: 6,
        trustedReceivedAt: new Date(open.h1ReceivedAtMs),
        move: {
          offerIndex: 0,
          tap: [0, 0],
          expectedBoardRevision: 5,
          writerGeneration: 1,
        },
      }),
      gameplay.handleClientCommand(
        { commandType: 'advance', idempotencyKey: 'concurrent-h1-advance' },
        hints,
      ),
    ]);
    assert.equal(moved.decision, 'apply');
    if (moved.decision === 'apply') {
      assert.equal(moved.fence.status, 'COMPLETED');
      assert.equal(moved.fence.resultsPublished, true);
    }
    assert.equal(advanced.decision, 'reject');
    if (advanced.decision === 'reject') {
      assert.ok(
        advanced.reason === 'NO_NEXT_ORDINAL' || advanced.reason === 'SERIES_TERMINAL',
        advanced.reason,
      );
    }
    assert.equal((await counts(open.seriesId)).completion, 1);
    assert.equal((await counts(open.seriesId)).scores, 6);
    assert.equal((await counts(open.seriesId)).categories, 4);
    const fence = await pool.query(
      `SELECT status, results_published FROM series_fence_state WHERE series_key=$1`,
      [open.seriesId],
    );
    assert.equal(fence.rows[0].status, 'COMPLETED');
    assert.equal(fence.rows[0].results_published, true);
  });

  it('rolls back an uncommitted COMPLETED fence and a failed next-ordinal advance', async () => {
    const held = await seed();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await lockSeriesForTransaction(holder, held.seriesId);
      await holder.query(
        `UPDATE series_fence_state
         SET status='COMPLETED', results_published=FALSE
         WHERE series_key=$1`,
        [held.seriesId],
      );
      const visible = await pool.query(
        `SELECT status FROM series_fence_state WHERE series_key=$1`,
        [held.seriesId],
      );
      assert.equal(visible.rows[0].status, 'AWAIT_ADVANCE');
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    const after = await pool.query(
      `SELECT status, results_published FROM series_fence_state WHERE series_key=$1`,
      [held.seriesId],
    );
    assert.equal(after.rows[0].status, 'AWAIT_ADVANCE');
    assert.equal(after.rows[0].results_published, false);
    assert.equal((await counts(held.seriesId)).categories, 0);

    const broken = await seed({ mode: 'five', fenceStatus: 'AWAIT_ADVANCE' });
    await pool.query(
      `DELETE FROM trusted_challenge_binding
       WHERE series_key=$1 AND subgame_ordinal=6`,
      [broken.seriesId],
    );
    const { gameplay, hints } = advanceHarness({ ...broken, ordinal: 5 });
    const failed = await gameplay.handleClientCommand(
      { commandType: 'advance', idempotencyKey: 'advance-missing-next' },
      hints,
    );
    assert.equal(failed.decision, 'unavailable');
    const fence = await pool.query(
      `SELECT status, results_published, last_applied_admission_id
       FROM series_fence_state WHERE series_key=$1`,
      [broken.seriesId],
    );
    assert.equal(fence.rows[0].status, 'AWAIT_ADVANCE');
    assert.equal(fence.rows[0].results_published, false);
    assert.equal(fence.rows[0].last_applied_admission_id, null);
    const snap = await pool.query(
      `SELECT count(*)::int AS n FROM authoritative_game_snapshot
       WHERE series_key=$1 AND subgame_ordinal=6`,
      [broken.seriesId],
    );
    assert.equal(snap.rows[0].n, 0);
    assert.equal((await counts(broken.seriesId)).completion, 0);
  });

  it('still publishes a verified terminal H1 through the F2-B transaction', async () => {
    const row = await seed();
    const result = publishedScores(
      await service().publish({
        seriesId: row.seriesId,
        playerId: row.playerId,
        writerGeneration: row.writerGeneration,
        commandIdempotencyKey: 'phase-a-isolation-h1',
        event: 'h1_terminal_move',
      }),
    );
    assert.equal(result.outcome, 'published');
    assert.equal(result.revision, 1);
    assert.equal((await counts(row.seriesId)).completion, 1);
    assert.equal((await counts(row.seriesId)).scores, 6);
    assert.equal((await counts(row.seriesId)).categories, 4);
    assert.equal((await counts(row.seriesId)).provenance, 1);
    const fence = await pool.query(
      `SELECT status, results_published FROM series_fence_state WHERE series_key=$1`,
      [row.seriesId],
    );
    assert.equal(fence.rows[0].status, 'COMPLETED');
    assert.equal(fence.rows[0].results_published, true);
  });
});
