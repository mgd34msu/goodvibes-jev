/**
 * `engine.tools.export-break`: analyze mode `breaking` finds each exported
 * declaration whose declaration text differs between the two refs of a diff;
 * these readings decide whether that change breaks the export's callers. They
 * replace reporting every text difference as breaking, which listed an added
 * optional parameter, a widened parameter type and a reformatted signature
 * beside a removed parameter.
 *
 * An export removed from the diff stays code: its name is gone, so every
 * caller that names it must change. An unchanged declaration is not read.
 *
 * Two narrow facts, composed in code (analyze/git-modes.ts exportBreakVerdict):
 * `inputs_break` (would a call written for the old declaration be rejected
 * now) and `output_breaks` (can callers no longer use what it returns or is
 * as before). Either yes is breaking, both no is safe, anything else is
 * listed as breaking with the reading marked uncertain.
 *
 * Band: medium stakes, as `engine.tools.semantic-diff`. The report is advice
 * to the person or agent reviewing a change; a wrong no hides a break from
 * that review, a wrong yes costs extra review.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** What the reading sees: the export's name and its declaration before and after. */
export function exportBreakView(name: string, before: string, after: string): { name: string; before: string; after: string } {
  return { name, before, after };
}

const CONTEXT = '`before` and `after` are the declaration of the exported `name` (its signature, without the body) before and after a code change. Callers are checked against the declared parameters and types, as a TypeScript compiler checks them.';

export const exportBreak = defineBattery({
  name: 'engine.tools.export-break',
  version: 1,
  description: 'Whether a change to an exported declaration rejects existing calls, and whether callers can still use what it returns.',
  accuracyFloor: 0.85,
  items: {
    inputs_break: yesNo(
      `${CONTEXT} Would a call written for \`before\`, passing the arguments \`before\` declares with the types it declares, be rejected or fail against \`after\`? That is the case when a parameter is removed, a required parameter is added, an optional parameter becomes required, or a parameter type is narrowed. Adding an optional parameter or one with a default, widening a parameter type, renaming a parameter, reformatting, and changing only the return type leave such calls valid.`,
      STAKES_BANDS.medium.yesNo,
    ),
    output_breaks: yesNo(
      `${CONTEXT} Could code that uses what \`name\` returns or is, relying on \`before\`, no longer use it the same way against \`after\`? That is the case when the return type changes to a different type, can now also be undefined or null, becomes a Promise because the function became async, or the export becomes a different kind of thing (a function becoming a constant or a class). Changes only to parameters, a return type that stays the same, and reformatting do not affect it.`,
      STAKES_BANDS.medium.yesNo,
    ),
  },
  fixtures: [
    { name: 'required parameter added', state: exportBreakView('sendWelcome', 'sendWelcome(to: string): Promise<void>', 'sendWelcome(to: string, locale: string): Promise<void>'), expect: { inputs_break: 'yes', output_breaks: 'no' } },
    { name: 'parameter removed', state: exportBreakView('search', 'search(query: string, limit: number): Result[]', 'search(query: string): Result[]'), expect: { inputs_break: 'yes', output_breaks: 'no' } },
    { name: 'parameter type narrowed', state: exportBreakView('formatId', 'formatId(id: string | number): string', 'formatId(id: string): string'), expect: { inputs_break: 'yes', output_breaks: 'no' } },
    { name: 'optional parameter made required', state: exportBreakView('connect', 'connect(url: string, timeoutMs?: number): Client', 'connect(url: string, timeoutMs: number): Client'), expect: { inputs_break: 'yes' } },
    { name: 'return may be undefined', state: exportBreakView('loadUser', 'loadUser(id: string): User', 'loadUser(id: string): User | undefined'), expect: { inputs_break: 'no', output_breaks: 'yes' } },
    { name: 'became async', state: exportBreakView('readConfig', 'readConfig(path: string): Config', 'async readConfig(path: string): Promise<Config>'), expect: { inputs_break: 'no', output_breaks: 'yes' } },
    { name: 'return type replaced', state: exportBreakView('count', 'count(items: Item[]): string', 'count(items: Item[]): number'), expect: { inputs_break: 'no', output_breaks: 'yes' } },
    { name: 'optional parameter added', state: exportBreakView('search', 'search(query: string): Result[]', 'search(query: string, limit?: number): Result[]'), expect: { inputs_break: 'no', output_breaks: 'no' } },
    { name: 'default parameter added', state: exportBreakView('paginate', 'paginate(items: Item[]): Page[]', 'paginate(items: Item[], pageSize = 20): Page[]'), expect: { inputs_break: 'no', output_breaks: 'no' } },
    { name: 'reformatted', state: exportBreakView('mean', 'mean(values:number[]):number', 'mean(values: number[]): number'), expect: { inputs_break: 'no', output_breaks: 'no' } },
    { name: 'parameter type widened', state: exportBreakView('formatId', 'formatId(id: string): string', 'formatId(id: string | number): string'), expect: { inputs_break: 'no', output_breaks: 'no' } },
    { name: 'parameter renamed', state: exportBreakView('taxFor', 'taxFor(amount: number, rate: number): number', 'taxFor(amountCents: number, rate: number): number'), expect: { inputs_break: 'no', output_breaks: 'no' } },
  ],
});
