/**
 * PZD-41 Stage F2-B — atomic six-game publication.
 *
 * Authority:
 * - Only this service, running inside the series advisory transaction, may
 *   insert publication rows and the provenance seal.
 * - The seal is HMAC-SHA256 over the replay-derived proof, keyed by a server
 *   secret that is never taken from a request. A hex string, a table row, or
 *   a TypeScript object is not authorization by itself.
 * - Scores come from core-001.v3 replay of the accepted move ledger. The
 *   series fence score is a cumulative consistency check, not the six scores.
 * - Client score, completion flag, ordinal proof and client time are ignored.
 *
 * Completion event (Q13, Q07, TD-06, TD-12, T-02):
 * - The verified terminal H1 move is the publication event.
 * - Between-game Advance applies only when a next ordinal exists. Passing
 *   event `between_game_advance` is rejected and writes nothing.
 * - A nonterminal H1 move does not publish.
 * - Ordinal-6 Advance is rejected by the gameplay writer (`NO_NEXT_ORDINAL`)
 *   and cannot mark the fence COMPLETED. Publication still happens only on
 *   `h1_terminal_move` when H1 is replay-terminal and no completion row exists.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import {
  parseGameState,
  parseInitialGameState,
  replayCore001V3,
  stateHashV3,
  stateToJson,
} from '../../engine/core001v3/index.mts';
import { lockSeriesForTransaction, lockWeeklySettlement } from '../ingress/series-fence.mts';
import type { PinnedManifestRegistry } from '../claims/pinned-manifest-registry.mts';
import type { PinnedDailyManifest } from '../claims/pinned-manifest-registry.mts';
import { findUtcDailyManifestByDigest } from '../uat/postgres-utc-daily-manifests.mts';
import { computeFourCategoryScores } from './four-category-scores.mts';
import {
  migrateF2APublicationSchema,
  onTimeBadgeFromClaim,
  publicationIdempotencyKey,
  type LeaderboardReadEligibility,
} from './f2a-publication-schema.mts';

export const F2B_PROVENANCE_KEY_MIN_LENGTH = 32;

export const F2B_REJECT_REASONS = [
  'CLIENT_AUTHORITY_FORBIDDEN',
  'COMPLETION_EVENT_BLOCKED',
  'INVALID_SERIES_ID',
  'INVALID_COMMAND_KEY',
  'NOT_OWNER',
  'WRITER_UNBOUND',
  'STALE_WRITER',
  'CLAIM_NOT_FOUND',
  'SERIES_FENCE_MISSING',
  'FORFEITED_SERIES',
  'MANIFEST_UNPINNED',
  'CHALLENGE_DIGEST_MISMATCH',
  'MISSING_OR_DUPLICATE_ORDINAL',
  'H1_NOT_TERMINAL',
  'REPLAY_MISMATCH',
  'LEDGER_SNAPSHOT_SCORE_MISMATCH',
  'ADMISSION_ORDER_INVALID',
  'JOURNAL_NOT_ACCEPTED',
  'PROGRESSION_INVALID',
  'FENCE_SCORE_MISMATCH',
  'PUBLICATION_CORRUPT',
  'PERIOD_CLOSED',
] as const;

export type F2BRejectReason = (typeof F2B_REJECT_REASONS)[number];

export const F2B_FAULT_POINTS = [
  'after_lock',
  'after_completion',
  'after_subgame_1',
  'after_subgame_2',
  'after_subgame_3',
  'after_subgame_4',
  'after_subgame_5',
  'after_subgame_6',
  'after_category_EASY',
  'after_category_MEDIUM',
  'after_category_HARD',
  'after_category_ALL',
  'after_badge',
  'after_provenance',
  'after_fence',
  'after_claim',
  'before_commit',
] as const;

export type F2BFaultPoint = (typeof F2B_FAULT_POINTS)[number];

export interface F2BHooks {
  inject?: (point: F2BFaultPoint) => Promise<void> | void;
  observe?: (point: F2BFaultPoint, client: pg.PoolClient) => Promise<void> | void;
  afterCommit?: () => Promise<void> | void;
}

export interface F2BPublishInput {
  readonly seriesId: string;
  readonly playerId: string;
  readonly writerGeneration: number;
  readonly commandIdempotencyKey: string;
  readonly event: 'h1_terminal_move' | 'between_game_advance';
}

export interface F2BPublishedBody {
  readonly seriesId: string;
  readonly playerId: string;
  readonly originalUtcDate: string;
  readonly revision: number;
  readonly completedAtMs: number;
  readonly commandIdempotencyKey: string;
  readonly h1AdmissionId: string;
  readonly subgameScores: readonly { readonly ordinal: number; readonly score: number }[];
  readonly easy: number;
  readonly medium: number;
  readonly hard: number;
  readonly all: number;
  readonly onTimeAwarded: boolean;
  readonly provenanceSeal: string;
  readonly fenceStatus: 'COMPLETED';
  readonly resultsPublished: true;
}

export type F2BPublishResult =
  | (F2BPublishedBody & { readonly outcome: 'published' | 'duplicate' })
  | { readonly outcome: 'rejected'; readonly reason: F2BRejectReason };

const FORBIDDEN_INPUT_KEYS = [
  'verified',
  'provenance',
  'provenanceSeal',
  'authorized',
  'score',
  'scores',
  'completesSeries',
  'completed',
  'onTimeAwarded',
  'clientTimestamp',
  'terminal',
] as const;

const ORDINAL_LABELS = ['E1', 'E2', 'E3', 'M1', 'M2', 'H1'] as const;

export const F2B_PUBLICATION_HARDENING_DDL = `
ALTER TABLE tournament_daily_series_completion
  ADD COLUMN IF NOT EXISTS source_command_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS h1_admission_id UUID;

CREATE OR REPLACE FUNCTION tournament_f2b_reject_publication_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'F2B_PUBLICATION_IMMUTABLE'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'tournament_daily_series_completion',
    'tournament_verified_subgame_score',
    'tournament_daily_result_category',
    'tournament_on_time_badge',
    'tournament_f2b_trusted_provenance'
  ]
  LOOP
    IF to_regclass('public.' || tbl) IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'trg_f2b_immutable_' || tbl
        AND tgrelid = tbl::regclass
        AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION tournament_f2b_reject_publication_mutation()',
        'trg_f2b_immutable_' || tbl,
        tbl
      );
    END IF;
  END LOOP;
END $$;
`;

class PublicationRejection extends Error {
  readonly reason: F2BRejectReason;
  constructor(reason: F2BRejectReason) {
    super(reason);
    this.name = 'PublicationRejection';
    this.reason = reason;
  }
}

function fail(reason: F2BRejectReason): never {
  throw new PublicationRejection(reason);
}

interface SubgameProof {
  readonly ordinal: number;
  readonly challengeId: string;
  readonly initialStateDigest: string;
  readonly stateHash: string;
  readonly score: number;
  readonly ledgerAdmissionSeq: number;
  readonly admissionId: string;
}

interface SeriesProof {
  readonly seriesId: string;
  readonly playerId: string;
  readonly originalUtcDate: string;
  readonly claimStartedAtMs: number;
  readonly manifestDigest: string;
  readonly completedAtMs: number;
  readonly h1AdmissionId: string;
  readonly subgames: readonly SubgameProof[];
  readonly easy: number;
  readonly medium: number;
  readonly hard: number;
  readonly all: number;
  readonly onTimeAwarded: boolean;
}

type Db = {
  query: (
    text: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: unknown[] }>;
};

function rowsOf(result: { rows: unknown[] }): Record<string, unknown>[] {
  return result.rows as Record<string, unknown>[];
}

function intOf(value: unknown, reason: F2BRejectReason): number {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(0)) fail(reason);
    return Number(value);
  }
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(n)) fail(reason);
  return n;
}

function addExact(a: number, b: number): number {
  const total = a + b;
  if (!Number.isSafeInteger(total)) fail('REPLAY_MISMATCH');
  return total;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('PUBLICATION_CORRUPT');
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
      .join(',')}}`;
  }
  fail('PUBLICATION_CORRUPT');
}

function sealProof(key: string, proof: SeriesProof, revision: number, commandKey: string): string {
  const material = canonicalJson({
    v: 1,
    seriesId: proof.seriesId,
    playerId: proof.playerId,
    originalUtcDate: proof.originalUtcDate,
    claimStartedAtMs: proof.claimStartedAtMs,
    manifestDigest: proof.manifestDigest,
    revision,
    completedAtMs: proof.completedAtMs,
    commandIdempotencyKey: commandKey,
    h1AdmissionId: proof.h1AdmissionId,
    subgames: proof.subgames.map((game) => ({
      ordinal: game.ordinal,
      challengeId: game.challengeId,
      initialStateDigest: game.initialStateDigest,
      stateHash: game.stateHash,
      score: game.score,
      ledgerAdmissionSeq: game.ledgerAdmissionSeq,
      admissionId: game.admissionId,
    })),
    categories: {
      ALL: proof.all,
      EASY: proof.easy,
      HARD: proof.hard,
      MEDIUM: proof.medium,
    },
    onTimeAwarded: proof.onTimeAwarded,
  });
  return createHmac('sha256', key).update(material, 'utf8').digest('hex');
}

function sealsEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertNoClientAuthority(input: object): void {
  for (const key of FORBIDDEN_INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw new Error('CLIENT_AUTHORITY_FORBIDDEN');
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}

async function loadProof(
  db: Db,
  seriesId: string,
  manifests: PinnedManifestRegistry | null,
  expectations?: { readonly playerId: string; readonly writerGeneration: number },
  enableUtcDailyManifests = false,
): Promise<SeriesProof> {
  const claimRes = await db.query(
    `SELECT player_id,
            to_char(original_utc_date, 'YYYY-MM-DD') AS original_utc_date,
            started_at_ms, manifest_digest, status
     FROM tournament_daily_claim
     WHERE series_id = $1`,
    [seriesId],
  );
  const claimRows = rowsOf(claimRes);
  if (claimRows.length !== 1) fail('CLAIM_NOT_FOUND');
  const claim = claimRows[0]!;
  const playerId = String(claim.player_id);
  const status = String(claim.status);
  if (status === 'FORFEITED') fail('FORFEITED_SERIES');
  if (expectations && playerId !== expectations.playerId) fail('NOT_OWNER');
  const originalUtcDate = String(claim.original_utc_date);
  const claimStartedAtMs = intOf(claim.started_at_ms, 'CLAIM_NOT_FOUND');
  const manifestDigest = String(claim.manifest_digest);

  const fenceRes = await db.query(
    `SELECT status, writer_generation, score, results_published
     FROM series_fence_state WHERE series_key = $1`,
    [seriesId],
  );
  const fenceRows = rowsOf(fenceRes);
  if (fenceRows.length !== 1) fail('SERIES_FENCE_MISSING');
  const fence = fenceRows[0]!;
  const fenceStatus = String(fence.status);
  if (fenceStatus === 'FORFEITED') fail('FORFEITED_SERIES');
  if (fenceStatus !== 'ACTIVE' && fenceStatus !== 'AWAIT_ADVANCE' && fenceStatus !== 'COMPLETED') {
    fail('PROGRESSION_INVALID');
  }
  const fenceGeneration = intOf(fence.writer_generation, 'STALE_WRITER');
  const fenceScore = intOf(fence.score, 'FENCE_SCORE_MISMATCH');

  if (expectations) {
    if (
      !Number.isSafeInteger(expectations.writerGeneration) ||
      expectations.writerGeneration < 1 ||
      expectations.writerGeneration !== fenceGeneration
    ) {
      fail('STALE_WRITER');
    }
    const writerRes = await db.query(
      `SELECT player_id, writer_generation
       FROM tournament_series_writer WHERE series_key = $1`,
      [seriesId],
    );
    const writerRows = rowsOf(writerRes);
    if (writerRows.length !== 1) fail('WRITER_UNBOUND');
    const writer = writerRows[0]!;
    if (String(writer.player_id) !== expectations.playerId) fail('NOT_OWNER');
    if (intOf(writer.writer_generation, 'STALE_WRITER') !== expectations.writerGeneration) {
      fail('STALE_WRITER');
    }
  }

  let verifiedPinned: PinnedDailyManifest | null = null;
  if (manifests) {
    verifiedPinned = manifests.get(manifestDigest);
    if (!verifiedPinned && enableUtcDailyManifests) {
      verifiedPinned = await findUtcDailyManifestByDigest(db as pg.PoolClient, manifestDigest);
    }
    if (!verifiedPinned || verifiedPinned.subgames.length !== 6) fail('MANIFEST_UNPINNED');
  }

  const bindingRes = await db.query(
    `SELECT subgame_ordinal, challenge_id, rules_version, generator_version,
            content_version, initial_state_digest, initial_state_json
     FROM trusted_challenge_binding
     WHERE series_key = $1 AND player_id = $2
     ORDER BY subgame_ordinal`,
    [seriesId, playerId],
  );
  const bindings = rowsOf(bindingRes);
  if (bindings.length !== 6) fail('MISSING_OR_DUPLICATE_ORDINAL');

  const snapRes = await db.query(
    `SELECT subgame_ordinal, challenge_id, state_hash, score, status,
            terminal_reason, state_json, ledger_admission_seq, writer_generation,
            produced_by_admission_id, move_cursor
     FROM authoritative_game_snapshot
     WHERE series_key = $1 AND player_id = $2
     ORDER BY subgame_ordinal`,
    [seriesId, playerId],
  );
  const snapshots = rowsOf(snapRes);
  const ordinals = snapshots.map((row) => intOf(row.subgame_ordinal, 'MISSING_OR_DUPLICATE_ORDINAL'));
  if (ordinals.length !== 6 || ordinals.some((ordinal, index) => ordinal !== index + 1)) {
    fail('MISSING_OR_DUPLICATE_ORDINAL');
  }

  const ledgerRes = await db.query(
    `SELECT subgame_ordinal, challenge_id, admission_id, admission_seq,
            board_revision_after, move_json, score_delta, score_after,
            state_hash_before, state_hash_after, rules_version,
            terminal_after, terminal_reason
     FROM accepted_move_ledger
     WHERE series_key = $1 AND player_id = $2
     ORDER BY subgame_ordinal, admission_seq`,
    [seriesId, playerId],
  );
  const ledger = rowsOf(ledgerRes);
  const admissionIds = ledger.map((row) => String(row.admission_id));
  if (admissionIds.length < 6) fail('H1_NOT_TERMINAL');
  const journalRes = await db.query(
    `SELECT admission_id, outcome, command_type, admission_seq, player_id, series_key,
            trusted_received_at_ms
     FROM command_admission_journal
     WHERE series_key = $1 AND admission_id = ANY($2::uuid[])`,
    [seriesId, admissionIds],
  );
  const journals = new Map(
    rowsOf(journalRes).map((row) => [String(row.admission_id), row]),
  );

  let maxSeq = -1;
  for (const row of ledger) {
    maxSeq = Math.max(maxSeq, intOf(row.admission_seq, 'ADMISSION_ORDER_INVALID'));
  }

  const subgames: SubgameProof[] = [];
  let running = 0;
  let previousOrdinalMaxSeq = -1;
  const seenSeq = new Set<number>();

  for (let index = 0; index < 6; index += 1) {
    const ordinal = index + 1;
    const label = ORDINAL_LABELS[index]!;
    const binding = bindings[index]!;
    const snapshot = snapshots[index]!;
    if (intOf(binding.subgame_ordinal, 'MISSING_OR_DUPLICATE_ORDINAL') !== ordinal) {
      fail('MISSING_OR_DUPLICATE_ORDINAL');
    }
    if (String(binding.rules_version) !== 'core-001.v3') fail('REPLAY_MISMATCH');
    const initialJson =
      typeof binding.initial_state_json === 'string'
        ? JSON.parse(binding.initial_state_json)
        : binding.initial_state_json;
    let initialState;
    try {
      initialState = parseInitialGameState(initialJson);
    } catch {
      fail('CHALLENGE_DIGEST_MISMATCH');
    }
    const initialDigest = stateHashV3(initialState);
    if (String(binding.initial_state_digest) !== initialDigest) {
      fail('CHALLENGE_DIGEST_MISMATCH');
    }
    if (manifests) {
      const pinned = verifiedPinned;
      const pinnedGame = pinned?.subgames[index];
      if (!pinned || !pinnedGame || pinnedGame.ordinal !== ordinal) fail('MANIFEST_UNPINNED');
      if (
        pinnedGame.challengeId !== String(binding.challenge_id) ||
        pinnedGame.generatorVersion !== String(binding.generator_version) ||
        pinnedGame.contentVersion !== String(binding.content_version)
      ) {
        fail('CHALLENGE_DIGEST_MISMATCH');
      }
      let pinnedState;
      try {
        pinnedState = parseInitialGameState(pinnedGame.initialState);
      } catch {
        fail('CHALLENGE_DIGEST_MISMATCH');
      }
      if (stateHashV3(pinnedState) !== initialDigest) fail('CHALLENGE_DIGEST_MISMATCH');
    }

    const moves = ledger.filter(
      (row) => intOf(row.subgame_ordinal, 'MISSING_OR_DUPLICATE_ORDINAL') === ordinal,
    );
    if (moves.length < 1) {
      fail(ordinal === 6 ? 'H1_NOT_TERMINAL' : 'PROGRESSION_INVALID');
    }
    const terminalRows = moves.filter((row) => row.terminal_after === true);
    if (terminalRows.length > 1) fail('MISSING_OR_DUPLICATE_ORDINAL');

    let ordinalMin = Number.POSITIVE_INFINITY;
    let previousRevision = -1;
    for (let moveIndex = 0; moveIndex < moves.length; moveIndex += 1) {
      const move = moves[moveIndex]!;
      const seq = intOf(move.admission_seq, 'ADMISSION_ORDER_INVALID');
      if (seenSeq.has(seq)) fail('ADMISSION_ORDER_INVALID');
      seenSeq.add(seq);
      ordinalMin = Math.min(ordinalMin, seq);
      const revision = intOf(move.board_revision_after, 'ADMISSION_ORDER_INVALID');
      if (revision <= previousRevision) fail('ADMISSION_ORDER_INVALID');
      previousRevision = revision;
      if (String(move.rules_version) !== 'core-001.v3') fail('REPLAY_MISMATCH');
      if (String(move.challenge_id) !== String(binding.challenge_id)) {
        fail('CHALLENGE_DIGEST_MISMATCH');
      }
      const journal = journals.get(String(move.admission_id));
      if (!journal) fail('JOURNAL_NOT_ACCEPTED');
      if (String(journal.player_id) !== playerId || String(journal.series_key) !== seriesId) {
        fail('NOT_OWNER');
      }
      if (String(journal.command_type) !== 'move') fail('JOURNAL_NOT_ACCEPTED');
      if (intOf(journal.admission_seq, 'JOURNAL_NOT_ACCEPTED') !== seq) {
        fail('JOURNAL_NOT_ACCEPTED');
      }
      const outcome = String(journal.outcome);
      const newestPending = outcome === 'pending' && seq === maxSeq;
      if (outcome !== 'applied' && !newestPending) fail('JOURNAL_NOT_ACCEPTED');
      if (moveIndex === 0 && String(move.state_hash_before) !== initialDigest) {
        fail('REPLAY_MISMATCH');
      }
      void label;
    }
    if (ordinalMin <= previousOrdinalMaxSeq) fail('PROGRESSION_INVALID');
    previousOrdinalMaxSeq = intOf(moves[moves.length - 1]!.admission_seq, 'ADMISSION_ORDER_INVALID');

    let replayed;
    try {
      replayed = replayCore001V3({
        initialState: stateToJson(initialState),
        moves: moves.map((move) => {
          const moveJson =
            typeof move.move_json === 'string'
              ? JSON.parse(String(move.move_json))
              : move.move_json;
          const parsed = moveJson as {
            offerIndex: 0 | 1 | 2;
            tap: { row: number; column: number };
          };
          return {
            offerIndex: parsed.offerIndex,
            tap: [parsed.tap.row, parsed.tap.column] as [number, number],
          };
        }),
      });
    } catch {
      fail('REPLAY_MISMATCH');
    }
    if (!replayed.ok) fail('REPLAY_MISMATCH');
    if (replayed.applied.length !== moves.length) fail('REPLAY_MISMATCH');

    let ordinalScore = 0;
    for (let moveIndex = 0; moveIndex < moves.length; moveIndex += 1) {
      const move = moves[moveIndex]!;
      const applied = replayed.applied[moveIndex]!;
      const delta = intOf(move.score_delta, 'LEDGER_SNAPSHOT_SCORE_MISMATCH');
      if (delta !== applied.scoreDelta || delta < 0) fail('LEDGER_SNAPSHOT_SCORE_MISMATCH');
      ordinalScore = addExact(ordinalScore, delta);
      running = addExact(running, delta);
      if (intOf(move.score_after, 'LEDGER_SNAPSHOT_SCORE_MISMATCH') !== running) {
        fail('LEDGER_SNAPSHOT_SCORE_MISMATCH');
      }
      const afterHash = stateHashV3(applied.finalState);
      if (String(move.state_hash_after) !== afterHash) fail('REPLAY_MISMATCH');
      const expectedBefore =
        moveIndex === 0
          ? initialDigest
          : stateHashV3(replayed.applied[moveIndex - 1]!.finalState);
      if (String(move.state_hash_before) !== expectedBefore) fail('REPLAY_MISMATCH');
    }
    if (ordinalScore !== replayed.finalState.score) fail('LEDGER_SNAPSHOT_SCORE_MISMATCH');

    const last = moves[moves.length - 1]!;
    const ended = replayed.finalState.status === 'ended';
    if (ordinal < 6 && !ended) fail('PROGRESSION_INVALID');
    if (ordinal === 6 && !ended) fail('H1_NOT_TERMINAL');
    if (last.terminal_after !== true) fail(ordinal === 6 ? 'H1_NOT_TERMINAL' : 'PROGRESSION_INVALID');
    if (String(snapshot.status) !== 'ended') {
      fail(ordinal === 6 ? 'H1_NOT_TERMINAL' : 'PROGRESSION_INVALID');
    }
    if (String(snapshot.challenge_id) !== String(binding.challenge_id)) {
      fail('CHALLENGE_DIGEST_MISMATCH');
    }
    if (String(snapshot.state_hash) !== replayed.stateHash) fail('REPLAY_MISMATCH');
    let storedState;
    try {
      const stateJson =
        typeof snapshot.state_json === 'string'
          ? JSON.parse(String(snapshot.state_json))
          : snapshot.state_json;
      storedState = parseGameState(stateJson);
    } catch {
      fail('REPLAY_MISMATCH');
    }
    if (stateHashV3(storedState) !== replayed.stateHash) fail('REPLAY_MISMATCH');
    if (intOf(snapshot.score, 'LEDGER_SNAPSHOT_SCORE_MISMATCH') !== running) {
      fail('LEDGER_SNAPSHOT_SCORE_MISMATCH');
    }
    if (intOf(snapshot.ledger_admission_seq, 'ADMISSION_ORDER_INVALID') !== previousOrdinalMaxSeq) {
      fail('ADMISSION_ORDER_INVALID');
    }
    if (intOf(snapshot.move_cursor, 'REPLAY_MISMATCH') !== moves.length) fail('REPLAY_MISMATCH');
    const snapWriter = intOf(snapshot.writer_generation, 'STALE_WRITER');
    if (snapWriter < 1 || snapWriter > fenceGeneration) fail('STALE_WRITER');
    if (String(snapshot.produced_by_admission_id) !== String(last.admission_id)) {
      fail('REPLAY_MISMATCH');
    }
    const reason = replayed.finalState.terminalReason;
    if (reason !== 'move_limit_reached' && reason !== 'no_legal_moves') fail('REPLAY_MISMATCH');
    if (String(snapshot.terminal_reason) !== reason) fail('REPLAY_MISMATCH');
    if (String(last.terminal_reason) !== reason) fail('REPLAY_MISMATCH');

    subgames.push({
      ordinal,
      challengeId: String(binding.challenge_id),
      initialStateDigest: initialDigest,
      stateHash: replayed.stateHash,
      score: ordinalScore,
      ledgerAdmissionSeq: previousOrdinalMaxSeq,
      admissionId: String(last.admission_id),
    });
  }

  if (fenceScore !== running) fail('FENCE_SCORE_MISMATCH');
  const h1 = subgames[5]!;
  const h1Journal = journals.get(h1.admissionId);
  if (!h1Journal) fail('JOURNAL_NOT_ACCEPTED');
  const completedAtMs = intOf(h1Journal.trusted_received_at_ms, 'JOURNAL_NOT_ACCEPTED');
  if (completedAtMs < claimStartedAtMs) fail('PROGRESSION_INVALID');

  const categories = computeFourCategoryScores(
    subgames.map((game) => ({ ordinal: game.ordinal, score: game.score })),
  );
  let onTimeAwarded: boolean;
  try {
    onTimeAwarded = onTimeBadgeFromClaim({ originalUtcDate, claimStartedAtMs });
  } catch {
    fail('PUBLICATION_CORRUPT');
  }

  return {
    seriesId,
    playerId,
    originalUtcDate,
    claimStartedAtMs,
    manifestDigest,
    completedAtMs,
    h1AdmissionId: h1.admissionId,
    subgames,
    easy: categories.easy,
    medium: categories.medium,
    hard: categories.hard,
    all: categories.all,
    onTimeAwarded,
  };
}

function bodyFromProof(
  proof: SeriesProof,
  commandKey: string,
  seal: string,
): F2BPublishedBody {
  return {
    seriesId: proof.seriesId,
    playerId: proof.playerId,
    originalUtcDate: proof.originalUtcDate,
    revision: 1,
    completedAtMs: proof.completedAtMs,
    commandIdempotencyKey: commandKey,
    h1AdmissionId: proof.h1AdmissionId,
    subgameScores: proof.subgames.map((game) => ({
      ordinal: game.ordinal,
      score: game.score,
    })),
    easy: proof.easy,
    medium: proof.medium,
    hard: proof.hard,
    all: proof.all,
    onTimeAwarded: proof.onTimeAwarded,
    provenanceSeal: seal,
    fenceStatus: 'COMPLETED',
    resultsPublished: true,
  };
}

async function readCommittedBody(
  db: Db,
  seriesId: string,
  key: string,
  manifests: PinnedManifestRegistry | null,
  enableUtcDailyManifests = false,
): Promise<F2BPublishedBody> {
  const proof = await loadProof(db, seriesId, manifests, undefined, enableUtcDailyManifests);
  const completionRes = await db.query(
    `SELECT player_id,
            to_char(original_utc_date, 'YYYY-MM-DD') AS original_utc_date,
            claim_started_at_ms, completed_at_ms, manifest_digest, revision,
            publication_idempotency_key, source_command_idempotency_key, h1_admission_id
     FROM tournament_daily_series_completion
     WHERE series_id = $1`,
    [seriesId],
  );
  const completionRows = rowsOf(completionRes);
  if (completionRows.length !== 1) fail('PUBLICATION_CORRUPT');
  const completion = completionRows[0]!;
  const commandKey = String(completion.source_command_idempotency_key ?? '');
  if (
    String(completion.player_id) !== proof.playerId ||
    String(completion.original_utc_date) !== proof.originalUtcDate ||
    intOf(completion.claim_started_at_ms, 'PUBLICATION_CORRUPT') !== proof.claimStartedAtMs ||
    intOf(completion.completed_at_ms, 'PUBLICATION_CORRUPT') !== proof.completedAtMs ||
    String(completion.manifest_digest) !== proof.manifestDigest ||
    intOf(completion.revision, 'PUBLICATION_CORRUPT') !== 1 ||
    String(completion.publication_idempotency_key) !== publicationIdempotencyKey(seriesId) ||
    String(completion.h1_admission_id) !== proof.h1AdmissionId ||
    commandKey.length < 1
  ) {
    fail('PUBLICATION_CORRUPT');
  }

  const scoreRes = await db.query(
    `SELECT subgame_ordinal, challenge_id, state_hash, score, ledger_admission_seq,
            produced_by_admission_id
     FROM tournament_verified_subgame_score
     WHERE series_id = $1
     ORDER BY subgame_ordinal`,
    [seriesId],
  );
  const scores = rowsOf(scoreRes);
  if (scores.length !== 6) fail('PUBLICATION_CORRUPT');
  for (let index = 0; index < 6; index += 1) {
    const row = scores[index]!;
    const game = proof.subgames[index]!;
    if (
      intOf(row.subgame_ordinal, 'PUBLICATION_CORRUPT') !== game.ordinal ||
      String(row.challenge_id) !== game.challengeId ||
      String(row.state_hash) !== game.stateHash ||
      intOf(row.score, 'PUBLICATION_CORRUPT') !== game.score ||
      intOf(row.ledger_admission_seq, 'PUBLICATION_CORRUPT') !== game.ledgerAdmissionSeq ||
      String(row.produced_by_admission_id) !== game.admissionId
    ) {
      fail('PUBLICATION_CORRUPT');
    }
  }

  const categoryRes = await db.query(
    `SELECT category, score FROM tournament_daily_result_category
     WHERE series_id = $1`,
    [seriesId],
  );
  const categories = new Map(
    rowsOf(categoryRes).map((row) => [String(row.category), intOf(row.score, 'PUBLICATION_CORRUPT')]),
  );
  if (
    categories.size !== 4 ||
    categories.get('EASY') !== proof.easy ||
    categories.get('MEDIUM') !== proof.medium ||
    categories.get('HARD') !== proof.hard ||
    categories.get('ALL') !== proof.all
  ) {
    fail('PUBLICATION_CORRUPT');
  }

  const badgeRes = await db.query(
    `SELECT awarded, claim_started_at_ms, to_char(original_utc_date, 'YYYY-MM-DD') AS original_utc_date
     FROM tournament_on_time_badge WHERE series_id = $1`,
    [seriesId],
  );
  const badgeRows = rowsOf(badgeRes);
  if (badgeRows.length !== 1) fail('PUBLICATION_CORRUPT');
  const badge = badgeRows[0]!;
  if (
    Boolean(badge.awarded) !== proof.onTimeAwarded ||
    intOf(badge.claim_started_at_ms, 'PUBLICATION_CORRUPT') !== proof.claimStartedAtMs ||
    String(badge.original_utc_date) !== proof.originalUtcDate
  ) {
    fail('PUBLICATION_CORRUPT');
  }

  const provenanceRes = await db.query(
    `SELECT revision, provenance_seal FROM tournament_f2b_trusted_provenance
     WHERE series_id = $1`,
    [seriesId],
  );
  const provenanceRows = rowsOf(provenanceRes);
  if (provenanceRows.length !== 1) fail('PUBLICATION_CORRUPT');
  const provenance = provenanceRows[0]!;
  if (intOf(provenance.revision, 'PUBLICATION_CORRUPT') !== 1) fail('PUBLICATION_CORRUPT');
  const expected = sealProof(key, proof, 1, commandKey);
  if (!sealsEqual(String(provenance.provenance_seal), expected)) fail('PUBLICATION_CORRUPT');

  const fenceRes = await db.query(
    `SELECT status, results_published FROM series_fence_state WHERE series_key = $1`,
    [seriesId],
  );
  const fenceRows = rowsOf(fenceRes);
  if (
    fenceRows.length !== 1 ||
    String(fenceRows[0]!.status) !== 'COMPLETED' ||
    fenceRows[0]!.results_published !== true
  ) {
    fail('PUBLICATION_CORRUPT');
  }
  const claimRes = await db.query(
    `SELECT status FROM tournament_daily_claim WHERE series_id = $1`,
    [seriesId],
  );
  const claimRows = rowsOf(claimRes);
  if (claimRows.length !== 1 || String(claimRows[0]!.status) !== 'COMPLETED') {
    fail('PUBLICATION_CORRUPT');
  }
  return bodyFromProof(proof, commandKey, expected);
}

/**
 * Read-path authorization. Replays durable evidence and checks the HMAC.
 * Any failure, including a forged seal or a score that no longer matches
 * replay, is F2B_PROVENANCE_SEAL_UNVERIFIED. This function does not write.
 */
export async function authorizePublishedSeries(
  db: Db,
  seriesId: string,
  provenanceKey: string,
): Promise<LeaderboardReadEligibility> {
  if (typeof provenanceKey !== 'string' || provenanceKey.length < F2B_PROVENANCE_KEY_MIN_LENGTH) {
    return { authorized: false, reason: 'F2B_PROVENANCE_SEAL_UNVERIFIED' };
  }
  try {
    const body = await readCommittedBody(db, seriesId, provenanceKey, null);
    return {
      authorized: true,
      seriesId: body.seriesId,
      playerId: body.playerId,
      originalUtcDate: body.originalUtcDate,
      revision: body.revision,
      easy: body.easy,
      medium: body.medium,
      hard: body.hard,
      all: body.all,
      onTimeAwarded: body.onTimeAwarded,
    };
  } catch {
    return { authorized: false, reason: 'F2B_PROVENANCE_SEAL_UNVERIFIED' };
  }
}

export class F2BPublicationService {
  readonly #pool: pg.Pool;
  readonly #key: string;
  readonly #manifests: PinnedManifestRegistry;
  readonly #enableUtcDailyManifests: boolean;
  readonly #hooks: F2BHooks;

  constructor(
    pool: pg.Pool,
    options: {
      readonly provenanceKey: string;
      readonly manifests: PinnedManifestRegistry;
      readonly enableUtcDailyManifests?: boolean;
      readonly hooks?: F2BHooks;
    },
  ) {
    if (
      typeof options.provenanceKey !== 'string' ||
      options.provenanceKey.length < F2B_PROVENANCE_KEY_MIN_LENGTH
    ) {
      throw new Error('F2B_PROVENANCE_KEY_UNCONFIGURED');
    }
    this.#pool = pool;
    this.#key = options.provenanceKey;
    this.#manifests = options.manifests;
    this.#enableUtcDailyManifests = options.enableUtcDailyManifests === true;
    this.#hooks = options.hooks ?? {};
  }

  async migrate(): Promise<void> {
    await migrateF2APublicationSchema(this.#pool);
    await this.#pool.query(F2B_PUBLICATION_HARDENING_DDL);
  }

  async publish(input: F2BPublishInput): Promise<F2BPublishResult> {
    const prepared = this.#prepare(input);
    if ('outcome' in prepared) return prepared;
    const client = await this.#pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await lockWeeklySettlement(client);
      const result = await this.#writeVerified(client, prepared, () => undefined);
      await this.#step('before_commit', client);
      await client.query('COMMIT');
      committed = true;
      if (this.#hooks.afterCommit) await this.#hooks.afterCommit();
      return result;
    } catch (err) {
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The transaction may already be aborted.
        }
      }
      if (!committed && isUniqueViolation(err)) {
        try {
          const body = await readCommittedBody(
            this.#pool,
            prepared.seriesId,
            this.#key,
            this.#manifests,
            this.#enableUtcDailyManifests,
          );
          return { outcome: 'duplicate', ...body };
        } catch (readErr) {
          if (readErr instanceof PublicationRejection) {
            return { outcome: 'rejected', reason: readErr.reason };
          }
        }
      }
      if (err instanceof PublicationRejection) {
        return { outcome: 'rejected', reason: err.reason };
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Publication writes for a caller that already opened the series transaction.
   * Does not commit. A rejected result must abort that transaction. The unit
   * of work rolls the move back and leaves the admission pending.
   */
  async publishOnOpenTransaction(
    client: pg.PoolClient,
    input: F2BPublishInput,
  ): Promise<F2BPublishResult> {
    const prepared = this.#prepare(input);
    if ('outcome' in prepared) return prepared;
    let wrote = false;
    try {
      return await this.#writeVerified(client, prepared, () => {
        wrote = true;
      });
    } catch (err) {
      if (err instanceof PublicationRejection && !wrote) {
        return { outcome: 'rejected', reason: err.reason };
      }
      throw err;
    }
  }

  #prepare(input: F2BPublishInput): F2BPublishInput | F2BPublishResult {
    assertNoClientAuthority(input);
    if (input.event !== 'h1_terminal_move') {
      return { outcome: 'rejected', reason: 'COMPLETION_EVENT_BLOCKED' };
    }
    let seriesId: string;
    try {
      seriesId = publicationIdempotencyKey(input.seriesId).slice('f2-publish:'.length);
    } catch {
      return { outcome: 'rejected', reason: 'INVALID_SERIES_ID' };
    }
    if (typeof input.playerId !== 'string' || input.playerId.trim().length < 1) {
      return { outcome: 'rejected', reason: 'NOT_OWNER' };
    }
    if (
      typeof input.commandIdempotencyKey !== 'string' ||
      input.commandIdempotencyKey.trim().length < 1 ||
      input.commandIdempotencyKey.length > 200
    ) {
      return { outcome: 'rejected', reason: 'INVALID_COMMAND_KEY' };
    }
    if (!Number.isSafeInteger(input.writerGeneration) || input.writerGeneration < 1) {
      return { outcome: 'rejected', reason: 'STALE_WRITER' };
    }
    return {
      seriesId,
      playerId: input.playerId,
      writerGeneration: input.writerGeneration,
      commandIdempotencyKey: input.commandIdempotencyKey,
      event: 'h1_terminal_move',
    };
  }

  async #writeVerified(
    client: pg.PoolClient,
    input: F2BPublishInput,
    onBeforeWrite: () => void,
  ): Promise<F2BPublishResult> {
    await lockSeriesForTransaction(client, input.seriesId);
    await this.#step('after_lock', client);

    const existing = await client.query(
      `SELECT 1 FROM tournament_daily_series_completion WHERE series_id = $1`,
      [input.seriesId],
    );
    if ((existing.rowCount ?? 0) > 0) {
      const body = await readCommittedBody(client, input.seriesId, this.#key, this.#manifests, this.#enableUtcDailyManifests);
      return { outcome: 'duplicate', ...body };
    }

    await client.query(`SELECT 1 FROM series_fence_state WHERE series_key = $1 FOR UPDATE`, [
      input.seriesId,
    ]);
    await client.query(
      `SELECT 1 FROM tournament_series_writer WHERE series_key = $1 FOR UPDATE`,
      [input.seriesId],
    );
    await client.query(`SELECT 1 FROM tournament_daily_claim WHERE series_id = $1 FOR UPDATE`, [
      input.seriesId,
    ]);
    const period = await client.query(`SELECT to_regclass('public.tournament_f2c_settlement') AS rel`);
    if (period.rows[0]?.rel) {
      const closed = await client.query(
        `SELECT 1
         FROM tournament_daily_claim c
         JOIN tournament_f2c_settlement s
           ON s.week_start = (c.original_utc_date - ((EXTRACT(ISODOW FROM c.original_utc_date)::int + 6) % 7))
          AND s.state = 'FINAL'
         WHERE c.series_id = $1`,
        [input.seriesId],
      );
      if ((closed.rowCount ?? 0) > 0) return { outcome: 'rejected', reason: 'PERIOD_CLOSED' };
    }

    const proof = await loadProof(client, input.seriesId, this.#manifests, {
      playerId: input.playerId,
      writerGeneration: input.writerGeneration,
    }, this.#enableUtcDailyManifests);
    const seal = sealProof(this.#key, proof, 1, input.commandIdempotencyKey);
    const idempotencyKey = publicationIdempotencyKey(input.seriesId);
    onBeforeWrite();

    await client.query(
      `INSERT INTO tournament_daily_series_completion (
         series_id, player_id, original_utc_date, claim_started_at_ms, completed_at_ms,
         manifest_digest, publication_idempotency_key, revision,
         source_command_idempotency_key, h1_admission_id
       ) VALUES ($1,$2,$3::date,$4,$5,$6,$7,1,$8,$9)`,
      [
        proof.seriesId,
        proof.playerId,
        proof.originalUtcDate,
        proof.claimStartedAtMs,
        proof.completedAtMs,
        proof.manifestDigest,
        idempotencyKey,
        input.commandIdempotencyKey,
        proof.h1AdmissionId,
      ],
    );
    await this.#step('after_completion', client);

    for (const game of proof.subgames) {
      await client.query(
        `INSERT INTO tournament_verified_subgame_score (
           series_id, subgame_ordinal, challenge_id, state_hash, score,
           ledger_admission_seq, produced_by_admission_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          proof.seriesId,
          game.ordinal,
          game.challengeId,
          game.stateHash,
          game.score,
          game.ledgerAdmissionSeq,
          game.admissionId,
        ],
      );
      await this.#step(`after_subgame_${game.ordinal}` as F2BFaultPoint, client);
    }

    const categories: readonly ['EASY' | 'MEDIUM' | 'HARD' | 'ALL', number][] = [
      ['EASY', proof.easy],
      ['MEDIUM', proof.medium],
      ['HARD', proof.hard],
      ['ALL', proof.all],
    ];
    for (const [category, score] of categories) {
      await client.query(
        `INSERT INTO tournament_daily_result_category (series_id, category, score)
         VALUES ($1,$2,$3)`,
        [proof.seriesId, category, score],
      );
      await this.#step(`after_category_${category}` as F2BFaultPoint, client);
    }

    await client.query(
      `INSERT INTO tournament_on_time_badge
         (series_id, awarded, claim_started_at_ms, original_utc_date)
       VALUES ($1,$2,$3,$4::date)`,
      [proof.seriesId, proof.onTimeAwarded, proof.claimStartedAtMs, proof.originalUtcDate],
    );
    await this.#step('after_badge', client);

    await client.query(
      `INSERT INTO tournament_f2b_trusted_provenance
         (series_id, revision, verified_at_ms, provenance_seal)
       VALUES ($1,1,$2,$3)`,
      [proof.seriesId, proof.completedAtMs, seal],
    );
    await this.#step('after_provenance', client);

    const fenceWrite = await client.query(
      `UPDATE series_fence_state
       SET status = 'COMPLETED', results_published = TRUE
       WHERE series_key = $1 AND writer_generation = $2
         AND status IN ('ACTIVE', 'AWAIT_ADVANCE', 'COMPLETED')`,
      [proof.seriesId, input.writerGeneration],
    );
    if ((fenceWrite.rowCount ?? 0) !== 1) fail('SERIES_FENCE_MISSING');
    await this.#step('after_fence', client);

    const claimWrite = await client.query(
      `UPDATE tournament_daily_claim
       SET status = 'COMPLETED'
       WHERE series_id = $1 AND player_id = $2 AND status <> 'FORFEITED'`,
      [proof.seriesId, proof.playerId],
    );
    if ((claimWrite.rowCount ?? 0) !== 1) fail('FORFEITED_SERIES');
    await this.#step('after_claim', client);

    return { outcome: 'published', ...bodyFromProof(proof, input.commandIdempotencyKey, seal) };
  }

  async #step(point: F2BFaultPoint, client: pg.PoolClient): Promise<void> {
    if (this.#hooks.observe) await this.#hooks.observe(point, client);
    if (this.#hooks.inject) await this.#hooks.inject(point);
  }
}
