/**
 * `contract.deliverable-judge` (docs/design/contract-runner.md section 6.4):
 * the judge pattern over the whole contract once every group passed. `goal` is
 * the contract goal, `criteria` the judged contract criteria (the user's
 * requirements, each traced to their words), `output` the answer the person
 * will receive, and `evidence` the contract's diff, gate results in the
 * contract's tree, and for each contract criterion the verdicts of the unit
 * criteria that serve it.
 *
 * Bands: the unit judge's two declared bands, chosen by
 * `contract.acceptanceStakes`.
 */
import { defineJudge, type Judge, type JudgeFixture, type YesNoBand } from '@goodvibes-jev/judgment';
import type { ContractAcceptanceStakes } from '../config.js';
import { UNIT_JUDGE_BANDS } from './unit-judge.js';

const CONVERT_GOAL = 'A convert command that reads a CSV file and writes it as JSON';
const CONVERT_CRITERIA = [
  'convert <in.csv> <out.json> writes the CSV rows as a JSON array of objects',
  'convert exits with status 1 and an error message when the input file does not exist',
] as const;

const CONVERT_SERVED = [
  { criterion: 'c1', servedBy: [{ id: 'u1.c1', text: 'parseCsv reads quoted fields', verdict: 'met' }, { id: 'u3.c1', text: 'convert writes parsed rows as JSON', verdict: 'met' }] },
  { criterion: 'c2', servedBy: [{ id: 'u3.c2', text: 'convert reports a missing input file', verdict: 'met' }] },
];

const FIXTURES: readonly JudgeFixture[] = [
  {
    name: 'the command works end to end',
    goal: CONVERT_GOAL,
    criteria: CONVERT_CRITERIA,
    output: 'The convert command is in src/cli/convert.ts. `convert in.csv out.json` writes the rows as a JSON array, and a missing input file prints "input file not found: in.csv" and exits 1.',
    evidence: {
      changedPaths: ['src/csv.ts', 'src/cli/convert.ts', 'src/cli/convert.test.ts'],
      diff: [
        '+++ b/src/cli/convert.ts',
        'export function convert(input: string, output: string): number {',
        '+  if (!existsSync(input)) {',
        '+    console.error(`input file not found: ${input}`);',
        '+    return 1;',
        '+  }',
        "+  writeFileSync(output, JSON.stringify(parseCsv(readFileSync(input, 'utf-8'))));",
        '+  return 0;',
        '+}',
      ].join('\n'),
      omitted: ['src/csv.ts', 'src/cli/convert.test.ts'],
      gates: [{ gate: 'test', passed: true, output: ' 12 pass\n 0 fail' }],
      commands: [
        { command: 'bun run src/cli/index.ts convert fixtures/a.csv /tmp/a.json && cat /tmp/a.json', success: true, head: '[{"name":"Ada","age":"36"},{"name":"Alan","age":"41"}]' },
        { command: 'bun run src/cli/index.ts convert missing.csv /tmp/b.json; echo "exit $?"', success: true, head: 'input file not found: missing.csv\nexit 1' },
      ],
      criteria: CONVERT_SERVED,
    },
    expect: { verdict: 'pass', unmet: [] },
  },
  {
    name: 'a missing input file is silently treated as empty and exits 0',
    goal: CONVERT_GOAL,
    criteria: CONVERT_CRITERIA,
    output: 'The convert command is in src/cli/convert.ts and writes the rows as a JSON array.',
    evidence: {
      changedPaths: ['src/csv.ts', 'src/cli/convert.ts'],
      diff: [
        '+++ b/src/cli/convert.ts',
        'export function convert(input: string, output: string): number {',
        "+  const text = existsSync(input) ? readFileSync(input, 'utf-8') : '';",
        '+  writeFileSync(output, JSON.stringify(parseCsv(text)));',
        '+  return 0;',
        '+}',
      ].join('\n'),
      omitted: ['src/csv.ts'],
      gates: [{ gate: 'test', passed: true, output: ' 8 pass\n 0 fail' }],
      commands: [
        { command: 'bun run src/cli/index.ts convert fixtures/a.csv /tmp/a.json && cat /tmp/a.json', success: true, head: '[{"name":"Ada","age":"36"},{"name":"Alan","age":"41"}]' },
        { command: 'bun run src/cli/index.ts convert missing.csv /tmp/b.json; echo "exit $?"', success: true, head: 'exit 0' },
        { command: 'cat /tmp/b.json', success: true, head: '[]' },
      ],
      criteria: CONVERT_SERVED,
    },
    expect: { verdict: 'fail', unmet: [1] },
  },
  {
    name: 'every stated criterion holds but the answer is about something else',
    goal: 'A backup script that copies the database file into backups/ under a dated name',
    criteria: ['Running scripts/backup.sh creates a file in backups/', 'The backup file name contains the date'],
    output: 'I looked at the database layer and wrote up how the connection pool is configured. The pool size is 10 and idle connections close after 30 seconds.',
    evidence: {
      changedPaths: ['scripts/backup.sh'],
      diff: [
        '+++ b/scripts/backup.sh',
        '+#!/bin/sh',
        '+cp data/app.db "backups/app-$(date +%F).db"',
      ].join('\n'),
      omitted: [],
      gates: [],
      commands: [{ command: 'sh scripts/backup.sh && ls backups', success: true, head: 'app-2026-09-27.db' }],
      criteria: [
        { criterion: 'c1', servedBy: [{ id: 'u1.c1', text: 'backup.sh copies the database into backups/', verdict: 'met' }] },
        { criterion: 'c2', servedBy: [{ id: 'u1.c2', text: 'the copy is named with the date', verdict: 'met' }] },
      ],
    },
    expect: { verdict: 'fail', unmet: [] },
  },
  {
    name: 'a research deliverable that answers what was asked',
    goal: 'A recommendation of which queue library to adopt for background jobs, with reasons',
    criteria: ['The answer names one queue library to adopt', 'The answer gives at least two reasons for the choice'],
    output: 'Recommendation: adopt BullMQ.\n\nReasons: it runs on the Redis we already operate, so no new service; it supports delayed and repeatable jobs, which the invoice reminders need; and it has a maintained dashboard.',
    evidence: {
      changedPaths: [],
      diff: '',
      omitted: [],
      gates: [],
      commands: [],
      criteria: [
        { criterion: 'c1', servedBy: [{ id: 'u1.c1', text: 'names one library', verdict: 'met' }] },
        { criterion: 'c2', servedBy: [{ id: 'u1.c2', text: 'gives reasons', verdict: 'met' }] },
      ],
    },
    expect: { verdict: 'pass', unmet: [] },
  },
];

function deliverableJudge(band: YesNoBand): Judge {
  return defineJudge({
    name: 'contract.deliverable-judge',
    version: 1,
    description: "Whether the finished deliverable meets each of the user's requirements, shown by the answer and the contract's evidence, and whether it achieves what the user asked for.",
    accuracyFloor: 0.9,
    band,
    fixtures: FIXTURES,
  });
}

/** The deliverable judge under each acceptance-stakes band; the fixtures and questions are the same. */
export const DELIVERABLE_JUDGES: Readonly<Record<ContractAcceptanceStakes, Judge>> = {
  high: deliverableJudge(UNIT_JUDGE_BANDS.high),
  critical: deliverableJudge(UNIT_JUDGE_BANDS.critical),
};

/** The registered instance: calibration checks answers, which do not depend on the band. */
export const deliverableJudgeDecision = DELIVERABLE_JUDGES.high;
