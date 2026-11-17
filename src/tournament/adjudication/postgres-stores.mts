/**
 * PostgreSQL stores for trusted gameplay (ledger, snapshots, challenges).
 * Used by PostgresTrustedUnitOfWork under a single connection/transaction.
 */

import type pg from 'pg';
import {
  parseInitialGameState,
  type GameState,
} from '../../engine/core001v3/index.mts';
import type {
  AcceptedMoveLedger,
  AcceptedMoveLedgerEntry,
  AuthoritativeGameSnapshot,
  AuthoritativeSnapshotStore,
} from './move-ledger.mts';
import type {
  TrustedChallengeBinding,
  TrustedChallengeStore,
} from './trusted-challenge.mts';

export const TRUSTED_GAMEPLAY_DDL = `
CREATE TABLE IF NOT EXISTS trusted_challenge_binding (
  series_key TEXT NOT NULL,
  player_id TEXT NOT NULL,
  subgame_ordinal INT NOT NULL,
  challenge_id TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  generator_version TEXT NOT NULL,
  content_version TEXT NOT NULL,
  initial_state_digest TEXT NOT NULL,
  initial_state_json JSONB NOT NULL,
  assigned_at_ms BIGINT NOT NULL,
  PRIMARY KEY (series_key, player_id, subgame_ordinal)
);

CREATE TABLE IF NOT EXISTS accepted_move_ledger (
  series_key TEXT NOT NULL,
  player_id TEXT NOT NULL,
  subgame_ordinal INT NOT NULL,
  challenge_id TEXT NOT NULL,
  admission_id UUID NOT NULL,
  admission_seq BIGINT NOT NULL,
  board_revision_after BIGINT NOT NULL,
  move_json JSONB NOT NULL,
  score_delta BIGINT NOT NULL,
  score_after BIGINT NOT NULL,
  state_hash_before TEXT NOT NULL,
  state_hash_after TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  trusted_received_at_ms BIGINT NOT NULL,
  terminal_after BOOLEAN NOT NULL,
  terminal_reason TEXT NULL,
  PRIMARY KEY (series_key, player_id, subgame_ordinal, board_revision_after),
  UNIQUE (series_key, player_id, subgame_ordinal, admission_id)
);

CREATE TABLE IF NOT EXISTS authoritative_game_snapshot (
  series_key TEXT NOT NULL,
  player_id TEXT NOT NULL,
  subgame_ordinal INT NOT NULL,
  challenge_id TEXT NOT NULL,
  board_revision BIGINT NOT NULL,
  move_cursor INT NOT NULL,
  state_hash TEXT NOT NULL,
  score BIGINT NOT NULL,
  status TEXT NOT NULL,
  terminal_reason TEXT NULL,
  state_json JSONB NOT NULL,
  ledger_admission_seq BIGINT NOT NULL,
  writer_generation BIGINT NOT NULL,
  produced_by_admission_id UUID NULL,
  PRIMARY KEY (series_key, player_id, subgame_ordinal)
);
`;

/** Optional ALTER for admission result envelope (P1-E04). */
export const ADMISSION_RESULT_DDL = `
ALTER TABLE command_admission_journal
  ADD COLUMN IF NOT EXISTS result_json JSONB NULL;
`;

type Queryable = pg.Pool | pg.PoolClient;

export class PostgresTrustedChallengeStore implements TrustedChallengeStore {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async migrate(): Promise<void> {
    if ('query' in this.#db) {
      await this.#db.query(TRUSTED_GAMEPLAY_DDL);
    }
  }

  async put(binding: TrustedChallengeBinding): Promise<void> {
    await this.#db.query(
      `INSERT INTO trusted_challenge_binding (
         series_key, player_id, subgame_ordinal, challenge_id,
         rules_version, generator_version, content_version,
         initial_state_digest, initial_state_json, assigned_at_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       ON CONFLICT (series_key, player_id, subgame_ordinal) DO NOTHING`,
      [
        binding.seriesKey,
        binding.playerId,
        binding.subgameOrdinal,
        binding.challengeId,
        binding.rulesVersion,
        binding.generatorVersion,
        binding.contentVersion,
        binding.initialStateDigest,
        JSON.stringify(binding.initialState),
        binding.assignedAt.getTime(),
      ],
    );
  }

  async get(
    seriesKey: string,
    playerId: string,
    subgameOrdinal: number,
  ): Promise<TrustedChallengeBinding | null> {
    const res = await this.#db.query(
      `SELECT * FROM trusted_challenge_binding
       WHERE series_key = $1 AND player_id = $2 AND subgame_ordinal = $3`,
      [seriesKey, playerId, subgameOrdinal],
    );
    if (!res.rowCount) return null;
    return mapChallenge(res.rows[0]);
  }
}

export class PostgresAcceptedMoveLedger implements AcceptedMoveLedger {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async append(entry: AcceptedMoveLedgerEntry): Promise<void> {
    await this.#db.query(
      `INSERT INTO accepted_move_ledger (
         series_key, player_id, subgame_ordinal, challenge_id,
         admission_id, admission_seq, board_revision_after, move_json,
         score_delta, score_after, state_hash_before, state_hash_after,
         rules_version, trusted_received_at_ms, terminal_after, terminal_reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        entry.seriesKey,
        entry.playerId,
        entry.subgameOrdinal,
        entry.challengeId,
        entry.admissionId,
        entry.admissionSeq,
        entry.boardRevisionAfter,
        JSON.stringify({
          offerIndex: entry.move.offerIndex,
          tap: { row: entry.move.tap.row, column: entry.move.tap.column },
        }),
        entry.scoreDelta,
        entry.scoreAfter,
        entry.stateHashBefore,
        entry.stateHashAfter,
        entry.rulesVersion,
        entry.trustedReceivedAt.getTime(),
        entry.terminalAfter,
        entry.terminalReason,
      ],
    );
  }

  async list(
    seriesKey: string,
    playerId: string,
    subgameOrdinal: number,
  ): Promise<AcceptedMoveLedgerEntry[]> {
    const res = await this.#db.query(
      `SELECT * FROM accepted_move_ledger
       WHERE series_key = $1 AND player_id = $2 AND subgame_ordinal = $3
       ORDER BY board_revision_after ASC`,
      [seriesKey, playerId, subgameOrdinal],
    );
    return res.rows.map(mapLedger);
  }

  async latestWatermark(
    seriesKey: string,
    playerId: string,
    subgameOrdinal: number,
  ): Promise<{ boardRevision: number; stateHash: string; admissionSeq: number } | null> {
    const res = await this.#db.query(
      `SELECT board_revision_after, state_hash_after, admission_seq
       FROM accepted_move_ledger
       WHERE series_key = $1 AND player_id = $2 AND subgame_ordinal = $3
       ORDER BY board_revision_after DESC LIMIT 1`,
      [seriesKey, playerId, subgameOrdinal],
    );
    if (!res.rowCount) return null;
    const row = res.rows[0];
    return {
      boardRevision: Number(row.board_revision_after),
      stateHash: String(row.state_hash_after),
      admissionSeq: Number(row.admission_seq),
    };
  }
}

export class PostgresAuthoritativeSnapshotStore implements AuthoritativeSnapshotStore {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async get(
    seriesKey: string,
    playerId: string,
    subgameOrdinal: number,
  ): Promise<AuthoritativeGameSnapshot | null> {
    const res = await this.#db.query(
      `SELECT * FROM authoritative_game_snapshot
       WHERE series_key = $1 AND player_id = $2 AND subgame_ordinal = $3`,
      [seriesKey, playerId, subgameOrdinal],
    );
    if (!res.rowCount) return null;
    return mapSnapshot(res.rows[0]);
  }

  async put(snapshot: AuthoritativeGameSnapshot): Promise<void> {
    await this.#db.query(
      `INSERT INTO authoritative_game_snapshot (
         series_key, player_id, subgame_ordinal, challenge_id,
         board_revision, move_cursor, state_hash, score, status,
         terminal_reason, state_json, ledger_admission_seq,
         writer_generation, produced_by_admission_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
       ON CONFLICT (series_key, player_id, subgame_ordinal) DO UPDATE SET
         challenge_id = EXCLUDED.challenge_id,
         board_revision = EXCLUDED.board_revision,
         move_cursor = EXCLUDED.move_cursor,
         state_hash = EXCLUDED.state_hash,
         score = EXCLUDED.score,
         status = EXCLUDED.status,
         terminal_reason = EXCLUDED.terminal_reason,
         state_json = EXCLUDED.state_json,
         ledger_admission_seq = EXCLUDED.ledger_admission_seq,
         writer_generation = EXCLUDED.writer_generation,
         produced_by_admission_id = EXCLUDED.produced_by_admission_id`,
      [
        snapshot.seriesKey,
        snapshot.playerId,
        snapshot.subgameOrdinal,
        snapshot.challengeId,
        snapshot.boardRevision,
        snapshot.moveCursor,
        snapshot.stateHash,
        snapshot.score,
        snapshot.status,
        snapshot.terminalReason,
        JSON.stringify(snapshot.state),
        snapshot.ledgerAdmissionSeq,
        snapshot.writerGeneration,
        snapshot.producedByAdmissionId,
      ],
    );
  }
}

function mapChallenge(row: Record<string, unknown>): TrustedChallengeBinding {
  const stateJson =
    typeof row.initial_state_json === 'string'
      ? JSON.parse(row.initial_state_json)
      : row.initial_state_json;
  return {
    seriesKey: String(row.series_key),
    playerId: String(row.player_id),
    subgameOrdinal: Number(row.subgame_ordinal),
    challengeId: String(row.challenge_id),
    rulesVersion: 'core-001.v3',
    generatorVersion: String(row.generator_version),
    contentVersion: String(row.content_version),
    initialStateDigest: String(row.initial_state_digest),
    initialState: parseInitialGameState(stateJson),
    assignedAt: new Date(Number(row.assigned_at_ms)),
  };
}

function mapLedger(row: Record<string, unknown>): AcceptedMoveLedgerEntry {
  const moveJson =
    typeof row.move_json === 'string' ? JSON.parse(row.move_json) : row.move_json;
  const move = moveJson as {
    offerIndex: 0 | 1 | 2;
    tap: { row: number; column: number };
  };
  return {
    seriesKey: String(row.series_key),
    playerId: String(row.player_id),
    subgameOrdinal: Number(row.subgame_ordinal),
    challengeId: String(row.challenge_id),
    admissionId: String(row.admission_id),
    admissionSeq: Number(row.admission_seq),
    boardRevisionAfter: Number(row.board_revision_after),
    move: {
      offerIndex: move.offerIndex,
      tap: { row: move.tap.row, column: move.tap.column },
    },
    scoreDelta: Number(row.score_delta),
    scoreAfter: Number(row.score_after),
    stateHashBefore: String(row.state_hash_before),
    stateHashAfter: String(row.state_hash_after),
    rulesVersion: 'core-001.v3',
    trustedReceivedAt: new Date(Number(row.trusted_received_at_ms)),
    terminalAfter: Boolean(row.terminal_after),
    terminalReason: row.terminal_reason == null ? null : String(row.terminal_reason),
  };
}

function mapSnapshot(row: Record<string, unknown>): AuthoritativeGameSnapshot {
  const stateJson =
    typeof row.state_json === 'string' ? JSON.parse(row.state_json) : row.state_json;
  return {
    seriesKey: String(row.series_key),
    playerId: String(row.player_id),
    subgameOrdinal: Number(row.subgame_ordinal),
    challengeId: String(row.challenge_id),
    boardRevision: Number(row.board_revision),
    moveCursor: Number(row.move_cursor),
    stateHash: String(row.state_hash),
    score: Number(row.score),
    status: String(row.status) as 'in_progress' | 'ended',
    terminalReason: row.terminal_reason == null ? null : String(row.terminal_reason),
    state: stateJson as GameState,
    ledgerAdmissionSeq: Number(row.ledger_admission_seq),
    writerGeneration: Number(row.writer_generation),
    producedByAdmissionId:
      row.produced_by_admission_id == null
        ? null
        : String(row.produced_by_admission_id),
  };
}
