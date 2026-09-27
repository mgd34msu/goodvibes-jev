/**
 * `engine.runtime.setup-reply-command`: whether a drafted setup reply hands
 * the user a command to type or a config key to edit, which the setup
 * contract (setup-contract.ts) forbids: the platform does the thing and says
 * what it did. One question per reply text; state: `{ reply }`, the text the
 * user would be shown.
 *
 * Band: low stakes. The reading flags wording in a reply; it never performs
 * or blocks an action.
 *
 * The fixtures are strings setup flows have actually shipped: the ones that
 * handed over a chore (the defects the contract was written against) and the
 * ones that replaced them.
 */
import { defineBattery, STAKES_BANDS, yesNo, type YesNoReading } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';

export const setupReplyCommand = defineBattery({
  name: 'engine.runtime.setup-reply-command',
  version: 1,
  description: 'Whether a setup reply tells the user to type a slash command or to set or edit a configuration key themselves, instead of the platform doing it.',
  accuracyFloor: 0.9,
  items: {
    instructs: yesNo(
      'Does `reply` hand the user a slash command (a command starting with "/") or a configuration key to type, set or edit themselves? A slash command shown on its own counts, since it reads as the thing to run. Asking the user to click something on a web page, sign in, paste a value into this conversation, or say yes does not count; neither does a URL or a report of what was already done.',
      STAKES_BANDS.low.yesNo,
    ),
  },
  fixtures: [
    { name: 'run a voice setup command', state: { reply: 'Run /voice setup to provision the managed local runtime.' }, expect: { instructs: 'yes' } },
    { name: 'set a wake config key', state: { reply: 'set voice.wake.surfaces.agent to true' }, expect: { instructs: 'yes' } },
    { name: 'bare slash command', state: { reply: '/voice wake setup' }, expect: { instructs: 'yes' } },
    { name: 'hand values over with a command', state: { reply: 'Hand both values over with: /google client <id> <secret>' }, expect: { instructs: 'yes' } },
    {
      name: 'fix naming a setup command',
      state: { reply: 'The stored grant is dead. Run `/google setup --path oauth` to create a new client, then try again.' },
      expect: { instructs: 'yes' },
    },
    {
      name: 'edit a config key by hand',
      state: { reply: 'To finish, edit calendar.google.clientId in your config file and restart the daemon.' },
      expect: { instructs: 'yes' },
    },
    { name: 'wake word reported on', state: { reply: 'Wake-word detection is on and this surface is listening.' }, expect: { instructs: 'no' } },
    { name: 'a download URL', state: { reply: 'Downloaded from https://example.com/model.onnx' }, expect: { instructs: 'no' } },
    {
      name: 'speech-to-text proposal',
      state: { reply: 'A wake word is only useful if what you say next becomes text, and speech-to-text is not set up on this machine yet, shall I provision the local speech-to-text runtime now so the whole thing works end to end?' },
      expect: { instructs: 'no' },
    },
    {
      name: 'fresh consent offer',
      state: { reply: 'Say the word and I will start a fresh consent for you to approve. Nothing is deleted until you say so.' },
      expect: { instructs: 'no' },
    },
    {
      name: 'publish the app in the console',
      state: { reply: 'Publish the app at https://console.cloud.google.com/auth/audience, set publishing status to "In production", which is self-certified and needs no review, then say the word and i will start a fresh consent.' },
      expect: { instructs: 'no' },
    },
    {
      name: 'paste the app password',
      state: { reply: 'Paste it here and I will put it straight into the encrypted store. Google shows it only in this dialog.' },
      expect: { instructs: 'no' },
    },
    { name: 'type into a web form', state: { reply: 'In the "App name" box type: GoodVibes' }, expect: { instructs: 'no' } },
    {
      name: 'offer to enable APIs',
      state: { reply: 'Say the word and I will enable both APIs through gcloud, which is signed in on this machine.' },
      expect: { instructs: 'no' },
    },
    { name: 'no credentials yet', state: { reply: 'No Google credentials found. Say the word and I will connect an account.' }, expect: { instructs: 'no' } },
    { name: 'ask for the client file path', state: { reply: 'Tell me where the client JSON is and I will read it from there.' }, expect: { instructs: 'no' } },
  ],
});

/**
 * Whether a reply tells the user to type a command or edit a config key: a
 * yes strong enough to act on. `site` names the decision site for the
 * decision log.
 */
export async function replyInstructsTyping(text: string, site: string): Promise<boolean> {
  const run = await setupReplyCommand.run(judgmentPort(site), { reply: text }, { site });
  const reading: YesNoReading = run.readings.instructs;
  return reading.verdict === 'yes' && reading.outcome === 'act';
}
