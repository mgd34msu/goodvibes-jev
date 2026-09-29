/**
 * Judgment port configuration: where the engine's Jev readings are answered,
 * where the API key comes from, and which model version the batteries are
 * tuned on. Every composition root builds its port from these settings over
 * judgmentConfigFromEnv (runtime/judgment-services.ts), so an empty setting
 * means the standard TypeSafe environment variable decides.
 */
import { type ConfigSettingDefinition, intRange } from './schema-shared.js';
import type { JudgmentSettings } from './schema-types-judgment.js';

export const judgmentConfigDefaults: { judgment: JudgmentSettings } = {
  judgment: {
    endpoint: '',
    keySource: 'env',
    model: '',
    timeoutMs: 10_000,
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

export const judgmentConfigSettings: ConfigSettingDefinition[] = [
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
    description: 'Versioned judgment model the batteries are tuned on; empty uses TYPESAFE_DEFAULT_MODEL, then the pinned version',
  },
  {
    key: 'judgment.timeoutMs',
    type: 'number',
    default: 10000,
    description: 'Timeout per judgment attempt in milliseconds',
    ...intRange(1000, 120000),
  },
];
