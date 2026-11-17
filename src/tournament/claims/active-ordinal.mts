/**
 * Canonical active subgame ordinal (E1→E2→E3→M1→M2→H1 = 1..6)
 * derived only from authoritative PostgreSQL fence + snapshots.
 * Clients never supply ordinal authority.
 */
import type pg from 'pg';

export async function resolveActiveSubgameOrdinal(
  db: pg.Pool | pg.PoolClient,
  seriesKey: string,
  playerId: string,
): Promise<number> {
  const fence = await db.query(
    `SELECT status FROM series_fence_state WHERE series_key = $1`,
    [seriesKey],
  );
  if (!fence.rowCount) return 1;
  const status = String(fence.rows[0].status);
  if (status === 'COMPLETED' || status === 'FORFEITED') {
    return 6;
  }

  const ended = await db.query(
    `SELECT count(*)::int AS n
     FROM authoritative_game_snapshot
     WHERE series_key = $1 AND player_id = $2 AND status = 'ended'`,
    [seriesKey, playerId],
  );
  const endedCount = Number(ended.rows[0].n);
  if (status === 'AWAIT_ADVANCE') {
    // Advance still targets the just-completed ordinal.
    return Math.min(Math.max(endedCount, 1), 6);
  }
  // ACTIVE: next playable ordinal is endedCount + 1.
  return Math.min(Math.max(endedCount + 1, 1), 6);
}
