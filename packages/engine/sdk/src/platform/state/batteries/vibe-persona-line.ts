/**
 * `engine.state.vibe-persona-line`: whether one non-bullet line of a VIBE.md
 * persona file is an instruction or preference about how the assistant should
 * behave or write, rather than a title, label or filler. Read by Jev in place
 * of vibe-projection.ts vibeBodyToConstraintOptions dropping every non-bullet
 * line of a bulleted body and every heading of a prose body, which silently
 * lost an intro line such as 'Always answer in British English.' above the
 * bullets.
 *
 * What code does with it (vibeBodyToConstraintOptions): in a bulleted body a
 * line read yes becomes its own persona record, in document order with the
 * bullets; in a body with no bullets a heading read yes stays in the prose
 * detail. A no, or a yes too weak to act on, leaves the line out. Bullet lines
 * are never read: each is one record by markdown list grammar.
 *
 * Band: low stakes. The persona block carries the precedence caveat, and the
 * import is person-initiated; the records can be edited or removed.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

export type VibeLineView = {
  /** One line of the file, as written. */
  readonly line: string;
  /** The whole file, for context. */
  readonly body: string;
};

const TEMPLATE = [
  '# VIBE.md',
  '',
  'Describe how GoodVibes Agent should feel and work with you.',
  '',
  '- Be direct about tradeoffs.',
  '- Prefer visible, reversible actions.',
].join('\n');

const INTRO_ABOVE_BULLETS = [
  '# Persona',
  'Always answer in British English.',
  '',
  '## Tone',
  '- Keep replies short.',
  '- No emoji.',
].join('\n');

const PROSE_WITH_HEADING = [
  '# Never apologise, just fix it',
  'Keep things calm and clear. Explain the plan before editing files.',
].join('\n');

const SECTIONED = [
  '## Code style',
  'Write TypeScript with strict types and never use any.',
  '- Run the tests before saying a change is done.',
  '',
  'Last updated March 2026',
].join('\n');

const WORKING_TOGETHER = [
  'My preferences for working together:',
  '- Ask before deleting anything.',
  '- Show diffs, not whole files.',
  '',
  '# Talk to me like a colleague, not a customer',
].join('\n');

export const vibePersonaLine = defineBattery({
  name: 'engine.state.vibe-persona-line',
  version: 1,
  description: 'Whether a non-bullet line of a VIBE.md persona file is an instruction or preference about how the assistant should behave or write, rather than a title, label or filler.',
  accuracyFloor: 0.9,
  items: {
    instruction: yesNo(
      '`body` is a VIBE.md persona file, where a person writes how they want their AI assistant to behave, talk and write. `line` is one line of it. Is `line` itself an instruction or preference about how the assistant should behave, talk or write, as opposed to a title, a section label, a date, or filler such as a template\'s explanation of what the file is for or a lead-in to a list?',
      STAKES_BANDS.low.yesNo,
      {
        true: 'The line tells the assistant how to behave, talk or write, even when it is written as a heading.',
        false: 'The line is a title, a section label, a date or note about the file, a lead-in to a list, or text addressed to the person filling in the file.',
      },
    ),
  },
  fixtures: [
    { name: 'the file title', state: { line: '# VIBE.md', body: TEMPLATE }, expect: { instruction: 'no' } },
    { name: 'the template explanation', state: { line: 'Describe how GoodVibes Agent should feel and work with you.', body: TEMPLATE }, expect: { instruction: 'no' } },
    { name: 'a section title above an intro line', state: { line: '# Persona', body: INTRO_ABOVE_BULLETS }, expect: { instruction: 'no' } },
    { name: 'an intro instruction above the bullets', state: { line: 'Always answer in British English.', body: INTRO_ABOVE_BULLETS }, expect: { instruction: 'yes' } },
    { name: 'a section label', state: { line: '## Tone', body: INTRO_ABOVE_BULLETS }, expect: { instruction: 'no' } },
    { name: 'an instruction written as a heading over prose', state: { line: '# Never apologise, just fix it', body: PROSE_WITH_HEADING }, expect: { instruction: 'yes' } },
    { name: 'a code style section label', state: { line: '## Code style', body: SECTIONED }, expect: { instruction: 'no' } },
    { name: 'a code style instruction under its label', state: { line: 'Write TypeScript with strict types and never use any.', body: SECTIONED }, expect: { instruction: 'yes' } },
    { name: 'a last-updated note', state: { line: 'Last updated March 2026', body: SECTIONED }, expect: { instruction: 'no' } },
    { name: 'a lead-in to a list', state: { line: 'My preferences for working together:', body: WORKING_TOGETHER }, expect: { instruction: 'no' } },
    { name: 'a closing instruction written as a heading', state: { line: '# Talk to me like a colleague, not a customer', body: WORKING_TOGETHER }, expect: { instruction: 'yes' } },
  ],
});
