#!/usr/bin/env bun
// observe-proof.ts: live proof of the observe analyses.
//
//   bun run observe:proof [--all | --only a,b] [--workspace <dir>]
//
// Seeds a decision log from a real calibration run and shows every analysis
// producing output. The log is the engine state layer's own
// (<workspace>/.goodvibes/proof/decisions.sqlite); the port is the System One
// endpoint from TYPESAFE_API_KEY. Calibration runs twice, so drift has two
// windows to compare, and records each fixture's expectations as ground
// truth. One production-style reading at a real site is then confirmed or
// corrected by an owner truth note, and one call is made through a decision
// no registry registers. The observe report CLI then runs against the log.
// Exits 1 when any analysis comes back empty.
//
// By default calibration takes the decision with the fewest fixtures from
// each engine registry; --all takes every registered decision.

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  calibrate,
  checkReading,
  createSystemOnePort,
  defineBattery,
  formatReport,
  judgmentConfigFromEnv,
  STAKES_BANDS,
  withDecisionLog,
  yesNo,
  type NamedDecision,
} from '@goodvibes-jev/judgment';
import { failureReading } from '../errors/src/failure-reading.ts';
import { analyzeDecisionLog, JUDGMENT_EVAL_SUITE, judgmentEvalScenarios } from '../sdk/src/platform/observe/index.ts';
import { EvalRunner } from '../sdk/src/platform/runtime/eval/index.ts';
import { decisionLogPath, openStateDecisionLog } from '../sdk/src/platform/state/decision-log.ts';
import { ENGINE_ROOT, loadEngineRegistries } from './judgment-registries.ts';
import { sweepStaleTmpDirs } from './stale-tmp-sweep.ts';
import { PROOF_RETAINED_MARKER, STALE_PROOF_TMP_MS, retainProofOutput } from './proof-temp.ts';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { all: { type: 'boolean' }, only: { type: 'string' }, workspace: { type: 'string' } },
});

const config = judgmentConfigFromEnv(process.env);
const endpoint = { kind: config.endpoint.kind, baseURL: config.endpoint.baseURL };
const { decisions, byFile } = await loadEngineRegistries();

function selected(): NamedDecision[] {
  if (values.only !== undefined) {
    const names = values.only.split(',');
    const missing = names.filter((name) => !decisions.some((decision) => decision.name === name));
    if (missing.length > 0) throw new Error(`no registered decision named ${missing.join(', ')}`);
    return decisions.filter((decision) => names.includes(decision.name));
  }
  if (values.all === true) return [...decisions];
  const smallest = byFile.map(({ decisions: list }) => [...list].sort((a, b) => a.fixtureCount - b.fixtureCount || a.name.localeCompare(b.name))[0]!);
  return [...new Map(smallest.map((decision) => [decision.name, decision])).values()];
}

// A new scratch prefix leaves older intentionally kept proof logs untouched.
sweepStaleTmpDirs(tmpdir(), 'observe-proof-scratch-', STALE_PROOF_TMP_MS, { preserveMarker: PROOF_RETAINED_MARKER });
const workspace = resolve(values.workspace ?? mkdtempSync(join(tmpdir(), 'observe-proof-scratch-')));
const stateRoot = join(workspace, '.goodvibes', 'proof');
mkdirSync(stateRoot, { recursive: true });
const logPath = decisionLogPath(stateRoot);
const chosen = selected();
console.log(`[observe-proof] calibrating ${chosen.map((decision) => decision.name).join(', ')} twice against ${endpoint.kind} ${endpoint.baseURL}`);
console.log(`[observe-proof] decision log ${logPath}`);

{
  using log = openStateDecisionLog(stateRoot);
  const port = withDecisionLog(createSystemOnePort(config), log);
  for (const pass of [1, 2]) {
    const report = await calibrate(port, chosen, { endpoint, log });
    console.log(`\n[observe-proof] calibration pass ${pass}\n${formatReport(report)}`);
    const recorded = report.decisions.reduce((sum, decision) => sum + (decision.truthRecorded ?? 0), 0);
    console.log(`[observe-proof] pass ${pass}: ground truth recorded for ${recorded} fixture(s)`);
  }

  // A production-style reading at a real site, then the owner's word on it.
  const run = await failureReading.run(port, 'Error type: Error\nMessage: read ECONNRESET while streaming the completion', { site: 'proof.provider-error' });
  const ownerSays = 'network';
  log.attach(run.result.decisionId!, {
    kind: 'truth',
    truth: { source: 'owner', checks: [checkReading('owner review', 'category', ownerSays, run.readings.category)] },
  });
  run.recordAction('retried after the owner review');
  console.log(`\n[observe-proof] owner review: the reading said ${run.readings.category.choice}, the owner says ${ownerSays}`);

  // A call through a decision no registry registers, which the report must name.
  const unregistered = defineBattery({
    name: 'proof.unregistered-probe',
    version: 1,
    description: 'A decision defined outside every registry, to show the report naming calls made outside a registered battery.',
    accuracyFloor: 0.5,
    items: { question: yesNo('Does this message ask for help?', STAKES_BANDS.low.yesNo) },
    fixtures: [{ name: 'asks', state: 'Can you help me reset my password?', expect: { question: 'yes' } }],
  });
  await unregistered.run(port, 'Can you help me reset my password?', { site: 'proof.adhoc' });
}

console.log('\n[observe-proof] running the observe report CLI against the log\n');
const cli = Bun.spawnSync(['bun', 'scripts/observe-report.ts', '--log', logPath, '--windows', '2'], { cwd: ENGINE_ROOT, stdout: 'pipe', stderr: 'pipe' });
process.stdout.write(cli.stdout);
process.stderr.write(cli.stderr);
if (cli.exitCode !== 0) {
  if (values.workspace === undefined) retainProofOutput(workspace);
  console.error(`[observe-proof] FAIL: the observe report exited ${cli.exitCode}`);
  process.exit(1);
}

using log = openStateDecisionLog(stateRoot);
const report = analyzeDecisionLog(log, { registered: decisions, drift: { windows: 2 } });
const suite = await new EvalRunner().runSuite(JUDGMENT_EVAL_SUITE, judgmentEvalScenarios(report.accuracy));
const outputs: Readonly<Record<string, boolean>> = {
  'accuracy against confidence (fixture truth)': report.accuracy.some((row) => row.sources.fixture > 0),
  'accuracy against confidence (owner truth)': report.accuracy.some((row) => row.sources.owner > 0),
  'threshold sweeps': report.sweeps.some((row) => row.readings > 0 && row.truthChecks > 0),
  'drift with a compared window': report.drift.some((row) => row.windows.filter((window) => window.readings >= 5).length >= 2),
  'question discovery': report.stuck.length > 0,
  'calls outside a registered battery': (report.unregistered ?? []).some((row) => row.battery === 'proof.unregistered-probe'),
  'judgment cost': report.cost.calls > 0 && report.cost.inputTokens > 0,
  'judgment accuracy eval suite': suite.results.length > 0,
};
console.log('\n[observe-proof] analyses with output:');
for (const [analysis, ok] of Object.entries(outputs)) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${analysis}`);
const empty = Object.entries(outputs).filter(([, ok]) => !ok).map(([analysis]) => analysis);
if (empty.length > 0) {
  if (values.workspace === undefined) retainProofOutput(workspace);
  console.error(`[observe-proof] FAIL: no output from ${empty.join(', ')}${values.all === true ? '' : '; try --all for more readings'}`);
  process.exit(1);
}
if (values.workspace === undefined) retainProofOutput(workspace);
console.log(`[observe-proof] PASS: every analysis produced output from ${report.entries} logged calls. Log kept at ${logPath}`);
