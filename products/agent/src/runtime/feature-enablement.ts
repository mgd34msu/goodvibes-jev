/**
 * feature-enablement.ts, explicit feature on/off requests over the dissolved
 * feature model.
 *
 * The SDK dissolved the feature-flag category: every capability is enabled
 * through a first-class settings key in its natural domain (FEATURE_SETTINGS
 * describes each feature's binding). This module turns an EXPLICIT
 * present-tense request, "enable feature X" from the CLI or an onboarding
 * plan, into the domain-key write that honestly fulfills it:
 * - boolean bindings write the key true/false;
 * - enum bindings write the canonical enabled value (first enabledValues
 *   entry) or a schema-honest disabled value;
 * - constant bindings have no separate off switch, so the request fails with
 *   the real settings keys to configure instead.
 *
 * This intentionally differs from the SDK's load-time MIGRATION of persisted
 * legacy featureFlags entries (migrateLegacyFeatureToggles preserves
 * historical AND-of-both-switches ambiguity); an explicit request has no such
 * ambiguity, the operator wants the feature on or off now.
 *
 * Legacy `featureFlags` / `featureFlags.<id>` set-config keys from stored
 * onboarding plans are accepted and expanded here so old plans keep working
 * against the domain keys.
 */
import {
  FEATURE_SETTINGS,
  deriveFeatureState,
  getFeatureSettingsBinding,
} from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import type { FeatureSetting } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { CONFIG_SCHEMA } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConfigKey, ConfigManager, ConfigSetting } from '../config/index.ts';

export type LegacyFeatureConfigKey = 'featureFlags' | `featureFlags.${string}`;

export type FeatureEnablementRequest = 'enabled' | 'disabled';

/** One domain-key write that fulfills an explicit feature request. */
export interface FeatureEnablementWrite {
  readonly key: ConfigKey;
  readonly value: unknown;
}

// This module is loaded by onboarding during the Agent runtime barrel
// initialization. Import feature metadata from the public engine state surface
// directly so compiled startup cannot observe an uninitialized barrel export.
const FEATURE_SETTINGS_BY_ID: ReadonlyMap<string, FeatureSetting> = new Map(
  FEATURE_SETTINGS.map((feature) => [feature.id, feature]),
);

const CONFIG_SCHEMA_BY_KEY: ReadonlyMap<string, ConfigSetting> = new Map(
  CONFIG_SCHEMA.map((setting) => [setting.key, setting]),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isLegacyFeatureConfigKey(key: string): key is LegacyFeatureConfigKey {
  return key === 'featureFlags' || key.startsWith('featureFlags.');
}

export function isFeatureEnablementRequest(value: unknown): value is FeatureEnablementRequest {
  return value === 'enabled' || value === 'disabled';
}

export function getFeatureSetting(featureId: string): FeatureSetting | null {
  return FEATURE_SETTINGS_BY_ID.get(featureId) ?? null;
}

function knownFeatureIdsHint(): string {
  return FEATURE_SETTINGS.map((feature) => feature.id).join(', ');
}

/** An enum key's honest "disabled" value: the schema default when it is not an enabled value, else the first non-enabled option. */
function resolveEnumDisabledValue(feature: FeatureSetting): string {
  const enabledValues = feature.enablement.enabledValues ?? [];
  const schema = CONFIG_SCHEMA_BY_KEY.get(feature.enablement.key);
  const schemaDefault = typeof schema?.default === 'string' ? schema.default : undefined;
  if (schemaDefault !== undefined && !enabledValues.includes(schemaDefault)) return schemaDefault;
  const candidate = (schema?.enumValues ?? []).find((value) => !enabledValues.includes(value));
  if (candidate !== undefined) return candidate;
  throw new Error(
    `Feature "${feature.id}" cannot be disabled through ${feature.enablement.key}: `
    + 'every allowed value keeps it enabled.',
  );
}

/**
 * The domain-key write that fulfills an explicit enable/disable request for
 * one feature. Throws with real guidance for unknown ids and for constant
 * bindings (whose own domain keys govern activation directly).
 */
export function resolveFeatureEnablementWrite(
  featureId: string,
  desired: FeatureEnablementRequest,
): FeatureEnablementWrite {
  const feature = FEATURE_SETTINGS_BY_ID.get(featureId);
  if (!feature) {
    throw new Error(`Unknown feature "${featureId}". Known features: ${knownFeatureIdsHint()}.`);
  }
  const { key, kind, enabledValues } = feature.enablement;
  if (kind === 'boolean') {
    return { key, value: desired === 'enabled' };
  }
  if (kind === 'enum') {
    if (desired === 'enabled') {
      const canonical = enabledValues?.[0];
      if (canonical === undefined) {
        throw new Error(`Feature "${featureId}" has no enabled value declared for ${key}.`);
      }
      return { key, value: canonical };
    }
    return { key, value: resolveEnumDisabledValue(feature) };
  }
  // constant: always available; its associated domain keys govern activation.
  throw new Error(
    `Feature "${featureId}" is always available and has no separate on/off switch; `
    + `configure its settings directly: ${feature.settings.join(', ')}.`,
  );
}

/** Whether a feature is currently enabled, derived from its bound domain settings key. */
export function isFeatureEnabledInConfig(
  config: Pick<ConfigManager, 'get'>,
  featureId: string,
): boolean {
  const binding = getFeatureSettingsBinding(featureId);
  if (!binding) return false;
  return deriveFeatureState(binding, config.get(binding.key)) === 'enabled';
}

/**
 * Expand a legacy `featureFlags` / `featureFlags.<id>` set-config value into
 * the domain-key writes that fulfill it. Validates shape with the historical
 * error wording; unknown ids and constant bindings throw with real guidance.
 */
export function expandLegacyFeatureConfigValue(
  key: LegacyFeatureConfigKey,
  value: unknown,
): readonly FeatureEnablementWrite[] {
  if (key === 'featureFlags') {
    if (!isRecord(value)) throw new Error('featureFlags expects an object value.');
    const writes: FeatureEnablementWrite[] = [];
    for (const [featureId, state] of Object.entries(value)) {
      if (featureId.trim().length === 0) throw new Error('featureFlags cannot contain an empty feature id.');
      if (!isFeatureEnablementRequest(state)) {
        throw new Error(`featureFlags.${featureId} expects enabled or disabled.`);
      }
      writes.push(resolveFeatureEnablementWrite(featureId, state));
    }
    return writes;
  }

  const featureId = key.slice('featureFlags.'.length);
  if (featureId.trim().length === 0) throw new Error('featureFlags requires a feature id.');
  if (!isFeatureEnablementRequest(value)) {
    throw new Error(`Config key ${key} expects enabled or disabled.`);
  }
  return [resolveFeatureEnablementWrite(featureId, value)];
}

/**
 * The feature ids a legacy set-config operation addresses (for verification:
 * each id's DERIVED state must match the requested one after apply).
 */
export function legacyFeatureConfigTargets(
  key: LegacyFeatureConfigKey,
  value: unknown,
): ReadonlyArray<{ readonly featureId: string; readonly desired: FeatureEnablementRequest }> {
  if (key === 'featureFlags') {
    if (!isRecord(value)) return [];
    return Object.entries(value)
      .filter((entry): entry is [string, FeatureEnablementRequest] => isFeatureEnablementRequest(entry[1]))
      .map(([featureId, desired]) => ({ featureId, desired }));
  }
  const featureId = key.slice('featureFlags.'.length);
  return isFeatureEnablementRequest(value) ? [{ featureId, desired: value }] : [];
}
