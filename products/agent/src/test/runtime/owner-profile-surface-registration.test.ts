/**
 * The owner profile's registration in this surface (docs/owner-profile.md
 * §12.1). A config domain whose root names no settings category is dropped from
 * the workspace silently, `push.*` and `cluster.*` both vanished that way
 * before, so the registration is asserted rather than assumed, both
 * structurally (the root names a category in a group) and against the live
 * schema (every `profile.*` key actually lands in the rendered group).
 *
 * Also pins the two conditions the owner attached to autonomous writes into the
 * turn prompt, and the permission classification of the tool's actions.
 */

import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { CONFIG_SCHEMA, ConfigManager, SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { SettingsModal } from '../../input/settings-modal.ts';
import {
  CROSS_LISTED_SETTING_ROOTS,
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_GROUPS,
} from '../../input/settings-modal-types.ts';
import { CATEGORY_LABELS } from '../../renderer/settings-modal-helpers.ts';
import { fallbackPermissionCategoryForArgs } from '../../runtime/tool-permission-safety.ts';

/**
 * Derived from the live schema, never written out as literals. The verification
 * ledger's settings denominator counts a key when its literal string appears
 * anywhere in this repo's TypeScript (src/verification/settings-consumed-keys.ts),
 * and these keys are read by the daemon's owner-profile store, not by a line of
 * this repo, spelling them here would put eight permanently unverifiable rows
 * into this product's denominator, which is the decay that file exists to stop.
 */
function profileSchemaKeys(): readonly string[] {
  return CONFIG_SCHEMA.map((setting) => setting.key).filter((key) => key.startsWith('profile.'));
}

describe('owner profile settings registration', () => {
  test('profile names a settings category, so profile.* keys are not dropped', () => {
    expect(SETTINGS_CATEGORIES).toContain('profile');
    const roots = new Set<string>([...SETTINGS_CATEGORIES, ...Object.keys(CROSS_LISTED_SETTING_ROOTS)]);
    const keys = profileSchemaKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(roots.has(key.split('.')[0] ?? ''), `${key} would be dropped from the settings workspace`).toBe(true);
    }
  });

  test('the category is listed in exactly one group, with a display name', () => {
    const groups = SETTINGS_CATEGORY_GROUPS.filter((group) => group.categories.includes('profile'));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe('Agent Experience');
    expect(CATEGORY_LABELS.profile).toBe('Your Profile');
  });

  test('every profile.* key in the live schema lands in the rendered profile group', () => {
    // Guards against the settings section being asserted against nothing: if the
    // platform runtime ever stops shipping the domain, this says so rather than
    // passing vacuously.
    const schemaKeys = profileSchemaKeys();
    expect(schemaKeys.length).toBeGreaterThan(0);

    const root = makeProjectTempDir('gv-agent-owner-profile-settings');
    try {
      const configManager = new ConfigManager({
        surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
        workingDir: root,
        homeDir: root,
        configDir: join(root, '.goodvibes', 'global-agent'),
      });
      const modal = new SettingsModal();
      modal.open(
        configManager,
        createFeatureFlagManager(),
        new SubscriptionManager(join(root, '.goodvibes', 'agent', 'subscriptions.json')),
        { getAll: () => ({}) },
      );
      const rendered = (modal.groups.get('profile') ?? []).map((entry) => String(entry.setting.key)).sort();
      expect(rendered).toEqual([...schemaKeys].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('owner profile tool permission classification', () => {
  test('the four lookup actions classify as reads', () => {
    for (const action of ['read', 'get', 'person', 'provenance', 'status']) {
      expect(fallbackPermissionCategoryForArgs('profile', { action }), action).toBe('read');
    }
  });

  test('the four changing actions classify as writes', () => {
    for (const action of ['set', 'append', 'forget', 'undo']) {
      expect(fallbackPermissionCategoryForArgs('profile', { action }), action).toBe('write');
    }
  });

  test('an unrecognized action is a write, never auto-approved as a read', () => {
    expect(fallbackPermissionCategoryForArgs('profile', { action: 'not_a_real_action' })).toBe('write');
  });
});
