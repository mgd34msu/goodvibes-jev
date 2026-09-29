/**
 * `config.setting-form`: which known setting, if any, an unknown key in a
 * settings file is a newer or renamed form of. It replaces the prefix test in
 * settings-ingestion.ts (`knownFormOf`): either name starting with the other
 * caught `clientSecretRef` beside a known `clientSecret`, but also paired
 * unrelated names that happen to share a start, and missed a rename that
 * changes the start.
 *
 * The selector pattern: `context` is `{ section, name }`, the section the
 * unknown key sits in and its own name; each candidate is a setting this build
 * knows in that section, with its id as the candidate id and its schema
 * description (when it has one) as content. An unknown key that is a newer
 * form of none of them stays unremarked, since an app-layer section may carry
 * keys the engine has never heard of.
 *
 * Band: low stakes. The reading only chooses whether a skipped-key notice
 * names a known setting; the key is left in the file either way.
 */
import { defineSelector, NONE, STAKES_BANDS } from '@goodvibes-jev/judgment';

const OAUTH = [
  { id: 'clientId', content: 'OAuth client id of the calendar app registration' },
  { id: 'clientSecret', content: 'OAuth client secret for a confidential client registration' },
  { id: 'redirectUri', content: 'Redirect address registered with the provider' },
  { id: 'scopes', content: 'OAuth scopes requested when connecting' },
];

const RETRY = [
  { id: 'maxRetries', content: 'How many times a failed delivery is attempted again' },
  { id: 'timeoutMs', content: 'How long one delivery attempt may take, in milliseconds' },
  { id: 'enabled', content: 'Whether delivery is on' },
];

export const settingForm = defineSelector({
  name: 'config.setting-form',
  version: 1,
  description: 'Which known setting in the same section an unknown settings key is a newer or renamed form of, or none.',
  accuracyFloor: 0.9,
  instructions: 'A settings file holds `name` under `section`, and this build does not know that setting. Which of `candidates`, the settings this build knows in that section, is `name` a newer, renamed or extended form of, holding the same setting?',
  fitInstructions: 'Is `name` in `context` a newer, renamed or extended form of this known setting, holding the same setting?',
  band: STAKES_BANDS.low.confidence,
  fitBand: STAKES_BANDS.low.yesNo,
  fixtures: [
    { name: 'a reference form of a known secret', context: { section: 'calendar.google', name: 'clientSecretRef' }, candidates: OAUTH, expect: 'clientSecret' },
    { name: 'a renamed setting with a different start', context: { section: 'calendar.google', name: 'callbackUrl' }, candidates: OAUTH, expect: 'redirectUri' },
    { name: 'a singular rename', context: { section: 'delivery', name: 'maxRetry' }, candidates: RETRY, expect: 'maxRetries' },
    { name: 'a unit change of a known setting', context: { section: 'delivery', name: 'timeoutSeconds' }, candidates: RETRY, expect: 'timeoutMs' },
    { name: 'an unrelated key sharing a start', context: { section: 'delivery', name: 'enabledChannels' }, candidates: RETRY, expect: NONE },
    { name: 'an app-layer key the engine never had', context: { section: 'calendar.google', name: 'accentColor' }, candidates: OAUTH, expect: NONE },
  ],
});
