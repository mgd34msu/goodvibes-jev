import type { ConfigKey, ConfigManager, ConfigSetting } from '../config/index.ts';
import { CONFIG_SCHEMA, ConfigError } from '../config/index.ts';
import { resolveFeatureEnablementWrite } from '../runtime/feature-enablement.ts';
import type { GoodVibesCliCommand, GoodVibesCliFlags } from './types.ts';
import { RUNTIME_ENDPOINT_CONFIG_KEYS, hostModeForHostname } from './endpoints.ts';
import type { RuntimeEndpointId } from './endpoints.ts';

const CONFIG_SCHEMA_BY_KEY = new Map<string, ConfigSetting>(
  CONFIG_SCHEMA.map((setting) => [setting.key, setting]),
);

type RuntimeOnlyConfigManager = {
  readonly config: Record<string, unknown>;
};

function mutableConfig(configManager: ConfigManager): Record<string, unknown> {
  const cast = configManager as unknown as RuntimeOnlyConfigManager;
  if (!cast.config || typeof cast.config !== 'object') {
    throw new Error(
      'ConfigManager.config private field is missing or was renamed in the SDK. ' +
      'Update setRuntimeOnlyConfigValue to use the correct field name.',
    );
  }
  return cast.config;
}

function setRuntimeOnlyConfigValue(configManager: ConfigManager, key: ConfigKey, value: unknown): void {
  const parts = key.split('.');
  let cursor = mutableConfig(configManager);
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new ConfigError(`Unknown config key: ${key}`);
    }
    cursor = next as Record<string, unknown>;
  }
  const leaf = parts.at(-1);
  if (!leaf || !(leaf in cursor)) {
    throw new ConfigError(`Unknown config key: ${key}`);
  }
  cursor[leaf] = value;
}

function parseConfigOverrideValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return value;
  }
}

function parseRuntimeUrl(rawValue: string, source: string): { readonly host: string; readonly port: number } {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    throw new ConfigError(`${source} requires a non-empty http://host:port value.`);
  }

  const value = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${source} must be a valid http://host:port URL.`);
  }

  if (url.protocol !== 'http:') {
    throw new ConfigError(`${source} must use http:// because Agent connects to the local GoodVibes API.`);
  }
  if (!url.hostname) {
    throw new ConfigError(`${source} must include a hostname.`);
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new ConfigError(`${source} must point at the connected GoodVibes API root, not a path, query, or hash.`);
  }

  const port = url.port ? Number.parseInt(url.port, 10) : 3421;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${source} port must be from 1 to 65535.`);
  }

  return { host: url.hostname, port };
}

function validateConfigValue(setting: ConfigSetting, value: unknown): void {
  if (setting.type === 'boolean' && typeof value !== 'boolean') {
    throw new ConfigError(`Invalid value for ${setting.key}. Expected boolean.`);
  }
  if (setting.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new ConfigError(`Invalid value for ${setting.key}. Expected number.`);
  }
  if (setting.type === 'string' && typeof value !== 'string') {
    throw new ConfigError(`Invalid value for ${setting.key}. Expected string.`);
  }
  if (setting.type === 'enum' && setting.enumValues && !setting.enumValues.includes(String(value))) {
    throw new ConfigError(`Invalid value for ${setting.key} "${String(value)}". Allowed values ${setting.enumValues.join(', ')}.`);
  }
  if (setting.validate && !setting.validate(value)) {
    throw new ConfigError(`Invalid value for ${setting.key} ${String(value)}`);
  }
}

export function applyRuntimeConfigValue(configManager: ConfigManager, key: ConfigKey, value: unknown): void {
  const setting = CONFIG_SCHEMA_BY_KEY.get(key);
  if (!setting) {
    throw new ConfigError(`Unknown config key: ${key}`);
  }
  validateConfigValue(setting, value);
  setRuntimeOnlyConfigValue(configManager, key, value);
}

export function applyRuntimeConfigOverrides(
  configManager: ConfigManager,
  overrides: readonly string[],
): readonly string[] {
  const errors: string[] = [];
  for (const override of overrides) {
    const index = override.indexOf('=');
    if (index <= 0) {
      errors.push(`Invalid --config override "${override}". Expected key=value.`);
      continue;
    }
    const key = override.slice(0, index) as ConfigKey;
    const rawValue = override.slice(index + 1);
    try {
      applyRuntimeConfigValue(configManager, key, parseConfigOverrideValue(rawValue));
    } catch (error) {
      errors.push(error instanceof Error ? `Invalid --config ${override}. ${error.message}` : `Invalid --config ${override}`);
    }
  }
  return errors;
}

export function applyRuntimeUrlOverride(
  configManager: ConfigManager,
  rawValue: string,
  source = '--runtime-url',
): readonly string[] {
  try {
    const parsed = parseRuntimeUrl(rawValue, source);
    applyRuntimeConfigValue(configManager, 'controlPlane.hostMode', hostModeForHostname(parsed.host));
    applyRuntimeConfigValue(configManager, 'controlPlane.host', parsed.host);
    applyRuntimeConfigValue(configManager, 'controlPlane.port', parsed.port);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : `Invalid ${source}`];
  }
}

/**
 * Apply --enable-feature/--disable-feature as RUNTIME-ONLY writes to the
 * feature's domain settings key (the dissolved feature model has no separate
 * enablement namespace). Nothing is persisted: the write lands on the
 * in-memory config just like --config overrides, and the settings-derived
 * gate seeding in bootstrap picks it up. Returns honest per-feature errors
 * (unknown ids, always-available features) instead of silently accepting
 * anything, matching applyRuntimeConfigOverrides' contract.
 */
export function applyRuntimeFeatureOverrides(
  configManager: ConfigManager,
  options: {
    readonly enableFeatures: readonly string[];
    readonly disableFeatures: readonly string[];
  },
): readonly string[] {
  const errors: string[] = [];
  const requests = [
    ...options.enableFeatures.map((featureId) => ({ featureId, desired: 'enabled' as const, flag: '--enable-feature' })),
    ...options.disableFeatures.map((featureId) => ({ featureId, desired: 'disabled' as const, flag: '--disable-feature' })),
  ];
  for (const request of requests) {
    try {
      const write = resolveFeatureEnablementWrite(request.featureId, request.desired);
      setRuntimeOnlyConfigValue(configManager, write.key, write.value);
    } catch (error) {
      errors.push(error instanceof Error
        ? `Invalid ${request.flag} ${request.featureId}. ${error.message}`
        : `Invalid ${request.flag} ${request.featureId}`);
    }
  }
  return errors;
}

export function applyRuntimeEndpointFlagOverrides(
  configManager: ConfigManager,
  endpoint: RuntimeEndpointId,
  flags: Pick<GoodVibesCliFlags, 'hostname' | 'port'>,
): readonly string[] {
  const keys = RUNTIME_ENDPOINT_CONFIG_KEYS[endpoint];
  const errors: string[] = [];

  if (flags.hostname !== undefined) {
    try {
      applyRuntimeConfigValue(configManager, keys.hostMode, hostModeForHostname(flags.hostname));
      applyRuntimeConfigValue(configManager, keys.host, flags.hostname);
    } catch (error) {
      errors.push(error instanceof Error
        ? `Invalid --hostname ${flags.hostname}. ${error.message}`
        : `Invalid --hostname ${flags.hostname}`);
    }
  }

  if (flags.port !== undefined) {
    try {
      applyRuntimeConfigValue(configManager, keys.port, flags.port);
    } catch (error) {
      errors.push(error instanceof Error
        ? `Invalid --port ${flags.port}. ${error.message}`
        : `Invalid --port ${flags.port}`);
    }
  }

  return errors;
}

export function applyRuntimeCommandEndpointFlagOverrides(
  configManager: ConfigManager,
  command: GoodVibesCliCommand,
  flags: Pick<GoodVibesCliFlags, 'hostname' | 'port'>,
): readonly string[] {
  if (flags.hostname === undefined && flags.port === undefined) return [];
  if (command === 'pair') return applyRuntimeEndpointFlagOverrides(configManager, 'controlPlane', flags);
  return [];
}
