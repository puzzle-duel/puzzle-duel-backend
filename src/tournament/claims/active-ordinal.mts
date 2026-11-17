/**
 * Canonical active subgame ordinal (E1→E2→E3→M1→M2→H1 = 1..6)
 * derived only from authoritative PostgreSQL fence + snapshots.
 * Clients never supply ordinal authority.
 *
 * P1-R03: fail closed on missing fence, gaps, or inconsistent snapshot /
 * challenge bindings — never invent ordinal 1.
 */
import type pg from 'pg';

export class OrdinalIntegrityError extends Error {
  readonly code = 'SERIES_STATE_CORRUPT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'OrdinalIntegrityError';
  }
}

const EXPECTED_ORDINALS = [1, 2, 3, 4, 5, 6] as const;

export async function resolveActiveSubgameOrdinal(
  db: pg.Pool | pg.PoolClient,
  seriesKey: string,
  playerId: string,
): Promise<number> {
  const fence = await db.query(
    `SELECT status FROM series_fence_state WHERE series_key = $1`,
    [seriesKey],
  );
  if (!fence.rowCount) {
    throw new OrdinalIntegrityError('fence_missing');
  }
  const status = String(fence.rows[0].status);

  const bindings = await db.query(
    `SELECT subgame_ordinal, challenge_id
     FROM trusted_challenge_binding
     WHERE series_key = $1 AND player_id = $2
     ORDER BY subgame_ordinal ASC`,
    [seriesKey, playerId],
  );
  if (bindings.rowCount !== 6) {
    throw new OrdinalIntegrityError('challenge_bindings_incomplete');
  }
  for (let i = 0; i < 6; i++) {
    const row = bindings.rows[i];
    if (Number(row.subgame_ordinal) !== EXPECTED_ORDINALS[i]) {
      throw new OrdinalIntegrityError('challenge_ordinal_gap');
    }
  }
  const pinnedByOrdinal = new Map<number, string>();
  for (const row of bindings.rows) {
    pinnedByOrdinal.set(Number(row.subgame_ordinal), String(row.challenge_id));
  }

  const snaps = await db.query(
    `SELECT subgame_ordinal, status, challenge_id
     FROM authoritative_game_snapshot
     WHERE series_key = $1 AND player_id = $2
     ORDER BY subgame_ordinal ASC`,
    [seriesKey, playerId],
  );

  const ended: number[] = [];
  const inProgress: number[] = [];
  let prevOrdinal = 0;
  for (const row of snaps.rows) {
    const ordinal = Number(row.subgame_ordinal);
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 6) {
      throw new OrdinalIntegrityError('snapshot_ordinal_out_of_range');
    }
    if (ordinal <= prevOrdinal) {
      throw new OrdinalIntegrityError('snapshot_ordinal_duplicate');
    }
    // Snapshots must form a contiguous prefix from 1 (no holes).
    if (ordinal !== prevOrdinal + 1) {
      throw new OrdinalIntegrityError('snapshot_ordinal_gap');
    }
    prevOrdinal = ordinal;

    const pinned = pinnedByOrdinal.get(ordinal);
    if (!pinned || pinned !== String(row.challenge_id)) {
      throw new OrdinalIntegrityError('snapshot_challenge_mismatch');
    }

    const snapStatus = String(row.status);
    if (snapStatus === 'ended') ended.push(ordinal);
    else if (snapStatus === 'in_progress') inProgress.push(ordinal);
    else throw new OrdinalIntegrityError('snapshot_status_unknown');
  }

  // Ended subgames must be a contiguous prefix 1..N.
  for (let i = 0; i < ended.length; i++) {
    if (ended[i] !== i + 1) {
      throw new OrdinalIntegrityError('ended_not_contiguous_prefix');
    }
  }
  if (inProgress.length > 1) {
    throw new OrdinalIntegrityError('multiple_in_progress');
  }

  if (status === 'COMPLETED' || status === 'FORFEITED') {
    if (status === 'COMPLETED' && ended.length !== 6) {
      throw new OrdinalIntegrityError('completed_without_six_ended');
    }
    if (inProgress.length !== 0) {
      throw new OrdinalIntegrityError('terminal_with_in_progress');
    }
    return 6;
  }

  if (status === 'AWAIT_ADVANCE') {
    if (inProgress.length !== 0) {
      throw new OrdinalIntegrityError('await_advance_with_in_progress');
    }
    if (ended.length < 1 || ended.length > 5) {
      throw new OrdinalIntegrityError('await_advance_ended_bounds');
    }
    if (snaps.rowCount !== ended.length) {
      throw new OrdinalIntegrityError('await_advance_extra_snapshots');
    }
    // Advance still targets the just-completed ordinal.
    return ended.length;
  }

  if (status !== 'ACTIVE') {
    throw new OrdinalIntegrityError('fence_status_unknown');
  }

  // ACTIVE: exactly one in_progress at endedCount+1; snapshots = ended + that one.
  const expectedActive = ended.length + 1;
  if (expectedActive > 6) {
    throw new OrdinalIntegrityError('active_past_terminal');
  }
  if (inProgress.length !== 1 || inProgress[0] !== expectedActive) {
    throw new OrdinalIntegrityError('active_in_progress_mismatch');
  }
  if (snaps.rowCount !== expectedActive) {
    throw new OrdinalIntegrityError('active_snapshot_count_mismatch');
  }
  return expectedActive;
}
