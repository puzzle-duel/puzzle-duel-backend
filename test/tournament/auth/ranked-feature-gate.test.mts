/**
 * PZD-40 P0 — ranked HTTP feature gate negative/positive security proofs.
 * Gate must deny before any JWT/session/claim/gameplay dependency is invoked.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  RANKED_HTTP_DISABLED_ERROR,
  explicitTestRankedHttpGateConfig,
  rankedHttpGateConfigFromEnv,
  resolveRankedHttpFeatureGate,
} from '../../../src/tournament/auth/ranked-feature-gate.mts';
import { createTournamentHttpHandler } from '../../../src/tournament/auth/tournament-http.mts';
import { createInternalSessionHttpHandler } from '../../../src/tournament/auth/internal-session-http.mts';

function countingProxy<T extends object>(target: T, counts: Record<string, number>): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const key = String(prop);
          counts[key] = (counts[key] ?? 0) + 1;
          return (value as (...a: unknown[]) => unknown).apply(obj, args);
        };
      }
      return value;
    },
  });
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}

describe('PZD-40 P0 ranked HTTP feature gate — resolve', () => {
  it('defaults to DISABLED for missing/empty/unknown/production configs', () => {
    assert.equal(resolveRankedHttpFeatureGate({}).enabled, false);
    assert.equal(
      resolveRankedHttpFeatureGate({ enableFlag: 'true' }).enabled,
      false,
    );
    assert.equal(
      resolveRankedHttpFeatureGate({
        enableFlag: 'true',
        runtimeProfile: 'production',
      }).enabled,
      false,
    );
    assert.equal(
      resolveRankedHttpFeatureGate({
        enableFlag: 'true',
        runtimeProfile: 'prod',
      }).enabled,
      false,
    );
    assert.equal(
      resolveRankedHttpFeatureGate({
        enableFlag: 'true',
        runtimeProfile: 'staging',
      }).enabled,
      false,
    );
    assert.equal(
      resolveRankedHttpFeatureGate({
        enableFlag: 'TRUE',
        runtimeProfile: 'test',
      }).enabled,
      false,
    );
    assert.equal(
      resolveRankedHttpFeatureGate({
        enableFlag: '1',
        runtimeProfile: 'test',
      }).enabled,
      false,
    );
    assert.equal(
      resolveRankedHttpFeatureGate({
        enableFlag: 'yes',
        runtimeProfile: 'development',
      }).enabled,
      false,
    );
    assert.equal(
      resolveRankedHttpFeatureGate({
        enableFlag: '',
        runtimeProfile: 'test',
      }).enabled,
      false,
    );
  });

  it('ENABLES only for exact test/development + enableFlag true', () => {
    assert.deepEqual(
      resolveRankedHttpFeatureGate({
        enableFlag: 'true',
        runtimeProfile: 'test',
      }),
      { enabled: true },
    );
    assert.deepEqual(
      resolveRankedHttpFeatureGate({
        enableFlag: 'true',
        runtimeProfile: 'development',
      }),
      { enabled: true },
    );
    assert.deepEqual(
      resolveRankedHttpFeatureGate(explicitTestRankedHttpGateConfig()),
      { enabled: true },
    );
  });

  it('env reader never treats client-shaped keys as authority; production cannot enable', () => {
    const fromProd = rankedHttpGateConfigFromEnv({
      NODE_ENV: 'production',
      PZD_RANKED_HTTP_ENABLED: 'true',
      PZD_RUNTIME_PROFILE: 'production',
    } as NodeJS.ProcessEnv);
    assert.equal(resolveRankedHttpFeatureGate(fromProd).enabled, false);

    const missing = rankedHttpGateConfigFromEnv({} as NodeJS.ProcessEnv);
    assert.equal(resolveRankedHttpFeatureGate(missing).enabled, false);
  });
});

describe('PZD-40 P0 ranked HTTP feature gate — tournament HTTP deny-before-deps', () => {
  it('disabled gate returns 503 no-store on all ranked routes with zero dep calls', async () => {
    const counts: Record<string, number> = {};
    const verifier = countingProxy(
      {
        verifyAuthorizationHeader() {
          throw new Error('verifier must not run when gate disabled');
        },
      },
      counts,
    );
    const sessions = countingProxy(
      {
        openAfterVerifiedJwt() {
          throw new Error('session open must not run');
        },
        authenticateVerifiedSession() {
          throw new Error('session auth must not run');
        },
        revokeSession() {
          throw new Error('revoke must not run');
        },
      },
      counts,
    );
    const claims = countingProxy(
      {
        claimAndBootstrap() {
          throw new Error('claim must not run');
        },
        getClaimForPlayer() {
          throw new Error('getClaim must not run');
        },
      },
      counts,
    );
    const writers = countingProxy(
      {
        get() {
          throw new Error('writers must not run');
        },
      },
      counts,
    );
    const fence = countingProxy(
      {
        get() {
          throw new Error('fence must not run');
        },
      },
      counts,
    );
    let gameplayFactoryCalls = 0;

    const handler = createTournamentHttpHandler({
      verifier: verifier as never,
      sessions: sessions as never,
      claims: claims as never,
      writers: writers as never,
      fence: fence as never,
      pool: {} as never,
      gameplayForSession: () => {
        gameplayFactoryCalls += 1;
        throw new Error('gameplay must not run');
      },
      // Explicit production-disabled config (not env-dependent).
      rankedHttpGate: {
        enableFlag: 'true',
        runtimeProfile: 'production',
      },
    });

    await withServer(handler, async (base) => {
      const series = '11111111-1111-4111-8111-111111111111';
      const attempts: Array<{ method: string; path: string }> = [
        { method: 'POST', path: '/v1/tournament/session' },
        { method: 'GET', path: '/v1/tournament/session' },
        { method: 'DELETE', path: '/v1/tournament/session' },
        { method: 'POST', path: '/v1/tournament/claims/daily' },
        { method: 'GET', path: `/v1/tournament/series/${series}` },
        { method: 'POST', path: `/v1/tournament/series/${series}/commands` },
      ];

      for (const a of attempts) {
        const res = await fetch(`${base}${a.path}`, {
          method: a.method,
          headers: {
            authorization: 'Bearer fake',
            'x-pzd-session-secret': 'fake',
            'x-pzd-ranked-http-enabled': 'true',
            'x-enable-ranked': '1',
          },
        });
        assert.equal(res.status, 503, `${a.method} ${a.path}`);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const body = (await res.json()) as {
          error: string;
          reason: string;
        };
        assert.equal(body.error, RANKED_HTTP_DISABLED_ERROR);
        assert.equal(body.reason, 'production_runtime_denied');
      }
    });

    assert.deepEqual(counts, {});
    assert.equal(gameplayFactoryCalls, 0);
  });

  it('ignores client query/body enable attempts while remaining disabled by default env', async () => {
    const handler = createTournamentHttpHandler({
      verifier: {
        verifyAuthorizationHeader() {
          throw new Error('must not verify');
        },
      } as never,
      sessions: {} as never,
      claims: {} as never,
      writers: {} as never,
      fence: {} as never,
      pool: {} as never,
      gameplayForSession: () => {
        throw new Error('must not build gameplay');
      },
      rankedHttpGate: {}, // missing → disabled
    });

    await withServer(handler, async (base) => {
      const res = await fetch(
        `${base}/v1/tournament/session?PZD_RANKED_HTTP_ENABLED=true&rankedHttpGate=enabled`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer x',
            'content-type': 'application/json',
            'x-pzd-ranked-http-enabled': 'true',
          },
          body: JSON.stringify({
            PZD_RANKED_HTTP_ENABLED: 'true',
            runtimeProfile: 'test',
            enableFlag: 'true',
          }),
        },
      );
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, RANKED_HTTP_DISABLED_ERROR);
    });
  });

  it('positive: explicit test gate allows handler to reach JWT verification', async () => {
    const { JwtVerificationError } = await import(
      '../../../src/tournament/auth/pinned-jwt-verifier.mts'
    );
    let verified = 0;
    const handler = createTournamentHttpHandler({
      verifier: {
        verifyAuthorizationHeader() {
          verified += 1;
          throw new JwtVerificationError();
        },
      } as never,
      sessions: {} as never,
      claims: {} as never,
      writers: {} as never,
      fence: {} as never,
      pool: {} as never,
      gameplayForSession: () => {
        throw new Error('unreachable');
      },
      rankedHttpGate: explicitTestRankedHttpGateConfig(),
    });

    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/v1/tournament/session`, {
        method: 'POST',
      });
      assert.equal(res.status, 401);
    });
    assert.equal(verified, 1);
  });
});

describe('PZD-40 P0 ranked HTTP feature gate — internal session path', () => {
  it('disabled gate blocks /internal/tournament/session with zero session mutations', async () => {
    const counts: Record<string, number> = {};
    const handler = createInternalSessionHttpHandler({
      // Stubs never invoked when gate is disabled; cast for typecheck only.
      verifier: countingProxy(
        {
          verifyAuthorizationHeader() {
            throw new Error('verifier must not run');
          },
        },
        counts,
      ) as unknown as import('../../../src/tournament/auth/pinned-jwt-verifier.mts').PinnedRs256JwtVerifier,
      sessions: countingProxy(
        {
          openAfterVerifiedJwt() {
            throw new Error('open must not run');
          },
          authenticateVerifiedSession() {
            throw new Error('auth must not run');
          },
          revokeSession() {
            throw new Error('revoke must not run');
          },
        },
        counts,
      ) as unknown as import('../../../src/tournament/auth/postgres-verified-sessions.mts').PostgresVerifiedIdentitySessionStore,
      rankedHttpGate: { enableFlag: 'true', runtimeProfile: 'production' },
    });

    await withServer(handler, async (base) => {
      for (const method of ['POST', 'GET', 'DELETE'] as const) {
        const res = await fetch(`${base}/internal/tournament/session`, {
          method,
          headers: {
            authorization: 'Bearer x',
            'x-pzd-session-secret': 'y',
            'x-pzd-ranked-http-enabled': 'true',
          },
        });
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const body = (await res.json()) as { error: string };
        assert.equal(body.error, RANKED_HTTP_DISABLED_ERROR);
      }
    });
    assert.deepEqual(counts, {});
  });
});
