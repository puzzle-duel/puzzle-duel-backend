import type {
  AdmitCommandInput,
  SeriesFenceState,
  ServerMoveEffectResolver,
} from '../../../src/tournament/ingress/types.mts';
import { idleDeadlineFrom } from '../../../src/tournament/ingress/types.mts';

export const T0 = new Date('2026-11-16T12:00:00.000Z');

export function baseFence(
  seriesKey: string,
  overrides: Partial<SeriesFenceState> = {},
): SeriesFenceState {
  return {
    seriesKey,
    boardRevision: 0,
    writerGeneration: 1,
    status: 'ACTIVE',
    idleDeadlineAt: idleDeadlineFrom(T0, 300),
    hardCutoffAt: null,
    score: 0,
    resultsPublished: false,
    lastAppliedAdmissionId: null,
    thinkingExtensionConsumed: false,
    ...overrides,
  };
}

/**
 * Explicit test-only move effect map keyed by idempotencyKey.
 * Never sourced from client scoreDelta/completesSeries.
 */
export function moveEffectsByKey(
  map: Record<
    string,
    { scoreDelta: number; completesSubgame?: boolean }
  >,
): ServerMoveEffectResolver {
  return (input: AdmitCommandInput) => {
    const row = map[input.idempotencyKey];
    if (!row) return { scoreDelta: 0, completesSubgame: false };
    return {
      scoreDelta: row.scoreDelta,
      completesSubgame: row.completesSubgame ?? false,
    };
  };
}

export function fixedMoveEffect(
  scoreDelta: number,
  completesSubgame = false,
): ServerMoveEffectResolver {
  return () => ({ scoreDelta, completesSubgame });
}
