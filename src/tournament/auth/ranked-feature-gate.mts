/**
 * PZD-40 P0 — production-disabled ranked HTTP feature gate.
 *
 * Fail-closed / default-deny. Server-side configuration only.
 * Request headers, query strings, and bodies MUST NEVER influence this gate.
 *
 * ENABLED only when BOTH:
 *   1) runtime profile is exactly `test` or `development`
 *   2) enable flag is exactly the string `true`
 *
 * Production, missing, empty, unknown, or malformed configuration → DISABLED.
 * A production profile can never enable ranked HTTP even if the flag is `true`.
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
   * `production` / missing / unknown → deny.
   */
  runtimeProfile?: string | null | undefined;
};

export type RankedHttpGateDecision =
  | { enabled: true }
  | { enabled: false; denyReason: string };

/**
 * Resolve ranked HTTP availability. Pure; no I/O; no request context.
 */
export function resolveRankedHttpFeatureGate(
  config: RankedHttpGateConfig = rankedHttpGateConfigFromEnv(),
): RankedHttpGateDecision {
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
 * Prefer `PZD_RUNTIME_PROFILE`; fall back to `NODE_ENV` only as a profile hint.
 */
export function rankedHttpGateConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RankedHttpGateConfig {
  return {
    enableFlag: env.PZD_RANKED_HTTP_ENABLED,
    runtimeProfile: env.PZD_RUNTIME_PROFILE ?? env.NODE_ENV,
  };
}

/** Explicit allowlisted test/dev config for harnesses — never for production. */
export function explicitTestRankedHttpGateConfig(): RankedHttpGateConfig {
  return { enableFlag: 'true', runtimeProfile: 'test' };
}
