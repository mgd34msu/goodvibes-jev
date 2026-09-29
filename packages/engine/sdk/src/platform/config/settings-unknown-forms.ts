/**
 * settings-unknown-forms.ts: which unknown settings keys are a newer form of a
 * setting this build knows, read through the `config.setting-form` selector.
 *
 * The synchronous screen (settings-ingestion.ts) collects every key this build
 * does not know in a section it does, exactly, and leaves it in the file. This
 * reads each one against the known settings of its section and returns a
 * skipped-key notice for those that are a newer, renamed or extended form of
 * one: "ignored in silence" is how a migrated setting became a daemon that
 * looked configured and behaved as if it were not. A key that is a form of
 * none stays unremarked, since an app-layer section may carry keys the engine
 * has never heard of.
 */
import type { Candidate } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { settingForm } from './batteries/setting-form.js';
import { configKeyDescription } from './credential-key-reading.js';
import { knownSettingNamesBySection, type SettingsIngestionNotice, type UnknownSettingKey } from './settings-ingestion.js';

const SITE = 'config.settings.unknown-form';

/** The known settings of a section, as selector candidates with their schema descriptions. */
function candidatesFor(section: string): Candidate[] {
  const names = [...(knownSettingNamesBySection().get(section) ?? [])].sort();
  return names.map((name) => {
    const description = configKeyDescription(section ? `${section}.${name}` : name);
    return { id: name, content: description.length > 0 ? description : null };
  });
}

/** The known setting `unknown` is a newer form of, as a dot path, or undefined. Throws when no reading can be made. */
export async function readUnknownSettingForm(unknown: UnknownSettingKey): Promise<string | undefined> {
  const candidates = candidatesFor(unknown.section);
  if (candidates.length === 0) return undefined;
  const selection = await settingForm.select(judgmentPort(SITE), { section: unknown.section, name: unknown.name }, candidates, { site: SITE });
  if (selection.chosen === undefined || selection.outcome !== 'act') return undefined;
  return unknown.section ? `${unknown.section}.${selection.chosen}` : selection.chosen;
}

/** A skipped-key notice for every unknown key that reads as a newer form of a known setting. */
export async function readUnknownSettingForms(file: string, unknownKeys: readonly UnknownSettingKey[]): Promise<SettingsIngestionNotice[]> {
  const readings = await Promise.all(unknownKeys.map(async (unknown) => ({ unknown, form: await readUnknownSettingForm(unknown) })));
  return readings.flatMap(({ unknown, form }) => form === undefined ? [] : [{
    file,
    key: unknown.key,
    reason: `is not a setting this build knows; it looks like a newer form of ${form}`,
    remedy: 'update this component, or remove the key if it is a typo; the value was left in the file untouched',
    action: 'skipped' as const,
  }]);
}
