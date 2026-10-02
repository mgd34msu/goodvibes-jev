import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_SCHEMA, ConfigManager, SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { SettingsModal, SETTINGS_CATEGORY_GROUPS } from '../../input/settings-modal.ts';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { frameFromLayer, frameText } from '../helpers/surface-frame.ts';

// Exercise the real SDK schema and local config write path, with no service or
// provider requests. Adding a category must not replace its schema metadata.
describe('contract and judgment settings workspace', () => {
  let root: string;
  let cm: ConfigManager;
  let modal: SettingsModal;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-settings-domains-'));
    cm = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, homeDir: root, configDir: join(root, 'config') });
    modal = new SettingsModal();
    modal.open(cm, createFeatureFlagManager(), new SubscriptionManager(join(root, 'subscriptions.json')), { getAll: () => ({}) });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  for (const [category, label, group] of [
    ['contract', 'Contracts', 'Automation'],
    ['judgment', 'Judgment', 'AI Routing'],
  ] as const) {
    test(`${category} exposes every schema key with unchanged metadata and defaults`, () => {
      expect(SETTINGS_CATEGORY_GROUPS.find(item => item.label === group)?.categories).toContain(category);
      const settings = CONFIG_SCHEMA.filter(setting => setting.key.startsWith(`${category}.`));
      expect(settings.length).toBeGreaterThan(0);
      expect(modal.groups.get(category)?.map(entry => entry.setting.key)).toEqual(settings.map(setting => setting.key));
      modal.selectTarget(category);
      expect(modal.currentCategory).toBe(category);
      for (const setting of settings) {
        modal.selectTarget(setting.key);
        expect(modal.getSelected()?.setting).toBe(setting);
        expect(modal.getSelected()?.currentValue).toEqual(setting.default);
        expect(modal.getSelected()?.isDefault).toBe(true);
        modal.setSearchQuery(setting.key);
        expect(modal.searchResults[0]?.setting.key).toBe(setting.key);
        modal.setSearchQuery('');
      }
    });

    for (const width of [80, 120]) {
      test(`${category} renders its category and a late selected key at ${width} columns`, () => {
        const key = category === 'contract' ? 'contract.nudgeTtlMs' : 'judgment.timeoutMs';
        modal.selectTarget(key);
        const lines = frameFromLayer(renderSettingsModal(modal, width, 24), width, 24);
        const text = frameText(lines).join('\n');
        expect(text).toContain(`Settings › ${label}`);
        expect(text).toContain(key);
        expect(text).toContain('source default');
        expect(text).not.toContain('undefined');
        expect(lines).toHaveLength(24);
        for (const line of lines) expect(line).toHaveLength(width);
      });
    }
  }

  test('contract boolean and enum settings keep the ordinary typed write path', () => {
    modal.selectTarget('contract.autoCommit');
    modal.activateSelected();
    expect(cm.get('contract.autoCommit')).toBe(false);
    expect(modal.getSelected()?.isDefault).toBe(false);
    modal.selectTarget('contract.commitScope');
    modal.activateSelected();
    expect(cm.get('contract.commitScope')).toBe('all');
  });

  test('judgment timeout rejects invalid input and persists a number', () => {
    modal.selectTarget('judgment.timeoutMs');
    modal.activateSelected();
    modal.editBuffer = '999';
    expect(modal.commitEdit()).toBe(false);
    expect(cm.get('judgment.timeoutMs')).toBe(10000);
    modal.activateSelected();
    modal.editBuffer = '20000';
    expect(modal.commitEdit()).toBe(true);
    expect(cm.get('judgment.timeoutMs')).toBe(20000);
  });

  test('judgment endpoint preserves validation, cancellation and empty fallback', () => {
    modal.selectTarget('judgment.endpoint');
    modal.activateSelected();
    modal.editBuffer = 'not a URL';
    expect(modal.commitEdit()).toBe(false);
    expect(cm.get('judgment.endpoint')).toBe('');
    modal.activateSelected();
    modal.editBuffer = 'http://localhost:9999';
    modal.cancelEdit();
    expect(cm.get('judgment.endpoint')).toBe('');
    modal.activateSelected();
    modal.editBuffer = '';
    expect(modal.commitEdit()).toBe(true);
    expect(cm.get('judgment.endpoint')).toBe('');
  });
});
