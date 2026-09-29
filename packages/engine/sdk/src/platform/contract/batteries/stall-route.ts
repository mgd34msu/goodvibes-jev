/**
 * `contract.stall-route` (docs/design/contract-runner.md section 5.1): where a
 * stalled piece of work goes next, once nudging stopped making progress. One
 * choice about `{ unit, unmet, unshown, lastNudges, checks, lastOutput }`:
 * `unit` is the stalled target's goal and criteria (a unit, a group or the
 * deliverable), `unmet` the criteria still read failing, `unshown` those the
 * evidence has not shown met, `lastNudges` the last corrections sent (empty for
 * a group or the deliverable, which have no agent of their own), `checks` one
 * line per check with each criterion's verdict, and `lastOutput` the agent's
 * last report (where it says what blocks it), or for a group or the
 * deliverable the answers its checks read.
 *
 * Code rules around the reading live in correction.ts: the fix-round cap goes
 * to the owner without asking, a merge conflict goes to a planned fix without
 * asking, and a reading below act goes to the owner.
 *
 * Band: medium stakes. A wrong split or fresh start costs one more round of
 * work, which is then checked like any other; a wrong owner route costs the
 * owner a question.
 */
import { defineBattery, oneOf, STAKES_BANDS } from '@goodvibes-jev/judgment';
import type { StallRoute } from '../../../events/contract.js';

export const STALL_ROUTE_OPTIONS = {
  split: 'The remaining problems are large or span several parts, and would be handled better as smaller separate pieces of work',
  fresh: 'The agent is stuck in one approach and a new attempt with a clean start could succeed',
  owner: "The remaining problems need a decision, access or information only the owner can give, or the unit's criteria conflict",
} as const satisfies Readonly<Record<StallRoute, string>>;

const EXPORT_UNIT = {
  goal: 'The report command exports the monthly report as CSV, JSON and XML',
  criteria: [
    'u2.c1 report --format csv writes a CSV file with one row per account',
    'u2.c2 report --format json writes a JSON array with one object per account',
    'u2.c3 report --format xml writes an XML document with one <account> element per account',
    'u2.c4 Each format has tests that pass',
  ],
};

const DATE_UNIT = {
  goal: 'parseDate reads the three date formats the importer receives',
  criteria: [
    "u1.c1 parseDate('2026-03-04') returns 4 March 2026",
    "u1.c2 parseDate('04/03/2026') returns 4 March 2026",
    "u1.c3 parseDate('4 Mar 2026') returns 4 March 2026",
  ],
};

export const stallRoute = defineBattery({
  name: 'contract.stall-route',
  version: 1,
  description: 'Where stalled work goes next: split into smaller planned pieces, a fresh agent with a clean start, or the owner.',
  accuracyFloor: 0.9,
  items: {
    route: oneOf(
      'Work on `unit` has stopped making progress: `unmet` lists its criteria still failing and `unshown` those not yet shown met. Given those, `lastNudges` (the corrections sent; empty when the work has no agent of its own), `checks` and `lastOutput`, how should the work go on?',
      STALL_ROUTE_OPTIONS,
      STAKES_BANDS.medium.confidence,
    ),
  },
  fixtures: [
    {
      name: 'three formats half done: split',
      state: {
        unit: EXPORT_UNIT,
        unmet: ['u2.c2', 'u2.c3', 'u2.c4'],
        unshown: [],
        lastNudges: [
          'Not met: [u2.c2] JSON output; [u2.c3] XML output; [u2.c4] tests for each format.',
          'Not met: [u2.c3] XML output; [u2.c4] tests for each format. Regressed: [u2.c2] JSON output.',
          'Not met: [u2.c2] JSON output; [u2.c3] XML output; [u2.c4] tests for each format.',
        ],
        checks: [
          'k1: u2.c1 met, u2.c2 unmet, u2.c3 unmet, u2.c4 unmet',
          'k2: u2.c1 met, u2.c2 met, u2.c3 unmet, u2.c4 unmet',
          'k3: u2.c1 met, u2.c2 unmet, u2.c3 unmet, u2.c4 unmet',
        ],
        lastOutput: 'CSV export works. I started the JSON writer and the XML writer and some tests, but each change to the shared row builder breaks another format. There is a lot left: the XML writer, the JSON escaping and tests for all three.',
      },
      expect: { route: 'split' },
    },
    {
      name: 'migration across many services: split',
      state: {
        unit: {
          goal: 'Every service reads its settings from the new config loader',
          criteria: [
            'u1.c1 The billing service reads its settings through loadConfig',
            'u1.c2 The search service reads its settings through loadConfig',
            'u1.c3 The mailer service reads its settings through loadConfig',
            'u1.c4 The scheduler service reads its settings through loadConfig',
            'u1.c5 No service reads process.env directly for settings',
          ],
        },
        unmet: ['u1.c2', 'u1.c3', 'u1.c4', 'u1.c5'],
        unshown: [],
        lastNudges: [
          'Not met: [u1.c2] search; [u1.c3] mailer; [u1.c4] scheduler; [u1.c5] no direct process.env reads.',
          'Not met: [u1.c3] mailer; [u1.c4] scheduler; [u1.c5] no direct process.env reads. Regressed: [u1.c2] search.',
          'Not met: [u1.c2] search; [u1.c3] mailer; [u1.c4] scheduler; [u1.c5] no direct process.env reads.',
        ],
        checks: [
          'k1: u1.c1 met, u1.c2 unmet, u1.c3 unmet, u1.c4 unmet, u1.c5 unmet',
          'k2: u1.c1 met, u1.c2 met, u1.c3 unmet, u1.c4 unmet, u1.c5 unmet',
          'k3: u1.c1 met, u1.c2 unmet, u1.c3 unmet, u1.c4 unmet, u1.c5 unmet',
        ],
        lastOutput: 'Billing is migrated. Search, mailer and scheduler each have their own settings code, and I keep running out of turns partway through one of them. Each service needs its own changes and its own tests.',
      },
      expect: { route: 'split' },
    },
    {
      name: 'same regex rewritten over and over: fresh',
      state: {
        unit: DATE_UNIT,
        unmet: ['u1.c2'],
        unshown: [],
        lastNudges: [
          "Not met: [u1.c2] parseDate('04/03/2026') returns 4 March 2026. Already met: [u1.c1], [u1.c3].",
          "Not met: [u1.c2] parseDate('04/03/2026') returns 4 March 2026. Already met: [u1.c1], [u1.c3].",
          "Not met: [u1.c2] parseDate('04/03/2026') returns 4 March 2026. Already met: [u1.c1], [u1.c3].",
        ],
        checks: [
          'k2: u1.c1 met, u1.c2 unmet, u1.c3 met',
          'k3: u1.c1 met, u1.c2 unmet, u1.c3 met',
          'k4: u1.c1 met, u1.c2 unmet, u1.c3 met',
        ],
        lastOutput: 'Adjusted the single big regular expression again so the slash form captures day before month. It should work now.',
      },
      expect: { route: 'fresh' },
    },
    {
      name: 'fixing one criterion keeps breaking the other: fresh',
      state: {
        unit: {
          goal: 'The cache evicts the least recently used entry when it is full',
          criteria: ['u3.c1 get moves an entry to most recently used', 'u3.c2 set on a full cache evicts the least recently used entry'],
        },
        unmet: ['u3.c1'],
        unshown: [],
        lastNudges: [
          'Not met: [u3.c2] eviction order. Already met: [u3.c1].',
          'Regressed: [u3.c1] get order. Already met: [u3.c2].',
          'Not met: [u3.c2] eviction order. Already met: [u3.c1].',
        ],
        checks: [
          'k2: u3.c1 met, u3.c2 unmet',
          'k3: u3.c1 unmet, u3.c2 met',
          'k4: u3.c1 met, u3.c2 unmet',
          'k5: u3.c1 unmet, u3.c2 met',
        ],
        lastOutput: 'Swapped the order of the two array splices in get and set again; the list now updates on get.',
      },
      expect: { route: 'fresh' },
    },
    {
      name: 'needs a credential the agent cannot have: owner',
      state: {
        unit: {
          goal: 'Refunds go through the payment provider',
          criteria: ['u4.c1 refund() calls the provider refund endpoint', 'u4.c2 The refund integration test passes against the provider sandbox'],
        },
        unmet: ['u4.c2'],
        unshown: [],
        lastNudges: [
          'Not shown: [u4.c2] run the refund integration test against the sandbox.',
          'Not met: [u4.c2] the refund integration test fails.',
          'Not met: [u4.c2] the refund integration test fails.',
        ],
        checks: ['k1: u4.c1 met, u4.c2 unshown', 'k2: u4.c1 met, u4.c2 unmet', 'k3: u4.c1 met, u4.c2 unmet'],
        lastOutput: 'The integration test fails with 401 Unauthorized: PAYMENTS_SANDBOX_KEY is not set in this environment and there is no key in the repository. I cannot get a sandbox key myself.',
      },
      expect: { route: 'owner' },
    },
    {
      name: 'two criteria that cannot both hold: owner',
      state: {
        unit: {
          goal: 'The price endpoint answers fast with current prices',
          criteria: ['u5.c1 GET /price responds in under 20 milliseconds', 'u5.c2 GET /price fetches the price from the supplier API on every request'],
        },
        unmet: ['u5.c1'],
        unshown: [],
        lastNudges: [
          'Not met: [u5.c1] responds in under 20 ms. Already met: [u5.c2].',
          'Not met: [u5.c1] responds in under 20 ms. Already met: [u5.c2].',
          'Regressed: [u5.c2] fetches on every request. Already met: [u5.c1].',
        ],
        checks: ['k1: u5.c1 unmet, u5.c2 met', 'k2: u5.c1 unmet, u5.c2 met', 'k3: u5.c1 met, u5.c2 unmet'],
        lastOutput: 'The supplier API itself takes 180 ms to answer, so a response that fetches from it on every request cannot come back in under 20 ms. Caching meets the time limit but then it no longer fetches on every request.',
      },
      expect: { route: 'owner' },
    },
    {
      name: 'a choice only the owner can make: owner',
      state: {
        unit: {
          goal: 'Old invoices are archived',
          criteria: ['u2.c1 Invoices older than the retention period move to the archive table', 'u2.c2 The retention period follows the company policy'],
        },
        unmet: ['u2.c2'],
        unshown: [],
        lastNudges: [
          'Not shown: [u2.c2] show the retention period follows the company policy.',
          'Not shown: [u2.c2] show the retention period follows the company policy.',
          'Not met: [u2.c2] the retention period is not the policy one.',
        ],
        checks: ['k1: u2.c1 met, u2.c2 unshown', 'k2: u2.c1 met, u2.c2 unshown', 'k3: u2.c1 met, u2.c2 unmet'],
        lastOutput: 'The archiving works with a 7 year period. Nothing in the repository or the docs says what the company retention policy is; it could be 5, 7 or 10 years. Someone who knows the policy has to say which.',
      },
      expect: { route: 'owner' },
    },
    {
      name: 'a migration only shown against data the agent cannot reach: owner',
      state: {
        unit: {
          goal: 'The orders table gains a currency column, filled for existing rows',
          criteria: ['u6.c1 A migration adds orders.currency', "u6.c2 After the migration every existing order has the currency of its store", 'u6.c3 The migration runs cleanly against a copy of the production database'],
        },
        unmet: [],
        unshown: ['u6.c3'],
        lastNudges: [
          'Not shown: [u6.c3] run the migration against a copy of the production database and show the output.',
          'Not shown: [u6.c3] run the migration against a copy of the production database and show the output.',
          'Not shown: [u6.c3] run the migration against a copy of the production database and show the output.',
        ],
        checks: ['k1: u6.c1 met, u6.c2 met, u6.c3 unshown', 'k2: u6.c1 met, u6.c2 met, u6.c3 unshown', 'k3: u6.c1 met, u6.c2 met, u6.c3 unshown'],
        lastOutput: 'The migration runs cleanly against the local test database. There is no copy of the production database here and no credentials for one; someone with access has to provide a copy or run it.',
      },
      expect: { route: 'owner' },
    },
    {
      name: 'tests claimed again and again but never run: fresh',
      state: {
        unit: {
          goal: 'The cart total applies percentage discount codes',
          criteria: ['u2.c1 applyDiscount takes a percentage off the cart total', 'u2.c2 The cart tests pass'],
        },
        unmet: [],
        unshown: ['u2.c2'],
        lastNudges: [
          'Not shown: [u2.c2] run the cart tests and show the result. Already met: [u2.c1].',
          'Not shown: [u2.c2] run the cart tests and show the result. Already met: [u2.c1].',
          'Not shown: [u2.c2] run the cart tests and show the result. Already met: [u2.c1].',
        ],
        checks: ['k2: u2.c1 met, u2.c2 unshown', 'k3: u2.c1 met, u2.c2 unshown', 'k4: u2.c1 met, u2.c2 unshown'],
        lastOutput: 'Reworded the discount comments again. The cart tests should all pass now.',
      },
      expect: { route: 'fresh' },
    },
    {
      name: 'a group whose parts fail in several separate places: split',
      state: {
        unit: {
          goal: 'Account settings can be exported and imported as JSON, YAML and TOML',
          criteria: [
            'g1.c1 Exporting as JSON and importing the file restores every setting',
            'g1.c2 Exporting as YAML and importing the file restores every setting',
            'g1.c3 Exporting as TOML and importing the file restores every setting',
            'g1.c4 Each format has round-trip tests that pass',
          ],
        },
        unmet: ['g1.c2', 'g1.c3', 'g1.c4'],
        unshown: [],
        lastNudges: [],
        checks: [
          'k1: g1.c1 met, g1.c2 unmet, g1.c3 unmet, g1.c4 unmet',
          'k2: g1.c1 met, g1.c2 unmet, g1.c3 unmet, g1.c4 unmet',
          'k3: g1.c1 met, g1.c2 unmet, g1.c3 unmet, g1.c4 unmet',
        ],
        lastOutput: 'u1 "Settings model": Added the settings schema.\nu2 "JSON": JSON export and import work.\nu3 "YAML and TOML": YAML drops nested notification settings on import; TOML writes dates the importer cannot read; there are no round-trip tests for either.',
      },
      expect: { route: 'split' },
    },
    {
      name: 'a group whose criterion needs a service only the owner can open: owner',
      state: {
        unit: {
          goal: 'Order emails go out through the new mail provider',
          criteria: ['g2.c1 The mailer sends through the provider API', 'g2.c2 A test email sent through the provider reaches the test inbox'],
        },
        unmet: [],
        unshown: ['g2.c2'],
        lastNudges: [],
        checks: ['k1: g2.c1 met, g2.c2 unshown', 'k2: g2.c1 met, g2.c2 unshown', 'k3: g2.c1 met, g2.c2 unshown'],
        lastOutput: 'u1 "Mailer": The mailer calls the provider send endpoint.\nu2 "Test send": The provider rejects the test send with 403 "account not verified"; the account has to be verified in the provider dashboard by its owner.',
      },
      expect: { route: 'owner' },
    },
    {
      name: 'a deliverable whose criteria cannot both hold: owner',
      state: {
        unit: {
          goal: 'The convert command writes CSV rows as JSON',
          criteria: [
            'c1 The JSON objects keep the columns in the order the CSV file has them',
            'c2 The JSON objects list their keys in alphabetical order',
          ],
        },
        unmet: ['c1'],
        unshown: [],
        lastNudges: [],
        checks: ['k1: c1 met, c2 unmet', 'k2: c1 unmet, c2 met', 'k3: c1 met, c2 unmet', 'k4: c1 unmet, c2 met'],
        lastOutput: 'convert writes each row as a JSON object with its keys sorted alphabetically. Keeping the CSV column order would put the keys out of alphabetical order for this file.',
      },
      expect: { route: 'owner' },
    },
    {
      name: 'a deliverable with many parts still missing: split',
      state: {
        unit: {
          goal: 'An admin dashboard showing signups, revenue and churn, each with a chart and a CSV download',
          criteria: [
            'c1 The dashboard shows a signups chart with a CSV download',
            'c2 The dashboard shows a revenue chart with a CSV download',
            'c3 The dashboard shows a churn chart with a CSV download',
          ],
        },
        unmet: ['c2', 'c3'],
        unshown: [],
        lastNudges: [],
        checks: ['k1: c1 met, c2 unmet, c3 unmet', 'k2: c1 met, c2 unmet, c3 unmet', 'k3: c1 met, c2 unmet, c3 unmet'],
        lastOutput: 'The dashboard page shows the signups chart with its CSV download. Revenue and churn have placeholder panels: their queries, charts and downloads are not built yet.',
      },
      expect: { route: 'split' },
    },
  ],
});
