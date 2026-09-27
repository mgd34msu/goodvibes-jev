/**
 * The judgment port's config types: the `judgment` category shape, the
 * `judgment.*` key union and the value of each key. Defaults and setting
 * definitions live in schema-domain-judgment.ts; the port is built from them in
 * runtime/judgment-services.ts.
 */

/** Where the judgment API key is read from. */
export type JudgmentKeySource = 'env' | 'secret';

export interface JudgmentSettings {
  /** System One endpoint base URL; empty uses TYPESAFE_BASE_URL, then the hosted endpoint. */
  endpoint: string;
  /** `env` reads TYPESAFE_API_KEY from the process environment; `secret` reads it from the secret store. */
  keySource: JudgmentKeySource;
  /** Versioned model the batteries are tuned on; empty uses TYPESAFE_DEFAULT_MODEL, then the pinned model. */
  model: string;
  /** Timeout per judgment attempt in milliseconds. */
  timeoutMs: number;
}

export type JudgmentConfigKey =
  | 'judgment.endpoint'
  | 'judgment.keySource'
  | 'judgment.model'
  | 'judgment.timeoutMs';

/** The value of every `judgment.*` key, folded into ConfigValue with one arm. */
export interface JudgmentConfigValueMap {
  'judgment.endpoint': string;
  'judgment.keySource': JudgmentKeySource;
  'judgment.model': string;
  'judgment.timeoutMs': number;
}
