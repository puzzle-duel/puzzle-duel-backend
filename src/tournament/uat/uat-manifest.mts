/**
 * Pinned CORE-001.v3 challenges for the local Tournament UAT.
 * These are the versioned contract fixtures, not a client-supplied board.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  digestManifestPayload,
  PinnedManifestRegistry,
  type PinnedSubgameChallenge,
} from '../claims/pinned-manifest-registry.mts';

const fixtureDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/contracts/gameplay/v3/fixtures',
);

const CONTENT_VERSION = 'pzd-42-uat';

const SLOTS: readonly { readonly ordinal: number; readonly file: string; readonly challengeId: string }[] = [
  { ordinal: 1, file: 'V3-02-single-wave.json', challengeId: 'uat-e1' },
  { ordinal: 2, file: 'V3-05-cascade-reopen.json', challengeId: 'uat-e2' },
  { ordinal: 3, file: 'V3-09-move-limit.json', challengeId: 'uat-e3' },
  { ordinal: 4, file: 'V3-03-multi-wave.json', challengeId: 'uat-m1' },
  { ordinal: 5, file: 'V3-09-move-limit.json', challengeId: 'uat-m2' },
  { ordinal: 6, file: 'V3-02-single-wave.json', challengeId: 'uat-h1' },
];

export function loadUatManifest(): PinnedManifestRegistry {
  const subgames: PinnedSubgameChallenge[] = SLOTS.map((slot) => {
    const fixture = JSON.parse(readFileSync(join(fixtureDirectory, slot.file), 'utf8')) as {
      initialState: unknown;
    };
    return {
      ordinal: slot.ordinal,
      challengeId: slot.challengeId,
      generatorVersion: 'pinned-core-001.v3-fixture',
      contentVersion: CONTENT_VERSION,
      initialState: fixture.initialState,
    };
  });
  const digest = digestManifestPayload(CONTENT_VERSION, subgames);
  return new PinnedManifestRegistry(
    [{ digest, contentVersion: CONTENT_VERSION, subgames }],
    digest,
  );
}
