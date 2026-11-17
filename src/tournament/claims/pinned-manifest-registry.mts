/**
 * Server-pinned six-game daily manifest registry.
 * Clients never supply authoritative challenge JSON or digest.
 */
import { createHash } from 'node:crypto';

export interface PinnedSubgameChallenge {
  readonly ordinal: number;
  readonly challengeId: string;
  readonly generatorVersion: string;
  readonly contentVersion: string;
  readonly initialState: unknown;
}

export interface PinnedDailyManifest {
  readonly digest: string;
  readonly contentVersion: string;
  readonly subgames: readonly PinnedSubgameChallenge[];
}

export function digestManifestPayload(
  contentVersion: string,
  subgames: readonly PinnedSubgameChallenge[],
): string {
  if (subgames.length !== 6) {
    throw new Error('MANIFEST_MUST_HAVE_SIX_SUBGAMES');
  }
  const canonical = JSON.stringify({
    contentVersion,
    subgames: subgames.map((s) => ({
      ordinal: s.ordinal,
      challengeId: s.challengeId,
      generatorVersion: s.generatorVersion,
      contentVersion: s.contentVersion,
      initialState: s.initialState,
    })),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export class PinnedManifestRegistry {
  readonly #byDigest = new Map<string, PinnedDailyManifest>();
  readonly #activeDigest: string;

  constructor(manifests: readonly PinnedDailyManifest[], activeDigest: string) {
    if (manifests.length < 1) throw new Error('MANIFEST_REGISTRY_EMPTY');
    for (const m of manifests) {
      if (!/^[0-9a-f]{64}$/.test(m.digest)) throw new Error('MANIFEST_DIGEST_INVALID');
      if (m.subgames.length !== 6) throw new Error('MANIFEST_MUST_HAVE_SIX_SUBGAMES');
      const recomputed = digestManifestPayload(m.contentVersion, m.subgames);
      if (recomputed !== m.digest) throw new Error('MANIFEST_DIGEST_MISMATCH');
      this.#byDigest.set(m.digest, Object.freeze({ ...m, subgames: [...m.subgames] }));
    }
    if (!this.#byDigest.has(activeDigest)) throw new Error('ACTIVE_MANIFEST_UNKNOWN');
    this.#activeDigest = activeDigest;
  }

  activeDigest(): string {
    return this.#activeDigest;
  }

  get(digest: string): PinnedDailyManifest | null {
    return this.#byDigest.get(digest) ?? null;
  }

  requireActive(): PinnedDailyManifest {
    const m = this.#byDigest.get(this.#activeDigest);
    if (!m) throw new Error('ACTIVE_MANIFEST_UNKNOWN');
    return m;
  }
}
