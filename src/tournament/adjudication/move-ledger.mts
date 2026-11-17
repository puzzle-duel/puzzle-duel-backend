import type { GameState, Move } from '../../engine/core001v3/index.mts';

/**
 * Durable accepted gameplay move ledger (distinct from admission journal).
 * Ordering is the server admission sequence / board revision — never client time.
 */
export interface AcceptedMoveLedgerEntry {
  seriesKey: string;
  playerId: string;
  subgameOrdinal: number;
  challengeId: string;
  admissionId: string;
  admissionSeq: number;
  boardRevisionAfter: number;
  move: Move;
  scoreDelta: number;
  scoreAfter: number;
  stateHashBefore: string;
  stateHashAfter: string;
  rulesVersion: 'core-001.v3';
  trustedReceivedAt: Date;
  terminalAfter: boolean;
  terminalReason: string | null;
}

export interface AcceptedMoveLedger {
  append(entry: AcceptedMoveLedgerEntry): Promise<void>;
  list(
    seriesKey: string,
    playerId: string,
    subgameOrdinal: number,
  ): Promise<AcceptedMoveLedgerEntry[]>;
  latestWatermark(
    seriesKey: string,
    playerId: string,
    subgameOrdinal: number,
  ): Promise<{ boardRevision: number; stateHash: string; admissionSeq: number } | null>;
}

export class MemoryAcceptedMoveLedger implements AcceptedMoveLedger {
  #rows: AcceptedMoveLedgerEntry[] = [];

  async append(entry: AcceptedMoveLedgerEntry): Promise<void> {
    const dup = this.#rows.find(
      (r) =>
        r.seriesKey === entry.seriesKey &&
        r.playerId === entry.playerId &&
        r.subgameOrdinal === entry.subgameOrdinal &&
        (r.admissionId === entry.admissionId ||
          r.boardRevisionAfter === entry.boardRevisionAfter),
    );
    if (dup) {
      throw new Error('ledger_duplicate_or_revision_conflict');
    }
    this.#rows.push({ ...entry, move: { ...entry.move, tap: { ...entry.move.tap } } });
  }

  async list(
    seriesKey: string,
    playerId: string,
    subgameOrdinal: number,
  ): Promise<AcceptedMoveLedgerEntry[]> {
    return this.#rows
      .filter(
        (r) =>
          r.seriesKey === seriesKey &&
          r.playerId === playerId &&
          r.subgameOrdinal === subgameOrdinal,
      )
      .sort((a, b) => a.boardRevisionAfter - b.boardRevisionAfter)
      .map((r) => ({ ...r, move: { ...r.move, tap: { ...r.move.tap } } }));
  }

  async latestWatermark(
    seriesKey: string,
    playerId: string,
    subgameOrdinal: number,
  ): Promise<{ boardRevision: number; stateHash: string; admissionSeq: number } | null> {
    const rows = await this.list(seriesKey, playerId, subgameOrdinal);
    const last = rows[rows.length - 1];
    if (!last) return null;
    return {
      boardRevision: last.boardRevisionAfter,
      stateHash: last.stateHashAfter,
      admissionSeq: last.admissionSeq,
    };
  }
}

export interface AuthoritativeGameSnapshot {
  seriesKey: string;
  playerId: string;
  subgameOrdinal: number;
  challengeId: string;
  boardRevision: number;
  moveCursor: number;
  stateHash: string;
  score: number;
  status: 'in_progress' | 'ended';
  terminalReason: string | null;
  /** Server-written only. Never accepted from client. */
  state: GameState;
  ledgerAdmissionSeq: number;
  writerGeneration: number;
  /** Provenance: which admission produced this snapshot. */
  producedByAdmissionId: string | null;
}

export interface AuthoritativeSnapshotStore {
  get(
    seriesKey: string,
    playerId: string,
    subgameOrdinal: number,
  ): Promise<AuthoritativeGameSnapshot | null>;
  put(snapshot: AuthoritativeGameSnapshot): Promise<void>;
}

export class MemoryAuthoritativeSnapshotStore implements AuthoritativeSnapshotStore {
  #rows = new Map<string, AuthoritativeGameSnapshot>();

  async get(
    seriesKey: string,
    playerId: string,
    subgameOrdinal: number,
  ): Promise<AuthoritativeGameSnapshot | null> {
    return this.#rows.get(`${seriesKey}|${playerId}|${subgameOrdinal}`) ?? null;
  }

  async put(snapshot: AuthoritativeGameSnapshot): Promise<void> {
    this.#rows.set(
      `${snapshot.seriesKey}|${snapshot.playerId}|${snapshot.subgameOrdinal}`,
      snapshot,
    );
  }
}
