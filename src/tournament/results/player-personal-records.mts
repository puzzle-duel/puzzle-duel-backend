/**
 * PZD-53: account-scoped personal best records.
 *
 * Practice: client-reported, maximum-only upsert (not competitive / not ranked).
 * Tournament: derived/projected from immutable F2-B verified_subgame_score rows
 * (individual board scores — never category or series aggregates).
 *
 * Does not grant badges, mutate leaderboards, or accept client tournament writes.
 */
import type pg from 'pg';

export const PERSONAL_RECORD_SOURCES = ['practice', 'tournament'] as const;
export type PersonalRecordSource = (typeof PERSONAL_RECORD_SOURCES)[number];

export const PERSONAL_RECORD_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type PersonalRecordDifficulty = (typeof PERSONAL_RECORD_DIFFICULTIES)[number];

export const PRACTICE_PROVENANCE = 'client_reported_practice' as const;
export const TOURNAMENT_PROVENANCE = 'tournament_f2b_verified_subgame' as const;

export const TOURNAMENT_RULES_VERSION = 'core-001.v3' as const;
export const TOURNAMENT_GENERATOR_VERSION = 'gen-001.v1' as const;

/** Same bound as tournament_verified_subgame_score / JSON safe integer. */
export const PERSONAL_RECORD_MAX_SCORE = 9007199254740991;
export const PRACTICE_SYNC_MAX_BATCH = 16;
export const PRACTICE_COMPLETION_ID_MAX = 128;
export const RULES_VERSION_MAX = 64;
export const GENERATOR_VERSION_MAX = 64;

const SUPPORTED_PRACTICE_RULES = new Set(['core-001.v1', 'core-001.v2', 'core-001.v3']);
const SUPPORTED_GENERATORS = new Set(['gen-001.v1']);

export interface PersonalRecordDto {
  readonly difficulty: PersonalRecordDifficulty;
  readonly source: PersonalRecordSource;
  readonly score: number;
  readonly rulesVersion: string;
  readonly generatorVersion: string;
  readonly achievedAt: string;
  readonly provenance: typeof PRACTICE_PROVENANCE | typeof TOURNAMENT_PROVENANCE;
  readonly completionId?: string;
}

export interface PersonalRecordsSnapshot {
  readonly playerScoped: true;
  readonly records: readonly PersonalRecordDto[];
  readonly schemaReady: boolean;
}

export interface PracticeSyncCandidate {
  readonly difficulty: PersonalRecordDifficulty;
  readonly score: number;
  readonly rulesVersion: string;
  readonly generatorVersion: string;
  readonly achievedAtMs: number;
  readonly completionId: string;
  readonly localRevision: number;
}

export interface PracticeSyncAck {
  readonly difficulty: PersonalRecordDifficulty;
  readonly rulesVersion: string;
  readonly generatorVersion: string;
  readonly completionId: string;
  readonly localRevision: number;
  readonly acceptedScore: number;
  readonly remoteScore: number;
  readonly improved: boolean;
}

export interface PracticeSyncResult {
  readonly ok: true;
  readonly snapshot: PersonalRecordsSnapshot;
  readonly acknowledgements: readonly PracticeSyncAck[];
}

export type PracticeSyncFailure =
  | { readonly ok: false; readonly status: 400; readonly error: 'MALFORMED_REQUEST' }
  | { readonly ok: false; readonly status: 503; readonly error: 'SCHEMA_NOT_READY' };

export function difficultyForSubgameOrdinal(ordinal: number): PersonalRecordDifficulty | null {
  if (!Number.isInteger(ordinal)) return null;
  if (ordinal >= 1 && ordinal <= 3) return 'easy';
  if (ordinal >= 4 && ordinal <= 5) return 'medium';
  if (ordinal === 6) return 'hard';
  return null;
}

function isDifficulty(value: unknown): value is PersonalRecordDifficulty {
  return typeof value === 'string'
    && (PERSONAL_RECORD_DIFFICULTIES as readonly string[]).includes(value);
}

function isSafeNonNegInt(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= PERSONAL_RECORD_MAX_SCORE;
}

function parseAchievedAtMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && value.length > 0 && value.length <= 40) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms >= 0) return Math.trunc(ms);
  }
  return null;
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function isUndefinedTable(err: unknown): boolean {
  return typeof err === 'object'
    && err !== null
    && 'code' in err
    && (err as { code?: string }).code === '42P01';
}

async function tableReady(client: pg.Pool | pg.PoolClient): Promise<boolean> {
  const result = await client.query<{ ready: boolean }>(
    `SELECT to_regclass('public.player_personal_best') IS NOT NULL AS ready`,
  );
  return result.rows[0]?.ready === true;
}

type StoredRow = {
  source: string;
  difficulty: string;
  rules_version: string;
  generator_version: string;
  score: string | number;
  achieved_at_ms: string | number;
  provenance: string;
  completion_id: string | null;
};

function rowToDto(row: StoredRow): PersonalRecordDto | null {
  if (!isDifficulty(row.difficulty)) return null;
  if (row.source !== 'practice' && row.source !== 'tournament') return null;
  if (
    row.provenance !== PRACTICE_PROVENANCE
    && row.provenance !== TOURNAMENT_PROVENANCE
  ) {
    return null;
  }
  const score = Number(row.score);
  const achievedAtMs = Number(row.achieved_at_ms);
  if (!isSafeNonNegInt(score) || !Number.isSafeInteger(achievedAtMs) || achievedAtMs < 0) {
    return null;
  }
  return {
    difficulty: row.difficulty,
    source: row.source,
    score,
    rulesVersion: String(row.rules_version),
    generatorVersion: String(row.generator_version),
    achievedAt: isoFromMs(achievedAtMs),
    provenance: row.provenance,
    ...(row.completion_id ? { completionId: row.completion_id } : {}),
  };
}

/**
 * Atomic maximum-only upsert. Equal/lower scores leave metadata unchanged.
 * Returns whether the stored score increased.
 */
export async function upsertPersonalBestMax(
  client: pg.PoolClient,
  input: {
    playerId: string;
    source: PersonalRecordSource;
    difficulty: PersonalRecordDifficulty;
    rulesVersion: string;
    generatorVersion: string;
    score: number;
    achievedAtMs: number;
    provenance: typeof PRACTICE_PROVENANCE | typeof TOURNAMENT_PROVENANCE;
    completionId?: string | null;
    seriesId?: string | null;
    subgameOrdinal?: number | null;
  },
): Promise<{ improved: boolean; remoteScore: number }> {
  if (!isSafeNonNegInt(input.score)) throw new Error('INVALID_SCORE');
  if (!Number.isSafeInteger(input.achievedAtMs) || input.achievedAtMs < 0) {
    throw new Error('INVALID_ACHIEVED_AT');
  }

  const result = await client.query<{ score: string | number; wrote: boolean }>(
    `WITH upserted AS (
       INSERT INTO public.player_personal_best AS t (
         player_id, source, difficulty, rules_version, generator_version,
         score, achieved_at_ms, provenance, completion_id, series_id, subgame_ordinal
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (player_id, source, difficulty, rules_version, generator_version)
       DO UPDATE SET
         score = EXCLUDED.score,
         achieved_at_ms = EXCLUDED.achieved_at_ms,
         recorded_at = clock_timestamp(),
         provenance = EXCLUDED.provenance,
         completion_id = EXCLUDED.completion_id,
         series_id = EXCLUDED.series_id,
         subgame_ordinal = EXCLUDED.subgame_ordinal
       WHERE EXCLUDED.score > t.score
       RETURNING t.score
     )
     SELECT
       COALESCE(
         (SELECT score FROM upserted),
         (SELECT score FROM public.player_personal_best
          WHERE player_id = $1 AND source = $2 AND difficulty = $3
            AND rules_version = $4 AND generator_version = $5),
         $6::bigint
       ) AS score,
       EXISTS (SELECT 1 FROM upserted) AS wrote`,
    [
      input.playerId,
      input.source,
      input.difficulty,
      input.rulesVersion,
      input.generatorVersion,
      input.score,
      input.achievedAtMs,
      input.provenance,
      input.completionId ?? null,
      input.seriesId ?? null,
      input.subgameOrdinal ?? null,
    ],
  );

  const remoteScore = Number(result.rows[0]?.score ?? input.score);
  return { improved: result.rows[0]?.wrote === true, remoteScore };
}

/**
 * Project one F2-B verified board into the personal-best table (max-only).
 * Must run inside the open F2-B publication transaction.
 */
export async function projectTournamentBoardPersonalBest(
  client: pg.PoolClient,
  input: {
    playerId: string;
    seriesId: string;
    subgameOrdinal: number;
    score: number;
    achievedAtMs: number;
    rulesVersion?: string;
    generatorVersion?: string;
  },
): Promise<void> {
  const difficulty = difficultyForSubgameOrdinal(input.subgameOrdinal);
  if (!difficulty) return;
  if (!(await tableReady(client))) return;

  await upsertPersonalBestMax(client, {
    playerId: input.playerId,
    source: 'tournament',
    difficulty,
    rulesVersion: input.rulesVersion ?? TOURNAMENT_RULES_VERSION,
    generatorVersion: input.generatorVersion ?? TOURNAMENT_GENERATOR_VERSION,
    score: input.score,
    achievedAtMs: input.achievedAtMs,
    provenance: TOURNAMENT_PROVENANCE,
    completionId: `${input.seriesId}:${input.subgameOrdinal}`,
    seriesId: input.seriesId,
    subgameOrdinal: input.subgameOrdinal,
  });
}

/** Allowlisted SQLSTATE classes that may be isolated behind a SAVEPOINT. */
const ISOLATABLE_PROJECTION_SQLSTATES = new Set([
  '42P01', // undefined_table
  '42703', // undefined_column
  '23514', // check_violation
  '23502', // not_null_violation
  '23505', // unique_violation (unexpected but non-fatal for competitive path)
  '22P02', // invalid_text_representation
  '22001', // string_data_right_truncation
]);

/** Connection / transaction-level failures must never be swallowed. */
const FATAL_PROJECTION_SQLSTATES = new Set([
  '08000', '08003', '08006', '08001', '08004',
  '57P01', '57P02', '57P03',
  '25P02', // in_failed_sql_transaction
  '25P03',
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

export type PersonalBestProjectionOutcome =
  | 'projected'
  | 'skipped_schema'
  | 'failed_isolated';

export interface PersonalBestProjectionDiagnostic {
  readonly code: 'tournament_record_projection_failed';
  readonly operation: 'tournament_record_projection';
  readonly ordinal: number;
  readonly sqlstate: string;
  readonly safeReason: string;
}

function sqlStateOf(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return 'XXXXX';
}

function safeProjectionReason(sqlstate: string): string {
  switch (sqlstate) {
    case '42P01': return 'undefined_table';
    case '42703': return 'undefined_column';
    case '23514': return 'check_violation';
    case '23502': return 'not_null_violation';
    case '23505': return 'unique_violation';
    case '22P02': return 'invalid_text_representation';
    case '22001': return 'string_data_right_truncation';
    default: return 'projection_error';
  }
}

export function isFatalPersonalBestProjectionError(err: unknown): boolean {
  const state = sqlStateOf(err);
  if (FATAL_PROJECTION_SQLSTATES.has(state)) return true;
  // Node driver connection termination often surfaces as Error without SQLSTATE.
  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    if (
      message.includes('connection terminated')
      || message.includes('client was closed')
      || message.includes('connection refused')
      || message.includes('cannot use a pool after calling end')
    ) {
      return true;
    }
  }
  return false;
}

export function isIsolatablePersonalBestProjectionError(err: unknown): boolean {
  if (isFatalPersonalBestProjectionError(err)) return false;
  const state = sqlStateOf(err);
  return ISOLATABLE_PROJECTION_SQLSTATES.has(state) || state === 'XXXXX';
}

/** Privacy-safe structured diagnostic — never includes player/series/score/PII. */
export function emitPersonalBestProjectionFailure(
  diagnostic: PersonalBestProjectionDiagnostic,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): void {
  write(JSON.stringify(diagnostic));
}

/**
 * Runs tournament personal-best projection inside a SAVEPOINT so recoverable
 * projection failures cannot abort the authoritative F2-B publication txn.
 * Connection/transaction-level failures are rethrown.
 */
export async function projectTournamentBoardPersonalBestIsolated(
  client: pg.PoolClient,
  input: {
    playerId: string;
    seriesId: string;
    subgameOrdinal: number;
    score: number;
    achievedAtMs: number;
    rulesVersion?: string;
    generatorVersion?: string;
  },
  options?: {
    onFailure?: (diagnostic: PersonalBestProjectionDiagnostic) => void;
  },
): Promise<PersonalBestProjectionOutcome> {
  if (!(await tableReady(client))) return 'skipped_schema';

  const savepoint = `pzd_pb_ord_${input.subgameOrdinal}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await projectTournamentBoardPersonalBest(client, input);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return 'projected';
  } catch (err) {
    if (isFatalPersonalBestProjectionError(err)) {
      // Do not attempt savepoint recovery — outer txn/connection is not usable.
      throw err;
    }
    if (!isIsolatablePersonalBestProjectionError(err)) {
      throw err;
    }
    const sqlstate = sqlStateOf(err);
    const diagnostic: PersonalBestProjectionDiagnostic = {
      code: 'tournament_record_projection_failed',
      operation: 'tournament_record_projection',
      ordinal: input.subgameOrdinal,
      sqlstate,
      safeReason: safeProjectionReason(sqlstate),
    };
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (rollbackErr) {
      // Savepoint cleanup failure is fatal for the surrounding transaction.
      throw rollbackErr;
    }
    if (options?.onFailure) options.onFailure(diagnostic);
    else emitPersonalBestProjectionFailure(diagnostic);
    return 'failed_isolated';
  }
}

/**
 * Derive tournament personal bests from immutable verified_subgame_score when
 * the projection table is absent or empty for this player.
 */
export async function deriveTournamentPersonalBests(
  pool: pg.Pool | pg.PoolClient,
  playerId: string,
): Promise<PersonalRecordDto[]> {
  const result = await pool.query<{
    difficulty: string;
    score: string | number;
    achieved_at_ms: string | number;
    completion_id: string | null;
    rules_version: string | null;
    generator_version: string | null;
  }>(
    `WITH boards AS (
       SELECT
         CASE
           WHEN score.subgame_ordinal BETWEEN 1 AND 3 THEN 'easy'
           WHEN score.subgame_ordinal BETWEEN 4 AND 5 THEN 'medium'
           WHEN score.subgame_ordinal = 6 THEN 'hard'
         END AS difficulty,
         score.score,
         completion.completed_at_ms AS achieved_at_ms,
         (completion.series_id::text || ':' || score.subgame_ordinal::text) AS completion_id,
         COALESCE(binding.rules_version, $2) AS rules_version,
         COALESCE(binding.generator_version, $3) AS generator_version,
         ROW_NUMBER() OVER (
           PARTITION BY
             CASE
               WHEN score.subgame_ordinal BETWEEN 1 AND 3 THEN 'easy'
               WHEN score.subgame_ordinal BETWEEN 4 AND 5 THEN 'medium'
               WHEN score.subgame_ordinal = 6 THEN 'hard'
             END
           ORDER BY score.score DESC, completion.completed_at_ms ASC, score.subgame_ordinal ASC
         ) AS rn
       FROM tournament_daily_series_completion AS completion
       INNER JOIN tournament_verified_subgame_score AS score
         ON score.series_id = completion.series_id
       LEFT JOIN trusted_challenge_binding AS binding
         ON binding.series_key = completion.series_id
        AND binding.subgame_ordinal = score.subgame_ordinal
       WHERE completion.player_id = $1
     )
     SELECT difficulty, score, achieved_at_ms, completion_id, rules_version, generator_version
     FROM boards
     WHERE rn = 1 AND difficulty IS NOT NULL`,
    [playerId, TOURNAMENT_RULES_VERSION, TOURNAMENT_GENERATOR_VERSION],
  );

  const out: PersonalRecordDto[] = [];
  for (const row of result.rows) {
    if (!isDifficulty(row.difficulty)) continue;
    const score = Number(row.score);
    const achievedAtMs = Number(row.achieved_at_ms);
    if (!isSafeNonNegInt(score) || !Number.isSafeInteger(achievedAtMs) || achievedAtMs < 0) {
      continue;
    }
    out.push({
      difficulty: row.difficulty,
      source: 'tournament',
      score,
      rulesVersion: String(row.rules_version ?? TOURNAMENT_RULES_VERSION),
      generatorVersion: String(row.generator_version ?? TOURNAMENT_GENERATOR_VERSION),
      achievedAt: isoFromMs(achievedAtMs),
      provenance: TOURNAMENT_PROVENANCE,
      ...(row.completion_id ? { completionId: row.completion_id } : {}),
    });
  }
  return out;
}

export async function loadPersonalRecordsSnapshot(
  pool: pg.Pool,
  playerId: string,
): Promise<PersonalRecordsSnapshot> {
  if (typeof playerId !== 'string' || playerId.length === 0) {
    throw new Error('PLAYER_ID_REQUIRED');
  }

  const ready = await tableReady(pool);
  const records: PersonalRecordDto[] = [];

  if (ready) {
    try {
      const stored = await pool.query<StoredRow>(
        `SELECT source, difficulty, rules_version, generator_version,
                score, achieved_at_ms, provenance, completion_id
         FROM public.player_personal_best
         WHERE player_id = $1
         ORDER BY source, difficulty`,
        [playerId],
      );
      for (const row of stored.rows) {
        const dto = rowToDto(row);
        if (dto) records.push(dto);
      }
    } catch (err) {
      if (!isUndefinedTable(err)) throw err;
    }
  }

  // Always merge derived tournament maxima so partial projections never hide
  // higher historical verified boards for a difficulty.
  try {
    const derived = await deriveTournamentPersonalBests(pool, playerId);
    const byDifficulty = new Map<string, PersonalRecordDto>();
    for (const record of records) {
      if (record.source === 'tournament') {
        byDifficulty.set(record.difficulty, record);
      }
    }
    for (const derivedRecord of derived) {
      const existing = byDifficulty.get(derivedRecord.difficulty);
      if (!existing || derivedRecord.score > existing.score) {
        byDifficulty.set(derivedRecord.difficulty, derivedRecord);
      }
    }
    const withoutTournament = records.filter((r) => r.source !== 'tournament');
    records.length = 0;
    records.push(...withoutTournament, ...byDifficulty.values());
  } catch (err) {
    // Historical tables may be absent in unit harnesses that only mock badges.
    if (!isUndefinedTable(err)) throw err;
  }

  return {
    playerScoped: true,
    records,
    schemaReady: ready,
  };
}

export function parsePracticeSyncBody(raw: unknown): PracticeSyncCandidate[] | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const records = (raw as { records?: unknown }).records;
  if (!Array.isArray(records) || records.length === 0 || records.length > PRACTICE_SYNC_MAX_BATCH) {
    return null;
  }

  const out: PracticeSyncCandidate[] = [];
  const seen = new Set<string>();
  for (const item of records) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
    const map = item as Record<string, unknown>;

    // Reject any attempt to write tournament authority through practice sync.
    if (map.source !== undefined && map.source !== 'practice') return null;
    if (map.provenance !== undefined && map.provenance !== PRACTICE_PROVENANCE) return null;
    if (map.seriesId !== undefined || map.subgameOrdinal !== undefined) return null;

    if (!isDifficulty(map.difficulty)) return null;
    if (!isSafeNonNegInt(map.score)) return null;

    const rulesVersion = typeof map.rulesVersion === 'string' ? map.rulesVersion.trim() : '';
    const generatorVersion = typeof map.generatorVersion === 'string'
      ? map.generatorVersion.trim()
      : '';
    if (
      rulesVersion.length === 0
      || rulesVersion.length > RULES_VERSION_MAX
      || !SUPPORTED_PRACTICE_RULES.has(rulesVersion)
    ) {
      return null;
    }
    if (
      generatorVersion.length === 0
      || generatorVersion.length > GENERATOR_VERSION_MAX
      || !SUPPORTED_GENERATORS.has(generatorVersion)
    ) {
      return null;
    }

    const achievedAtMs = parseAchievedAtMs(map.achievedAt ?? map.achievedAtMs);
    if (achievedAtMs === null) return null;

    const completionId = typeof map.completionId === 'string' ? map.completionId.trim() : '';
    if (
      completionId.length === 0
      || completionId.length > PRACTICE_COMPLETION_ID_MAX
    ) {
      return null;
    }

    const localRevision = map.localRevision;
    if (
      typeof localRevision !== 'number'
      || !Number.isSafeInteger(localRevision)
      || localRevision < 1
    ) {
      return null;
    }

    const key = `${map.difficulty}|${rulesVersion}|${generatorVersion}`;
    if (seen.has(key)) return null;
    seen.add(key);

    out.push({
      difficulty: map.difficulty,
      score: map.score,
      rulesVersion,
      generatorVersion,
      achievedAtMs,
      completionId,
      localRevision,
    });
  }
  return out;
}

export async function syncPracticePersonalRecords(
  pool: pg.Pool,
  playerId: string,
  rawBody: unknown,
): Promise<PracticeSyncResult | PracticeSyncFailure> {
  if (typeof playerId !== 'string' || playerId.length === 0) {
    throw new Error('PLAYER_ID_REQUIRED');
  }

  const candidates = parsePracticeSyncBody(rawBody);
  if (!candidates) {
    return { ok: false, status: 400, error: 'MALFORMED_REQUEST' };
  }

  const client = await pool.connect();
  const acknowledgements: PracticeSyncAck[] = [];
  try {
    if (!(await tableReady(client))) {
      return { ok: false, status: 503, error: 'SCHEMA_NOT_READY' };
    }

    await client.query('BEGIN');
    for (const candidate of candidates) {
      const before = await client.query<{ score: string | number }>(
        `SELECT score FROM public.player_personal_best
         WHERE player_id = $1 AND source = 'practice' AND difficulty = $2
           AND rules_version = $3 AND generator_version = $4
         FOR UPDATE`,
        [
          playerId,
          candidate.difficulty,
          candidate.rulesVersion,
          candidate.generatorVersion,
        ],
      );
      const priorScore = before.rowCount === 1 ? Number(before.rows[0]!.score) : null;

      await upsertPersonalBestMax(client, {
        playerId,
        source: 'practice',
        difficulty: candidate.difficulty,
        rulesVersion: candidate.rulesVersion,
        generatorVersion: candidate.generatorVersion,
        score: candidate.score,
        achievedAtMs: candidate.achievedAtMs,
        provenance: PRACTICE_PROVENANCE,
        completionId: candidate.completionId,
      });

      const after = await client.query<{ score: string | number }>(
        `SELECT score FROM public.player_personal_best
         WHERE player_id = $1 AND source = 'practice' AND difficulty = $2
           AND rules_version = $3 AND generator_version = $4`,
        [
          playerId,
          candidate.difficulty,
          candidate.rulesVersion,
          candidate.generatorVersion,
        ],
      );
      const remoteScore = Number(after.rows[0]!.score);
      acknowledgements.push({
        difficulty: candidate.difficulty,
        rulesVersion: candidate.rulesVersion,
        generatorVersion: candidate.generatorVersion,
        completionId: candidate.completionId,
        localRevision: candidate.localRevision,
        acceptedScore: candidate.score,
        remoteScore,
        improved: priorScore === null || remoteScore > priorScore,
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    if (isUndefinedTable(err)) {
      return { ok: false, status: 503, error: 'SCHEMA_NOT_READY' };
    }
    throw err;
  } finally {
    client.release();
  }

  const snapshot = await loadPersonalRecordsSnapshot(pool, playerId);
  return { ok: true, snapshot, acknowledgements };
}

/**
 * One-shot backfill of tournament projections from historical verified boards.
 * Idempotent max-only; safe to re-run.
 */
export async function backfillTournamentPersonalBests(
  pool: pg.Pool,
  playerId?: string,
): Promise<number> {
  if (!(await tableReady(pool))) return 0;
  const client = await pool.connect();
  let updated = 0;
  try {
    await client.query('BEGIN');
    const result = await client.query<{
      player_id: string;
      series_id: string;
      subgame_ordinal: number;
      score: string | number;
      achieved_at_ms: string | number;
      rules_version: string | null;
      generator_version: string | null;
    }>(
      `SELECT completion.player_id,
              completion.series_id,
              score.subgame_ordinal,
              score.score,
              completion.completed_at_ms AS achieved_at_ms,
              binding.rules_version,
              binding.generator_version
       FROM tournament_daily_series_completion AS completion
       INNER JOIN tournament_verified_subgame_score AS score
         ON score.series_id = completion.series_id
       LEFT JOIN trusted_challenge_binding AS binding
         ON binding.series_key = completion.series_id
        AND binding.subgame_ordinal = score.subgame_ordinal
       WHERE ($1::text IS NULL OR completion.player_id = $1)
       ORDER BY completion.completed_at_ms ASC, score.subgame_ordinal ASC`,
      [playerId ?? null],
    );
    for (const row of result.rows) {
      await projectTournamentBoardPersonalBest(client, {
        playerId: row.player_id,
        seriesId: row.series_id,
        subgameOrdinal: Number(row.subgame_ordinal),
        score: Number(row.score),
        achievedAtMs: Number(row.achieved_at_ms),
        rulesVersion: row.rules_version ?? TOURNAMENT_RULES_VERSION,
        generatorVersion: row.generator_version ?? TOURNAMENT_GENERATOR_VERSION,
      });
      updated += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
  return updated;
}
