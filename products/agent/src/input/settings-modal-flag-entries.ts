/**
 * settings-modal-flag-entries.ts, the feature rows the settings modal renders.
 *
 * Two sources, in a deliberate order. A flag the live FeatureFlagManager knows
 * about reports the manager's state, because that is what the runtime is
 * actually gated on; a flag it does not know reports the state DERIVED from the
 * domain settings key, because a row that showed nothing for a setting the user
 * can see and change would read as broken.
 *
 * Ordering is by domain, then by declaration order within the domain, so the
 * list is stable across renders rather than following whatever order the
 * manager's map happens to iterate in.
 *
 * Split out of settings-modal.ts, which is at the line cap
 * check-architecture.ts enforces, beside the MCP and subscription builders.
 */
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { FeatureFlagManager, FlagState } from '@/runtime/index.ts';
import { FEATURE_SETTINGS } from '@/runtime/index.ts';
import { isFeatureEnabledInConfig } from '../runtime/feature-enablement.ts';
import type { FlagEntry } from './settings-modal-types.ts';

/** Empty with no config manager wired, nothing can be derived without one. */
export function buildFlagEntries(
  configManager: ConfigManager | null,
  featureFlagManager: FeatureFlagManager | null,
): FlagEntry[] {
  if (!configManager) return [];
  const managerStates = featureFlagManager?.getAll() ?? null;
  return FEATURE_SETTINGS
    .map((feature, declarationIndex) => {
      const managed = managerStates?.get(feature.id);
      const derivedState: FlagState = isFeatureEnabledInConfig(configManager, feature.id) ? 'enabled' : 'disabled';
      return {
        entry: {
          feature,
          state: managed?.state ?? derivedState,
          enablementValue: String(configManager.get(feature.enablement.key)),
        },
        declarationIndex,
      };
    })
    .sort((left, right) => (
      left.entry.feature.domain.localeCompare(right.entry.feature.domain)
      || left.declarationIndex - right.declarationIndex
    ))
    .map(({ entry }) => entry);
}
