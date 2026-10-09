/**
 * settings-modal-reset, pure reset helpers for SettingsModal.
 *
 * These functions encapsulate the three reset operations:
 *   - resetSelected: reset the currently selected setting to its schema default
 *   - initiateResetCategory: arm the category-reset confirmation gate
 *   - initiateResetAll: arm the reset-all confirmation gate
 *   - handleResetConfirmKey: route a keypress through the active gate
 *
 * Each function takes its dependencies as explicit arguments rather than
 * accessing class-level state. resetCategoryConfirm and resetAllConfirm
 * remain public class fields on SettingsModal, the renderer reads them
 * directly to decide the footer state.
 */

import type { ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import { isSecretConfigKey } from '../config/secret-config.ts';
import type { SettingEntry, SettingsCategory } from './settings-modal-types.ts';
import type { SettingsSecretsManager } from './settings-modal-secrets.ts';

// ---------------------------------------------------------------------------
// resetSelected
// ---------------------------------------------------------------------------

export function resetSelected({
  editingMode,
  hasConfigManager,
  selected,
  resetSecrets,
  setValue,
  setHostValue,
}: {
  editingMode: boolean;
  hasConfigManager: boolean;
  selected: SettingEntry | null;
  secretsManager: SettingsSecretsManager | null;
  /** Starts captured-owner async resets; pending secrets are not reported as completed. */
  resetSecrets?: (entries: ReadonlyArray<{ key: ConfigKey; value: unknown }>) => void;
  setValue: (key: ConfigKey, value: unknown) => void;
  setHostValue?: (key: string, value: boolean) => void;
}): { key: string; value: unknown } | null {
  if (editingMode || !hasConfigManager) return null;
  if (!selected) return null;
  if (selected.kind === 'host') {
    if (!setHostValue) return null;
    // Modal reset is scoped set(default), not the handle's full-owner reset().
    setHostValue(selected.setting.key, selected.setting.default);
    return { key: selected.setting.key, value: selected.setting.default };
  }
  if (selected.metadataUnavailable) return null;
  const key = selected.setting.key;
  if (isSecretConfigKey(key)) {
    resetSecrets?.([{ key, value: selected.setting.default }]);
    return null;
  }
  setValue(key, selected.setting.default);
  return { key, value: selected.setting.default };
}

// ---------------------------------------------------------------------------
// initiateResetCategory
// ---------------------------------------------------------------------------

export function initiateResetCategory({
  hasConfigManager,
  currentCategory,
  setResetCategoryConfirm,
  setResetAllConfirm,
}: {
  hasConfigManager: boolean;
  currentCategory: string;
  setResetCategoryConfirm: (value: { readonly subject: string } | null) => void;
  setResetAllConfirm: (value: { readonly subject: 'all' } | null) => void;
}): void {
  if (!hasConfigManager) return;
  setResetCategoryConfirm({ subject: currentCategory });
  setResetAllConfirm(null);
}

// ---------------------------------------------------------------------------
// initiateResetAll
// ---------------------------------------------------------------------------

export function initiateResetAll({
  hasConfigManager,
  setResetCategoryConfirm,
  setResetAllConfirm,
}: {
  hasConfigManager: boolean;
  setResetCategoryConfirm: (value: { readonly subject: string } | null) => void;
  setResetAllConfirm: (value: { readonly subject: 'all' } | null) => void;
}): void {
  if (!hasConfigManager) return;
  setResetAllConfirm({ subject: 'all' });
  setResetCategoryConfirm(null);
}

// ---------------------------------------------------------------------------
// handleResetConfirmKey
// ---------------------------------------------------------------------------

export type ResetConfirmKeyResult =
  | { result: 'confirmed'; entries: ReadonlyArray<{ key: string; value: unknown }> }
  | 'cancelled'
  | 'absorbed'
  | 'inactive';

export function handleResetConfirmKey({
  key,
  resetCategoryConfirm,
  resetAllConfirm,
  hasConfigManager,
  currentItems,
  groups,
  setValue,
  resetSecrets,
  setHostValue,
  setResetCategoryConfirm,
  setResetAllConfirm,
}: {
  key: string;
  resetCategoryConfirm: { readonly subject: string } | null;
  resetAllConfirm: { readonly subject: 'all' } | null;
  hasConfigManager: boolean;
  currentItems: () => SettingEntry[];
  groups: Map<SettingsCategory, SettingEntry[]>;
  setValue: (key: ConfigKey, value: unknown) => void;
  resetSecrets?: (entries: ReadonlyArray<{ key: ConfigKey; value: unknown }>) => void;
  setHostValue?: (key: string, value: boolean) => void;
  setResetCategoryConfirm: (value: { readonly subject: string } | null) => void;
  setResetAllConfirm: (value: { readonly subject: 'all' } | null) => void;
}): ResetConfirmKeyResult {
  const gate = resetCategoryConfirm ?? resetAllConfirm;
  if (!gate || !hasConfigManager) return 'inactive';

  if (key === 'enter' || key === 'y') {
    const entries: Array<{ key: string; value: unknown }> = [];
    const secretEntries = new Map<ConfigKey, { key: ConfigKey; value: unknown }>();
    if (resetCategoryConfirm) {
      // Reset all settings in the current category to defaults.
      const items = currentItems();
      for (const item of items) {
        if (item.kind === 'host' ? !setHostValue : item.metadataUnavailable) continue;
        if (item.kind !== 'host' && isSecretConfigKey(item.setting.key)) {
          secretEntries.set(item.setting.key, { key: item.setting.key, value: item.setting.default });
          continue;
        }
        if (item.kind === 'host') setHostValue?.(item.setting.key, item.setting.default);
        else setValue(item.setting.key, item.setting.default);
        entries.push({ key: item.setting.key, value: item.setting.default });
      }
      setResetCategoryConfirm(null);
    } else {
      // Reset ALL settings across all categories to defaults.
      for (const [, items] of groups) {
        for (const item of items) {
          if (item.kind === 'host' ? !setHostValue : item.metadataUnavailable) continue;
          if (item.kind !== 'host' && isSecretConfigKey(item.setting.key)) {
            secretEntries.set(item.setting.key, { key: item.setting.key, value: item.setting.default });
            continue;
          }
          if (item.kind === 'host') setHostValue?.(item.setting.key, item.setting.default);
          else setValue(item.setting.key, item.setting.default);
          entries.push({ key: item.setting.key, value: item.setting.default });
        }
      }
      setResetAllConfirm(null);
    }
    if (secretEntries.size > 0) resetSecrets?.([...secretEntries.values()]);
    return { result: 'confirmed', entries };
  }

  if (key === 'escape' || key === 'n') {
    setResetCategoryConfirm(null);
    setResetAllConfirm(null);
    return 'cancelled';
  }

  // All other keys are absorbed while the gate is active.
  return 'absorbed';
}
