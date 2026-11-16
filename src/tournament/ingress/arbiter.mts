import type { AdmissionJournal } from './journal.mts';
import {
  isTimely,
  type AdmittedCommand,
  type AdmitCommandInput,
  type AdmitResult,
} from './types.mts';

export interface SeriesDeadlineState {
  seriesKey: string;
  /** Effective inactivity deadline. */
  idleDeadlineAt: Date;
  /** Applicable UTC hard cutoff, if any. */
  hardCutoffAt: Date | null;
  status: 'ACTIVE' | 'AWAIT_ADVANCE' | 'COMPLETED' | 'FORFEITED';
}

export type AdjudicationResult =
  | { decision: 'apply'; command: AdmittedCommand }
  | {
      decision: 'reject';
      command: AdmittedCommand;
      reason:
        | 'IDLE_EXPIRED'
        | 'HARD_CUTOFF_EXPIRED'
        | 'SERIES_TERMINAL'
        | 'INGRESS_UNAVAILABLE'
        | 'IDEMPOTENCY_PAYLOAD_CONFLICT';
    }
  | { decision: 'unavailable'; reason: 'INGRESS_UNAVAILABLE' };

/**
 * Per-series arbiter: admit first (durable trusted time), then evaluate
 * eligibility against deadlines using the original trustedReceivedAt —
 * never Date.now() at later lock acquisition (contract §4 / TD-02/TD-03).
 */
export class SeriesCommandArbiter {
  readonly #journal: AdmissionJournal;

  constructor(journal: AdmissionJournal) {
    this.#journal = journal;
  }

  async admitAndEvaluate(
    input: AdmitCommandInput,
    series: SeriesDeadlineState,
    options?: {
      /** Simulated delay between admit and lock/adjudication. */
      afterAdmit?: () => Promise<void>;
    },
  ): Promise<AdjudicationResult> {
    if (series.status === 'COMPLETED' || series.status === 'FORFEITED') {
      const admit = await this.#journal.admit(input);
      if (!admit.ok) {
        return this.#mapAdmitFailure(admit);
      }
      await this.#journal.markOutcome(admit.command.admissionId, 'rejected');
      return {
        decision: 'reject',
        command: admit.command,
        reason: 'SERIES_TERMINAL',
      };
    }

    const admit = await this.#journal.admit(input);
    if (!admit.ok) {
      return this.#mapAdmitFailure(admit);
    }

    if (options?.afterAdmit) {
      await options.afterAdmit();
    }

    const command = admit.command;
    const t = command.trustedReceivedAt;

    if (!isTimely(t, series.idleDeadlineAt)) {
      await this.#journal.markOutcome(command.admissionId, 'rejected');
      return { decision: 'reject', command, reason: 'IDLE_EXPIRED' };
    }

    if (series.hardCutoffAt && !isTimely(t, series.hardCutoffAt)) {
      await this.#journal.markOutcome(command.admissionId, 'rejected');
      return { decision: 'reject', command, reason: 'HARD_CUTOFF_EXPIRED' };
    }

    await this.#journal.markOutcome(command.admissionId, 'applied');
    return { decision: 'apply', command };
  }

  /**
   * Expiry barrier (TD-13): forfeit only when no eligible pending admitted
   * command remains before the deadline watermark.
   */
  async canSafelyForfeit(
    seriesKey: string,
    idleDeadlineAt: Date,
  ): Promise<{ allowed: boolean; blocking: AdmittedCommand[] }> {
    const blocking = await this.#journal.listEligiblePending(
      seriesKey,
      idleDeadlineAt,
    );
    return { allowed: blocking.length === 0, blocking };
  }

  #mapAdmitFailure(admit: Exclude<AdmitResult, { ok: true }>): AdjudicationResult {
    if (admit.reason === 'INGRESS_UNAVAILABLE') {
      return { decision: 'unavailable', reason: 'INGRESS_UNAVAILABLE' };
    }
    return {
      decision: 'reject',
      command: admit.existing,
      reason: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
    };
  }
}
