import { CONFIG_SCHEMA, DEFAULT_CONFIG, type ConfigKey, type ConfigSetting, type GoodVibesConfig } from './schema.js';
import { configKeyScope } from './config-ownership.js';
import { ConfigError } from '../types/errors.js';
import { readDotPath } from './shared-config-tier.js';
import { deleteRawDotPath, writeRawDotPath } from './settings-io.js';

/**
 * A surface-owned scalar leaf under an existing config category. Registration
 * is per instance, never a change to the SDK's shared schema/defaults. The
 * declared default must be the host's restrictive fallback: absent preferences,
 * malformed stored values, and failed reloads resolve to it.
 *
 * set/setDynamic edit an existing explicit project leaf, otherwise the global
 * leaf. setProjectValue remains explicitly project-scoped. Bulk saves preserve
 * the destination's own host leaves rather than copying effective permissions
 * between tiers. Only literal booleans may be written through scalar setters.
 */
export interface HostBooleanSetting {
  readonly key: string;
  readonly type: 'boolean';
  readonly default: boolean;
  readonly description: string;
}

export type HostSettingValues = Map<string, boolean>;

export function isHostSettingsObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Internal, immutable per-manager registration. Live values stay in config. */
export class HostSettings {
  readonly definitions: readonly Readonly<HostBooleanSetting>[];
  private readonly byKey: ReadonlyMap<string, Readonly<HostBooleanSetting>>;

  constructor(definitions: readonly HostBooleanSetting[] = []) {
    const keys = new Set<string>();
    this.definitions = Object.freeze(definitions.map((definition) => {
      const key = definition.key;
      const parts = typeof key === 'string' ? key.split('.') : [];
      const root = parts[0];
      const leaf = parts[1];
      const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
      if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(part) || unsafe.has(part))
        || !root || !leaf || !Object.hasOwn(DEFAULT_CONFIG, root)
        || !isHostSettingsObject((DEFAULT_CONFIG as unknown as Record<string, unknown>)[root])) {
        throw new ConfigError('A host setting must be a new scalar leaf under an existing config object category.');
      }
      if (keys.has(key) || CONFIG_SCHEMA.some((entry) => entry.key === key)
        || readDotPath(DEFAULT_CONFIG, key).present || configKeyScope(key) !== 'client') {
        throw new ConfigError(`Host setting ${key} collides with a registered or non-client config path.`);
      }
      if (definition.type !== 'boolean' || typeof definition.default !== 'boolean'
        || typeof definition.description !== 'string' || !definition.description.trim()) {
        throw new ConfigError(`Host setting ${key} requires a boolean descriptor, default, and description.`);
      }
      keys.add(key);
      return Object.freeze({ key, type: 'boolean' as const, default: definition.default, description: definition.description });
    }));
    this.byKey = new Map(this.definitions.map((definition) => [definition.key, definition]));
  }

  get active(): boolean { return this.definitions.length > 0; }
  has(key: string): boolean { return this.byKey.has(key); }
  keys(): IterableIterator<string> { return this.byKey.keys(); }

  schema(key: string): ConfigSetting | undefined {
    const definition = this.byKey.get(key);
    return definition ? {
      ...definition, key: definition.key as ConfigKey,
      validate: (value: unknown) => typeof value === 'boolean', validationHint: 'literal boolean',
    } : undefined;
  }

  defaults(): HostSettingValues {
    return new Map(this.definitions.map((definition) => [definition.key, definition.default]));
  }

  snapshot(config: GoodVibesConfig): HostSettingValues {
    return new Map(this.definitions.map((definition) => {
      const value = readDotPath(config, definition.key).value;
      return [definition.key, typeof value === 'boolean' ? value : definition.default];
    }));
  }

  apply(config: GoodVibesConfig, values: HostSettingValues): void {
    for (const [key, value] of values) writeRawDotPath(config as unknown as Record<string, unknown>, key, value);
  }

  /** Missing leaves inherit; present malformed leaves/sections override with default. */
  overlay(values: HostSettingValues, raw: unknown): string[] {
    if (!isHostSettingsObject(raw)) throw new ConfigError('Host settings could not be read from a JSON object.');
    const malformed: string[] = [];
    for (const definition of this.definitions) {
      const [root, leaf] = definition.key.split('.') as [string, string];
      if (!Object.hasOwn(raw, root)) continue;
      const category = raw[root];
      if (!isHostSettingsObject(category)) {
        values.set(definition.key, definition.default);
        malformed.push(definition.key);
      } else if (Object.hasOwn(category, leaf)) {
        const value = category[leaf];
        values.set(definition.key, typeof value === 'boolean' ? value : definition.default);
        if (typeof value !== 'boolean') malformed.push(definition.key);
      }
    }
    return malformed;
  }

  /** Preserve only this destination's host leaves, never transplant effective values. */
  preserveDestination(snapshot: Record<string, unknown>, destination: Record<string, unknown>): void {
    for (const definition of this.definitions) {
      deleteRawDotPath(snapshot, definition.key);
      const [root, leaf] = definition.key.split('.') as [string, string];
      if (!Object.hasOwn(destination, root)) continue;
      const category = destination[root];
      if (!isHostSettingsObject(category)) {
        throw new ConfigError(`Cannot preserve host setting ${definition.key} from a malformed destination category.`);
      }
      if (Object.hasOwn(category, leaf)) writeRawDotPath(snapshot, definition.key, structuredClone(category[leaf]));
    }
  }
}
