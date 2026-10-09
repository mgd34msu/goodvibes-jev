/** Owned, nonpersistent inputs and the working persisted view of one manager. */
import { CONFIG_SCHEMA, type ConfigKey, type ConfigValue, type GoodVibesConfig } from './schema.js';
import { ConfigError } from '../types/errors.js';
import { coerceSchemaValue } from './manager-bootstrap.js';
import { readDotPath } from './shared-config-tier.js';
import { stripFrozenDefaults, writeRawDotPath } from './settings-io.js';
import type { ConfigKeyTier } from './manager-key-source.js';

/** Dot-segment ancestry, never an arbitrary string prefix. */
export function withinConfigPath(key: string, path: string): boolean {
  return key === path || key.startsWith(`${path}.`);
}

/** Capture only plain JSON-shaped values, without invoking getters or toJSON. */
function capture(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('unsupported configuration value');
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error('unsupported configuration object');
  }
  ancestors.add(value);
  try {
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('unsupported property');
      if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) throw new Error('unsupported array property');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('unsupported property descriptor');
      (result as Record<string, unknown>)[key] = capture(descriptor.value, ancestors);
    }
    if (Array.isArray(value) && Object.keys(result).length !== value.length) throw new Error('sparse array');
    return result;
  } finally { ancestors.delete(value); }
}

function freezeCaptured(value: unknown): unknown {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeCaptured(nested);
    Object.freeze(value);
  }
  return value;
}

/** One strict admission path for constructor aliases and frontend helpers. */
export function captureRuntimeValue<K extends ConfigKey>(key: K, value: unknown): ConfigValue<K> {
  const schema = CONFIG_SCHEMA.find(setting => setting.key === key);
  if (!schema) throw new ConfigError('Unknown config key: runtime configuration requires a builtin schema key.');
  // The current structured schema leaves are atomic. Do not silently introduce
  // overlapping runtime authority if the schema grows a descendant later.
  if (CONFIG_SCHEMA.some(setting => setting.key !== key &&
    (withinConfigPath(setting.key, key) || withinConfigPath(key, setting.key)))) {
    throw new ConfigError(`Runtime setting ${key} has overlapping schema paths.`);
  }
  try {
    const owned = freezeCaptured(capture(coerceSchemaValue(key, schema, capture(value))));
    const validType = schema.type === 'enum'
      ? typeof owned === 'string' && schema.enumValues?.includes(owned)
      : schema.type === 'object'
        ? owned !== null && typeof owned === 'object' && !Array.isArray(owned)
        : typeof owned === schema.type;
    if (!validType || (schema.validate && !schema.validate(owned))) throw new Error('invalid');
    return capture(owned) as ConfigValue<K>;
  } catch {
    // No raw values, borrowed validator errors, URLs, or argv in diagnostics.
    throw new ConfigError(`Invalid runtime value for ${key}.`);
  }
}

export class ConfigRuntimeState {
  readonly defaults = new Map<ConfigKey, unknown>();
  readonly overrides = new Map<ConfigKey, unknown>();
  /** Origin of the accepted/post-write non-runtime working value. */
  readonly sources = new Map<string, ConfigKeyTier>();

  constructor(public nonRuntime: GoodVibesConfig) {}

  fork(): ConfigRuntimeState {
    const result = new ConfigRuntimeState(structuredClone(this.nonRuntime));
    for (const [key, value] of this.defaults) result.defaults.set(key, structuredClone(value));
    for (const [key, value] of this.overrides) result.overrides.set(key, structuredClone(value));
    for (const [key, tier] of this.sources) result.sources.set(key, tier);
    return result;
  }

  recordLayer(raw: Record<string, unknown>, tier: ConfigKeyTier, prefix = ''): void {
    for (const [field, value] of Object.entries(raw)) {
      const path = prefix ? `${prefix}.${field}` : field;
      this.sources.set(path, tier);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        this.recordLayer(value as Record<string, unknown>, tier, path);
      }
    }
  }

  compose(): GoodVibesConfig {
    const effective = structuredClone(this.nonRuntime) as unknown as Record<string, unknown>;
    for (const [key, value] of this.defaults) {
      if (!this.sources.has(key)) writeRawDotPath(effective, key, structuredClone(value));
    }
    for (const [key, value] of this.overrides) writeRawDotPath(effective, key, structuredClone(value));
    return effective as unknown as GoodVibesConfig;
  }

  retire(path?: string): void {
    for (const key of this.overrides.keys()) if (path === undefined || withinConfigPath(key, path)) this.overrides.delete(key);
  }

  mark(path: string, tier?: ConfigKeyTier): void {
    for (const key of this.sources.keys()) if (withinConfigPath(key, path)) this.sources.delete(key);
    if (tier) {
      const found = readDotPath(this.nonRuntime, path);
      if (!found.present) return;
      this.sources.set(path, tier);
      if (found.value !== null && typeof found.value === 'object' && !Array.isArray(found.value)) {
        this.recordLayer(found.value as Record<string, unknown>, tier, path);
      }
    }
  }

  bulkSnapshot(): Record<string, unknown> {
    const { config } = stripFrozenDefaults(structuredClone(this.nonRuntime) as unknown as Record<string, unknown>);
    // An explicit shipped-default value may suppress a different frontend
    // default. Preserve that accepted choice without persisting either map.
    for (const key of this.defaults.keys()) {
      if (this.sources.has(key)) {
        const found = readDotPath(this.nonRuntime, key);
        if (found.present) writeRawDotPath(config, key, structuredClone(found.value));
      }
    }
    return config;
  }
}
