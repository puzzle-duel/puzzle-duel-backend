/**
 * Production-oriented AuthorizationGateway backed by verified PG sessions
 * and server-owned series writer bindings. Never trusts client player IDs.
 */
import type {
  AuthorizationDecision,
  AuthorizationGateway,
  RankedCommandType,
  TrustedAuthorizationContext,
} from '../adjudication/authorization.mts';
import type { ImmutableDailyClaim } from '../claims/postgres-daily-claim.mts';
import type { VerifiedSession } from './postgres-verified-sessions.mts';
import type { PostgresSeriesWriterStore } from './series-writer-binding.mts';

export interface SessionAuthorizationGatewayDeps {
  session: VerifiedSession;
  writers: PostgresSeriesWriterStore;
  /** Load claim by series for the authenticated player only. */
  loadOwnedClaim: (
    playerId: string,
    seriesKey: string,
  ) => Promise<ImmutableDailyClaim | null>;
  /** Server-resolved active ordinal (1..6). */
  resolveActiveOrdinal: (
    seriesKey: string,
    playerId: string,
  ) => Promise<number>;
}

export class SessionAuthorizationGateway implements AuthorizationGateway {
  readonly #deps: SessionAuthorizationGatewayDeps;

  constructor(deps: SessionAuthorizationGatewayDeps) {
    this.#deps = deps;
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
    if (
      args.clientClaimedPlayerId !== undefined &&
      args.clientClaimedPlayerId !== this.#deps.session.playerId
    ) {
      return { ok: false, reason: 'PLAYER_MISMATCH' };
    }

    const claim = await this.#deps.loadOwnedClaim(
      this.#deps.session.playerId,
      args.clientClaimedSeriesKey,
    );
    if (!claim) return { ok: false, reason: 'SERIES_NOT_OWNED' };
    if (claim.playerId !== this.#deps.session.playerId) {
      return { ok: false, reason: 'SERIES_NOT_OWNED' };
    }

    const writer = await this.#deps.writers.get(args.clientClaimedSeriesKey);
    if (!writer || writer.playerId !== this.#deps.session.playerId) {
      return { ok: false, reason: 'SERIES_NOT_OWNED' };
    }
    if (
      writer.sessionId !== this.#deps.session.sessionId ||
      writer.deviceId !== this.#deps.session.deviceId
    ) {
      // Session is authenticated owner but not active writer.
      if (args.commandType !== 'device_handoff') {
        return { ok: false, reason: 'WRITER_NOT_AUTHORIZED' };
      }
    }
    if (
      args.clientClaimedWriterGeneration !== undefined &&
      args.clientClaimedWriterGeneration !== writer.writerGeneration
    ) {
      return { ok: false, reason: 'WRITER_NOT_AUTHORIZED' };
    }

    const ordinal = await this.#deps.resolveActiveOrdinal(
      args.clientClaimedSeriesKey,
      this.#deps.session.playerId,
    );

    const context: TrustedAuthorizationContext = {
      principal: { playerId: this.#deps.session.playerId },
      session: {
        sessionId: this.#deps.session.sessionId,
        deviceId: this.#deps.session.deviceId,
        writerGeneration: writer.writerGeneration,
      },
      series: {
        seriesKey: args.clientClaimedSeriesKey,
        ownerPlayerId: this.#deps.session.playerId,
        activeSubgameOrdinal: ordinal,
        status: claim.status,
      },
      authorizedAt: new Date(),
      authProofId: `session:${this.#deps.session.sessionId}`,
    };
    return { ok: true, context };
  }
}
