/**
 * Judgment port configuration: where the engine's Jev readings are answered,
 * where the API key comes from, and which model or alias the batteries use. Every composition root builds its port from these settings over
 * judgmentConfigFromEnv (runtime/judgment-services.ts), so an empty setting
 * means the standard TypeSafe environment variable decides.
 */
import { type ConfigSettingDefinition, intRange } from './schema-shared.js';
import type { JudgmentSettings } from './schema-types-judgment.js';
import type { ConfigSetting } from './schema-types.js';
import { validJudgmentFallbackSettings } from './judgment-fallback-settings.js';

export const judgmentConfigDefaults: { judgment: JudgmentSettings } = {
  judgment: {
    endpoint: '',
    keySource: 'env',
    model: '',
    timeoutMs: 10_000,
    fallbacks: [],
  },
};

function isEndpoint(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value === '') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export const judgmentConfigSettings: (ConfigSettingDefinition | ConfigSetting)[] = [
  {
    key: 'judgment.endpoint',
    type: 'string',
    default: '',
    description: 'System One endpoint the engine asks for judgments; empty uses TYPESAFE_BASE_URL, then the hosted endpoint. A loopback address selects a local model',
    validate: isEndpoint,
    validationHint: 'empty, or an http(s) URL',
  },
  {
    key: 'judgment.keySource',
    type: 'enum',
    default: 'env',
    description: 'Which place the judgment API key is read from, env (TYPESAFE_API_KEY in the process environment) or secret (TYPESAFE_API_KEY in the secret store); the setting names the place, not the key',
    enumValues: ['env', 'secret'],
  },
  {
    key: 'judgment.model',
    type: 'string',
    default: '',
    description: 'Judgment model or alias; empty uses TYPESAFE_DEFAULT_MODEL, then jev-latest',
  },
  {
    key: 'judgment.fallbacks',
    type: 'object',
    default: [],
    description: 'Ordered array of zero to eight System One fallback objects. Each object has exactly endpoint, model, keySource and keyName. endpoint is an HTTP or HTTPS URL without embedded credentials, query or fragment. model is a Jev model name or alias such as jev-latest; it must match the requested primary model. keySource is env or secret; keyName names the environment variable or native secret-store entry from which the runtime privately resolves the API key. This setting accepts only that reference name, never a credential value or an inline apiKey field. An empty array disables fallbacks, including inherited fallbacks.',
    validate: validJudgmentFallbackSettings,
    validationHint: 'array of { endpoint, model, keySource: "env" | "secret", keyName }, at most eight compatible targets; no credentials in URLs or inline keys',
  },
  {
    key: 'judgment.timeoutMs',
    type: 'number',
    default: 10000,
    description: 'Timeout per judgment attempt in milliseconds',
    ...intRange(1000, 120000),
  },
];
