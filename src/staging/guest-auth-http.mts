import type { IncomingMessage, ServerResponse } from 'node:http';
import { GuestCredentialError } from './guest-auth-service.mts';

// Server-local diagnostic metadata; never serialized into HTTP response headers.
const guestAuthReasons = new WeakMap<ServerResponse, string>();
export function guestAuthDiagnosticReason(res: ServerResponse): string | undefined {
  return guestAuthReasons.get(res);
}

export interface GuestAuthGateway {
  create(): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }>;
  refresh(token: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }>;
  logout(token: string): Promise<void>;
}

export function createGuestAuthHttpHandler(gateway: GuestAuthGateway) {
  // Defense in depth; production deployment also requires a shared proxy
  // limiter because this in-memory limit is per process.
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = req.url?.split('?')[0];
    if (!['/v1/auth/guest', '/v1/auth/refresh', '/v1/auth/logout'].includes(path ?? '')) return false;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'application/json');
    const reply = (status: number, data: object) => {
      res.writeHead(status);
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'POST' || req.url !== path) {
      reply(405, { error: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    // Only accept HTTPS requests terminated by the explicitly configured
    // loopback reverse proxy. Never expose this handler on a public listener.
    if (req.headers['x-forwarded-proto'] !== 'https') {
      reply(403, { error: 'HTTPS_REQUIRED' });
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
      const entry = prior && prior.resetAt > now
        ? prior : { count: 0, resetAt: now + 60000 };
      entry.count++;
      attempts.set(peer, entry);
      if (entry.count > 30 || attempts.size > 10000) {
        reply(429, { error: 'RATE_LIMITED' });
        return true;
      }
      if (!req.headers['content-type']?.startsWith('application/json')) {
        reply(415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
        return true;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 2048) {
          reply(413, { error: 'PAYLOAD_TOO_LARGE' });
          return true;
        }
        chunks.push(bytes);
      }
      let payload: unknown;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reply(400, { error: 'INVALID_JSON' }); return true; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        reply(400, { error: 'INVALID_REQUEST' });
        return true;
      }
      const data = payload as Record<string, unknown>;
      if (path === '/v1/auth/guest') {
        if (Object.keys(data).length !== 0) {
          reply(400, { error: 'INVALID_REQUEST' });
          return true;
        }
        reply(201, await gateway.create());
        return true;
      }
      if (Object.keys(data).length !== 1 || typeof data.refreshToken !== 'string') {
        reply(400, { error: 'INVALID_REQUEST' });
        return true;
      }
      if (path === '/v1/auth/refresh') {
        reply(200, await gateway.refresh(data.refreshToken));
      } else {
        await gateway.logout(data.refreshToken);
        // Local-only audit marker for a confirmed explicit guest logout.
        // Never expose the marker or token as HTTP headers or response fields.
        guestAuthReasons.set(res, 'GUEST_LOGOUT_REVOKED');
        reply(200, { status: 'revoked' });
      }
    } catch (error) {
      if (error instanceof GuestCredentialError) {
        // Only fixed, allowlisted refresh failure categories enter staging HTTP diagnostics.
        // Do not record credentials, request bodies, player identity or arbitrary exception text.
        if (path === '/v1/auth/refresh') guestAuthReasons.set(res, error.diagnosticReason ?? error.code);
        reply(401, { error: error.code });
      } else {
        // Do not expose credentials, database details or exception text.
        reply(503, { error: 'AUTH_UNAVAILABLE' });
      }
    }
    return true;
  };
}
