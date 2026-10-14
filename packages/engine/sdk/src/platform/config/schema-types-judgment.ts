/**
 * The judgment port's config types: the `judgment` category shape, the
 * `judgment.*` key union and the value of each key. Defaults and setting
 * definitions live in schema-domain-judgment.ts; the port is built from them in
 * runtime/judgment-services.ts.
 */

/** Where the judgment API key is read from. */
export type JudgmentKeySource = 'env' | 'secret';

/** A compatible endpoint and a credential name, never a credential value. */
export interface JudgmentFallbackSettings {
  readonly endpoint: string;
  readonly model: string;
  readonly keySource: JudgmentKeySource;
  readonly keyName: string;
}

export interface JudgmentSettings {
  /** System One endpoint base URL; empty uses TYPESAFE_BASE_URL, then the hosted endpoint. */
  endpoint: string;
  /** `env` reads TYPESAFE_API_KEY from the process environment; `secret` reads it from the secret store. */
  keySource: JudgmentKeySource;
  /** Judgment model or alias; empty uses TYPESAFE_DEFAULT_MODEL, then jev-latest. */
  model: string;
  /** Timeout per judgment attempt in milliseconds. */
  timeoutMs: number;
  /** Ordered compatible endpoints. An explicit empty list disables inherited fallbacks. */
  fallbacks: readonly JudgmentFallbackSettings[];
}

export type JudgmentConfigKey =
  | 'judgment.endpoint'
  | 'judgment.keySource'
  | 'judgment.model'
  | 'judgment.timeoutMs'
  | 'judgment.fallbacks';

/** The value of every `judgment.*` key, folded into ConfigValue with one arm. */
export interface JudgmentConfigValueMap {
  'judgment.endpoint': string;
  'judgment.keySource': JudgmentKeySource;
  'judgment.model': string;
  'judgment.timeoutMs': number;
  'judgment.fallbacks': readonly JudgmentFallbackSettings[];
}
