/**
 * PZD-41 Stage F2 — pure four-category total function.
 *
 * SECURITY BOUNDARY: this function does NOT establish that scores are earned,
 * that the six subgames are replay-verified, or that a daily series may publish.
 * Only call it after the trusted server verifies ownership, pinned manifest,
 * all six terminal snapshots and immutable accepted-move ledgers.
 * Its output must enter a single completion+publication DB transaction.
 */
export interface SubgameScore {
  readonly ordinal: number;
  readonly score: number;
}

export interface FourCategoryScores {
  readonly easy: number;
  readonly medium: number;
  readonly hard: number;
  readonly all: number;
}

const REQUIRED_ORDINALS = 6;

function checkedSum(a: number, b: number): number {
  const total = a + b;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError('TOTAL_SCORE_OVERFLOW');
  }
  return total;
}

/** E1/E2/E3 = Easy, M1/M2 = Medium, H1 = Hard. */
export function computeFourCategoryScores(
  replayVerifiedSubgames: readonly SubgameScore[],
): Readonly<FourCategoryScores> {
  if (replayVerifiedSubgames.length !== REQUIRED_ORDINALS) {
    throw new RangeError('REQUIRES_SIX_COMPLETED_GAMES');
  }
  const byOrdinal = new Map<number, number>();
  for (const subgame of replayVerifiedSubgames) {
    if (!Number.isSafeInteger(subgame.ordinal) || subgame.ordinal < 1 || subgame.ordinal > 6) {
      throw new RangeError('INVALID_SUBGAME_ORDINAL');
    }
    if (!Number.isSafeInteger(subgame.score) || subgame.score < 0) {
      throw new RangeError('INVALID_VERIFIED_SCORE');
    }
    if (byOrdinal.has(subgame.ordinal)) {
      throw new RangeError('DUPLICATE_SUBGAME_ORDINAL');
    }
    byOrdinal.set(subgame.ordinal, subgame.score);
  }
  const score = (ordinal: number): number => {
    const result = byOrdinal.get(ordinal);
    if (result === undefined) throw new RangeError('MISSING_SUBGAME_ORDINAL');
    return result;
  };
  const easy = checkedSum(checkedSum(score(1), score(2)), score(3));
  const medium = checkedSum(score(4), score(5));
  const hard = score(6);
  const all = checkedSum(checkedSum(easy, medium), hard);
  return Object.freeze({ easy, medium, hard, all });
}
