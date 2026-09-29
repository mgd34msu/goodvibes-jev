/**
 * `engine.tools.semantic-diff`: two narrow facts about a git diff, from which
 * analyze mode `semantic_diff` composes its risk tier in code
 * (analyze/git-modes.ts semanticDiffRisk):
 *
 * - `breaks_callers`: does the diff remove, rename, or change the required
 *   inputs or the output of something other code or users call? A yes is
 *   tier high.
 * - `changes_behavior`: does the diff change what existing code does when it
 *   runs? A yes (with no break) is tier medium; neither is tier low.
 *
 * Read by Jev in place of the free-text prompt that asked a helper model to
 * rate risk as low/medium/high and parsed the JSON reply, and in place of the
 * regex fallback (export, signature, async, return/throw/if line shapes and a
 * more-than-one-file count) that guessed the same tier when the model was
 * unavailable. There is no fallback path: the reading decides the tier.
 *
 * Band: medium stakes. The tier is advice to the person or agent reviewing a
 * change; a wrong low hides a risky change from that review, a wrong high
 * costs extra review. Code counts a fact that is not a confident no (an
 * uncertain reading) toward the higher tier, so doubt is shown as risk.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** Most characters of the diff one request carries; longer diffs are cut at a file or hunk boundary by the caller. */
export const MAX_JUDGED_DIFF_CHARS = 12_000;

/** What the reading sees: the refs, the changed files, and the (bounded) unified diff. */
export function semanticDiffView(range: string, changedFiles: readonly string[], diff: string): { range: string; changedFiles: string[]; diff: string } {
  return { range, changedFiles: [...changedFiles], diff };
}

const view = (files: readonly string[], diff: readonly string[]) => semanticDiffView('HEAD~1..HEAD', files, diff.join('\n'));

export const semanticDiff = defineBattery({
  name: 'engine.tools.semantic-diff',
  version: 1,
  description: 'Whether a git diff breaks the callers of something it changes, and whether it changes what existing code does when run.',
  accuracyFloor: 0.85,
  items: {
    breaks_callers: yesNo(
      '`diff` is a unified git diff of a code change. Would code, scripts or users that already call or use something changed here have to change too? That is the case when the diff removes or renames an exported function, class, type, constant, API route, command-line flag or config key, adds a required parameter or field, removes a parameter or field callers pass, or changes a return type or response shape. Adding new exports, adding optional parameters, and changing only internals, comments, tests or docs do not break callers.',
      STAKES_BANDS.medium.yesNo,
    ),
    changes_behavior: yesNo(
      '`diff` is a unified git diff of a code change. Does the diff change what existing code does when it runs: different results, different conditions or branches, different errors thrown, different side effects, or different timing such as making a call asynchronous? Changes that only add new code nothing calls yet, rename local variables, reformat, or edit comments, docs or tests do not change behavior.',
      STAKES_BANDS.medium.yesNo,
    ),
  },
  fixtures: [
    {
      name: 'docs only',
      state: view(['README.md'], [
        'diff --git a/README.md b/README.md',
        '@@ -10,3 +10,5 @@',
        ' ## Install',
        ' Run `bun install`.',
        '+',
        '+Then run `bun test` to check the setup.',
      ]),
      expect: { breaks_callers: 'no', changes_behavior: 'no' },
    },
    {
      name: 'comment rewrite',
      state: view(['src/cart.ts'], [
        'diff --git a/src/cart.ts b/src/cart.ts',
        '@@ -1,4 +1,4 @@',
        '-// Sum the line totals.',
        '+// Adds up every line total in the cart, before tax.',
        ' export function subtotal(lines: Line[]): number {',
        '   return lines.reduce((sum, line) => sum + line.total, 0);',
        ' }',
      ]),
      expect: { breaks_callers: 'no', changes_behavior: 'no' },
    },
    {
      name: 'new helper nothing calls yet',
      state: view(['src/format.ts'], [
        'diff --git a/src/format.ts b/src/format.ts',
        '@@ -12,3 +12,7 @@ export function formatPrice(cents: number): string {',
        '   return `$${(cents / 100).toFixed(2)}`;',
        ' }',
        '+',
        '+export function formatPercent(ratio: number): string {',
        '+  return `${Math.round(ratio * 100)}%`;',
        '+}',
      ]),
      expect: { breaks_callers: 'no', changes_behavior: 'no' },
    },
    {
      name: 'removed export',
      state: view(['src/api/users.ts'], [
        'diff --git a/src/api/users.ts b/src/api/users.ts',
        '@@ -20,9 +20,0 @@',
        '-export async function deleteUser(id: string): Promise<void> {',
        '-  await db.users.delete(id);',
        '-  await audit.log("user.deleted", { id });',
        '-}',
      ]),
      expect: { breaks_callers: 'yes', changes_behavior: 'yes' },
    },
    {
      name: 'new required parameter',
      state: view(['src/mail.ts'], [
        'diff --git a/src/mail.ts b/src/mail.ts',
        '@@ -3,5 +3,5 @@',
        '-export function sendWelcome(to: string): Promise<void> {',
        '-  return send(to, "Welcome!", welcomeBody());',
        '+export function sendWelcome(to: string, locale: string): Promise<void> {',
        '+  return send(to, translate("Welcome!", locale), welcomeBody(locale));',
        ' }',
      ]),
      expect: { breaks_callers: 'yes' },
    },
    {
      name: 'renamed cli flag',
      state: view(['src/cli.ts'], [
        'diff --git a/src/cli.ts b/src/cli.ts',
        '@@ -8,4 +8,4 @@',
        ' program',
        "-  .option('--dry-run', 'print the plan without applying it')",
        "+  .option('--plan-only', 'print the plan without applying it')",
        '   .parse(process.argv);',
      ]),
      expect: { breaks_callers: 'yes' },
    },
    {
      name: 'changed rounding inside a function',
      state: view(['src/tax.ts'], [
        'diff --git a/src/tax.ts b/src/tax.ts',
        '@@ -4,4 +4,4 @@ export function taxFor(amountCents: number, rate: number): number {',
        '-  return Math.round(amountCents * rate);',
        '+  return Math.floor(amountCents * rate);',
        ' }',
      ]),
      expect: { breaks_callers: 'no', changes_behavior: 'yes' },
    },
    {
      name: 'new guard throws on empty input',
      state: view(['src/orders.ts'], [
        'diff --git a/src/orders.ts b/src/orders.ts',
        '@@ -15,6 +15,9 @@ export function placeOrder(cart: Cart): Order {',
        '+  if (cart.lines.length === 0) {',
        "+    throw new Error('cannot place an empty order');",
        '+  }',
        '   const order = createOrder(cart);',
        '   return order;',
        ' }',
      ]),
      expect: { breaks_callers: 'no', changes_behavior: 'yes' },
    },
    {
      name: 'optional parameter added with a default',
      state: view(['src/search.ts'], [
        'diff --git a/src/search.ts b/src/search.ts',
        '@@ -1,4 +1,4 @@',
        '-export function search(query: string): Result[] {',
        '-  return index.find(query, 20);',
        '+export function search(query: string, limit = 20): Result[] {',
        '+  return index.find(query, limit);',
        ' }',
      ]),
      expect: { breaks_callers: 'no', changes_behavior: 'no' },
    },
    {
      name: 'local rename and reformat',
      state: view(['src/stats.ts'], [
        'diff --git a/src/stats.ts b/src/stats.ts',
        '@@ -2,5 +2,5 @@ export function mean(values: number[]): number {',
        '-  const s = values.reduce((a, b) => a + b, 0);',
        '-  return s / values.length;',
        '+  const total = values.reduce((a, b) => a + b, 0);',
        '+  return total / values.length;',
        ' }',
      ]),
      expect: { breaks_callers: 'no', changes_behavior: 'no' },
    },
    {
      name: 'response field renamed',
      state: view(['src/routes/profile.ts'], [
        'diff --git a/src/routes/profile.ts b/src/routes/profile.ts',
        '@@ -9,5 +9,5 @@ app.get("/api/profile", async (req, res) => {',
        '   const user = await loadUser(req.session.userId);',
        '-  res.json({ id: user.id, displayName: user.name });',
        '+  res.json({ id: user.id, name: user.name });',
        ' });',
      ]),
      expect: { breaks_callers: 'yes', changes_behavior: 'yes' },
    },
    {
      name: 'test added',
      state: view(['test/tax.test.ts'], [
        'diff --git a/test/tax.test.ts b/test/tax.test.ts',
        '@@ -10,3 +10,7 @@',
        " test('rounds half up', () => {",
        '   expect(taxFor(105, 0.1)).toBe(11);',
        ' });',
        "+test('zero rate is zero', () => {",
        '+  expect(taxFor(999, 0)).toBe(0);',
        '+});',
      ]),
      expect: { breaks_callers: 'no', changes_behavior: 'no' },
    },
  ],
});
