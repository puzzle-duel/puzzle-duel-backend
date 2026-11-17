import { randomUUID } from 'node:crypto';
import type { ImmutableAdmissionResult } from '../adjudication/admission-result.mts';
import type { IngressClock } from './clock.mts';
import type {
  AdmitCommandInput,
  AdmitResult,
  AdmittedCommand,
  CommandOutcomeStatus,
} from './types.mts';

/**
 * Durable trusted ingress journal (TD-02).
 * A request is reliably admitted only when this write survives crash/retry.
 * Row-locking the series aggregate alone is NOT sufficient for eligibility.
 */
export interface AdmissionJournal {
  admit(input: AdmitCommandInput): Promise<AdmitResult>;
  getByIdempotency(
    seriesKey: string,
    playerId: string,
    idempotencyKey: string,
  ): Promise<AdmittedCommand | null>;
  getOutcome(admissionId: string): Promise<CommandOutcomeStatus>;
  /**
   * Highest admission_seq observed for the series (watermark for barriers).
   */
  maxAdmissionSeq(seriesKey: string): Promise<number>;
  /**
   * Admitted commands still pending adjudication with trusted_received_at < cutoff.
   */
  listEligiblePending(
    seriesKey: string,
    cutoffExclusive: Date,
  ): Promise<AdmittedCommand[]>;
  /**
   * Eligible pending admissions across many series (weekly settlement barrier).
   */
  listEligiblePendingForSeries(
    seriesKeys: string[],
    cutoffExclusive: Date,
  ): Promise<AdmittedCommand[]>;
  /**
   * Conditionally set outcome only while still pending.
   * Returns true if this caller won the transition (prevents applied→rejected races).
   */
  markOutcome(
    admissionId: string,
    outcome: 'applied' | 'rejected' | 'pending',
  ): Promise<boolean>;
  /**
   * Persist immutable per-admission result with outcome (P1-E04).
   * Only transitions from pending.
   */
  markOutcomeWithResult(
    admissionId: string,
    outcome: 'applied' | 'rejected',
    result: ImmutableAdmissionResult,
  ): Promise<boolean>;
  /** Load frozen result for duplicate-safe retries. */
  getResult(admissionId: string): Promise<ImmutableAdmissionResult | null>;
}

export interface MemoryJournalOptions {
  clock: IngressClock;
  /** When true, admit() fails closed (X-01 A / P38-05). */
  failClosed?: boolean;
}

type Stored = AdmittedCommand & {
  outcome: CommandOutcomeStatus;
  result?: ImmutableAdmissionResult;
};

/**
 * In-process journal for unit/fault proofs.
 * Not evidence of durable production correctness — use PostgresAdmissionJournal.
 */
export class MemoryAdmissionJournal implements AdmissionJournal {
  #clock: IngressClock;
  #failClosed: boolean;
  #byId = new Map<string, Stored>();
  #byIdempotency = new Map<string, string>();
  #seqBySeries = new Map<string, number>();
  /** Per-series mutex so concurrent admits get deterministic seq order. */
  #locks = new Map<string, Promise<void>>();

  constructor(options: MemoryJournalOptions) {
    this.#clock = options.clock;
    this.#failClosed = options.failClosed ?? false;
  }

  setFailClosed(value: boolean): void {
    this.#failClosed = value;
  }

  /** Simulate process crash recovery from persisted snapshot. */
  restoreSnapshot(rows: Stored[]): void {
    this.#byId.clear();
    this.#byIdempotency.clear();
    this.#seqBySeries.clear();
    for (const row of rows) {
      this.#byId.set(row.admissionId, { ...row });
      this.#byIdempotency.set(
        this.#idemKey(row.seriesKey, row.playerId, row.idempotencyKey),
        row.admissionId,
      );
      const prev = this.#seqBySeries.get(row.seriesKey) ?? 0;
      if (row.admissionSeq > prev) {
        this.#seqBySeries.set(row.seriesKey, row.admissionSeq);
      }
    }
  }

  snapshot(): Stored[] {
    return [...this.#byId.values()].map((row) => ({ ...row }));
  }

  async admit(input: AdmitCommandInput): Promise<AdmitResult> {
    if (this.#failClosed) {
      return { ok: false, reason: 'INGRESS_UNAVAILABLE' };
    }

    return this.#withSeriesLock(input.seriesKey, async () => {
      const idemKey = this.#idemKey(
        input.seriesKey,
        input.playerId,
        input.idempotencyKey,
      );
      const existingId = this.#byIdempotency.get(idemKey);
      if (existingId) {
        const existing = this.#byId.get(existingId)!;
        if (existing.payloadHash !== input.payloadHash) {
          return {
            ok: false,
            reason: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
            existing: this.#public(existing),
            outcome: existing.outcome,
          };
        }
        return {
          ok: true,
          command: { ...this.#public(existing), status: 'duplicate' },
          outcome: existing.outcome,
        };
      }

      // Capture trusted time under series lock, before returning to adjudicator.
      const trustedReceivedAt = this.#clock.now();
      const admissionSeq = (this.#seqBySeries.get(input.seriesKey) ?? 0) + 1;
      this.#seqBySeries.set(input.seriesKey, admissionSeq);

      const command: Stored = {
        admissionId: randomUUID(),
        seriesKey: input.seriesKey,
        playerId: input.playerId,
        commandType: input.commandType,
        idempotencyKey: input.idempotencyKey,
        payloadHash: input.payloadHash,
        trustedReceivedAt,
        admissionSeq,
        status: 'admitted',
        outcome: 'pending',
        expectedBoardRevision: input.expectedBoardRevision,
        writerGeneration: input.writerGeneration,
        // Stage E: never persist client scoreDelta / completesSeries as authority.
      };
      this.#byId.set(command.admissionId, command);
      this.#byIdempotency.set(idemKey, command.admissionId);
      return {
        ok: true,
        command: this.#public(command),
        outcome: 'pending',
      };
    });
  }

  async getByIdempotency(
    seriesKey: string,
    playerId: string,
    idempotencyKey: string,
  ): Promise<AdmittedCommand | null> {
    const id = this.#byIdempotency.get(
      this.#idemKey(seriesKey, playerId, idempotencyKey),
    );
    if (!id) return null;
    const row = this.#byId.get(id);
    return row ? this.#public(row) : null;
  }

  async getOutcome(admissionId: string): Promise<CommandOutcomeStatus> {
    return this.#byId.get(admissionId)?.outcome ?? 'unknown';
  }

  async maxAdmissionSeq(seriesKey: string): Promise<number> {
    return this.#seqBySeries.get(seriesKey) ?? 0;
  }

  async listEligiblePending(
    seriesKey: string,
    cutoffExclusive: Date,
  ): Promise<AdmittedCommand[]> {
    return [...this.#byId.values()]
      .filter(
        (row) =>
          row.seriesKey === seriesKey &&
          row.outcome === 'pending' &&
          row.trustedReceivedAt.getTime() < cutoffExclusive.getTime(),
      )
      .sort((a, b) => a.admissionSeq - b.admissionSeq)
      .map((row) => this.#public(row));
  }

  async listEligiblePendingForSeries(
    seriesKeys: string[],
    cutoffExclusive: Date,
  ): Promise<AdmittedCommand[]> {
    const set = new Set(seriesKeys);
    return [...this.#byId.values()]
      .filter(
        (row) =>
          set.has(row.seriesKey) &&
          row.outcome === 'pending' &&
          row.trustedReceivedAt.getTime() < cutoffExclusive.getTime(),
      )
      .sort((a, b) => a.admissionSeq - b.admissionSeq)
      .map((row) => this.#public(row));
  }

  async markOutcome(
    admissionId: string,
    outcome: 'applied' | 'rejected' | 'pending',
  ): Promise<boolean> {
    const row = this.#byId.get(admissionId);
    if (!row) return false;
    if (outcome !== 'pending' && row.outcome !== 'pending') {
      return false;
    }
    row.outcome = outcome;
    return true;
  }

  async markOutcomeWithResult(
    admissionId: string,
    outcome: 'applied' | 'rejected',
    result: ImmutableAdmissionResult,
  ): Promise<boolean> {
    const row = this.#byId.get(admissionId);
    if (!row || row.outcome !== 'pending') return false;
    row.outcome = outcome;
    row.result = Object.freeze({ ...result });
    return true;
  }

  async getResult(
    admissionId: string,
  ): Promise<ImmutableAdmissionResult | null> {
    const row = this.#byId.get(admissionId);
    return row?.result ? { ...row.result } : null;
  }

  #public(row: Stored): AdmittedCommand {
    const {
      outcome: _outcome,
      result: _result,
      ...command
    } = row;
    return { ...command };
  }

  #idemKey(seriesKey: string, playerId: string, key: string): string {
    return `${seriesKey}|${playerId}|${key}`;
  }

  async #withSeriesLock<T>(seriesKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(seriesKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(
      seriesKey,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
