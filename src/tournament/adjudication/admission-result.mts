/**
 * Immutable per-admission gameplay result (P1-E04).
 * Retries must return this envelope, never the current active ordinal snapshot.
 */

export interface ImmutableAdmissionResult {
  admissionId: string;
  playerId: string;
  seriesKey: string;
  subgameOrdinal: number;
  boardRevision: number;
  score: number;
  scoreDelta: number;
  terminal: boolean;
  terminalReason: string | null;
  stateHash: string;
  writerGeneration: number;
  awaitAdvance: boolean;
  decision: 'apply' | 'reject';
  rejectReason?: string;
}

export function freezeAdmissionResult(
  result: ImmutableAdmissionResult,
): ImmutableAdmissionResult {
  return Object.freeze({ ...result });
}
