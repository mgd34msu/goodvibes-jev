import type { Fetch, RetryPolicy } from '@typesafe-ai/sdk';
import { JudgmentError } from './errors.ts';

/** The hosted System One endpoint. */
export const HOSTED_BASE_URL = 'https://api.typesafe.ai';

/**
 * The model every battery is tuned against. Thresholds are calibrated on a
 * specific version, so the port pins it instead of following an alias that
 * can move under us (docs.typesafe.ai/models).
 */
export const PINNED_MODEL = 'jev-1.13.0';

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

export interface JudgmentConfig {
  readonly endpoint: JudgmentEndpoint;
  /** The versioned model id to ask; defaults to {@link PINNED_MODEL}. */
  readonly model: string;
  /** Timeout per attempt in milliseconds. */
  readonly timeoutMs: number;
  /** Retry overrides for rate limits, overload and connection failures. */
  readonly retry: Partial<RetryPolicy>;
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
  return {
    endpoint: { kind: endpointKind(baseURL), baseURL, apiKey },
    model: overrides.model ?? (env['TYPESAFE_DEFAULT_MODEL']?.trim() || PINNED_MODEL),
    timeoutMs: overrides.timeoutMs ?? 10_000,
    retry: overrides.retry ?? {},
    ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
  };
}
