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
import { DiagnosticReportStore } from '../../diagnostics/report-store.mts';
import {
  JwtVerificationError,
  type PinnedRs256JwtVerifier,
} from './pinned-jwt-verifier.mts';
import type { PostgresVerifiedIdentitySessionStore } from './postgres-verified-sessions.mts';
import type { PostgresSameDeviceRecovery } from './postgres-same-device-recovery.mts';
import type { DeviceRecoveryProofInput } from './device-recovery-proof.mts';
import type { AtomicDailyClaimBootstrap } from '../claims/atomic-claim-bootstrap.mts';
import { resolveActiveSubgameOrdinal } from '../claims/active-ordinal.mts';
import type { PostgresSeriesWriterStore } from './series-writer-binding.mts';
import { SessionAuthorizationGateway } from './session-authorization-gateway.mts';
import type { TrustedGameplayService } from '../adjudication/trusted-gameplay.mts';
import { validateUntrustedClientCommand } from '../adjudication/client-commands.mts';
import type { SeriesFenceStore } from '../ingress/series-fence.mts';
import type pg from 'pg';
import { OrdinalIntegrityError } from '../claims/active-ordinal.mts';
import { evaluateLeaderboardReadEligibility } from '../results/f2a-publication-schema.mts';
import {
  F2C_CATEGORIES,
  F2C_PAGE_SIZE_LIMIT,
  visibleWeekStarts,
  type F2CCategory,
  type F2CRankingService,
} from '../results/f2c-rankings.mts';
import { loadPlayerBadgeCollection } from '../results/player-badges.mts';
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
  /** Optional, server-controlled candidate; absent means all recovery routes deny. */
  sameDeviceRecovery?: PostgresSameDeviceRecovery;
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
  /**
   * Present only when this process is allowed to read F2 rankings.
   * The UAT server sets it. Production does not construct that server.
   */
  rankings?: F2CRankingService;
  /** Server HMAC key. Never read from the request. */
  provenanceKey?: string;
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
  const diagnosticReports = new DiagnosticReportStore();
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

      // Diagnostic reports are strictly staging/UAT only, behind the same
      // verified JWT, active session, and player rate-limit as gameplay.
      if (path === '/v1/diagnostics/reports' && method === 'POST') {
        if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod') {
          send(res, 404, { error: 'NOT_FOUND' });
          return;
        }
        const raw = await readBody(req);
        if (!raw) {
          send(res, 400, { error: 'MALFORMED_REQUEST' });
          return;
        }
        let payload: unknown;
        try { payload = JSON.parse(raw.toString('utf8')); }
        catch { send(res, 400, { error: 'MALFORMED_REQUEST' }); return; }
        const result = diagnosticReports.submit(session.playerId, payload);
        send(res, result.ok ? 201 : result.status,
          result.ok ? { reportId: result.reportId } : { error: result.error });
        return;
      }

      // Candidate only: UAT server opts in explicitly after schema migration.
      // Existing ranked gate and verified JWT/session checks run before this.
      const recovery = deps.sameDeviceRecovery;
      if (path === '/v1/tournament/devices/register' && method === 'POST') {
        if (!recovery) {
          send(res, 404, { error: 'NOT_FOUND' });
          return;
        }
        const raw = await readBody(req);
        if (!raw) {
          send(res, 400, { error: 'MALFORMED_REQUEST' });
          return;
        }
        let payload: unknown;
        try { payload = JSON.parse(raw.toString('utf8')); }
        catch { send(res, 400, { error: 'MALFORMED_REQUEST' }); return; }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          send(res, 400, { error: 'MALFORMED_REQUEST' });
          return;
        }
        const args = payload as Record<string, unknown>;
        if (typeof args.spkiBase64Url !== 'string' ||
            typeof args.signatureBase64Url !== 'string') {
          send(res, 400, { error: 'MALFORMED_REQUEST' });
          return;
        }
        const outcome = await recovery.registerKey({
          session,
          spkiBase64Url: args.spkiBase64Url,
          signatureBase64Url: args.signatureBase64Url,
        });
        send(res, outcome.ok ? 200 : 409,
          outcome.ok ? outcome.data : { error: outcome.reason });
        return;
      }

      const challengeMatch =
        /^\/v1\/tournament\/series\/([0-9a-f-]{36})\/recovery-challenge$/.exec(path);
      if (challengeMatch && method === 'POST') {
        if (!recovery) {
          send(res, 404, { error: 'NOT_FOUND' });
          return;
        }
        if (req.headers['transfer-encoding'] !== undefined ||
            (req.headers['content-length'] !== undefined &&
             req.headers['content-length'] !== '0')) {
          send(res, 400, { error: 'MALFORMED_REQUEST' });
          return;
        }
        const outcome = await recovery.issueChallenge({
          session, seriesId: challengeMatch[1]!,
        });
        send(res, outcome.ok ? 200 : 409,
          outcome.ok ? outcome.data : { error: outcome.reason });
        return;
      }

      const recoveryMatch =
        /^\/v1\/tournament\/series\/([0-9a-f-]{36})\/recover-writer$/.exec(path);
      if (recoveryMatch && method === 'POST') {
        if (!recovery) {
          send(res, 404, { error: 'NOT_FOUND' });
          return;
        }
        const raw = await readBody(req);
        if (!raw) {
          send(res, 400, { error: 'MALFORMED_REQUEST' });
          return;
        }
        let payload: unknown;
        try { payload = JSON.parse(raw.toString('utf8')); }
        catch { send(res, 400, { error: 'MALFORMED_REQUEST' }); return; }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          send(res, 400, { error: 'MALFORMED_REQUEST' });
          return;
        }
        const data = payload as Record<string, unknown>;
        if (!data.proof || typeof data.proof !== 'object' ||
            Array.isArray(data.proof) ||
            typeof data.signatureBase64Url !== 'string') {
          send(res, 400, { error: 'MALFORMED_REQUEST' });
          return;
        }
        const outcome = await recovery.recover({
          session, seriesId: recoveryMatch[1]!,
          proof: data.proof as DeviceRecoveryProofInput,
          signatureBase64Url: data.signatureBase64Url,
        });
        send(res, outcome.ok ? 200 : 409,
          outcome.ok ? outcome.data : { error: outcome.reason });
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

      const boardMatch = /^\/v1\/tournament\/series\/([0-9a-f-]{36})\/board$/.exec(path);
      if (boardMatch && method === 'GET') {
        await sendOwnedBoard(res, deps, session.playerId, boardMatch[1]!);
        return;
      }
      const resultsMatch = /^\/v1\/tournament\/series\/([0-9a-f-]{36})\/results$/.exec(path);
      if (resultsMatch && method === 'GET') {
        await sendOwnedResults(res, deps, session.playerId, resultsMatch[1]!);
        return;
      }
      if (path === '/v1/tournament/leaderboards/weeks' && method === 'GET') {
        await sendVisibleWeeks(res, deps);
        return;
      }
      if (path === '/v1/tournament/leaderboards/daily' && method === 'GET') {
        await sendLeaderboard(res, deps, session.playerId, 'daily', url);
        return;
      }
      if (path === '/v1/tournament/leaderboards/weekly' && method === 'GET') {
        await sendLeaderboard(res, deps, session.playerId, 'weekly', url);
        return;
      }
      if (path === '/v1/tournament/me/badges' && method === 'GET') {
        await sendPlayerBadges(res, deps, session.playerId, url);
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

const ORDINAL_LABEL = ['', 'E1', 'E2', 'E3', 'M1', 'M2', 'H1'] as const;

function parseCategory(value: string | null): F2CCategory | null {
  if (!value) return null;
  return (F2C_CATEGORIES as readonly string[]).includes(value) ? (value as F2CCategory) : null;
}

function parsePageSize(value: string | null): number | null {
  if (value === null || value === '') return 50;
  if (!/^[1-9][0-9]{0,3}$/.test(value)) return null;
  const size = Number(value);
  if (size < 1 || size > F2C_PAGE_SIZE_LIMIT) return null;
  return size;
}

async function sendOwnedBoard(
  res: ServerResponse,
  deps: TournamentHttpDeps,
  playerId: string,
  seriesId: string,
): Promise<void> {
  const claim = await deps.claims.getClaimForPlayer(playerId, seriesId);
  if (!claim) {
    send(res, 404, { error: 'SERIES_NOT_OWNED' });
    return;
  }
  let ordinal: number;
  try {
    ordinal = await resolveActiveSubgameOrdinal(deps.pool, seriesId, playerId);
  } catch (error) {
    if (error instanceof OrdinalIntegrityError) {
      send(res, 409, { error: 'SERIES_STATE_INCONSISTENT' });
      return;
    }
    throw error;
  }
  const snap = await deps.pool.query(
    `SELECT state_json, board_revision, score, status, terminal_reason, state_hash
     FROM authoritative_game_snapshot
     WHERE series_key = $1 AND player_id = $2 AND subgame_ordinal = $3`,
    [seriesId, playerId, ordinal],
  );
  const fence = await deps.fence.get(seriesId);
  const writer = await deps.writers.get(seriesId);
  const now = await deps.pool.query(
    `SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS ms`,
  );
  if (!snap.rowCount || !fence || !writer) {
    send(res, 409, { error: 'SERIES_STATE_INCONSISTENT' });
    return;
  }
  const row = snap.rows[0]!;
  send(res, 200, {
    seriesId,
    ordinal,
    ordinalLabel: ORDINAL_LABEL[ordinal] ?? String(ordinal),
    status: claim.status,
    fenceStatus: fence.status,
    boardRevision: fence.boardRevision,
    score: Number(row.score),
    seriesScore: fence.score,
    gameStatus: String(row.status),
    terminalReason: row.terminal_reason === null ? null : String(row.terminal_reason),
    stateHash: String(row.state_hash),
    state: row.state_json,
    writerGeneration: writer.writerGeneration,
    idleDeadlineAtMs: fence.idleDeadlineAt.getTime(),
    serverNowMs: Number(now.rows[0]?.ms),
    awaitAdvance: fence.status === 'AWAIT_ADVANCE',
    resultsPublished: fence.resultsPublished,
  });
}

/**
 * PZD-43 candidate: authenticated player's badge collection.
 * Bound to the verified session player id — query playerId is ignored.
 */
async function sendPlayerBadges(
  res: ServerResponse,
  deps: TournamentHttpDeps,
  playerId: string,
  url: URL,
): Promise<void> {
  const limitRaw = url.searchParams.get('grantLimit');
  let grantLimit: number | undefined;
  if (limitRaw !== null && limitRaw !== '') {
    if (!/^[1-9][0-9]{0,3}$/.test(limitRaw)) {
      send(res, 400, { error: 'MALFORMED_REQUEST' });
      return;
    }
    grantLimit = Number(limitRaw);
  }
  const payload = await loadPlayerBadgeCollection(deps.pool, playerId, {
    grantLimit,
  });
  send(res, 200, payload);
}

async function sendOwnedResults(
  res: ServerResponse,
  deps: TournamentHttpDeps,
  playerId: string,
  seriesId: string,
): Promise<void> {
  const claim = await deps.claims.getClaimForPlayer(playerId, seriesId);
  if (!claim) {
    send(res, 404, { error: 'SERIES_NOT_OWNED' });
    return;
  }
  if (!deps.provenanceKey) {
    send(res, 404, { error: 'NOT_FOUND' });
    return;
  }
  const eligibility = await evaluateLeaderboardReadEligibility(deps.pool, seriesId, {
    provenanceKey: deps.provenanceKey,
  });
  if (!eligibility.authorized) {
    send(res, 409, { error: eligibility.reason });
    return;
  }
  if (eligibility.playerId !== playerId) {
    send(res, 404, { error: 'SERIES_NOT_OWNED' });
    return;
  }
  const games = await deps.pool.query(
    `SELECT subgame_ordinal, score
     FROM tournament_verified_subgame_score
     WHERE series_id = $1
     ORDER BY subgame_ordinal`,
    [seriesId],
  );
  send(res, 200, {
    seriesId,
    originalUtcDate: eligibility.originalUtcDate,
    easy: eligibility.easy,
    medium: eligibility.medium,
    hard: eligibility.hard,
    all: eligibility.all,
    onTimeAwarded: eligibility.onTimeAwarded,
    games: games.rows.map((row) => ({
      ordinal: Number(row.subgame_ordinal),
      label: ORDINAL_LABEL[Number(row.subgame_ordinal)] ?? String(row.subgame_ordinal),
      score: Number(row.score),
    })),
  });
}

async function sendVisibleWeeks(res: ServerResponse, deps: TournamentHttpDeps): Promise<void> {
  if (!deps.rankings) {
    send(res, 404, { error: 'NOT_FOUND' });
    return;
  }
  const now = await deps.pool.query(
    `SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS ms`,
  );
  const nowMs = Number(now.rows[0]?.ms);
  send(res, 200, { weeks: visibleWeekStarts(nowMs), serverNowMs: nowMs });
}

async function sendLeaderboard(
  res: ServerResponse,
  deps: TournamentHttpDeps,
  playerId: string,
  board: 'daily' | 'weekly',
  url: URL,
): Promise<void> {
  if (!deps.rankings) {
    send(res, 404, { error: 'NOT_FOUND' });
    return;
  }
  const category = parseCategory(url.searchParams.get('category'));
  const pageSize = parsePageSize(url.searchParams.get('pageSize'));
  if (!category || pageSize === null) {
    send(res, 400, { error: 'MALFORMED_REQUEST' });
    return;
  }
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const period = board === 'daily'
    ? url.searchParams.get('date')
    : url.searchParams.get('weekStart');
  if (!period || !/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    send(res, 400, { error: 'MALFORMED_REQUEST' });
    return;
  }
  const result = board === 'daily'
    ? await deps.rankings.readDaily({ date: period, category, pageSize, cursor })
    : await deps.rankings.readWeekly({ weekStart: period, category, pageSize, cursor });
  if (!result.ok) {
    send(res, result.reason === 'SNAPSHOT_CHANGED' ? 409 : 400, { error: result.reason });
    return;
  }
  const self = result.rows.find((row) => row.playerId === playerId) ?? null;
  send(res, 200, {
    board: result.board,
    period: result.period,
    category: result.category,
    state: result.state,
    revision: result.revision,
    settlementId: result.settlementId,
    pageSize: result.pageSize,
    cursor: result.cursor,
    nextCursor: result.nextCursor,
    self: self
      ? { score: self.score, rank: self.rank, onTimeAwarded: self.onTimeAwarded }
      : null,
    rows: result.rows.map((row) => ({
      score: row.score,
      rank: row.rank,
      displayPosition: row.displayPosition,
      onTimeAwarded: row.onTimeAwarded,
      self: row.playerId === playerId,
    })),
  });
}

async function handleSession(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  deps: TournamentHttpDeps,
): Promise<void> {
  if (!['POST', 'GET', 'DELETE', 'PATCH'].includes(method)) {
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
      // Caller-owned internal player id only — never another player's id.
      playerId: session.playerId,
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
  if (method === 'PATCH') {
    // No new writer binding or device handoff: only the same active session
    // is extended, subject to the existing verified JWT expiration ceiling.
    const renewed = await deps.sessions.renewActiveSession(identity, secret);
    if (!renewed) {
      send(res, 401, { error: 'UNAUTHENTICATED' });
      return;
    }
    send(res, 200, {
      playerId: renewed.playerId,
      sessionId: renewed.sessionId,
      deviceId: renewed.deviceId,
      expiresAtMs: renewed.expiresAtMs,
    });
    return;
  }
  send(res, 200, {
    playerId: verified.playerId,
    sessionId: verified.sessionId,
    deviceId: verified.deviceId,
    expiresAtMs: verified.expiresAtMs,
  });
}

/** Backward-compatible alias for earlier internal session path tests. */
export { createInternalSessionHttpHandler } from './internal-session-http.mts';
