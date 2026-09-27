#!/usr/bin/env bun
// observe-report.ts: the operator report over a decision log.
//
//   bun run observe:report [--log <decisions.sqlite>] [--workspace <dir>] [--surface <name>]
//                          [--since <iso>] [--until <iso>] [--battery <name>] [--site <site>]
//                          [--no-calibration] [--thresholds 0.6,0.7,0.8]
//                          [--window 30m|6h|1d | --windows <n>] [--limit <n>] [--json] [--check]
//
// Prints every observe analysis of the log: accuracy against confidence where
// fixtures, owners or outcomes gave ground truth; threshold sweeps over the
// logged readings (no new calls); drift per window with the change flag;
// questions stuck in confirm or escalate by decision, site and question;
// calls outside a registered battery; judgment cost; and the judgment
// accuracy eval suite. Every registry in packages/engine supplies the floors
// and the registered names.
//
// Without --log, the log is <workspace>/.goodvibes/<surface>/decisions.sqlite
// (workspace defaults to the current directory; with no --surface, the one
// surface that has a log). A log at an older schema is brought forward in
// place when opened. --check exits 1 when a decision is below its floor or a
// logged call was made outside a registered battery.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SqliteDecisionLog } from '@goodvibes-jev/judgment';
import {
  analyzeDecisionLog,
  formatObserveReport,
  JUDGMENT_EVAL_SUITE,
  judgmentEvalScenarios,
  type DriftOptions,
} from '../sdk/src/platform/observe/index.ts';
import { EvalRunner, formatSuiteResult } from '../sdk/src/platform/runtime/eval/index.ts';
import { DECISION_LOG_FILE } from '../sdk/src/platform/state/decision-log.ts';
import { loadEngineRegistries } from './judgment-registries.ts';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    log: { type: 'string' },
    workspace: { type: 'string' },
    surface: { type: 'string' },
    since: { type: 'string' },
    until: { type: 'string' },
    battery: { type: 'string' },
    site: { type: 'string' },
    'no-calibration': { type: 'boolean' },
    thresholds: { type: 'string' },
    window: { type: 'string' },
    windows: { type: 'string' },
    limit: { type: 'string' },
    json: { type: 'boolean' },
    check: { type: 'boolean' },
  },
});

function fail(message: string): never {
  console.error(`[observe-report] ${message}`);
  process.exit(2);
}

/** The log path: --log, or the one surface log under the workspace's .goodvibes directory. */
function logPath(): string {
  if (values.log !== undefined) return resolve(values.log);
  const stateDir = resolve(values.workspace ?? process.cwd(), '.goodvibes');
  if (values.surface !== undefined) return resolve(stateDir, values.surface, DECISION_LOG_FILE);
  const found = existsSync(stateDir) ? [...new Bun.Glob(`*/${DECISION_LOG_FILE}`).scanSync({ cwd: stateDir })].sort() : [];
  if (found.length === 1) return resolve(stateDir, found[0]!);
  if (found.length === 0) fail(`no ${DECISION_LOG_FILE} under ${stateDir}; pass --log or --workspace`);
  return fail(`more than one decision log under ${stateDir} (${found.join(', ')}); pass --surface or --log`);
}

const UNIT_MS: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

function driftOptions(): DriftOptions {
  if (values.windows !== undefined) return { windows: Number(values.windows) };
  if (values.window === undefined) return {};
  const match = /^(\d+)([mhd])$/.exec(values.window);
  if (match === null) fail(`--window takes a length such as 30m, 6h or 1d, not "${values.window}"`);
  return { windowMs: Number(match[1]) * UNIT_MS[match[2]!]! };
}

function thresholds(): number[] | undefined {
  if (values.thresholds === undefined) return undefined;
  const parsed = values.thresholds.split(',').map(Number);
  if (parsed.some((value) => !(value >= 0 && value <= 1))) fail('--thresholds takes numbers in [0, 1], comma separated');
  return parsed;
}

const path = logPath();
if (!existsSync(path)) fail(`no decision log at ${path}`);
const { decisions, files } = await loadEngineRegistries();
const limit = values.limit === undefined ? undefined : Number(values.limit);
if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) fail('--limit takes a positive integer');
const sweepAt = thresholds();

using log = new SqliteDecisionLog(path);
const report = analyzeDecisionLog(log, {
  ...(values.since === undefined ? {} : { since: values.since }),
  ...(values.until === undefined ? {} : { until: values.until }),
  ...(values.battery === undefined ? {} : { battery: values.battery }),
  ...(values.site === undefined ? {} : { site: values.site }),
  ...(values['no-calibration'] === true ? { excludeCalibration: true } : {}),
  ...(sweepAt === undefined ? {} : { thresholds: sweepAt }),
  ...(limit === undefined ? {} : { limit }),
  drift: driftOptions(),
  registered: decisions,
});
const suite = await new EvalRunner().runSuite(JUDGMENT_EVAL_SUITE, judgmentEvalScenarios(report.accuracy));

if (values.json === true) {
  console.log(JSON.stringify({ log: path, registries: files, report, evalSuite: suite }, null, 2));
} else {
  console.log(formatObserveReport(report, path));
  console.log('\n== Judgment accuracy eval suite (ground-truth accuracy scored against each registered floor)');
  console.log(suite.results.length === 0 ? '    no registered decision has ground truth in this window' : formatSuiteResult(suite));
}

if (values.check === true) {
  const below = report.accuracy.filter((row) => row.belowFloor === true).map((row) => row.battery);
  const outside = report.unregistered ?? [];
  if (below.length > 0 || outside.length > 0) {
    console.error(`[observe-report] CHECK FAILED: ${below.length} decision(s) below floor${below.length > 0 ? ` (${below.join(', ')})` : ''}, ${outside.length} site group(s) calling Jev outside a registered battery`);
    process.exit(1);
  }
  console.log('[observe-report] CHECK PASSED: every decision with ground truth is at or above its floor, and every call names a registered decision');
}
