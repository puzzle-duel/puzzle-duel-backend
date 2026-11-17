/**
 * PZD-40 internal HTTP session boundary. NOT a production tournament route,
 * not a provider OAuth login or a valid claim of complete ranked auth.
 * Requires a deployment-pinned issuer verifier and real PostgreSQL sessions.
 * No HTTP request field can assert internal playerId or writerGeneration.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { JwtVerificationError, type PinnedRs256JwtVerifier } from './pinned-jwt-verifier.mts';
import type { PostgresVerifiedIdentitySessionStore } from './postgres-verified-sessions.mts';
import {
  RANKED_HTTP_DISABLED_ERROR,
  resolveRankedHttpFeatureGate,
  type RankedHttpGateConfig,
} from './ranked-feature-gate.mts';

function send(res: ServerResponse, status: number, data: unknown) {
  const body = status === 204 ? '' : JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}
export function createInternalSessionHttpHandler(deps: {
  verifier: PinnedRs256JwtVerifier;
  sessions: PostgresVerifiedIdentitySessionStore;
  /** Server-side gate; defaults to env. Never from the request. */
  rankedHttpGate?: RankedHttpGateConfig;
  /**
   * Optional injected runtime env — may ONLY tighten denial (P0-FG02).
   * Never overrides real process.env.NODE_ENV=production|prod.
   */
  actualRuntimeEnv?: NodeJS.ProcessEnv;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
    if (req.url !== '/internal/tournament/session' ||
        !['POST','GET','DELETE'].includes(req.method ?? '')) {
      send(res,404,{error:'NOT_FOUND'});
      return;
    }
    // No JSON body is accepted: cannot provide alleged playerId/device/session.
    const length = req.headers['content-length'];
    if (req.headers['transfer-encoding'] !== undefined ||
        (length !== undefined && length !== '0')) {
      send(res,400,{error:'MALFORMED_REQUEST'});
      return;
    }
    try {
      const identity = deps.verifier.verifyAuthorizationHeader(req.headers.authorization);
      if (req.method === 'POST') {
        const session = await deps.sessions.openAfterVerifiedJwt(identity);
        send(res,201,{
          sessionSecret:session.sessionSecret,
          sessionId:session.sessionId,
          deviceId:session.deviceId,
          expiresAtMs:session.expiresAtMs,
        });
        return;
      }
      const secret = req.headers['x-pzd-session-secret'];
      if (typeof secret !== 'string') {
        send(res,401,{error:'UNAUTHENTICATED'});
        return;
      }
      const verified = await deps.sessions.authenticateVerifiedSession(identity,secret);
      if (!verified) {
        send(res,401,{error:'UNAUTHENTICATED'});
        return;
      }
      if (req.method === 'DELETE') {
        await deps.sessions.revokeSession(identity,secret);
        send(res,204,{});
        return;
      }
      // No playerId is exposed by this proof endpoint; linked verified
      // internal ID stays in server-owned auth/session context only.
      send(res,200,{
        sessionId:verified.sessionId,
        deviceId:verified.deviceId,
        expiresAtMs:verified.expiresAtMs,
      });
    } catch(error) {
      if (error instanceof JwtVerificationError || (error instanceof Error && error.message==='UNAUTHENTICATED')) {
        send(res,401,{error:'UNAUTHENTICATED'});
        return;
      }
      send(res,503,{error:'AUTH_UNAVAILABLE'});
    }
  };
}
