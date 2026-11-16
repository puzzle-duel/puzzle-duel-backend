/**
 * Authoritative ingress clock.
 * Production: NTP-monitored UTC. Tests: ControllableClock.
 * Client clocks are never authoritative (ADR-T02 / TD-02).
 */
export interface IngressClock {
  now(): Date;
}

export class SystemUtcClock implements IngressClock {
  now(): Date {
    return new Date();
  }
}

/** Deterministic clock for Gate A proofs. */
export class ControllableClock implements IngressClock {
  #now: Date;

  constructor(initial: Date) {
    this.#now = new Date(initial.getTime());
  }

  now(): Date {
    return new Date(this.#now.getTime());
  }

  set(next: Date): void {
    this.#now = new Date(next.getTime());
  }

  advanceMs(deltaMs: number): void {
    this.#now = new Date(this.#now.getTime() + deltaMs);
  }
}
