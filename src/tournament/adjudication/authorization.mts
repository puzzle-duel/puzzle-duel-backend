/**
 * Ranked authorization boundary (P0-E02).
 *
 * Untrusted JSON seriesKey/playerId never establish ownership.
 * A server-derived TrustedAuthorizationContext must be supplied by an
 * AuthorizationGateway that has already verified principal/session.
 *
 * Authenticated HTTP/Nest wiring remains NOT_RUN when no accepted
 * session/token contract exists — ranked entry fails closed without a
 * verified context.
 */

export type RankedCommandType =
  | 'start'
  | 'move'
  | 'advance'
  | 'thinking_extension'
  | 'device_handoff'
  | 'abandon';

export interface TrustedPrincipal {
  /** Internal immutable player_id (AGENTS.md). Never a raw provider ID. */
  playerId: string;
}

export interface TrustedSession {
  sessionId: string;
  deviceId: string;
  /** Writer generation this session is authorized to use. */
  writerGeneration: number;
}

export interface TrustedSeriesEntitlement {
  seriesKey: string;
  ownerPlayerId: string;
  /** Active subgame ordinal 1..6 resolved server-side. */
  activeSubgameOrdinal: number;
  status: 'ACTIVE' | 'AWAIT_ADVANCE' | 'COMPLETED' | 'FORFEITED';
}

/**
 * Server-minted authorization context. Construct only after verification.
 * Never deserialize from client JSON.
 */
export interface TrustedAuthorizationContext {
  principal: TrustedPrincipal;
  session: TrustedSession;
  series: TrustedSeriesEntitlement;
  /** Wall-clock of authorization decision (diagnostics). */
  authorizedAt: Date;
  /** Opaque proof id from the auth layer (test or future HTTP middleware). */
  authProofId: string;
}

export type AuthorizationFailureReason =
  | 'AUTH_REQUIRED'
  | 'PLAYER_MISMATCH'
  | 'SERIES_NOT_OWNED'
  | 'SERIES_TERMINAL'
  | 'WRITER_NOT_AUTHORIZED'
  | 'COMMAND_NOT_ENTITLED'
  | 'AUTH_CONTRACT_UNAVAILABLE';

export type AuthorizationDecision =
  | { ok: true; context: TrustedAuthorizationContext }
  | { ok: false; reason: AuthorizationFailureReason };

/**
 * Pluggable gateway. Production Nest middleware would implement this after
 * accepted auth contracts. Tests inject an in-memory verified gateway.
 */
export interface AuthorizationGateway {
  /**
   * Authorize a ranked command. Must NOT trust client-claimed player/series
   * as ownership proof — those are at most lookup hints after verification.
   */
  authorize(args: {
    commandType: RankedCommandType;
    /** Optional client hint; never authority. */
    clientClaimedSeriesKey?: string;
    clientClaimedPlayerId?: string;
    clientClaimedWriterGeneration?: number;
  }): Promise<AuthorizationDecision>;
}

/**
 * Fail-closed gateway used when HTTP/session contracts are unavailable.
 * Ranked exposure is blocked until an accepted auth implementation is wired.
 */
export class FailClosedAuthorizationGateway implements AuthorizationGateway {
  async authorize(_args: {
    commandType: RankedCommandType;
    clientClaimedSeriesKey?: string;
    clientClaimedPlayerId?: string;
    clientClaimedWriterGeneration?: number;
  }): Promise<AuthorizationDecision> {
    return { ok: false, reason: 'AUTH_CONTRACT_UNAVAILABLE' };
  }
}

/**
 * Test/service gateway that only accepts pre-registered verified contexts.
 * Explicitly not HTTP authentication.
 */
export class MemoryVerifiedAuthorizationGateway implements AuthorizationGateway {
  #bySeries = new Map<string, TrustedAuthorizationContext>();

  register(context: TrustedAuthorizationContext): void {
    this.#bySeries.set(context.series.seriesKey, structuredClone(context));
  }

  update(context: TrustedAuthorizationContext): void {
    this.#bySeries.set(context.series.seriesKey, structuredClone(context));
  }

  get(seriesKey: string): TrustedAuthorizationContext | null {
    const row = this.#bySeries.get(seriesKey);
    return row ? structuredClone(row) : null;
  }

  async authorize(args: {
    commandType: RankedCommandType;
    clientClaimedSeriesKey?: string;
    clientClaimedPlayerId?: string;
    clientClaimedWriterGeneration?: number;
  }): Promise<AuthorizationDecision> {
    if (!args.clientClaimedSeriesKey) {
      return { ok: false, reason: 'AUTH_REQUIRED' };
    }
    const ctx = this.#bySeries.get(args.clientClaimedSeriesKey);
    if (!ctx) {
      return { ok: false, reason: 'SERIES_NOT_OWNED' };
    }
    if (
      args.clientClaimedPlayerId !== undefined &&
      args.clientClaimedPlayerId !== ctx.principal.playerId
    ) {
      return { ok: false, reason: 'PLAYER_MISMATCH' };
    }
    if (ctx.series.ownerPlayerId !== ctx.principal.playerId) {
      return { ok: false, reason: 'SERIES_NOT_OWNED' };
    }
    // Terminal series status is enforced at the fence/adjudication layer so
    // authenticated duplicate retries can still return immutable results.
    void args.commandType;
    if (
      args.clientClaimedWriterGeneration !== undefined &&
      args.clientClaimedWriterGeneration !== ctx.session.writerGeneration
    ) {
      return { ok: false, reason: 'WRITER_NOT_AUTHORIZED' };
    }
    return { ok: true, context: structuredClone(ctx) };
  }
}

export function assertContextMatchesCommand(
  context: TrustedAuthorizationContext,
  commandType: RankedCommandType,
  clientWriterGeneration?: number,
): AuthorizationDecision {
  void commandType;
  if (context.series.ownerPlayerId !== context.principal.playerId) {
    return { ok: false, reason: 'SERIES_NOT_OWNED' };
  }
  if (
    clientWriterGeneration !== undefined &&
    clientWriterGeneration !== context.session.writerGeneration
  ) {
    return { ok: false, reason: 'WRITER_NOT_AUTHORIZED' };
  }
  return { ok: true, context };
}
