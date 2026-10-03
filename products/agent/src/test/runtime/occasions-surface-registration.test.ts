/**
 * The occasions domain's registration in this surface's settings workspace.
 *
 * A config domain whose root names no settings category is dropped from the
 * workspace silently, `push.*` and `cluster.*` both vanished that way, and all
 * twelve `occasions.*` keys did too the moment the platform shipped them: present
 * in the schema, read by the daemon, reachable only by hand-editing a file. So the
 * registration is asserted rather than assumed, both structurally (the root names
 * a category listed in exactly one group, with a display name) and against the
 * live schema (every `occasions.*` key actually lands in the rendered group).
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
import { OCCASIONS_ACTIONS } from '../../tools/agent-occasions-types.ts';

/**
 * Derived from the live schema, never written out as literals. The verification
 * ledger's settings denominator counts a key when its literal string appears
 * anywhere in this repo's TypeScript (src/verification/settings-consumed-keys.ts),
 * and eleven of these twelve are read by the daemon's occasions sweep rather than
 * by a line of this repo, spelling them here would put eleven permanently
 * unverifiable rows into this product's denominator, which is the decay that file
 * exists to stop. `occasions.enabled` is the exception and is covered by
 * src/test/runtime/occasions-nudge-surface.test.ts.
 */
function occasionsSchemaKeys(): readonly string[] {
  return CONFIG_SCHEMA.map((setting) => setting.key).filter((key) => key.startsWith('occasions.'));
}

describe('occasions settings registration', () => {
  test('occasions names a settings category, so occasions.* keys are not dropped', () => {
    expect(SETTINGS_CATEGORIES).toContain('occasions');
    const roots = new Set<string>([...SETTINGS_CATEGORIES, ...Object.keys(CROSS_LISTED_SETTING_ROOTS)]);
    const keys = occasionsSchemaKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(roots.has(key.split('.')[0] ?? ''), `${key} would be dropped from the settings workspace`).toBe(true);
    }
  });

  test('the category is listed in exactly one group, with a display name', () => {
    const groups = SETTINGS_CATEGORY_GROUPS.filter((group) => group.categories.includes('occasions'));
    expect(groups).toHaveLength(1);
    // Beside `profile`, because the occasions and plans these settings govern are
    // prose lines in that same document.
    expect(groups[0]?.label).toBe('Agent Experience');
    expect(CATEGORY_LABELS.occasions).toBe('Dates and Plans');
  });

  test('every occasions.* key in the live schema lands in the rendered occasions group', () => {
    // Guards against asserting against nothing: if the platform runtime ever
    // stops shipping the domain, this says so rather than passing vacuously.
    const schemaKeys = occasionsSchemaKeys();
    expect(schemaKeys.length).toBeGreaterThan(0);

    const root = makeProjectTempDir('gv-agent-occasions-settings');
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
      const rendered = (modal.groups.get('occasions') ?? []).map((entry) => String(entry.setting.key)).sort();
      expect(rendered).toEqual([...schemaKeys].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('occasions tool permission classification', () => {
  test('the five lookups classify as reads', () => {
    for (const action of ['list', 'pending', 'state', 'gifts', 'plans']) {
      expect(fallbackPermissionCategoryForArgs('occasions', { action }), action).toBe('read');
    }
  });

  test('the two proposals classify as reads, because they write nothing', () => {
    // docs/occasions.md §4.5 and the SDK's own proposeOccasion/proposePlan: a
    // proposal works out what WOULD be written and hands back the one line to put
    // to him. Classifying it as a write would put a confirmation prompt in front
    // of the confirmation prompt, and the whole point of the two-step is that
    // step one is free.
    for (const action of ['propose', 'plan_propose']) {
      expect(fallbackPermissionCategoryForArgs('occasions', { action }), action).toBe('read');
    }
  });

  test('everything that changes durable state classifies as a write', () => {
    const writes = [
      // The machine-owned acknowledgement store.
      'answer', 'interview_answer', 'interview_record', 'resolve_conflict', 'sweep',
      // The owner's own profile file.
      'confirm', 'plan_confirm', 'remove',
    ];
    for (const action of writes) {
      expect(fallbackPermissionCategoryForArgs('occasions', { action }), action).toBe('write');
    }
  });

  test('an unrecognised or absent action is a write, never auto-approved as a read', () => {
    expect(fallbackPermissionCategoryForArgs('occasions', { action: 'sing' })).toBe('write');
    expect(fallbackPermissionCategoryForArgs('occasions', {})).toBe('write');
  });

  test('every action the tool accepts is classified, so none falls through unlabelled', () => {
    // The two sides read the same vocabulary; this asserts the vocabulary is
    // fully covered rather than that the two lists happen to agree today.
    for (const action of OCCASIONS_ACTIONS) {
      const category = fallbackPermissionCategoryForArgs('occasions', { action });
      expect(['read', 'write'], action).toContain(category);
    }
  });
});

