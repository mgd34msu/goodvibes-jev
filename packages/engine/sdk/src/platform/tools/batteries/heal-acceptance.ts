/**
 * `engine.tools.heal-acceptance`: whether an auto-heal repair
 * (tools/shared/auto-heal.ts) is accepted and written over the file. Each
 * stage's output is shown as a line diff from the content it was given,
 * with the validation errors it was meant to fix:
 *
 * - `fixes_errors` (every stage: formatter, linter, model rewrite): does the
 *   change fix every listed error? Replaces "the result transpiles" for
 *   JavaScript and TypeScript (which says nothing about type or lint
 *   errors) and "accept" for every other file.
 * - `only_the_fix` (the model's whole-file rewrite only): is the rewrite the
 *   given file with only the fix applied, nothing else removed, rewritten or
 *   added? Replaces accepting any rewrite that transpiles, which let a
 *   rewrite that dropped or changed unrelated code (or was cut off by the
 *   model's output limit) replace the file. A formatter's or linter's
 *   changes are the transformation the user enabled that tool for, so they
 *   are not asked this.
 *
 * A JavaScript or TypeScript result that does not parse is not asked about:
 * Bun's parser settles that it is not a repaired file.
 *
 * Band: high stakes. An accepted repair is written over the user's file with
 * no review; a false yes silently corrupts it. A repair is accepted only
 * when every question asked reads yes and acts.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** Most characters of a diff the readings carry; a larger change is not accepted (it cannot be read whole). */
export const MAX_JUDGED_CHANGE_CHARS = 60_000;

/** What the readings see: the file, the errors to fix, and the change as a unified diff. */
export type HealChangeView = { file: string; errors: string[]; change: string };

const HIGH = STAKES_BANDS.high.yesNo;

const view = (file: string, errors: string[], hunks: string[]): HealChangeView => ({ file, errors, change: [`--- ${file}`, `+++ ${file}`, ...hunks].join('\n') });

const BRACE = view('src/greet.ts', ["src/greet.ts(3,1): error TS1005: '}' expected."], [
  '@@ -1,3 +1,4 @@',
  ' export function greet(name: string): string {',
  '   return `Hello, ${name}`;',
  '+}',
  " export const DEFAULT_NAME = 'world';",
]);
const TYPO_AND_DROPPED_FUNCTION = view('src/cart.ts', ["src/cart.ts(12,10): error TS2304: Cannot find name 'totl'."], [
  '@@ -9,12 +9,6 @@',
  '   const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);',
  '   applyDiscount(cart, total);',
  '-  return totl;',
  '+  return total;',
  ' }',
  ' ',
  '-export function clearCart(cart: Cart): void {',
  '-  cart.items = [];',
  '-  cart.discount = undefined;',
  '-  saveCart(cart);',
  '-}',
  '-',
]);
const QUOTES_ONLY = view('src/api.ts', ["src/api.ts(7,10): error TS2304: Cannot find name 'respone'."], [
  '@@ -1,8 +1,8 @@',
  '-import { fetchJson } from "./http.js";',
  '-import type { User } from "./types.js";',
  "+import { fetchJson } from './http.js';",
  "+import type { User } from './types.js';",
  ' ',
  ' export async function loadUser(id: string): Promise<User> {',
  '   const response = await fetchJson(`/users/${id}`);',
  '   if (!response.ok) throw new Error(`load failed: ${response.status}`);',
  '   return respone.body as User;',
  ' }',
]);
const CUT_OFF_REWRITE = view('config/app.json', ['config/app.json: Unexpected token } in JSON at position 88'], [
  '@@ -3,14 +3,5 @@',
  '   "port": 8080,',
  '   "logLevel": "info",',
  '-  "features": ["search", "export",],',
  '+  "features": ["search", "export"]',
  '-  "database": {',
  '-    "host": "db.internal",',
  '-    "pool": 10',
  '-  },',
  '-  "cache": {',
  '-    "ttlSeconds": 300',
  '-  }',
  ' }',
]);
const PROPERTY_NAME = view('src/user.ts', ["src/user.ts(9,15): error TS2551: Property 'fullname' does not exist on type 'User'. Did you mean 'fullName'?"], [
  '@@ -7,4 +7,4 @@',
  ' export function label(user: User): string {',
  '   if (!user.active) return `${user.email} (inactive)`;',
  '-  return user.fullname;',
  '+  return user.fullName;',
  ' }',
]);
const UNRELATED_COMMENT = view('src/math.ts', ["src/math.ts(3,10): error TS2322: Type 'string' is not assignable to type 'number'."], [
  '@@ -1,4 +1,5 @@',
  '+// Arithmetic helpers.',
  ' export function double(value: number): number {',
  '   const doubled = value * 2;',
  '   return String(doubled);',
  ' }',
]);

export const healAcceptance = defineBattery({
  name: 'engine.tools.heal-acceptance',
  version: 1,
  description: 'Whether an automatic repair of a file that failed validation fixes the listed errors and, for a model\'s whole-file rewrite, changes nothing else.',
  accuracyFloor: 0.9,
  items: {
    fixes_errors: yesNo(
      '`errors` are validation errors reported for `file`, and `change` is a unified diff from the failing content to a proposed repair. Does the change fix every listed error, so that none of them would still be reported for the repaired content?',
      HIGH,
    ),
    only_the_fix: yesNo(
      '`errors` are validation errors reported for `file`, and `change` is a unified diff from the failing content to a rewrite of the whole file meant to repair it. Is the rewrite the original file with only the fix for the listed errors applied: nothing else removed, rewritten, reordered or added, and nothing cut off?',
      HIGH,
    ),
  },
  fixtures: [
    { name: 'adds the missing brace', state: BRACE, expect: { fixes_errors: 'yes', only_the_fix: 'yes' } },
    { name: 'fixes the typo but drops a function', state: TYPO_AND_DROPPED_FUNCTION, expect: { fixes_errors: 'yes', only_the_fix: 'no' } },
    { name: 'changes quotes, the error stays', state: QUOTES_ONLY, expect: { fixes_errors: 'no', only_the_fix: 'no' } },
    { name: 'removes the trailing comma but cuts off the file', state: CUT_OFF_REWRITE, expect: { only_the_fix: 'no' } },
    { name: 'corrects the property name', state: PROPERTY_NAME, expect: { fixes_errors: 'yes', only_the_fix: 'yes' } },
    { name: 'adds a comment, the type error stays', state: UNRELATED_COMMENT, expect: { fixes_errors: 'no', only_the_fix: 'no' } },
  ],
});
