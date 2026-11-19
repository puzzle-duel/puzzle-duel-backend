/**
 * Pinned CORE-001.v3 challenges for the local Tournament UAT.
 * New claims use the V4 progression. An already stored claim keeps its digest.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  digestManifestPayload,
  PinnedManifestRegistry,
  type PinnedDailyManifest,
  type PinnedSubgameChallenge,
} from '../claims/pinned-manifest-registry.mts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const legacyDirectory = join(root, 'docs/contracts/gameplay/v3/fixtures');
const v4Directory = join(root, 'docs/tournament/uat-challenges/v4');

const LEGACY_VERSION = 'pzd-42-uat';
export const UAT_ACTIVE_CONTENT_VERSION = 'pzd-42-v4';

const LEGACY_SLOTS: readonly { readonly ordinal: number; readonly file: string; readonly challengeId: string }[] = [
  { ordinal: 1, file: 'V3-02-single-wave.json', challengeId: 'uat-e1' },
  { ordinal: 2, file: 'V3-05-cascade-reopen.json', challengeId: 'uat-e2' },
  { ordinal: 3, file: 'V3-09-move-limit.json', challengeId: 'uat-e3' },
  { ordinal: 4, file: 'V3-03-multi-wave.json', challengeId: 'uat-m1' },
  { ordinal: 5, file: 'V3-09-move-limit.json', challengeId: 'uat-m2' },
  { ordinal: 6, file: 'V3-02-single-wave.json', challengeId: 'uat-h1' },
];

const V4_SLOTS: readonly { readonly ordinal: number; readonly file: string; readonly challengeId: string }[] = [
  { ordinal: 1, file: 'E1.json', challengeId: 'uat-e1' },
  { ordinal: 2, file: 'E2.json', challengeId: 'uat-e2' },
  { ordinal: 3, file: 'E3.json', challengeId: 'uat-e3' },
  { ordinal: 4, file: 'M1.json', challengeId: 'uat-m1' },
  { ordinal: 5, file: 'M2.json', challengeId: 'uat-m2' },
  { ordinal: 6, file: 'H1.json', challengeId: 'uat-h1' },
];

function manifestFrom(
  directory: string,
  slots: readonly { readonly ordinal: number; readonly file: string; readonly challengeId: string }[],
  contentVersion: string,
  generatorVersion: string,
): PinnedDailyManifest {
  const subgames: PinnedSubgameChallenge[] = slots.map((slot) => {
    const fixture = JSON.parse(readFileSync(join(directory, slot.file), 'utf8')) as {
      initialState: unknown;
    };
    return {
      ordinal: slot.ordinal,
      challengeId: slot.challengeId,
      generatorVersion,
      contentVersion,
      initialState: fixture.initialState,
    };
  });
  return {
    digest: digestManifestPayload(contentVersion, subgames),
    contentVersion,
    subgames,
  };
}

export function loadUatManifest(): PinnedManifestRegistry {
  const legacy = manifestFrom(
    legacyDirectory,
    LEGACY_SLOTS,
    LEGACY_VERSION,
    'pinned-core-001.v3-fixture',
  );
  const active = manifestFrom(v4Directory, V4_SLOTS, UAT_ACTIVE_CONTENT_VERSION, 'gen-001.v1');
  return new PinnedManifestRegistry([legacy, active], active.digest);
}
