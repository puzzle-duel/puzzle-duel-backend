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
import { OrdinalIntegrityError } from '../claims/active-ordinal.mts';
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

export type WriterDenialCategory = 'SESSION_MISMATCH' | 'DEVICE_MISMATCH' | 'GENERATION_MISMATCH';

export class SessionAuthorizationGateway implements AuthorizationGateway {
  /** Staging-only static forensics; never contains identifiers or secrets. */
  writerDenialCategory: WriterDenialCategory | null = null;
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
    this.writerDenialCategory = null;
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
    // P0-F11 fail-closed: only the active writer session/device may mutate,
    // including device_handoff. Cross-device seize by another same-player
    // session is rejected; broader recovery policy remains BLOCKED.
    if (writer.sessionId !== this.#deps.session.sessionId) {
      this.writerDenialCategory = 'SESSION_MISMATCH';
      return { ok: false, reason: 'WRITER_NOT_AUTHORIZED' };
    }
    if (writer.deviceId !== this.#deps.session.deviceId) {
      this.writerDenialCategory = 'DEVICE_MISMATCH';
      return { ok: false, reason: 'WRITER_NOT_AUTHORIZED' };
    }
    if (
      args.clientClaimedWriterGeneration !== undefined &&
      args.clientClaimedWriterGeneration !== writer.writerGeneration
    ) {
      this.writerDenialCategory = 'GENERATION_MISMATCH';
      return { ok: false, reason: 'WRITER_NOT_AUTHORIZED' };
    }

    let ordinal: number;
    try {
      ordinal = await this.#deps.resolveActiveOrdinal(
        args.clientClaimedSeriesKey,
        this.#deps.session.playerId,
      );
    } catch (err) {
      // P1-R03: missing fence / gaps / inconsistent snapshots fail closed.
      if (err instanceof OrdinalIntegrityError) {
        return { ok: false, reason: 'SERIES_STATE_CORRUPT' };
      }
      throw err;
    }

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
