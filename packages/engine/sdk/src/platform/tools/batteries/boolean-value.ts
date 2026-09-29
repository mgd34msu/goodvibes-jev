/**
 * `engine.tools.boolean-value`: a tool call passed a string where the schema
 * declares a boolean parameter, and the string is not the JSON literal `true`
 * or `false`. Which boolean did the caller mean, if any? Read by Jev over the
 * value, the parameter's name and its description, in place of the two-word
 * list that read `yes` and `no` (any case) as booleans and left every other
 * spelling (`on`, `enabled`, `y`, `off`) unrepaired.
 *
 * The JSON literals stay code (auto-repair.ts): the JSON grammar spells the
 * two booleans `true` and `false`, so a string holding exactly one of them is
 * that boolean.
 *
 * Band: high stakes, as `engine.tools.param-fill`. The repaired call runs as
 * if the caller had sent it, so a wrong boolean can turn on a flag such as
 * `force` or `recursive` the caller did not ask for; a missed repair only
 * lets the call fail on its parameter type, as it would have without repair.
 * Only a reading that acts on `true` or `false` is applied.
 */
import { defineBattery, oneOf, STAKES_BANDS } from '@goodvibes-jev/judgment';

/** Most characters of the value or the description the reading carries. */
export const MAX_JUDGED_BOOLEAN_CHARS = 300;

const clip = (text: string): string => (text.length <= MAX_JUDGED_BOOLEAN_CHARS ? text : `${text.slice(0, MAX_JUDGED_BOOLEAN_CHARS)}...`);

export const BOOLEAN_VALUE_OPTIONS = {
  true: 'The value says yes, on, enabled or true for this parameter.',
  false: 'The value says no, off, disabled or false for this parameter.',
  neither: 'The value is not a yes or no answer for this parameter (a path, a name, a number of items, a sentence, or something meant for another parameter).',
} as const;

export type BooleanValue = keyof typeof BOOLEAN_VALUE_OPTIONS;

/** What the reading sees: the tool, the parameter, its description when the schema has one, and the string value sent. */
export function booleanValueView(tool: string, parameter: string, description: string | undefined, value: string): { tool: string; parameter: string; description?: string; value: string } {
  return { tool, parameter, ...(description ? { description: clip(description) } : {}), value: clip(value) };
}

export const booleanValue = defineBattery({
  name: 'engine.tools.boolean-value',
  version: 1,
  description: 'Which boolean, if any, a string value sent for a boolean tool parameter means.',
  accuracyFloor: 0.85,
  items: {
    boolean_value: oneOf(
      'An AI model called the tool `tool` and sent the string `value` for the parameter `parameter`, which takes a boolean (true or false). `description`, when present, says what the parameter does. Which boolean did the model mean by `value`?',
      BOOLEAN_VALUE_OPTIONS,
      STAKES_BANDS.high.confidence,
    ),
  },
  fixtures: [
    { name: 'yes', state: booleanValueView('find', 'recursive', 'Search subdirectories too.', 'yes'), expect: { boolean_value: 'true' } },
    { name: 'on', state: booleanValueView('exec', 'background', 'Run the command in the background.', 'on'), expect: { boolean_value: 'true' } },
    { name: 'capitalized True', state: booleanValueView('write', 'overwrite', 'Replace the file if it exists.', 'True'), expect: { boolean_value: 'true' } },
    { name: 'enabled', state: booleanValueView('fetch', 'follow_redirects', undefined, 'enabled'), expect: { boolean_value: 'true' } },
    { name: 'no', state: booleanValueView('find', 'recursive', 'Search subdirectories too.', 'no'), expect: { boolean_value: 'false' } },
    { name: 'off', state: booleanValueView('exec', 'background', 'Run the command in the background.', 'off'), expect: { boolean_value: 'false' } },
    { name: 'capitalized FALSE', state: booleanValueView('write', 'overwrite', 'Replace the file if it exists.', 'FALSE'), expect: { boolean_value: 'false' } },
    { name: 'a path', state: booleanValueView('find', 'recursive', 'Search subdirectories too.', 'src/components'), expect: { boolean_value: 'neither' } },
    { name: 'a sentence', state: booleanValueView('write', 'overwrite', 'Replace the file if it exists.', 'the config file for the build'), expect: { boolean_value: 'neither' } },
    { name: 'maybe', state: booleanValueView('exec', 'background', 'Run the command in the background.', 'maybe'), expect: { boolean_value: 'neither' } },
  ],
});
