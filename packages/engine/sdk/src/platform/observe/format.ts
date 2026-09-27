import type { ObserveReport } from './analyze.js';
import type { BatteryAccuracy, BatterySweep } from './accuracy.js';
import type { BatteryDrift } from './drift.js';
import type { StuckQuestion, UnregisteredCalls } from './discovery.js';
import type { JudgmentCost } from './judgment-cost.js';

const pct = (value: number | null | undefined): string => (value === null || value === undefined ? '   -  ' : `${(value * 100).toFixed(1).padStart(5)}%`);
const INDENT = '    ';

function heading(title: string): string[] {
  return ['', `== ${title}`];
}

function accuracySection(rows: readonly BatteryAccuracy[]): string[] {
  const lines = heading('Accuracy against confidence (ground truth from fixtures, owner corrections and outcomes)');
  if (rows.length === 0) return [...lines, `${INDENT}no ground truth in this window`];
  for (const row of rows) {
    const floor = row.accuracyFloor === undefined ? 'floor unknown' : `floor ${pct(row.accuracyFloor)} ${row.belowFloor === true ? 'BELOW FLOOR' : 'ok'}`;
    lines.push(
      `${row.battery}  accuracy ${pct(row.accuracy)} (${row.correct}/${row.checks})  ${floor}  automatic accuracy ${pct(row.automaticAccuracy)}  act/confirm/escalate ${row.outcomes.act}/${row.outcomes.confirm}/${row.outcomes.escalate}  truth fixture ${row.sources.fixture} owner ${row.sources.owner} outcome ${row.sources.outcome}`,
    );
    const bins = row.bins.filter((bin) => bin.checks > 0);
    lines.push(`${INDENT}confidence vs accuracy: ${bins.map((bin) => `[${bin.from.toFixed(2)}-${bin.to.toFixed(2)}) ${bin.correct}/${bin.checks}`).join('  ')}`);
  }
  return lines;
}

function sweepSection(rows: readonly BatterySweep[]): string[] {
  const lines = heading('Threshold sweeps (logged readings re-banded, no new calls)');
  if (rows.length === 0) return [...lines, `${INDENT}no readings in this window`];
  for (const row of rows) {
    lines.push(`${row.battery}  ${row.readings} readings, ${row.truthChecks} ground-truth checks`);
    for (const point of row.points) {
      lines.push(`${INDENT}act at >= ${point.threshold.toFixed(2)}: automatic ${pct(point.automatic)}  accuracy ${pct(point.accuracy)}`);
    }
  }
  return lines;
}

const mix = (window: BatteryDrift['windows'][number]): string =>
  `${pct(window.outcomeMix.act).trim()}/${pct(window.outcomeMix.confirm).trim()}/${pct(window.outcomeMix.escalate).trim()}`;

function driftSection(rows: readonly BatteryDrift[]): string[] {
  const lines = heading('Drift per window (reading distribution and outcome mix; change flag computed in code)');
  if (rows.length === 0) return [...lines, `${INDENT}no readings in this window`];
  for (const row of rows) {
    lines.push(`${row.battery}  ${row.changed ? 'CHANGED' : 'steady'}  ${row.windows.length} window(s)`);
    for (const window of row.windows) {
      const mean = window.meanSignal.toFixed(2);
      const bins = window.signalBins.filter((bin) => bin.readings > 0).map((bin) => `>=${bin.from.toFixed(2)}:${bin.readings}`).join(' ');
      const flag = window.changed ? `  CHANGED: ${window.reasons.join('; ')}` : '';
      lines.push(
        `${INDENT}${window.from} to ${window.to}  n=${window.readings}  mean signal ${mean}  act/confirm/escalate ${mix(window)}  signal bins ${bins || '-'}  models ${window.models.join(', ') || '-'}${flag}`,
      );
    }
  }
  return lines;
}

function stuckSection(rows: readonly StuckQuestion[]): string[] {
  const lines = heading('Question discovery (readings stuck in confirm or escalate, by decision, site and question)');
  if (rows.length === 0) return [...lines, `${INDENT}no reading landed in confirm or escalate`];
  for (const row of rows) {
    const actions = row.actions.length === 0 ? '' : `  actions ${row.actions.map((entry) => `${entry.action} x${entry.count}`).join(', ')}`;
    lines.push(
      `${row.battery} @ ${row.site}  question ${row.question}  stuck ${row.confirm + row.escalate}/${row.readings} (${pct(row.stuckShare).trim()}: confirm ${row.confirm}, escalate ${row.escalate})  stuck mean signal ${row.stuckMeanSignal.toFixed(2)}  e.g. ${row.examples.join(', ')}${actions}`,
    );
  }
  return lines;
}

function unregisteredSection(rows: readonly UnregisteredCalls[] | undefined): string[] {
  const lines = heading('Calls outside a registered battery');
  if (rows === undefined) return [...lines, `${INDENT}not checked: no registry given`];
  if (rows.length === 0) return [...lines, `${INDENT}none: every logged call names a registered decision`];
  for (const row of rows) lines.push(`${row.battery} @ ${row.site}  ${row.calls} call(s)  e.g. ${row.examples.join(', ')}`);
  return lines;
}

const dollars = (cost: number | null, state: string): string => (cost === null ? `cost ${state}` : `cost $${cost.toFixed(6)} (${state})`);

function costSection(cost: JudgmentCost): string[] {
  const lines = heading('Judgment cost (Jev calls by decision and site)');
  for (const row of cost.rows) {
    lines.push(
      `${row.battery} @ ${row.site}  calls ${row.calls} (failed ${row.failed})  tokens in ${row.inputTokens} out ${row.outputTokens}  mean latency ${Math.round(row.meanLatencyMs)}ms  ${dollars(row.costUsd, row.costState)}`,
    );
  }
  lines.push(`total  calls ${cost.calls} (failed ${cost.failed})  tokens in ${cost.inputTokens} out ${cost.outputTokens}  ${dollars(cost.costUsd, cost.costState)}`);
  return lines;
}

/** A plain-text rendering of every analysis, for the terminal. */
export function formatObserveReport(report: ObserveReport, source?: string): string {
  const { window } = report;
  const range = window.first === null ? 'no entries' : `${window.first} to ${window.last}`;
  const lines = [
    `decision log${source === undefined ? '' : ` ${source}`}: ${report.entries} entries (${report.answered} answered, ${report.failed} failed), ${report.readings} readings, ${report.withTruth} with ground truth, ${range}`,
  ];
  if (report.truncated) lines.push('only the newest entries up to the limit were read; narrow the window or raise --limit to read the rest');
  lines.push(
    ...accuracySection(report.accuracy),
    ...sweepSection(report.sweeps),
    ...driftSection(report.drift),
    ...stuckSection(report.stuck),
    ...unregisteredSection(report.unregistered),
    ...costSection(report.cost),
  );
  return lines.join('\n');
}
