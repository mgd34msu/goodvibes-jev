import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager, CONFIG_SCHEMA, SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createFeatureFlagManager } from '../../runtime/index.ts';
import { SettingsModal, SETTINGS_CATEGORIES } from '../../input/settings-modal.ts';
import { CATEGORY_LABELS } from '../../renderer/settings-modal-helpers.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

test('every public contract and judgment setting is reachable in the Agent settings modal', () => {
  const root = makeProjectTempDir('agent-contract-settings');
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'agent') });
  const modal = new SettingsModal();
  const keys = CONFIG_SCHEMA.filter(setting => setting.key.startsWith('contract.') || setting.key.startsWith('judgment.')).map(setting => setting.key);
  expect(keys.length).toBeGreaterThan(0);
  modal.open(config, createFeatureFlagManager(), new SubscriptionManager(join(root, 'subscriptions.json')), { getAll: () => [] });
  try {
    expect(SETTINGS_CATEGORIES).toContain('contract');
    expect(SETTINGS_CATEGORIES).not.toContain('wrfc');
    expect(SETTINGS_CATEGORIES).toContain('judgment');
    expect(CATEGORY_LABELS).toHaveProperty('contract', 'Contracts');
    for (const key of keys) {
      modal.selectTarget(key);
      expect(modal.currentCategory).toBe(key.split('.')[0]);
      expect(modal.getSelected()?.setting.key).toBe(key);
      expect(modal.getSelected()?.currentValue).toEqual(config.get(key as Parameters<ConfigManager['get']>[0]));
    }
  } finally { modal.close(); }
});
