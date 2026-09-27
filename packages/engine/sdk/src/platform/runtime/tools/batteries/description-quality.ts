/**
 * `engine.tools.description-quality`: does a tool's description tell the model
 * what the tool does and when to call it? One yes/no over the description text,
 * asked once per distinct description (contract-verifier.ts remembers each).
 *
 * Band: low stakes. A no only adds a warning to the tool's contract
 * verification; it never blocks registration.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

export const descriptionQuality = defineBattery({
  name: 'engine.tools.description-quality',
  version: 1,
  description: 'Whether a tool description clearly explains what the tool does and when a model should use it.',
  accuracyFloor: 0.9,
  items: {
    explains: yesNo(
      'This is the description of a tool offered to a language model. Does it clearly explain what the tool does and when to use it?',
      STAKES_BANDS.low.yesNo,
      {
        true: 'A model reading only this description would know what the tool does and in which situations to call it.',
        false: 'The description is vague, a bare name or label, or leaves unclear what the tool does or when to call it.',
      },
    ),
  },
  fixtures: [
    {
      name: 'file read tool',
      state: 'Read the contents of a file in the workspace. Use this before editing a file, or when you need to see what a file contains. Supports line ranges for large files.',
      expect: { explains: 'yes' },
    },
    {
      name: 'web fetch tool',
      state: 'Fetch a URL over HTTP and return the response body as text or markdown. Use when the user gives a link or you need the current content of a public web page.',
      expect: { explains: 'yes' },
    },
    {
      name: 'short but complete',
      state: 'Run a shell command in the project directory and return its output. Use for builds, tests and git.',
      expect: { explains: 'yes' },
    },
    {
      name: 'bare label',
      state: 'Helper tool.',
      expect: { explains: 'no' },
    },
    {
      name: 'repeats the name',
      state: 'The query tool.',
      expect: { explains: 'no' },
    },
    {
      name: 'long but says nothing',
      state: 'This tool is a powerful and flexible utility designed to help with many different kinds of tasks across the system in a variety of useful ways.',
      expect: { explains: 'no' },
    },
    {
      name: 'what without when',
      state: 'Does things with packets.',
      expect: { explains: 'no' },
    },
  ],
});
