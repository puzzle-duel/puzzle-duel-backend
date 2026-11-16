import { randomUUID } from 'node:crypto';
import type { IngressClock } from './clock.mts';
import type {
  AdmitCommandInput,
  AdmitResult,
  AdmittedCommand,
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
  markOutcome(
    admissionId: string,
    outcome: 'applied' | 'rejected' | 'pending',
  ): Promise<void>;
}

export interface MemoryJournalOptions {
  clock: IngressClock;
  /** When true, admit() fails closed (X-01 A / P38-05). */
  failClosed?: boolean;
}

/**
 * In-process durable journal for unit proofs and fault injection.
 * "Durable" here means survives simulated process restart via explicit snapshot.
 */
export class MemoryAdmissionJournal implements AdmissionJournal {
  #clock: IngressClock;
  #failClosed: boolean;
  #byId = new Map<string, AdmittedCommand & { outcome: string }>();
  #byIdempotency = new Map<string, string>();
  #seqBySeries = new Map<string, number>();

  constructor(options: MemoryJournalOptions) {
    this.#clock = options.clock;
    this.#failClosed = options.failClosed ?? false;
  }

  setFailClosed(value: boolean): void {
    this.#failClosed = value;
  }

  /** Simulate process crash recovery from persisted snapshot. */
  restoreSnapshot(
    rows: Array<AdmittedCommand & { outcome?: string }>,
  ): void {
    this.#byId.clear();
    this.#byIdempotency.clear();
    this.#seqBySeries.clear();
    for (const row of rows) {
      this.#byId.set(row.admissionId, {
        ...row,
        outcome: row.outcome ?? 'pending',
      });
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

  snapshot(): Array<AdmittedCommand & { outcome: string }> {
    return [...this.#byId.values()].map((row) => ({ ...row }));
  }

  async admit(input: AdmitCommandInput): Promise<AdmitResult> {
    if (this.#failClosed) {
      return { ok: false, reason: 'INGRESS_UNAVAILABLE' };
    }

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
          existing: { ...existing },
        };
      }
      return {
        ok: true,
        command: {
          ...existing,
          status: 'duplicate',
        },
      };
    }

    // Capture trusted time BEFORE any later series lock / adjudication wait.
    const trustedReceivedAt = this.#clock.now();
    const admissionSeq = (this.#seqBySeries.get(input.seriesKey) ?? 0) + 1;
    this.#seqBySeries.set(input.seriesKey, admissionSeq);

    const command: AdmittedCommand & { outcome: string } = {
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
    };
    this.#byId.set(command.admissionId, command);
    this.#byIdempotency.set(idemKey, command.admissionId);
    return { ok: true, command: { ...command } };
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
    return row ? { ...row } : null;
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
      .map((row) => ({ ...row }));
  }

  async markOutcome(
    admissionId: string,
    outcome: 'applied' | 'rejected' | 'pending',
  ): Promise<void> {
    const row = this.#byId.get(admissionId);
    if (!row) return;
    row.outcome = outcome;
  }

  #idemKey(seriesKey: string, playerId: string, key: string): string {
    return `${seriesKey}|${playerId}|${key}`;
  }
}
