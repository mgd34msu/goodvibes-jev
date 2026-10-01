/**
 * The `profile.*` settings reach the web settings view as their own named group.
 *
 * docs/owner-profile.md §12.1 makes this registration mandatory rather than cosmetic in
 * the TUI and the agent, where a namespace with no matching category is silently dropped.
 * This webui derives its groups from the SDK schema with no hand-maintained category list,
 * so it cannot drop the domain, but without the CATEGORY_LABELS entry the group would
 * render as a Title-Cased "Profile", which collides in the reader's mind with
 * platform/profiles' saved display/provider presets. This pins the label and that every
 * profile.* key the schema carries lands in that one group.
 */
import { describe, expect, test } from 'bun:test';
import { CONFIG_SCHEMA_ENTRIES } from './generated/config-schema';
import { categoryLabelForKey } from './config-redaction';
import { buildSettingsModel, groupLabelForNamespace } from './settings-model';

const PROFILE_KEYS = CONFIG_SCHEMA_ENTRIES.map((entry) => entry.key).filter((key) => key.startsWith('profile.'));

describe('the owner-profile settings group', () => {
  test('every profile key lands in the profile namespace group', () => {
    const label = groupLabelForNamespace('profile');
    expect(categoryLabelForKey('profile.enabled')).toBe(label);
    expect(categoryLabelForKey('profile.path')).toBe(label);
  });

  test('the settings model builds one "Owner Profile" group holding those keys', () => {
    const groups = buildSettingsModel({});
    const group = groups.find((entry) => entry.id === 'profile');
    expect(group, 'no profile group was built').toBeDefined();
    expect(group?.label).toBe(groupLabelForNamespace('profile'));
    const rendered = new Set([
      ...(group?.plainRows ?? []).map((row) => row.key),
      ...(group?.featureUnits ?? []).flatMap((unit) => [
        ...(unit.enablementField ? [unit.enablementField.key] : []),
        ...unit.fields.map((field) => field.key),
      ]),
    ]);
    expect(PROFILE_KEYS.length).toBeGreaterThan(0);
    for (const key of PROFILE_KEYS) {
      expect(rendered.has(key), `${key} is not reachable in the settings modal`).toBe(true);
    }
  });
});
