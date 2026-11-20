/**
 * PZD-48 deterministic UTC date challenge generation; no player or client seed.
 * Persistence and claim wiring remain a separate fail-closed integration gate.
 */
import { createHash } from 'node:crypto';
import { generateChallenge, type Profile, type Challenge } from '../../generator.mts';
import {
  digestManifestPayload,
  type PinnedDailyManifest,
  type PinnedSubgameChallenge,
} from '../claims/pinned-manifest-registry.mts';

const DAILY_VERSION = 'pzd-daily-v1';
const GENERATOR_VERSION = 'gen-001.v1';
const PROFILES: readonly Profile[] = ['easy', 'easy', 'easy', 'medium', 'medium', 'hard'];
const ATTEMPTS = 256;

function validUtcDate(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const millis = Date.parse(day + 'T00:00:00.000Z');
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === day;
}
function previousDay(day: string): string {
  return new Date(Date.parse(day + 'T00:00:00.000Z') - 86400000).toISOString().slice(0, 10);
}
function seed(day: string, ordinal: number, attempt: number): number {
  return createHash('sha256').update(
    ['PZD-DAILY-001', DAILY_VERSION, GENERATOR_VERSION, day, ordinal, attempt].join('|'),
  ).digest().readUInt32BE(0);
}
function toV3(challenge: Challenge): Record<string, unknown> {
  return {
    rulesVersion: 'core-001.v3',
    boardSize: challenge.config.boardSize,
    moveLimit: challenge.config.moveLimit,
    blocked: challenge.blocked.map(([r, c]) => [r, c]),
    cells: challenge.cells.map(row => row.map(p => p ? { ...p } : null)),
    offers: challenge.offers.map(p => ({ kind: 'piece', ...p })),
    futurePieces: challenge.futurePieces.map(p => ({ ...p })),
    turnsUsed: 0, score: 0, status: 'in_progress', terminalReason: null,
  };
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function generateUtcDailyManifest(
  utcDate: string,
  pinnedNeighbors: readonly PinnedDailyManifest[] = [],
): PinnedDailyManifest {
  if (!validUtcDate(utcDate)) throw new Error('DAILY_MANIFEST_INVALID_DATE');
  const seen = new Set<string>();
  const contentVersion = DAILY_VERSION + ':' + utcDate;
  const subgames: PinnedSubgameChallenge[] = PROFILES.map((profile, index) => {
    const ordinal = index + 1;
    // Reject identical same-slot board/supply from the preceding UTC day.
    const prior = generateChallenge(profile, seed(previousDay(utcDate), ordinal, 0));
    if (prior.ok) seen.add(fingerprint(toV3(prior.challenge)));
    for (const neighbor of pinnedNeighbors) {
      const comparison = neighbor.subgames[index];
      if (neighbor.subgames.length !== 6 || !comparison || comparison.ordinal !== ordinal) {
        throw new Error('DAILY_MANIFEST_NEIGHBOR_CORRUPT');
      }
      seen.add(fingerprint(comparison.initialState));
    }
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const candidate = generateChallenge(profile, seed(utcDate, ordinal, attempt));
      if (!candidate.ok) continue;
      const initialState = toV3(candidate.challenge);
      const hash = fingerprint(initialState);
      if (seen.has(hash)) continue;
      seen.add(hash);
      return {
        ordinal, challengeId: 'daily-' + utcDate + '-' + ordinal,
        generatorVersion: GENERATOR_VERSION, contentVersion, initialState,
      };
    }
    throw new Error('DAILY_MANIFEST_GENERATION_EXHAUSTED');
  });
  return { digest: digestManifestPayload(contentVersion, subgames), contentVersion, subgames };
}
