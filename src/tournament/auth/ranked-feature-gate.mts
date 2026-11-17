/**
 * PZD-40 P0 — production-disabled ranked HTTP feature gate.
 *
 * Fail-closed / default-deny. Server-side configuration only.
 * Request headers, query strings, and bodies MUST NEVER influence this gate.
 *
 * HARD DENY (P0-FG01): if the actual process `NODE_ENV` is `production` or `prod`,
 * ranked HTTP is ALWAYS disabled — even when `PZD_RUNTIME_PROFILE=development`
 * and/or an injected test `rankedHttpGate` claims enablement.
 *
 * Otherwise ENABLED only when BOTH:
 *   1) runtime profile is exactly `test` or `development`
 *   2) enable flag is exactly the string `true`
 *
 * Missing, empty, unknown, or malformed configuration → DISABLED.
 */

export const RANKED_HTTP_DISABLED_ERROR = 'RANKED_HTTP_DISABLED' as const;

/** Profiles that may intentionally enable candidate ranked HTTP for tests. */
const ALLOWLISTED_ENABLE_PROFILES = new Set(['test', 'development']);

export type RankedHttpGateConfig = {
  /**
   * Exact enable token. Only the string `true` can enable (with allowlisted profile).
   * Read from server env / bootstrap — never from the client request.
   */
  enableFlag?: string | null | undefined;
  /**
   * Runtime profile. Only `test` | `development` may enable.
   * `production` / missing / unknown → deny (after NODE_ENV hard deny).
   */
  runtimeProfile?: string | null | undefined;
};

export type RankedHttpGateDecision =
  | { enabled: true }
  | { enabled: false; denyReason: string };

export type RankedHttpGateResolveOptions = {
  /**
   * Actual process environment used for the non-overridable NODE_ENV hard deny.
   * Defaults to `process.env`. Injected gate config cannot override this check.
   */
  actualEnv?: NodeJS.ProcessEnv;
};

function normalizeNodeEnv(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Non-overridable production hard deny based on actual NODE_ENV.
 * PZD_RUNTIME_PROFILE and injected rankedHttpGate MUST NOT bypass this.
 */
export function isNodeEnvProductionHardDeny(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const nodeEnv = normalizeNodeEnv(env.NODE_ENV);
  return nodeEnv === 'production' || nodeEnv === 'prod';
}

/**
 * Resolve ranked HTTP availability.
 * Always applies NODE_ENV production hard deny before profile/flag checks.
 */
export function resolveRankedHttpFeatureGate(
  config: RankedHttpGateConfig = rankedHttpGateConfigFromEnv(),
  options: RankedHttpGateResolveOptions = {},
): RankedHttpGateDecision {
  const actualEnv = options.actualEnv ?? process.env;
  if (isNodeEnvProductionHardDeny(actualEnv)) {
    return {
      enabled: false,
      denyReason: 'node_env_production_hard_deny',
    };
  }

  const profile =
    typeof config.runtimeProfile === 'string'
      ? config.runtimeProfile.trim()
      : '';
  const flag =
    typeof config.enableFlag === 'string' ? config.enableFlag.trim() : '';

  if (profile === '' || profile === 'production' || profile === 'prod') {
    return {
      enabled: false,
      denyReason:
        profile === ''
          ? 'missing_runtime_profile'
          : 'production_runtime_denied',
    };
  }
  if (!ALLOWLISTED_ENABLE_PROFILES.has(profile)) {
    return { enabled: false, denyReason: 'unknown_runtime_profile' };
  }
  if (flag !== 'true') {
    return {
      enabled: false,
      denyReason: flag === '' ? 'missing_enable_flag' : 'enable_flag_not_true',
    };
  }
  return { enabled: true };
}

/**
 * Server bootstrap reader. Intentionally ignores any client-supplied values.
 *
 * When actual `NODE_ENV` is production/prod, `runtimeProfile` is forced to
 * `production` so `PZD_RUNTIME_PROFILE=development` cannot soft-enable via
 * profile alone (hard deny still applies independently in resolve).
 */
export function rankedHttpGateConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RankedHttpGateConfig {
  if (isNodeEnvProductionHardDeny(env)) {
    return {
      enableFlag: env.PZD_RANKED_HTTP_ENABLED,
      runtimeProfile: 'production',
    };
  }
  return {
    enableFlag: env.PZD_RANKED_HTTP_ENABLED,
    runtimeProfile: env.PZD_RUNTIME_PROFILE ?? env.NODE_ENV,
  };
}

/** Explicit allowlisted test/dev config for harnesses — never for production. */
export function explicitTestRankedHttpGateConfig(): RankedHttpGateConfig {
  return { enableFlag: 'true', runtimeProfile: 'test' };
}
