import { createHash } from 'node:crypto';
import {
  parseInitialGameState,
  stateHashV3,
  stateToJson,
  type GameState,
} from '../../engine/core001v3/index.mts';

/**
 * Server-owned immutable ranked challenge binding.
 * Clients never supply the ranked initialState.
 */
export interface TrustedChallengeBinding {
  seriesKey: string;
  playerId: string;
  /** Subgame ordinal 1..6 (E1..H1). */
  subgameOrdinal: number;
  challengeId: string;
  rulesVersion: 'core-001.v3';
  generatorVersion: string;
  contentVersion: string;
  /** Canonical SHA-256 of the trusted initial GameState JSON. */
  initialStateDigest: string;
  /** Immutable trusted initial GameState (server-owned). */
  initialState: GameState;
  assignedAt: Date;
}

export interface TrustedChallengeStore {
  put(binding: TrustedChallengeBinding): Promise<void>;
  get(
    seriesKey: string,
    playerId: string,
    subgameOrdinal: number,
  ): Promise<TrustedChallengeBinding | null>;
}

export class MemoryTrustedChallengeStore implements TrustedChallengeStore {
  #rows = new Map<string, TrustedChallengeBinding>();

  async put(binding: TrustedChallengeBinding): Promise<void> {
    this.#rows.set(this.#key(binding.seriesKey, binding.playerId, binding.subgameOrdinal), {
      ...binding,
      initialState: binding.initialState,
    });
  }

  async get(
    seriesKey: string,
    playerId: string,
    subgameOrdinal: number,
  ): Promise<TrustedChallengeBinding | null> {
    return this.#rows.get(this.#key(seriesKey, playerId, subgameOrdinal)) ?? null;
  }

  #key(seriesKey: string, playerId: string, subgameOrdinal: number): string {
    return `${seriesKey}|${playerId}|${subgameOrdinal}`;
  }
}

export function digestInitialState(state: GameState): string {
  return stateHashV3(state);
}

/**
 * Bind a raw initial JSON challenge after parseInitialGameState validation.
 * Rejects non-initial / unplayable payloads.
 */
export function bindTrustedChallenge(args: {
  seriesKey: string;
  playerId: string;
  subgameOrdinal: number;
  challengeId: string;
  generatorVersion: string;
  contentVersion: string;
  initialStateRaw: unknown;
  assignedAt: Date;
}): TrustedChallengeBinding {
  const initialState = parseInitialGameState(args.initialStateRaw);
  if (initialState.rulesVersion !== 'core-001.v3') {
    throw new Error('rules_version_mismatch');
  }
  return {
    seriesKey: args.seriesKey,
    playerId: args.playerId,
    subgameOrdinal: args.subgameOrdinal,
    challengeId: args.challengeId,
    rulesVersion: 'core-001.v3',
    generatorVersion: args.generatorVersion,
    contentVersion: args.contentVersion,
    initialStateDigest: digestInitialState(initialState),
    initialState,
    assignedAt: args.assignedAt,
  };
}

/** Structural self-hash of arbitrary JSON — never authenticity proof. */
export function selfConsistentJsonHash(value: unknown): string {
  const canonical = JSON.stringify(value);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function challengeBindingFingerprint(binding: TrustedChallengeBinding): string {
  return createHash('sha256')
    .update(
      [
        binding.seriesKey,
        binding.playerId,
        String(binding.subgameOrdinal),
        binding.challengeId,
        binding.rulesVersion,
        binding.generatorVersion,
        binding.contentVersion,
        binding.initialStateDigest,
      ].join('|'),
      'utf8',
    )
    .digest('hex');
}

export { stateToJson };
