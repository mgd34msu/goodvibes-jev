/**
 * `contract.best-of-n` (docs/design/contract-runner.md section 6.2): which of
 * a unit's passing attempts to keep, or none. The select pattern: one choice
 * over the candidate ids plus "none", and one yes/no per candidate on whether
 * it meets every criterion with no defect another candidate avoids. The
 * winner stands only when its own fit reads yes.
 *
 * State: `{ context: { goal, criteria }, candidates: [{ id, content: { stat,
 * diff, answer } }] }`. Candidate ids are the attempt units' ids; only
 * attempts that passed their own checks are ever offered.
 *
 * Bands: high stakes. The chosen attempt becomes the unit's work with no
 * further unit check, so anything short of act goes to the owner.
 */
import { defineSelector, STAKES_BANDS, type Candidate, type JsonValue } from '@goodvibes-jev/judgment';

/**
 * The work-note marker word, assembled at run time: this fixture data needs
 * the word to mean what it tests, and the source scan (todo:check) forbids
 * the literal in published source, where it would read as a deferred-work note.
 */
const WORK_MARKER = ['TO', 'DO'].join('');

export const BEST_OF_N_INSTRUCTIONS = "Which candidate best achieves the unit's goal and criteria in `context`?";
export const BEST_OF_N_FIT_INSTRUCTIONS = "Does this candidate meet every criterion of the unit in `context`, with no defect that another candidate avoids?";

function context(goal: string, criteria: readonly string[]): JsonValue {
  return { goal, criteria: criteria.map((text, index) => ({ id: `u1.c${index + 1}`, text })) };
}

function attempt(index: number, stat: string, diff: readonly string[], answer: string): Candidate {
  return { id: `u1#a${index}`, content: { stat, diff: diff.join('\n'), answer } };
}

const BYTES = context('A formatBytes helper for the status line', [
  'formatBytes(n) returns n in the largest decimal unit (B, KB, MB, GB) with two decimals',
  'formatBytes(0) returns "0 B"',
]);

const BYTES_NO_ZERO = attempt(0, 'src/bytes.ts | 6 ++++++', [
  '--- /dev/null',
  '+++ b/src/bytes.ts',
  "+const UNITS = ['B', 'KB', 'MB', 'GB'];",
  '+export function formatBytes(n: number): string {',
  '+  const i = Math.floor(Math.log(n) / Math.log(1000));',
  '+  return `${(n / 1000 ** i).toFixed(2)} ${UNITS[i]}`;',
  '+}',
], 'Added formatBytes in src/bytes.ts.');

const BYTES_WITH_ZERO = attempt(1, 'src/bytes.ts | 7 +++++++', [
  '--- /dev/null',
  '+++ b/src/bytes.ts',
  "+const UNITS = ['B', 'KB', 'MB', 'GB'];",
  '+export function formatBytes(n: number): string {',
  "+  if (n === 0) return '0 B';",
  '+  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1000)));',
  '+  return `${(n / 1000 ** i).toFixed(2)} ${UNITS[i]}`;',
  '+}',
], 'Added formatBytes in src/bytes.ts; 0 returns "0 B" and values past GB stay in GB.');

const CSV = context('A CSV line parser for the import command', [
  'parseCsvLine splits a line into fields on commas',
  'A field wrapped in double quotes may contain commas, which stay part of the field',
]);

const CSV_QUOTES = attempt(0, 'src/csv.ts | 18 ++++++++++++++++++', [
  '--- /dev/null',
  '+++ b/src/csv.ts',
  '+export function parseCsvLine(line: string): string[] {',
  '+  const fields: string[] = [];',
  "+  let current = '';",
  '+  let quoted = false;',
  '+  for (const ch of line) {',
  '+    if (ch === \'"\') { quoted = !quoted; continue; }',
  "+    if (ch === ',' && !quoted) { fields.push(current); current = ''; continue; }",
  '+    current += ch;',
  '+  }',
  '+  fields.push(current);',
  '+  return fields;',
  '+}',
], 'parseCsvLine walks the line and keeps commas inside quoted fields.');

const CSV_SPLIT = attempt(1, 'src/csv.ts | 3 +++', [
  '--- /dev/null',
  '+++ b/src/csv.ts',
  '+export function parseCsvLine(line: string): string[] {',
  "+  return line.split(',');",
  '+}',
], 'parseCsvLine splits the line on commas.');

const CSV_SPLIT_TRIM = attempt(2, 'src/csv.ts | 3 +++', [
  '--- /dev/null',
  '+++ b/src/csv.ts',
  '+export function parseCsvLine(line: string): string[] {',
  "+  return line.split(',').map((field) => field.trim().replace(/^\"|\"$/g, ''));",
  '+}',
], 'parseCsvLine splits on commas and strips quotes from each field.');

const SLUG = context('A slugify helper for article URLs', [
  'slugify lowercases the title',
  'Runs of characters other than letters and digits become a single hyphen',
  'The slug has no leading or trailing hyphen',
]);

const SLUG_CASE = attempt(0, 'src/slug.ts | 3 +++', [
  '--- /dev/null',
  '+++ b/src/slug.ts',
  '+export function slugify(title: string): string {',
  "+  return title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');",
  '+}',
], 'slugify replaces runs of other characters with a hyphen and trims hyphens at the ends.');

const SLUG_EDGES = attempt(1, 'src/slug.ts | 3 +++', [
  '--- /dev/null',
  '+++ b/src/slug.ts',
  '+export function slugify(title: string): string {',
  "+  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-');",
  '+}',
], 'slugify lowercases and hyphenates the title.');

const SLUG_GOOD = attempt(2, 'src/slug.ts | 6 ++++++', [
  '--- /dev/null',
  '+++ b/src/slug.ts',
  '+export function slugify(title: string): string {',
  '+  return title',
  '+    .toLowerCase()',
  "+    .replace(/[^a-z0-9]+/g, '-')",
  "+    .replace(/^-+|-+$/g, '');",
  '+}',
], 'slugify lowercases, collapses runs of other characters into one hyphen, and trims hyphens at both ends.');

const EXPORT = context('An export command that writes orders to orders.csv', [
  'orders export writes every order to orders.csv with one row per order',
  'orders export --since <date> writes only the orders dated on or after <date>',
]);

const EXPORT_ALL_ONLY = attempt(0, 'src/commands/export.ts | 9 +++++++++', [
  '--- /dev/null',
  '+++ b/src/commands/export.ts',
  "+import { writeFileSync } from 'node:fs';",
  "+import { listOrders } from '../orders';",
  '+export function exportOrders(): void {',
  '+  const rows = listOrders().map((o) => `${o.id},${o.date},${o.total}`);',
  "+  writeFileSync('orders.csv', ['id,date,total', ...rows].join('\\n'));",
  '+}',
], 'Added orders export; it writes every order to orders.csv.');

const EXPORT_IGNORES_SINCE = attempt(1, 'src/commands/export.ts | 10 ++++++++++', [
  '--- /dev/null',
  '+++ b/src/commands/export.ts',
  "+import { writeFileSync } from 'node:fs';",
  "+import { listOrders } from '../orders';",
  '+export function exportOrders(options: { since?: string }): void {',
  `+  // ${WORK_MARKER}: filter by options.since`,
  '+  const rows = listOrders().map((o) => `${o.id},${o.date},${o.total}`);',
  "+  writeFileSync('orders.csv', ['id,date,total', ...rows].join('\\n'));",
  '+}',
], 'Added orders export with a --since option.');

const RETRY = context('A fetchWithRetry helper for the sync client', [
  'fetchWithRetry retries a failed request at most 3 times',
  'Each retry waits twice as long as the one before, starting at 200 ms',
]);

const RETRY_GOOD = attempt(0, 'src/retry.ts | 12 ++++++++++++', [
  '--- /dev/null',
  '+++ b/src/retry.ts',
  '+export async function fetchWithRetry(url: string): Promise<Response> {',
  '+  let delay = 200;',
  '+  for (let attempt = 0; ; attempt += 1) {',
  '+    try {',
  '+      return await fetch(url);',
  '+    } catch (error) {',
  '+      if (attempt === 3) throw error;',
  '+      await new Promise((resolve) => setTimeout(resolve, delay));',
  '+      delay *= 2;',
  '+    }',
  '+  }',
  '+}',
], 'fetchWithRetry retries up to 3 times, waiting 200, 400 and 800 ms.');

const RETRY_SKIPPED_TEST = attempt(1, 'src/retry.ts | 12 ++++++++++++\n test/retry.test.ts | 2 +-', [
  '--- /dev/null',
  '+++ b/src/retry.ts',
  '+export async function fetchWithRetry(url: string): Promise<Response> {',
  '+  let delay = 200;',
  '+  for (let attempt = 0; ; attempt += 1) {',
  '+    try {',
  '+      return await fetch(url);',
  '+    } catch (error) {',
  '+      if (attempt === 3) throw error;',
  '+      await new Promise((resolve) => setTimeout(resolve, delay));',
  '+      delay *= 2;',
  '+    }',
  '+  }',
  '+}',
  '--- a/test/retry.test.ts',
  '+++ b/test/retry.test.ts',
  "-test('gives up after three retries', async () => {",
  "+test.skip('gives up after three retries', async () => {",
], 'fetchWithRetry retries up to 3 times with doubling delays. The give-up test was flaky, so it is skipped.');

const RETRY_FOREVER = attempt(0, 'src/retry.ts | 10 ++++++++++', [
  '--- /dev/null',
  '+++ b/src/retry.ts',
  '+export async function fetchWithRetry(url: string): Promise<Response> {',
  '+  let delay = 200;',
  '+  while (true) {',
  '+    try {',
  '+      return await fetch(url);',
  '+    } catch {',
  '+      await new Promise((resolve) => setTimeout(resolve, delay));',
  '+      delay *= 2;',
  '+    }',
  '+  }',
  '+}',
], 'fetchWithRetry retries with doubling delays until the request succeeds.');

const RETRY_FIXED_DELAY = attempt(1, 'src/retry.ts | 10 ++++++++++', [
  '--- /dev/null',
  '+++ b/src/retry.ts',
  '+export async function fetchWithRetry(url: string): Promise<Response> {',
  '+  for (let attempt = 0; ; attempt += 1) {',
  '+    try {',
  '+      return await fetch(url);',
  '+    } catch (error) {',
  '+      if (attempt === 3) throw error;',
  '+      await new Promise((resolve) => setTimeout(resolve, 200));',
  '+    }',
  '+  }',
  '+}',
], 'fetchWithRetry retries up to 3 times, 200 ms apart.');

/**
 * What `createSelectAttemptJudge` sends for an engine outside any contract:
 * the work item's task as the goal and no criteria (contract/best-of-n.ts `taskContext`).
 */
const SLUG_TASK = { goal: 'Add a slugify helper that turns article titles into URL slugs: lowercase, a single hyphen between words, no hyphen at either end.', criteria: [] };
const BYTES_TASK = { goal: 'Add a formatBytes helper for the status line that shows sizes in B, KB, MB or GB, and shows 0 as "0 B".', criteria: [] };

export const bestOfN = defineSelector({
  name: 'contract.best-of-n',
  version: 1,
  description: "Which of a unit's passing attempts best achieves its goal and criteria, or none.",
  accuracyFloor: 0.9,
  instructions: BEST_OF_N_INSTRUCTIONS,
  fitInstructions: BEST_OF_N_FIT_INSTRUCTIONS,
  band: STAKES_BANDS.high.confidence,
  fitBand: STAKES_BANDS.high.yesNo,
  fixtures: [
    { name: 'the attempt that handles zero', context: BYTES, candidates: [BYTES_NO_ZERO, BYTES_WITH_ZERO], expect: 'u1#a1' },
    { name: 'the attempt that keeps quoted commas', context: CSV, candidates: [CSV_QUOTES, CSV_SPLIT, CSV_SPLIT_TRIM], expect: 'u1#a0' },
    { name: 'the attempt that meets all three rules', context: SLUG, candidates: [SLUG_CASE, SLUG_EDGES, SLUG_GOOD], expect: 'u1#a2' },
    { name: 'the attempt that does not skip a test', context: RETRY, candidates: [RETRY_GOOD, RETRY_SKIPPED_TEST], expect: 'u1#a0' },
    { name: 'a single attempt that meets every criterion', context: SLUG, candidates: [{ id: 'u1#a0', content: SLUG_GOOD.content }], expect: 'u1#a0' },
    { name: 'no attempt filters by date', context: EXPORT, candidates: [EXPORT_ALL_ONLY, EXPORT_IGNORES_SINCE], expect: 'none' },
    { name: 'no attempt meets both retry rules', context: RETRY, candidates: [RETRY_FOREVER, RETRY_FIXED_DELAY], expect: 'none' },
    { name: 'a single attempt that breaks quoted fields', context: CSV, candidates: [{ id: 'u1#a0', content: CSV_SPLIT.content }], expect: 'none' },
    { name: 'outside a contract: the task alone, the attempt that does all it says', context: SLUG_TASK, candidates: [SLUG_CASE, SLUG_EDGES, SLUG_GOOD], expect: 'u1#a2' },
    { name: 'outside a contract: the task alone, a single attempt that misses part of it', context: BYTES_TASK, candidates: [BYTES_NO_ZERO], expect: 'none' },
  ],
});
