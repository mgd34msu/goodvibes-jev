/**
 * `contract.stall-route` (docs/design/contract-runner.md section 5.1): where a
 * stalled piece of work goes next, once nudging stopped making progress. One
 * choice about `{ unit, unmet, lastNudges, checks, lastOutput }`: `unit` is its
 * goal and criteria, `unmet` the criteria still failing, `lastNudges` the last
 * corrections sent, `checks` one line per check with each criterion's verdict,
 * and `lastOutput` the agent's last report (where it says what blocks it).
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
      'Nudging `unit` has stopped making progress. Given `unmet`, `lastNudges`, `checks` and `lastOutput`, how should the work go on?',
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
  ],
});
