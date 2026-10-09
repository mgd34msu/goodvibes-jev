/**
 * cli-config-overrides.ts, applying `--config key=value`, `--enable`/
 * `--disable`, `--hostname`/`--port`, and a front-end's own launch-time
 * settings defaults onto a live ConfigManager.
 */
import type { ConfigKey, ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { featureEnablementWrite, getFeatureSetting } from './cli-feature-settings.js';
import type { GoodVibesCliCommand, GoodVibesCliFlags } from './cli-types.js';
import { RUNTIME_ENDPOINT_CONFIG_KEYS, hostModeForHostname } from './cli-endpoints.js';
import type { RuntimeEndpointId } from './cli-endpoints.js';

/**
 * Read a settings value as a command line writes it.
 *
 * Two entry points need this and must agree: `--config key=value`, which
 * arrives as one string and is split here, and a `config set <key> <value>`
 * command, which arrives with the halves already apart. If they coerce
 * differently then `--config x=false` and `config set x false` write different
 * things into the same key, which is the sort of divergence nobody notices
 * until a boolean setting is mysteriously the string "false".
 *
 * The order is deliberate: JSON first, so `[1,2]`, `{"a":1}`, `"3"` and `null`
 * all mean what they look like; then the three bare literals a shell user
 * actually types (`true`, `false`, a number); then the raw string, returned
 * un-trimmed because trailing space can be significant in a string value.
 */
export function parseConfigValueText(value: string): unknown {
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

/** Register a frontend default against the manager's last accepted persisted view. */
export function applyRuntimeConfigDefault(configManager: ConfigManager, key: ConfigKey, defaultValue: unknown): void {
  configManager.setRuntimeDefault(key, defaultValue as never);
}

/**
 * Every front-end-side config default applied at startup, in one place.
 * Currently: show token speed ON (the SDK schema default is false).
 * The manager applies it below accepted persisted settings and invocation
 * overrides, independent of registration order. No disk read or write.
 */
export function applyTerminalRuntimeConfigDefaults(configManager: ConfigManager): void {
  applyRuntimeConfigDefault(configManager, 'display.showTokenSpeed', true);
}

/**
 * Applies the persisted `behavior.hitlMode` config value to the live mode
 * manager at startup, ignoring unset or unrecognized values.
 */
export function applyConfiguredHitlMode(
  configManager: ConfigManager,
  modeManager: { setHITLMode(mode: 'quiet' | 'balanced' | 'operator'): void },
): void {
  const hitlMode = configManager.get('behavior.hitlMode');
  if (hitlMode === 'quiet' || hitlMode === 'balanced' || hitlMode === 'operator') {
    modeManager.setHITLMode(hitlMode);
  }
}

export function applyRuntimeConfigValue(configManager: ConfigManager, key: ConfigKey, value: unknown): void {
  configManager.setRuntimeOverride(key, value as never);
}

export function applyRuntimeConfigOverrides(
  configManager: ConfigManager,
  overrides: readonly string[],
): readonly string[] {
  const errors: string[] = [];
  for (const override of overrides) {
    const index = override.indexOf('=');
    if (index <= 0) {
      errors.push('Invalid --config override. Expected key=value.');
      continue;
    }
    const key = override.slice(0, index) as ConfigKey;
    const rawValue = override.slice(index + 1);
    try {
      applyRuntimeConfigValue(configManager, key, parseConfigValueText(rawValue));
    } catch (error) {
      errors.push(error instanceof Error ? `Invalid --config override: ${error.message}` : 'Invalid --config override.');
    }
  }
  return errors;
}

/**
 * Session-only feature overrides (--enable-feature / --disable-feature).
 * Each feature is switched through its real domain settings key (e.g.
 * sandbox.enabled, behavior.compactionStrategy) in the runtime config layer;
 * features without an off position (constant capabilities on non-boolean
 * keys) and unknown ids are reported as errors rather than silently ignored.
 */
export function applyRuntimeFeatureFlagOverrides(
  configManager: ConfigManager,
  options: {
    readonly enableFeatures: readonly string[];
    readonly disableFeatures: readonly string[];
  },
): readonly string[] {
  if (options.enableFeatures.length === 0 && options.disableFeatures.length === 0) return [];
  const errors: string[] = [];
  const apply = (feature: string, enabled: boolean, flagName: string): void => {
    const write = featureEnablementWrite(feature, enabled);
    if (!write) {
      errors.push(getFeatureSetting(feature)
        ? `${flagName} ${feature}: this capability has no ${enabled ? 'on' : 'off'} switch (its domain settings govern it directly).`
        : `${flagName} ${feature}: unknown feature id.`);
      return;
    }
    try { applyRuntimeConfigValue(configManager, write.key, write.value); }
    catch (error) { errors.push(error instanceof Error ? `${flagName}: ${error.message}` : `Invalid ${flagName}.`); }
  };
  for (const feature of options.enableFeatures) apply(feature, true, '--enable-feature');
  for (const feature of options.disableFeatures) apply(feature, false, '--disable-feature');
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
        ? `Invalid --hostname: ${error.message}`
        : 'Invalid --hostname.');
    }
  }

  if (flags.port !== undefined) {
    try {
      applyRuntimeConfigValue(configManager, keys.port, flags.port);
    } catch (error) {
      errors.push(error instanceof Error
        ? `Invalid --port: ${error.message}`
        : 'Invalid --port.');
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
  if (command === 'web') return applyRuntimeEndpointFlagOverrides(configManager, 'web', flags);
  if (command === 'listener') return applyRuntimeEndpointFlagOverrides(configManager, 'httpListener', flags);
  if (command === 'control-plane' || command === 'pair' || command === 'serve') {
    return applyRuntimeEndpointFlagOverrides(configManager, 'controlPlane', flags);
  }
  return [];
}
