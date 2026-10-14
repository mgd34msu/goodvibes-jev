import type { Fetch } from '@typesafe-ai/sdk';
import { JudgmentError } from './errors.ts';
import { retryPolicy, type JudgmentRetryPolicy } from './retry.ts';
import { validEndpointURL } from './endpoint-validation.ts';
export { isPinnedJudgmentModel, validEndpointURL } from './endpoint-validation.ts';

/** The hosted System One endpoint. */
export const HOSTED_BASE_URL = 'https://api.typesafe.ai';

/** Follow TypeSafe's most recent stable Jev release. Responses retain the resolved version. */
export const DEFAULT_MODEL = 'jev-latest';

/**
 * Where judgments are answered. `hosted` is TypeSafe's Jev endpoint; `local`
 * is a System One model the owner runs themselves. Both speak the same wire
 * protocol (POST /v1/systemone), so only the address and key differ.
 */
export interface JudgmentEndpoint {
  readonly kind: 'hosted' | 'local';
  readonly baseURL: string;
  readonly apiKey: string;
}

/** An explicitly configured compatible System One target, in failover order. */
export interface JudgmentFallback {
  readonly endpoint: JudgmentEndpoint;
  /** Requested model or alias. Only matching requests may use this target. */
  readonly model: string;
}

export interface JudgmentConfig {
  readonly endpoint: JudgmentEndpoint;
  /** The model id or alias to ask; defaults to {@link DEFAULT_MODEL}. */
  readonly model: string;
  /** Timeout per attempt in milliseconds. */
  readonly timeoutMs: number;
  /** Backoff between transient failures: a configured chain runs once; primary-only retries persist. */
  readonly retry: Partial<JudgmentRetryPolicy>;
  /** Additional System One targets. No discovery or implicit alternate providers. */
  readonly fallbacks?: readonly JudgmentFallback[];
  /** Custom fetch, for tests and transport configuration. */
  readonly fetch?: Fetch;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** A base URL on a loopback host is a local System One model. */
export function endpointKind(baseURL: string): JudgmentEndpoint['kind'] {
  const host = new URL(baseURL).hostname;
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.') ? 'local' : 'hosted';
}

/**
 * Builds the config from the standard TypeSafe environment variables:
 * TYPESAFE_API_KEY, TYPESAFE_BASE_URL (a loopback address selects a local
 * model) and TYPESAFE_DEFAULT_MODEL.
 */
export function judgmentConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  overrides: Partial<Omit<JudgmentConfig, 'endpoint'>> = {},
): JudgmentConfig {
  const apiKey = env['TYPESAFE_API_KEY']?.trim();
  if (!apiKey) {
    throw new JudgmentError('invalid-request', 'TYPESAFE_API_KEY is not set; the judgment port has no key');
  }
  const baseURL = env['TYPESAFE_BASE_URL']?.trim() || HOSTED_BASE_URL;
  if (!validEndpointURL(baseURL)) throw new JudgmentError('invalid-request', 'invalid System One endpoint URL; credentials, query and fragment are not allowed');
  return {
    endpoint: { kind: endpointKind(baseURL), baseURL, apiKey },
    model: overrides.model ?? (env['TYPESAFE_DEFAULT_MODEL']?.trim() || DEFAULT_MODEL),
    timeoutMs: overrides.timeoutMs ?? 10_000,
    retry: overrides.retry ?? {},
    ...(overrides.fallbacks === undefined ? {} : { fallbacks: overrides.fallbacks }),
    ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
  };
}

/** Validate the complete chain before constructing clients or transmitting state. */
export function validateJudgmentConfig(config: JudgmentConfig): void {
  if (!Array.isArray(config.fallbacks ?? []) || (config.fallbacks?.length ?? 0) > 8) throw new JudgmentError('invalid-request', 'judgment allows at most eight fallback targets');
  const targets = [{ endpoint: config.endpoint, model: config.model }, ...(config.fallbacks ?? [])];
  for (const target of targets) {
    if (!target || !target.endpoint || !['hosted', 'local'].includes(target.endpoint.kind)
      || !validEndpointURL(target.endpoint.baseURL) || typeof target.endpoint.apiKey !== 'string' || !target.endpoint.apiKey.trim()
      || typeof target.model !== 'string' || !target.model.trim()) {
      throw new JudgmentError('invalid-request', 'invalid judgment target; use an http(s) URL without credentials, query or fragment, a model and a resolved key');
    }
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 120_000
    || 'totalTimeoutMs' in config) {
    throw new JudgmentError('invalid-request', 'judgment attempt timeout must be positive bounded milliseconds; total-time limits are not supported');
  }
  retryPolicy(config.retry);
}
