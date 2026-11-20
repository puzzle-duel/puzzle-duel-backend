/**
 * PZD-48 candidate immutable day->six-challenge storage.
 * Versioned PostgreSQL migration 0012 installs the table/immutable trigger.
 * Only feature-gated UAT claim/publication paths use this store.
 */
import type pg from 'pg';
import {
  digestManifestPayload,
  type PinnedDailyManifest,
} from '../claims/pinned-manifest-registry.mts';
import { generateUtcDailyManifest } from './utc-daily-manifest.mts';

// Table and immutable trigger are installed by versioned migration 0012.

function parseStored(text: string, digest: string, version: string): PinnedDailyManifest {
  const payload: unknown = JSON.parse(text);
  if (!payload || typeof payload !== 'object') throw new Error('DAILY_MANIFEST_CORRUPT');
  const manifest = payload as PinnedDailyManifest;
  if (manifest.digest !== digest || manifest.contentVersion !== version ||
      !Array.isArray(manifest.subgames) || manifest.subgames.length !== 6 ||
      digestManifestPayload(manifest.contentVersion, manifest.subgames) !== manifest.digest) {
    throw new Error('DAILY_MANIFEST_CORRUPT');
  }
  return manifest;
}

/** Call inside an already-open transaction, after the DB clock and weekly lock. */
export async function selectOrCreateUtcDailyManifest(
  client: pg.PoolClient,
  utcDate: string,
): Promise<PinnedDailyManifest> {
  // Validate the caller's exact UTC date before database access.
  generateUtcDailyManifest(utcDate);
  const adjacent = await client.query<{
    manifest_digest: string; content_version: string; manifest_text: string;
  }>(
    `SELECT manifest_digest, content_version, manifest_text
     FROM tournament_utc_daily_manifest
     WHERE utc_date = ($1::date - 1) OR utc_date = ($1::date + 1)
     FOR SHARE`,
    [utcDate],
  );
  const pinnedNeighbors = adjacent.rows.map(row => parseStored(
    row.manifest_text, row.manifest_digest.trim(), row.content_version,
  ));
  const proposed = generateUtcDailyManifest(utcDate, pinnedNeighbors);
  await client.query(
    `INSERT INTO tournament_utc_daily_manifest
      (utc_date, manifest_digest, content_version, manifest_text)
     VALUES ($1::date,$2,$3,$4)
     ON CONFLICT (utc_date) DO NOTHING`,
    [utcDate, proposed.digest, proposed.contentVersion, JSON.stringify(proposed)],
  );
  const result = await client.query<{
    manifest_digest: string; content_version: string; manifest_text: string;
  }>(
    `SELECT manifest_digest, content_version, manifest_text
     FROM tournament_utc_daily_manifest WHERE utc_date=$1::date FOR SHARE`,
    [utcDate],
  );
  if (result.rowCount !== 1) throw new Error('DAILY_MANIFEST_UNAVAILABLE');
  const row = result.rows[0]!;
  return parseStored(row.manifest_text, row.manifest_digest.trim(), row.content_version);
}

export async function findUtcDailyManifestByDigest(
  client: pg.Pool | pg.PoolClient,
  digest: string,
): Promise<PinnedDailyManifest | null> {
  if (!/^[a-f0-9]{64}$/.test(digest)) return null;
  const result = await client.query<{
    manifest_digest: string; content_version: string; manifest_text: string;
  }>(
    `SELECT manifest_digest, content_version, manifest_text
     FROM tournament_utc_daily_manifest WHERE manifest_digest=$1`,
    [digest],
  );
  if (result.rowCount !== 1) return null;
  const row = result.rows[0]!;
  return parseStored(row.manifest_text, row.manifest_digest.trim(), row.content_version);
}
