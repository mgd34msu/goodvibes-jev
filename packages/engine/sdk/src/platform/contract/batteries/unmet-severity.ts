/**
 * `contract.unmet-severity` (docs/design/contract-runner.md section 4.4): how
 * serious one unmet criterion is. One choice per unmet criterion, asked
 * concurrently after the nudge is sent so it never delays a nudge. State:
 * `{ request, goal, criterion }`, where `request` is the person's words, so the
 * reading can tell a requirement they stated from a detail.
 *
 * Band: low stakes. The severity only orders and labels what a nudge or an
 * escalation already lists; it never decides whether work passes.
 */
import { defineBattery, oneOf, STAKES_BANDS } from '@goodvibes-jev/judgment';
import type { CriterionSeverity } from '../types.js';

const SEVERITY_OPTIONS = {
  critical: 'While this is unmet the deliverable cannot be used for its goal at all',
  major: 'The deliverable can be used, but something the user asked for in `request` is missing or wrong',
  minor: 'A detail `request` does not ask for; the deliverable does what was asked without it',
} as const satisfies Readonly<Record<CriterionSeverity, string>>;

const EXPORT_REQUEST = 'Add an `export` command to the orders CLI that writes all orders to orders.csv. It must accept --since <date> to export only newer orders.';

export const unmetSeverity = defineBattery({
  name: 'contract.unmet-severity',
  version: 1,
  description: 'How serious it is that the work does not yet meet one acceptance criterion: critical, major or minor.',
  accuracyFloor: 0.9,
  items: {
    severity: oneOf(
      'How serious is it that the work does not yet meet `criterion`, given `request` and `goal`?',
      SEVERITY_OPTIONS,
      STAKES_BANDS.low.confidence,
    ),
  },
  fixtures: [
    {
      name: 'the command crashes',
      state: { request: EXPORT_REQUEST, goal: 'The export command writes every order to orders.csv', criterion: 'Running `orders export` exits without an error' },
      expect: { severity: 'critical' },
    },
    {
      name: 'the server never listens',
      state: {
        request: 'Build a small HTTP server that serves the files in ./public on port 8080.',
        goal: 'A static file server for ./public on port 8080',
        criterion: 'The server starts and accepts connections on port 8080',
      },
      expect: { severity: 'critical' },
    },
    {
      name: 'the file is never written',
      state: { request: EXPORT_REQUEST, goal: 'The export command writes every order to orders.csv', criterion: 'After `orders export` runs, orders.csv exists and holds one row per order' },
      expect: { severity: 'critical' },
    },
    {
      name: 'a stated filter flag is missing',
      state: { request: EXPORT_REQUEST, goal: 'The export command writes every order to orders.csv', criterion: 'export --since <date> writes only the orders dated on or after <date>' },
      expect: { severity: 'major' },
    },
    {
      name: 'a stated error message is missing',
      state: {
        request: 'Add a `config check` command that validates config.yaml. When a required key is missing, say which key.',
        goal: 'config check validates config.yaml and reports problems',
        criterion: 'When a required key is missing, config check names that key in its error message',
      },
      expect: { severity: 'major' },
    },
    {
      name: 'help text ordering',
      state: { request: EXPORT_REQUEST, goal: 'The export command writes every order to orders.csv', criterion: 'The help text for export lists its options in alphabetical order' },
      expect: { severity: 'minor' },
    },
    {
      name: 'progress message colour',
      state: {
        request: 'Add a `backup` command that copies the database file to backups/ with the date in the file name.',
        goal: 'backup copies the database into backups/ under a dated name',
        criterion: 'The progress message backup prints uses the same colours as the other commands',
      },
      expect: { severity: 'minor' },
    },
  ],
});
