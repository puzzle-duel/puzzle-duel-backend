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
  isNodeEnvProductionHardDeny,
  rankedHttpGateConfigFromEnv,
  resolveRankedHttpFeatureGate,
} from '../../../src/tournament/auth/ranked-feature-gate.mts';

/** Non-production actual env so harness NODE_ENV cannot hard-deny enable proofs. */
const NON_PROD_ACTUAL = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
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
    const opts = { actualEnv: NON_PROD_ACTUAL };
    assert.equal(resolveRankedHttpFeatureGate({}, opts).enabled, false);
    assert.equal(
      resolveRankedHttpFeatureGate({ enableFlag: 'true' }, opts).enabled,
      false,
    );
    assert.equal(
      resolveRankedHttpFeatureGate(
        { enableFlag: 'true', runtimeProfile: 'production' },
        opts,
      ).enabled,
      false,
    );
    assert.equal(
      resolveRankedHttpFeatureGate(
        { enableFlag: 'true', runtimeProfile: 'prod' },
        opts,
      ).enabled,
      false,
    );
    assert.equal(
      resolveRankedHttpFeatureGate(
        { enableFlag: 'true', runtimeProfile: 'staging' },
        opts,
      ).enabled,
      false,
    );
    assert.equal(
      resolveRankedHttpFeatureGate(
        { enableFlag: 'TRUE', runtimeProfile: 'test' },
        opts,
      ).enabled,
      false,
    );
    assert.equal(
      resolveRankedHttpFeatureGate(
        { enableFlag: '1', runtimeProfile: 'test' },
        opts,
      ).enabled,
      false,
    );
    assert.equal(
      resolveRankedHttpFeatureGate(
        { enableFlag: 'yes', runtimeProfile: 'development' },
        opts,
      ).enabled,
      false,
    );
    assert.equal(
      resolveRankedHttpFeatureGate(
        { enableFlag: '', runtimeProfile: 'test' },
        opts,
      ).enabled,
      false,
    );
  });

  it('ENABLES only for exact test/development + enableFlag true', () => {
    const opts = { actualEnv: NON_PROD_ACTUAL };
    assert.deepEqual(
      resolveRankedHttpFeatureGate(
        { enableFlag: 'true', runtimeProfile: 'test' },
        opts,
      ),
      { enabled: true },
    );
    assert.deepEqual(
      resolveRankedHttpFeatureGate(
        { enableFlag: 'true', runtimeProfile: 'development' },
        opts,
      ),
      { enabled: true },
    );
    assert.deepEqual(
      resolveRankedHttpFeatureGate(explicitTestRankedHttpGateConfig(), opts),
      { enabled: true },
    );
  });

  it('P0-FG01: NODE_ENV=production hard-denies even when profile=development and enable=true', () => {
    assert.equal(
      isNodeEnvProductionHardDeny({
        NODE_ENV: 'production',
      } as NodeJS.ProcessEnv),
      true,
    );
    const contradictory = rankedHttpGateConfigFromEnv({
      NODE_ENV: 'production',
      PZD_RUNTIME_PROFILE: 'development',
      PZD_RANKED_HTTP_ENABLED: 'true',
    } as NodeJS.ProcessEnv);
    // fromEnv must not adopt development profile under NODE_ENV=production
    assert.equal(contradictory.runtimeProfile, 'production');
    const decision = resolveRankedHttpFeatureGate(contradictory, {
      actualEnv: {
        NODE_ENV: 'production',
        PZD_RUNTIME_PROFILE: 'development',
        PZD_RANKED_HTTP_ENABLED: 'true',
      } as NodeJS.ProcessEnv,
    });
    assert.equal(decision.enabled, false);
    assert.equal(
      !decision.enabled && decision.denyReason,
      'node_env_production_hard_deny',
    );

    // Injected test enable config still hard-denied by actual NODE_ENV=production
    const injected = resolveRankedHttpFeatureGate(
      explicitTestRankedHttpGateConfig(),
      { actualEnv: { NODE_ENV: 'production' } as NodeJS.ProcessEnv },
    );
    assert.equal(injected.enabled, false);
    assert.equal(
      !injected.enabled && injected.denyReason,
      'node_env_production_hard_deny',
    );
  });

  it('env reader never treats client-shaped keys as authority; production cannot enable', () => {
    const fromProd = rankedHttpGateConfigFromEnv({
      NODE_ENV: 'production',
      PZD_RANKED_HTTP_ENABLED: 'true',
      PZD_RUNTIME_PROFILE: 'production',
    } as NodeJS.ProcessEnv);
    assert.equal(
      resolveRankedHttpFeatureGate(fromProd, {
        actualEnv: { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
      }).enabled,
      false,
    );

    const missing = rankedHttpGateConfigFromEnv({} as NodeJS.ProcessEnv);
    assert.equal(
      resolveRankedHttpFeatureGate(missing, {
        actualEnv: {} as NodeJS.ProcessEnv,
      }).enabled,
      false,
    );
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
      actualRuntimeEnv: NON_PROD_ACTUAL,
    });

    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/v1/tournament/session`, {
        method: 'POST',
      });
      assert.equal(res.status, 401);
    });
    assert.equal(verified, 1);
  });

  it('P0-FG01: injected test enable config cannot bypass actual NODE_ENV=production', async () => {
    const counts: Record<string, number> = {};
    let gameplayFactoryCalls = 0;
    const handler = createTournamentHttpHandler({
      verifier: countingProxy(
        {
          verifyAuthorizationHeader() {
            throw new Error('verifier must not run under production hard deny');
          },
        },
        counts,
      ) as unknown as import('../../../src/tournament/auth/pinned-jwt-verifier.mts').PinnedRs256JwtVerifier,
      sessions: countingProxy(
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
      ) as unknown as import('../../../src/tournament/auth/postgres-verified-sessions.mts').PostgresVerifiedIdentitySessionStore,
      claims: countingProxy(
        {
          claimAndBootstrap() {
            throw new Error('claim must not run');
          },
          getClaimForPlayer() {
            throw new Error('getClaim must not run');
          },
        },
        counts,
      ) as unknown as import('../../../src/tournament/claims/atomic-claim-bootstrap.mts').AtomicDailyClaimBootstrap,
      writers: countingProxy(
        {
          get() {
            throw new Error('writers must not run');
          },
        },
        counts,
      ) as unknown as import('../../../src/tournament/auth/series-writer-binding.mts').PostgresSeriesWriterStore,
      fence: countingProxy(
        {
          get() {
            throw new Error('fence must not run');
          },
        },
        counts,
      ) as unknown as import('../../../src/tournament/ingress/series-fence.mts').SeriesFenceStore,
      pool: {} as import('pg').Pool,
      gameplayForSession: () => {
        gameplayFactoryCalls += 1;
        throw new Error('gameplay must not run');
      },
      // Injected enable that previously could soft-bypass — must still hard-deny.
      rankedHttpGate: {
        enableFlag: 'true',
        runtimeProfile: 'development',
      },
      actualRuntimeEnv: {
        NODE_ENV: 'production',
        PZD_RUNTIME_PROFILE: 'development',
        PZD_RANKED_HTTP_ENABLED: 'true',
      } as NodeJS.ProcessEnv,
    });

    await withServer(handler, async (base) => {
      const series = '22222222-2222-4222-8222-222222222222';
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
          },
        });
        assert.equal(res.status, 503, `${a.method} ${a.path}`);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const body = (await res.json()) as { error: string; reason: string };
        assert.equal(body.error, RANKED_HTTP_DISABLED_ERROR);
        assert.equal(body.reason, 'node_env_production_hard_deny');
      }
    });
    assert.deepEqual(counts, {});
    assert.equal(gameplayFactoryCalls, 0);
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
      rankedHttpGate: explicitTestRankedHttpGateConfig(),
      actualRuntimeEnv: {
        NODE_ENV: 'production',
        PZD_RUNTIME_PROFILE: 'development',
        PZD_RANKED_HTTP_ENABLED: 'true',
      } as NodeJS.ProcessEnv,
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
        assert.equal(
          (body as unknown as { reason: string }).reason,
          'node_env_production_hard_deny',
        );
      }
    });
    assert.deepEqual(counts, {});
  });
});
