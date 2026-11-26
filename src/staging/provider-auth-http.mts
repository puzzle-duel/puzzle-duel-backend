import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { issueProviderChallenge } from './provider-challenge.mts';
import {
  PostgresProviderIdentityAuth,
  ProviderAuthError,
} from './provider-identity-service.mts';
import { ProviderJwks } from './provider-jwks.mts';
import type { Provider } from './provider-token-verifier.mts';
import {
  continueChallengeBinding,
  linkChallengeBinding,
} from './staging-access-token.mts';
import type { PinnedRs256JwtVerifier } from '../tournament/auth/pinned-jwt-verifier.mts';
import type pg from 'pg';

const providerAuthReasons = new WeakMap<ServerResponse, string>();
export function providerAuthDiagnosticReason(res: ServerResponse): string | undefined {
  return providerAuthReasons.get(res);
}

export type ProviderAuthConfig = {
  appleAudiences: readonly string[];
  googleAudiences: readonly string[];
};

const PATHS = new Set([
  '/v1/auth/providers/challenge',
  '/v1/auth/providers/login',
  '/v1/auth/providers/link',
  '/v1/auth/providers/recover',
  '/v1/auth/providers/continue',
  '/v1/auth/providers/continue/confirm',
]);

export function createProviderAuthHttpHandler(deps: {
  pool: pg.Pool;
  identity: PostgresProviderIdentityAuth;
  jwks: ProviderJwks;
  config: ProviderAuthConfig;
  guestVerifier: PinnedRs256JwtVerifier;
  /** Exact guest family from access JWT `fid` — never "any family for player". */
  requireExactActiveGuestFamily: (playerId: string, familyId: string) => Promise<boolean>;
}) {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = req.url?.split('?')[0] ?? '';
    if (!PATHS.has(path)) return false;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'application/json');
    const reply = (status: number, data: object, reason?: string) => {
      if (reason) providerAuthReasons.set(res, reason);
      res.writeHead(status);
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'POST') {
      reply(405, { error: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    if (req.headers['x-forwarded-proto'] !== 'https') {
      reply(403, { error: 'HTTPS_REQUIRED' });
      return true;
    }
    if (!deps.config.appleAudiences.length && !deps.config.googleAudiences.length) {
      reply(503, { error: 'AUTH_UNAVAILABLE' }, 'PROVIDER_CONFIG_MISSING');
      return true;
    }
    try {
      const peer = req.socket.remoteAddress ?? 'unknown';
      const now = Date.now();
      if (attempts.size > 10000) {
        for (const [key, entry] of attempts) {
          if (entry.resetAt <= now) attempts.delete(key);
        }
      }
      const prior = attempts.get(peer);
      const entry = prior && prior.resetAt > now ? prior : { count: 0, resetAt: now + 60_000 };
      entry.count += 1;
      attempts.set(peer, entry);
      if (entry.count > 30 || attempts.size > 10000) {
        reply(429, { error: 'RATE_LIMITED' }, 'RATE_LIMITED');
        return true;
      }
      if (!req.headers['content-type']?.startsWith('application/json')) {
        reply(415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
        return true;
      }
      const data = await readJson(req, reply);
      if (!data) return true;
      if (path === '/v1/auth/providers/challenge') {
        return await handleChallenge(deps, data, req, reply);
      }
      if (path === '/v1/auth/providers/login') {
        return await handleLogin(deps, data, reply);
      }
      if (path === '/v1/auth/providers/recover') {
        return await handleRecover(deps, data, reply);
      }
      if (path === '/v1/auth/providers/continue') {
        return await handleContinue(deps, data, req, reply);
      }
      if (path === '/v1/auth/providers/continue/confirm') {
        return await handleContinueConfirm(deps, data, reply);
      }
      return await handleLink(deps, data, req, reply);
    } catch (error) {
      if (error instanceof ProviderAuthError) {
        if (error.code === 'ACCOUNT_SWITCH_CONFIRMATION_REQUIRED') {
          reply(409, {
            error: error.code,
            continuationToken: error.continuationToken,
            expiresAt: error.expiresAt,
          }, error.code);
          return true;
        }
        const status = error.code === 'ACCOUNT_CONFLICT' ? 409
          : error.code === 'AUTH_UNAVAILABLE' ? 503
            : error.code === 'GUEST_PROOF_REQUIRED' ? 401
              : error.code === 'RECOVERY_NOT_LINKED' ? 401
                : error.code === 'INVALID_CONTINUATION' ? 401
                  : 401;
        reply(status, { error: error.code }, error.code);
      } else {
        reply(503, { error: 'AUTH_UNAVAILABLE' }, 'AUTH_UNAVAILABLE');
      }
      return true;
    }
  };
}

async function requireGuestLinkProof(
  deps: {
    guestVerifier: PinnedRs256JwtVerifier;
    requireExactActiveGuestFamily: (playerId: string, familyId: string) => Promise<boolean>;
  },
  req: IncomingMessage,
  reply: (status: number, data: object, reason?: string) => void,
): Promise<{ subject: string; familyId: string } | null> {
  const guest = await tryGuestLinkProof(deps, req);
  if (!guest) {
    reply(401, { error: 'GUEST_PROOF_REQUIRED' }, 'GUEST_PROOF_REQUIRED');
    return null;
  }
  return guest;
}

async function tryGuestLinkProof(
  deps: {
    guestVerifier: PinnedRs256JwtVerifier;
    requireExactActiveGuestFamily: (playerId: string, familyId: string) => Promise<boolean>;
  },
  req: IncomingMessage,
): Promise<{ subject: string; familyId: string } | null> {
  let identity;
  try {
    identity = deps.guestVerifier.verifyAuthorizationHeader(req.headers.authorization);
  } catch {
    return null;
  }
  if (identity.accountType !== 'guest' || !identity.familyId) {
    return null;
  }
  if (!(await deps.requireExactActiveGuestFamily(identity.subject, identity.familyId))) {
    return null;
  }
  return { subject: identity.subject, familyId: identity.familyId };
}

async function handleContinue(
  deps: {
    identity: PostgresProviderIdentityAuth;
    jwks: ProviderJwks;
    config: ProviderAuthConfig;
    guestVerifier: PinnedRs256JwtVerifier;
    requireExactActiveGuestFamily: (playerId: string, familyId: string) => Promise<boolean>;
  },
  data: Record<string, unknown>,
  req: IncomingMessage,
  reply: (status: number, data: object, reason?: string) => void,
): Promise<boolean> {
  const provider = parseProvider(data.provider);
  const keyCount = Object.keys(data).length;
  if (!provider ||
      typeof data.idToken !== 'string' ||
      typeof data.nonce !== 'string' ||
      typeof data.binding !== 'string' ||
      (keyCount !== 4 && keyCount !== 5) ||
      (keyCount === 5 && typeof data.localProgressProtected !== 'boolean')) {
    reply(400, { error: 'INVALID_REQUEST' });
    return true;
  }
  const audiences = audiencesFor(deps.config, provider);
  if (!audiences.length) {
    reply(503, { error: 'AUTH_UNAVAILABLE' }, 'PROVIDER_CONFIG_MISSING');
    return true;
  }
  const guest = await tryGuestLinkProof(deps, req);
  const bundle = await deps.identity.continue({
    provider,
    idToken: data.idToken,
    nonce: data.nonce,
    binding: data.binding,
    guestPlayerId: guest?.subject,
    guestFamilyId: guest?.familyId,
    localProgressProtected: data.localProgressProtected === true,
    audiences,
    keys: await deps.jwks.keys(provider, kidFromToken(data.idToken)),
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  reply(201, {
    playerId: bundle.playerId,
    accountType: bundle.accountType,
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    expiresAt: bundle.expiresAt,
    linkedProviders: bundle.linkedProviders,
    resolution: bundle.resolution,
  }, 'AUTH_CONTINUE_SUCCESS');
  return true;
}

async function handleContinueConfirm(
  deps: {
    identity: PostgresProviderIdentityAuth;
  },
  data: Record<string, unknown>,
  reply: (status: number, data: object, reason?: string) => void,
): Promise<boolean> {
  if (typeof data.continuationToken !== 'string' || Object.keys(data).length !== 1) {
    reply(400, { error: 'INVALID_REQUEST' });
    return true;
  }
  const bundle = await deps.identity.confirmContinue({
    continuationToken: data.continuationToken,
  });
  reply(201, {
    playerId: bundle.playerId,
    accountType: bundle.accountType,
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    expiresAt: bundle.expiresAt,
    linkedProviders: bundle.linkedProviders,
    resolution: bundle.resolution,
  }, 'AUTH_CONTINUE_CONFIRMED');
  return true;
}

async function handleChallenge(
  deps: {
    pool: pg.Pool;
    guestVerifier: PinnedRs256JwtVerifier;
    requireExactActiveGuestFamily: (playerId: string, familyId: string) => Promise<boolean>;
    config: ProviderAuthConfig;
  },
  data: Record<string, unknown>,
  req: IncomingMessage,
  reply: (status: number, data: object, reason?: string) => void,
): Promise<boolean> {
  const provider = parseProvider(data.provider);
  const purpose = data.purpose === 'login' || data.purpose === 'link' ||
      data.purpose === 'continue'
    ? data.purpose
    : null;
  if (!provider || !purpose || Object.keys(data).length !== 2) {
    reply(400, { error: 'INVALID_REQUEST' });
    return true;
  }
  if (!audiencesFor(deps.config, provider).length) {
    reply(503, { error: 'AUTH_UNAVAILABLE' }, 'PROVIDER_CONFIG_MISSING');
    return true;
  }
  if (purpose === 'login') {
    const binding = randomBytes(32).toString('base64url');
    const nonce = await issueProviderChallenge(deps.pool, { provider, purpose, binding });
    reply(201, { provider, purpose, nonce, binding }, 'AUTH_CHALLENGE_ISSUED');
    return true;
  }
  if (purpose === 'continue') {
    // Optional guest: when present, bind to exact family; otherwise mint login-like binding.
    const optionalGuest = await tryGuestLinkProof(deps, req);
    if (optionalGuest) {
      const binding = continueChallengeBinding(
        optionalGuest.subject,
        optionalGuest.familyId,
      );
      const nonce = await issueProviderChallenge(deps.pool, { provider, purpose, binding });
      reply(201, { provider, purpose, nonce, binding }, 'AUTH_CHALLENGE_ISSUED');
      return true;
    }
    const binding = randomBytes(32).toString('base64url');
    const nonce = await issueProviderChallenge(deps.pool, { provider, purpose, binding });
    reply(201, { provider, purpose, nonce, binding }, 'AUTH_CHALLENGE_ISSUED');
    return true;
  }
  const guest = await requireGuestLinkProof(deps, req, reply);
  if (!guest) return true;
  const binding = linkChallengeBinding(guest.subject, guest.familyId);
  const nonce = await issueProviderChallenge(deps.pool, { provider, purpose, binding });
  reply(201, { provider, purpose, nonce }, 'AUTH_CHALLENGE_ISSUED');
  return true;
}

async function handleLogin(
  deps: {
    identity: PostgresProviderIdentityAuth;
    jwks: ProviderJwks;
    config: ProviderAuthConfig;
  },
  data: Record<string, unknown>,
  reply: (status: number, data: object, reason?: string) => void,
): Promise<boolean> {
  const provider = parseProvider(data.provider);
  if (!provider ||
      typeof data.idToken !== 'string' ||
      typeof data.nonce !== 'string' ||
      typeof data.binding !== 'string' ||
      Object.keys(data).length !== 4) {
    reply(400, { error: 'INVALID_REQUEST' });
    return true;
  }
  const audiences = audiencesFor(deps.config, provider);
  if (!audiences.length) {
    reply(503, { error: 'AUTH_UNAVAILABLE' }, 'PROVIDER_CONFIG_MISSING');
    return true;
  }
  reply(201, await deps.identity.login({
    provider,
    idToken: data.idToken,
    nonce: data.nonce,
    binding: data.binding,
    audiences,
    keys: await deps.jwks.keys(provider, kidFromToken(data.idToken)),
    nowSeconds: Math.floor(Date.now() / 1000),
  }), 'AUTH_LOGIN_SUCCESS');
  return true;
}

async function handleRecover(
  deps: {
    identity: PostgresProviderIdentityAuth;
    jwks: ProviderJwks;
    config: ProviderAuthConfig;
  },
  data: Record<string, unknown>,
  reply: (status: number, data: object, reason?: string) => void,
): Promise<boolean> {
  const provider = parseProvider(data.provider);
  if (!provider ||
      typeof data.idToken !== 'string' ||
      typeof data.nonce !== 'string' ||
      typeof data.binding !== 'string' ||
      typeof data.expectedPlayerId !== 'string' ||
      Object.keys(data).length !== 5) {
    reply(400, { error: 'INVALID_REQUEST' });
    return true;
  }
  if (!/^[0-9a-f-]{36}$/i.test(data.expectedPlayerId)) {
    reply(400, { error: 'INVALID_REQUEST' });
    return true;
  }
  const audiences = audiencesFor(deps.config, provider);
  if (!audiences.length) {
    reply(503, { error: 'AUTH_UNAVAILABLE' }, 'PROVIDER_CONFIG_MISSING');
    return true;
  }
  reply(201, await deps.identity.recover({
    provider,
    idToken: data.idToken,
    nonce: data.nonce,
    binding: data.binding,
    expectedPlayerId: data.expectedPlayerId,
    audiences,
    keys: await deps.jwks.keys(provider, kidFromToken(data.idToken)),
    nowSeconds: Math.floor(Date.now() / 1000),
  }), 'AUTH_RECOVERY_SUCCESS');
  return true;
}

async function handleLink(
  deps: {
    identity: PostgresProviderIdentityAuth;
    jwks: ProviderJwks;
    config: ProviderAuthConfig;
    guestVerifier: PinnedRs256JwtVerifier;
    requireExactActiveGuestFamily: (playerId: string, familyId: string) => Promise<boolean>;
  },
  data: Record<string, unknown>,
  req: IncomingMessage,
  reply: (status: number, data: object, reason?: string) => void,
): Promise<boolean> {
  const provider = parseProvider(data.provider);
  if (!provider ||
      typeof data.idToken !== 'string' ||
      typeof data.nonce !== 'string' ||
      Object.keys(data).length !== 3) {
    reply(400, { error: 'INVALID_REQUEST' });
    return true;
  }
  const guest = await requireGuestLinkProof(deps, req, reply);
  if (!guest) return true;
  const audiences = audiencesFor(deps.config, provider);
  if (!audiences.length) {
    reply(503, { error: 'AUTH_UNAVAILABLE' }, 'PROVIDER_CONFIG_MISSING');
    return true;
  }
  reply(201, await deps.identity.link({
    provider,
    idToken: data.idToken,
    nonce: data.nonce,
    guestPlayerId: guest.subject,
    guestFamilyId: guest.familyId,
    audiences,
    keys: await deps.jwks.keys(provider, kidFromToken(data.idToken)),
    nowSeconds: Math.floor(Date.now() / 1000),
  }), 'AUTH_LINK_SUCCESS');
  return true;
}

function parseProvider(value: unknown): Provider | null {
  return value === 'apple' || value === 'google' ? value : null;
}

function audiencesFor(config: ProviderAuthConfig, provider: Provider): readonly string[] {
  return provider === 'apple' ? config.appleAudiences : config.googleAudiences;
}

function kidFromToken(token: string): string {
  const header = token.split('.')[0];
  if (!header || !/^[A-Za-z0-9_-]+$/.test(header)) throw new ProviderAuthError('INVALID_PROVIDER_ASSERTION');
  const parsed: unknown = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProviderAuthError('INVALID_PROVIDER_ASSERTION');
  }
  const kid = (parsed as { kid?: unknown }).kid;
  if (typeof kid !== 'string' || !kid || kid.length > 256) {
    throw new ProviderAuthError('INVALID_PROVIDER_ASSERTION');
  }
  return kid;
}

async function readJson(
  req: IncomingMessage,
  reply: (status: number, data: object, reason?: string) => void,
): Promise<Record<string, unknown> | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 8192) {
      reply(413, { error: 'PAYLOAD_TOO_LARGE' });
      return null;
    }
    chunks.push(bytes);
  }
  try {
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      reply(400, { error: 'INVALID_REQUEST' });
      return null;
    }
    return payload as Record<string, unknown>;
  } catch {
    reply(400, { error: 'INVALID_JSON' });
    return null;
  }
}
