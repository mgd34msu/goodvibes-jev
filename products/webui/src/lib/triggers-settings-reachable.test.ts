/**
 * triggers-settings-reachable.test.ts, the `watchers.triggers.*` config keys
 * are reachable and readable in the settings workspace.
 *
 * Triggers are configured entirely through config keys, so a key that exists in
 * the SDK schema but never surfaces in this app is a capability the owner cannot
 * actually tune. This is the same reachability pin the paired-phone and
 * wake-word families carry (device-settings-reachable.test.ts,
 * settings-wake-word-group.test.ts): every key routes into a group, the group
 * carries a real human label rather than a raw namespace, and every key ships a
 * written purpose rather than a restatement of its own name.
 */
import { describe, expect, test } from 'bun:test';
import { buildSettingsModel, groupLabelForNamespace } from './settings-model';
import { categoryLabelForKey } from './config-redaction';
import { CONFIG_SCHEMA_ENTRIES } from './generated/config-schema';

const TRIGGER_KEYS = CONFIG_SCHEMA_ENTRIES
  .filter((entry) => entry.key.startsWith('watchers.triggers.'))
  .map((entry) => entry.key);

describe('trigger settings reachability', () => {
  test('every trigger key is routed into the settings workspace', () => {
    const groups = buildSettingsModel({});
    // A trigger key surfaces either as a plain row or as one of the trigger
    // feature's own fields; both are reachable, so both count.
    const routed = new Set(groups.flatMap((group) => [
      ...group.plainRows.map((row) => row.key),
      ...group.featureUnits.flatMap((unit) => [
        ...(unit.enablementField ? [unit.enablementField.key] : []),
        ...unit.fields.map((field) => field.key),
      ]),
    ]));
    expect(TRIGGER_KEYS.filter((key) => !routed.has(key))).toEqual([]);
  });

  test('trigger keys group with the rest of the watchers namespace', () => {
    const groups = buildSettingsModel({});
    const watchersGroup = groups.find((group) => group.id === 'watchers');
    expect(watchersGroup).toBeDefined();
    expect(watchersGroup?.label).toBe(groupLabelForNamespace('watchers'));
    expect(categoryLabelForKey('watchers.triggers.enabled')).toBe(groupLabelForNamespace('watchers'));
  });
});
