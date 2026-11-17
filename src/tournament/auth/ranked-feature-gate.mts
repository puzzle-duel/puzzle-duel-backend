/**
 * PZD-40 P0 — production-disabled ranked HTTP feature gate.
 *
 * Fail-closed / default-deny. Server-side configuration only.
 * Request headers, query strings, and bodies MUST NEVER influence this gate.
 *
 * HARD DENY (P0-FG01 / P0-FG02): the real process `NODE_ENV` (`process.env`)
 * is the non-overridable production veto. If it is `production` or `prod`,
 * ranked HTTP is ALWAYS disabled — even when:
 *   - `PZD_RUNTIME_PROFILE=development`
 *   - an injected `rankedHttpGate` claims enablement
 *   - an injected `actualRuntimeEnv` / `injectedRuntimeEnv` claims `NODE_ENV=test`
 *
 * Injected runtime env may ONLY add restrictions (e.g. also deny when the
 * injected env itself looks like production). It must never loosen a real
 * process.env production veto.
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
   * Optional injected runtime env that may ONLY tighten denial (P0-FG02).
   * Never replaces `process.env` for the production veto.
   * If this env's NODE_ENV is production/prod, deny; if process.env is
   * production/prod, deny regardless of this value.
   */
  injectedRuntimeEnv?: NodeJS.ProcessEnv;
};

function normalizeNodeEnv(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Production hard deny based on NODE_ENV of the given env object.
 * Callers that need the non-overridable veto must pass `process.env`.
 */
export function isNodeEnvProductionHardDeny(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const nodeEnv = normalizeNodeEnv(env.NODE_ENV);
  return nodeEnv === 'production' || nodeEnv === 'prod';
}

/**
 * Resolve ranked HTTP availability.
 *
 * Order (P0-FG02):
 * 1) Real `process.env` production veto — non-overridable
 * 2) Optional injected runtime env — may only add a production deny
 * 3) Profile / enable-flag checks (fail-closed)
 */
export function resolveRankedHttpFeatureGate(
  config: RankedHttpGateConfig = rankedHttpGateConfigFromEnv(),
  options: RankedHttpGateResolveOptions = {},
): RankedHttpGateDecision {
  // Non-overridable: actual process production always wins.
  if (isNodeEnvProductionHardDeny(process.env)) {
    return {
      enabled: false,
      denyReason: 'node_env_production_hard_deny',
    };
  }

  // Injection may only tighten (deny if injected env looks like production).
  if (
    options.injectedRuntimeEnv !== undefined &&
    isNodeEnvProductionHardDeny(options.injectedRuntimeEnv)
  ) {
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
