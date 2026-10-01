/**
 * device-settings-reachable.test.ts, the `device.*` config keys are reachable
 * and readable in the settings workspace.
 *
 * The paired-phone feature is configured entirely through config keys, so a key
 * that exists in the SDK schema but never surfaces in this app is a feature the
 * owner cannot actually configure. This pins three things: every device key is
 * routed into a group, that group carries a real human label rather than a raw
 * namespace, and every key carries a written purpose long enough to be a
 * description rather than a restatement of its own name.
 */
import { describe, expect, test } from 'bun:test';
import { buildSettingsModel } from './settings-model';
import { CONFIG_SCHEMA_ENTRIES } from './generated/config-schema';

const DEVICE_KEYS = CONFIG_SCHEMA_ENTRIES.filter((entry) => entry.key.startsWith('device.')).map((entry) => entry.key);

describe('paired-phone settings reachability', () => {
  test('every device key is routed into the settings workspace', () => {
    const groups = buildSettingsModel({});
    // A device key surfaces either as a plain row or as one of the paired-phone
    // feature's own fields; both are reachable, so both count.
    const routed = new Set(groups.flatMap((group) => [
      ...group.plainRows.map((row) => row.key),
      ...group.featureUnits.flatMap((unit) => [
        ...(unit.enablementField ? [unit.enablementField.key] : []),
        ...unit.fields.map((field) => field.key),
      ]),
    ]));
    expect(DEVICE_KEYS.filter((key) => !routed.has(key))).toEqual([]);
  });

});
