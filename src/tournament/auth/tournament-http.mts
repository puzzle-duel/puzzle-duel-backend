/**
 * PZD-40 Stage F1 candidate Tournament HTTP surface (node:http).
 *
 * OpenAPI candidate — not an Accepted production contract until owner freeze.
 * No NestJS dependency (repo has none; ADR-005 scaffolding not authorized).
 * Live Apple/Google OAuth credentials are NOT invented here.
 *
 * MemoryVerifiedAuthorizationGateway is never used on these routes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  JwtVerificationError,
  type PinnedRs256JwtVerifier,
} from './pinned-jwt-verifier.mts';
import type { PostgresVerifiedIdentitySessionStore } from './postgres-verified-sessions.mts';
import type { AtomicDailyClaimBootstrap } from '../claims/atomic-claim-bootstrap.mts';
import { resolveActiveSubgameOrdinal } from '../claims/active-ordinal.mts';
import type { PostgresSeriesWriterStore } from './series-writer-binding.mts';
import { SessionAuthorizationGateway } from './session-authorization-gateway.mts';
import type { TrustedGameplayService } from '../adjudication/trusted-gameplay.mts';
import { validateUntrustedClientCommand } from '../adjudication/client-commands.mts';
import type { SeriesFenceStore } from '../ingress/series-fence.mts';
import type pg from 'pg';
import {
  RANKED_HTTP_DISABLED_ERROR,
  resolveRankedHttpFeatureGate,
  type RankedHttpGateConfig,
} from './ranked-feature-gate.mts';

const MAX_BODY = 16_384;

function send(res: ServerResponse, status: number, data: unknown): void {
  const body = status === 204 ? '' : JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const lengthHeader = req.headers['content-length'];
  if (req.headers['transfer-encoding'] !== undefined) return null;
  const length =
    lengthHeader === undefined ? 0 : Number.parseInt(String(lengthHeader), 10);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY) {
    return null;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY) return null;
    chunks.push(buf);
  }
  if (lengthHeader !== undefined && total !== length) return null;
  return Buffer.concat(chunks);
}

export interface TournamentHttpDeps {
  verifier: PinnedRs256JwtVerifier;
  sessions: PostgresVerifiedIdentitySessionStore;
  claims: AtomicDailyClaimBootstrap;
  writers: PostgresSeriesWriterStore;
  fence: SeriesFenceStore;
  /** Pool used for canonical ordinal resolution (P1-F14). */
  pool: pg.Pool;
  /**
   * Factory: build a TrustedGameplayService bound to this verified session.
   * Must use SessionAuthorizationGateway — never MemoryVerifiedAuthorizationGateway.
   */
  gameplayForSession: (
    gateway: SessionAuthorizationGateway,
  ) => TrustedGameplayService;
  /** Simple in-process rate limit: max requests per player per window. */
  rateLimit?: {
    maxPerWindow: number;
    windowMs: number;
  };
  /**
   * Server-side ranked HTTP gate config. Defaults to process env.
   * Never derived from request headers/query/body.
   * Cannot override NODE_ENV=production hard deny (P0-FG01).
   */
  rankedHttpGate?: RankedHttpGateConfig;
  /**
   * Optional injected runtime env that may ONLY tighten denial (P0-FG02).
   * Never overrides a real `process.env.NODE_ENV=production|prod` veto.
   * Production omits this; harnesses may inject a synthetic production-like
   * env to force deny, but cannot use NODE_ENV=test to enable under prod.
   */
  actualRuntimeEnv?: NodeJS.ProcessEnv;
}

type RateBucket = { count: number; resetAt: number };

export function createTournamentHttpHandler(deps: TournamentHttpDeps) {
  const buckets = new Map<string, RateBucket>();
  const rate = deps.rateLimit ?? { maxPerWindow: 120, windowMs: 60_000 };

  function checkRate(playerId: string): boolean {
    const now = Date.now();
    const b = buckets.get(playerId);
    if (!b || now >= b.resetAt) {
      buckets.set(playerId, { count: 1, resetAt: now + rate.windowMs });
      return true;
    }
    if (b.count >= rate.maxPerWindow) return false;
    b.count += 1;
    return true;
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // P0 ranked gate: before any JWT verify, session, claim, or gameplay work.
    // Client enable/bypass headers/query/body are intentionally ignored.
    // P0-FG01/FG02: real process.env.NODE_ENV=production hard-denies even if
    // rankedHttpGate or actualRuntimeEnv claim test/development enablement.
    const gate = resolveRankedHttpFeatureGate(deps.rankedHttpGate, {
      injectedRuntimeEnv: deps.actualRuntimeEnv,
    });
    if (!gate.enabled) {
      send(res, 503, {
        error: RANKED_HTTP_DISABLED_ERROR,
        reason: gate.denyReason,
      });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    try {
      if (path === '/v1/tournament/session') {
        return await handleSession(req, res, method, deps);
      }

      const identity = deps.verifier.verifyAuthorizationHeader(
        req.headers.authorization,
      );
      const secret = req.headers['x-pzd-session-secret'];
      if (typeof secret !== 'string') {
        send(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      const session = await deps.sessions.authenticateVerifiedSession(
        identity,
        secret,
      );
      if (!session) {
        send(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      if (!checkRate(session.playerId)) {
        send(res, 429, { error: 'RATE_LIMITED' });
        return;
      }

      if (path === '/v1/tournament/claims/daily' && method === 'POST') {
        const raw = await readBody(req);
        if (!raw) {
          send(res, 400, { error: 'MALFORMED_REQUEST' });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8') || '{}');
        } catch {
          send(res, 400, { error: 'MALFORMED_REQUEST' });
          return;
        }
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed) ||
          Object.keys(parsed as object).some((k) => k !== 'originalUtcDate')
        ) {
          send(res, 400, { error: 'MALFORMED_REQUEST' });
          return;
        }
        const originalUtcDate = (parsed as { originalUtcDate?: unknown })
          .originalUtcDate;
        if (typeof originalUtcDate !== 'string') {
          send(res, 400, { error: 'MALFORMED_REQUEST' });
          return;
        }
        // Reject client authority fields if smuggled somehow.
        const result = await deps.claims.claimAndBootstrap({
          session,
          originalUtcDate,
        });
        if (!result.ok) {
          const status =
            result.reason === 'CLAIM_WINDOW_CLOSED'
              ? 403
              : result.reason === 'INVALID_DATE'
                ? 400
                : 503;
          send(res, status, { error: result.reason });
          return;
        }
        send(res, result.original ? 201 : 200, {
          seriesId: result.claim.seriesId,
          originalUtcDate: result.claim.originalUtcDate,
          startedAtMs: result.claim.startedAtMs,
          manifestDigest: result.claim.manifestDigest,
          status: result.claim.status,
          original: result.original,
          writerGeneration: result.writerGeneration,
        });
        return;
      }

      const seriesMatch = /^\/v1\/tournament\/series\/([0-9a-f-]{36})$/.exec(
        path,
      );
      if (seriesMatch && method === 'GET') {
        const seriesId = seriesMatch[1]!;
        const claim = await deps.claims.getClaimForPlayer(
          session.playerId,
          seriesId,
        );
        if (!claim) {
          send(res, 404, { error: 'SERIES_NOT_OWNED' });
          return;
        }
        const fence = await deps.fence.get(seriesId);
        const writer = await deps.writers.get(seriesId);
        // GET must not renew inactivity — fence is read-only here.
        send(res, 200, {
          seriesId: claim.seriesId,
          originalUtcDate: claim.originalUtcDate,
          startedAtMs: claim.startedAtMs,
          manifestDigest: claim.manifestDigest,
          status: claim.status,
          boardRevision: fence?.boardRevision ?? null,
          writerGeneration: writer?.writerGeneration ?? null,
          idleDeadlineAtMs: fence?.idleDeadlineAt.getTime() ?? null,
          thinkingExtensionConsumed: fence?.thinkingExtensionConsumed ?? null,
        });
        return;
      }

      const cmdMatch =
        /^\/v1\/tournament\/series\/([0-9a-f-]{36})\/commands$/.exec(path);
      if (cmdMatch && method === 'POST') {
        const seriesId = cmdMatch[1]!;
        const raw = await readBody(req);
        if (!raw) {
          send(res, 400, { error: 'MALFORMED_REQUEST' });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          send(res, 400, { error: 'MALFORMED_REQUEST' });
          return;
        }
        const validated = validateUntrustedClientCommand(parsed);
        if (!validated.ok) {
          send(res, 400, { error: validated.reason });
          return;
        }

        // P0-F11/F12/P1-F15: no writer mutation before authoritative admission.
        // device_handoff goes through TrustedGameplayService → AtomicDeviceHandoffUnitOfWork.
        const gateway = new SessionAuthorizationGateway({
          session,
          writers: deps.writers,
          loadOwnedClaim: (playerId, key) =>
            deps.claims.getClaimForPlayer(playerId, key),
          resolveActiveOrdinal: (key, playerId) =>
            resolveActiveSubgameOrdinal(deps.pool, key, playerId),
        });
        const gameplay = deps.gameplayForSession(gateway);
        const writerHint =
          validated.command.commandType === 'move' && validated.command.move
            ? validated.command.move.writerGeneration
            : validated.command.commandType === 'device_handoff'
              ? validated.command.expectedWriterGeneration
              : undefined;
        const decision = await gameplay.handleClientCommand(validated.command, {
          seriesKeyHint: seriesId,
          playerIdHint: session.playerId,
          writerGenerationHint: writerHint,
        });
        if (decision.decision === 'unavailable') {
          send(res, 503, { error: decision.reason });
          return;
        }
        if (decision.decision === 'reject') {
          send(res, 409, {
            error: decision.reason,
            admissionResult: decision.admissionResult ?? null,
          });
          return;
        }
        send(res, 200, {
          decision: 'apply',
          boardRevision: decision.boardRevision,
          score: decision.score,
          scoreDelta: decision.scoreDelta,
          stateHash: decision.stateHash,
          terminal: decision.terminal,
          awaitAdvance: decision.awaitAdvance,
          duplicateReplay: decision.duplicateReplay ?? false,
          admissionResult: decision.admissionResult ?? null,
        });
        return;
      }

      send(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (
        error instanceof JwtVerificationError ||
        (error instanceof Error && error.message === 'UNAUTHENTICATED')
      ) {
        send(res, 401, { error: 'UNAUTHENTICATED' });
        return;
      }
      send(res, 503, { error: 'AUTH_UNAVAILABLE' });
    }
  };
}

async function handleSession(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  deps: TournamentHttpDeps,
): Promise<void> {
  if (!['POST', 'GET', 'DELETE'].includes(method)) {
    send(res, 404, { error: 'NOT_FOUND' });
    return;
  }
  if (method === 'POST') {
    const length = req.headers['content-length'];
    if (
      req.headers['transfer-encoding'] !== undefined ||
      (length !== undefined && length !== '0')
    ) {
      send(res, 400, { error: 'MALFORMED_REQUEST' });
      return;
    }
  } else {
    const length = req.headers['content-length'];
    if (
      req.headers['transfer-encoding'] !== undefined ||
      (length !== undefined && length !== '0')
    ) {
      send(res, 400, { error: 'MALFORMED_REQUEST' });
      return;
    }
  }
  const identity = deps.verifier.verifyAuthorizationHeader(
    req.headers.authorization,
  );
  if (method === 'POST') {
    const session = await deps.sessions.openAfterVerifiedJwt(identity);
    send(res, 201, {
      sessionSecret: session.sessionSecret,
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      expiresAtMs: session.expiresAtMs,
    });
    return;
  }
  const secret = req.headers['x-pzd-session-secret'];
  if (typeof secret !== 'string') {
    send(res, 401, { error: 'UNAUTHENTICATED' });
    return;
  }
  const verified = await deps.sessions.authenticateVerifiedSession(
    identity,
    secret,
  );
  if (!verified) {
    send(res, 401, { error: 'UNAUTHENTICATED' });
    return;
  }
  if (method === 'DELETE') {
    await deps.sessions.revokeSession(identity, secret);
    send(res, 204, null);
    return;
  }
  send(res, 200, {
    sessionId: verified.sessionId,
    deviceId: verified.deviceId,
    expiresAtMs: verified.expiresAtMs,
  });
}

/** Backward-compatible alias for earlier internal session path tests. */
export { createInternalSessionHttpHandler } from './internal-session-http.mts';
