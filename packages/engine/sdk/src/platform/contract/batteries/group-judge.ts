/**
 * `contract.group-judge` (docs/design/contract-runner.md section 6.4): the
 * judge pattern over a group once every unit in it passed. `goal` is the
 * group's goal, `criteria` its criteria, `output` the units' answers, and
 * `evidence` the group's diff since it started, its gate results in the
 * contract's tree, and each unit's criteria with their verdicts.
 *
 * Bands: the unit judge's two declared bands, chosen by
 * `contract.acceptanceStakes` (a false pass accepts failing work).
 */
import { defineJudge, type Judge, type JudgeFixture, type YesNoBand } from '@goodvibes-jev/judgment';
import type { ContractAcceptanceStakes } from '../config.js';
import { UNIT_JUDGE_BANDS } from './unit-judge.js';

const MODULES_GOAL = 'A CSV parser and a JSON formatter, each tested, ready for the convert command';
const MODULES_CRITERIA = [
  'parseCsv and formatJson are both exported from src/index.ts',
  'The tests for both modules pass',
] as const;

const MODULE_UNITS = [
  { id: 'u1', title: 'CSV parser', criteria: [{ id: 'u1.c1', text: 'src/csv.ts parses quoted fields and its tests pass', verdict: 'met' }] },
  { id: 'u2', title: 'JSON formatter', criteria: [{ id: 'u2.c1', text: 'src/json.ts formats records as pretty JSON and its tests pass', verdict: 'met' }] },
];

const FIXTURES: readonly JudgeFixture[] = [
  {
    name: 'both modules exported and tested',
    goal: MODULES_GOAL,
    criteria: MODULES_CRITERIA,
    output: 'u1 "CSV parser": Added parseCsv in src/csv.ts with tests.\nu2 "JSON formatter": Added formatJson in src/json.ts with tests.',
    evidence: {
      changedPaths: ['src/csv.ts', 'src/csv.test.ts', 'src/json.ts', 'src/json.test.ts', 'src/index.ts'],
      diff: [
        '+++ b/src/index.ts',
        "+export { parseCsv } from './csv';",
        "+export { formatJson } from './json';",
      ].join('\n'),
      omitted: ['src/csv.ts', 'src/csv.test.ts', 'src/json.ts', 'src/json.test.ts'],
      gates: [{ gate: 'test', passed: true, output: ' 9 pass\n 0 fail\nRan 9 tests across 2 files.' }],
      units: MODULE_UNITS,
    },
    expect: { verdict: 'pass', unmet: [] },
  },
  {
    name: 'the formatter is never exported',
    goal: MODULES_GOAL,
    criteria: MODULES_CRITERIA,
    output: 'u1 "CSV parser": Added parseCsv in src/csv.ts with tests.\nu2 "JSON formatter": Added formatJson in src/json.ts with tests.',
    evidence: {
      changedPaths: ['src/csv.ts', 'src/csv.test.ts', 'src/json.ts', 'src/json.test.ts', 'src/index.ts'],
      diff: ['+++ b/src/index.ts', "+export { parseCsv } from './csv';"].join('\n'),
      omitted: ['src/csv.ts', 'src/csv.test.ts', 'src/json.ts', 'src/json.test.ts'],
      gates: [{ gate: 'test', passed: true, output: ' 9 pass\n 0 fail\nRan 9 tests across 2 files.' }],
      units: MODULE_UNITS,
    },
    expect: { verdict: 'fail', unmet: [0] },
  },
  {
    name: 'the tests fail once both modules sit together',
    goal: MODULES_GOAL,
    criteria: MODULES_CRITERIA,
    output: 'u1 "CSV parser": Added parseCsv in src/csv.ts with tests.\nu2 "JSON formatter": Added formatJson in src/json.ts with tests.',
    evidence: {
      changedPaths: ['src/csv.ts', 'src/csv.test.ts', 'src/json.ts', 'src/json.test.ts', 'src/index.ts'],
      diff: [
        '+++ b/src/index.ts',
        "+export { parseCsv } from './csv';",
        "+export { formatJson } from './json';",
      ].join('\n'),
      omitted: ['src/csv.ts', 'src/csv.test.ts', 'src/json.ts', 'src/json.test.ts'],
      gates: [{
        gate: 'test',
        passed: false,
        output: "src/json.test.ts:\n(fail) formatJson > formats a parsed row\n  error: Cannot find name 'Row' imported from './csv'\n 7 pass\n 2 fail",
      }],
      units: MODULE_UNITS,
    },
    expect: { verdict: 'fail', unmet: [1] },
  },
  {
    name: 'every criterion holds but the group does not do its job: the two halves disagree on the record shape',
    goal: 'Orders can be exported and re-imported without losing data',
    criteria: ['exportOrders writes orders.json', 'importOrders reads orders.json'],
    output: 'u1 "Export": exportOrders writes orders.json as an array of { id, total }.\nu2 "Import": importOrders reads orders.json as an object keyed by order id.',
    evidence: {
      changedPaths: ['src/export.ts', 'src/import.ts'],
      diff: [
        '+++ b/src/export.ts',
        '+export function exportOrders(orders: Order[]): void {',
        "+  writeFileSync('orders.json', JSON.stringify(orders.map((o) => ({ id: o.id, total: o.total }))));",
        '+}',
        '+++ b/src/import.ts',
        '+export function importOrders(): Record<string, Order> {',
        "+  return JSON.parse(readFileSync('orders.json', 'utf-8')) as Record<string, Order>;",
        '+}',
      ].join('\n'),
      omitted: [],
      gates: [{ gate: 'typecheck', passed: true, output: '' }],
      units: [
        { id: 'u1', title: 'Export', criteria: [{ id: 'u1.c1', text: 'exportOrders writes orders.json', verdict: 'met' }] },
        { id: 'u2', title: 'Import', criteria: [{ id: 'u2.c1', text: 'importOrders reads orders.json', verdict: 'met' }] },
      ],
    },
    expect: { verdict: 'fail', unmet: [] },
  },
];

function groupJudge(band: YesNoBand): Judge {
  return defineJudge({
    name: 'contract.group-judge',
    version: 1,
    description: "Whether a group's combined work meets each of the group's criteria, shown by its units' answers and the group's evidence, and whether it achieves the group's goal.",
    accuracyFloor: 0.9,
    band,
    fixtures: FIXTURES,
  });
}

/** The group judge under each acceptance-stakes band; the fixtures and questions are the same. */
export const GROUP_JUDGES: Readonly<Record<ContractAcceptanceStakes, Judge>> = {
  high: groupJudge(UNIT_JUDGE_BANDS.high),
  critical: groupJudge(UNIT_JUDGE_BANDS.critical),
};

/** The registered instance: calibration checks answers, which do not depend on the band. */
export const groupJudgeDecision = GROUP_JUDGES.high;
