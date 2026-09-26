import type { FixtureCheck, NamedDecision } from '../batteries/decision.ts';
import type { Outcome } from '../readings/bands.ts';

/** Accuracy for checks whose signal fell in [from, to). */
export interface ConfidenceBin {
  readonly from: number;
  readonly to: number;
  readonly checks: number;
  readonly correct: number;
  readonly accuracy: number | null;
}

export interface DecisionReport {
  readonly name: string;
  readonly version: number;
  readonly model: string;
  readonly accuracyFloor: number;
  readonly checks: readonly FixtureCheck[];
  readonly accuracy: number;
  readonly passed: boolean;
  readonly outcomes: Readonly<Record<Outcome, number>>;
  /** Accuracy of the checks code would have acted on without asking anyone. */
  readonly automaticAccuracy: number | null;
  readonly bins: readonly ConfidenceBin[];
  /** Set when the decision could not be run at all. */
  readonly error?: string;
}

export interface CalibrationReport {
  readonly at: string;
  readonly endpoint: { readonly kind: string; readonly baseURL: string };
  readonly decisions: readonly DecisionReport[];
  readonly passed: boolean;
}

const BIN_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.000001];

export function confidenceBins(checks: readonly FixtureCheck[]): ConfidenceBin[] {
  return BIN_EDGES.slice(0, -1).map((from, index) => {
    const to = BIN_EDGES[index + 1]!;
    const inBin = checks.filter((check) => check.signal >= from && check.signal < to);
    const correct = inBin.filter((check) => check.correct).length;
    return { from, to: Math.min(to, 1), checks: inBin.length, correct, accuracy: inBin.length === 0 ? null : correct / inBin.length };
  });
}

/** Summarizes one decision's fixture checks against its accuracy floor. */
export function summarize(decision: NamedDecision, model: string, checks: readonly FixtureCheck[]): DecisionReport {
  const correct = checks.filter((check) => check.correct).length;
  const accuracy = checks.length === 0 ? 0 : correct / checks.length;
  const outcomes: Record<Outcome, number> = { act: 0, confirm: 0, escalate: 0 };
  for (const check of checks) outcomes[check.outcome]++;
  const automatic = checks.filter((check) => check.outcome === 'act');
  return {
    name: decision.name,
    version: decision.version,
    model,
    accuracyFloor: decision.accuracyFloor,
    checks,
    accuracy,
    passed: checks.length > 0 && accuracy >= decision.accuracyFloor,
    outcomes,
    automaticAccuracy: automatic.length === 0 ? null : automatic.filter((check) => check.correct).length / automatic.length,
    bins: confidenceBins(checks),
  };
}

/** One point of a threshold sweep: what acting at or above `threshold` would have meant. */
export interface SweepPoint {
  readonly threshold: number;
  /** Share of checks whose signal clears the threshold (acted on automatically). */
  readonly automatic: number;
  /** Accuracy among those; null when nothing clears. */
  readonly accuracy: number | null;
}

/**
 * Re-bands recorded checks at each threshold without asking the model again:
 * the signal and correctness of every check are already known, so moving a
 * threshold is arithmetic over the report.
 */
export function sweep(checks: readonly FixtureCheck[], thresholds: readonly number[]): SweepPoint[] {
  return thresholds.map((threshold) => {
    const cleared = checks.filter((check) => check.signal >= threshold);
    return {
      threshold,
      automatic: checks.length === 0 ? 0 : cleared.length / checks.length,
      accuracy: cleared.length === 0 ? null : cleared.filter((check) => check.correct).length / cleared.length,
    };
  });
}

export const DEFAULT_SWEEP = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

const pct = (value: number | null): string => (value === null ? '   -  ' : `${(value * 100).toFixed(1).padStart(5)}%`);

/** A plain-text rendering of a report for the terminal. */
export function formatReport(report: CalibrationReport): string {
  const lines: string[] = [`calibration ${report.at} against ${report.endpoint.kind} ${report.endpoint.baseURL}`, ''];
  for (const decision of report.decisions) {
    const status = decision.error !== undefined ? 'ERROR' : decision.passed ? 'PASS ' : 'FAIL ';
    lines.push(
      `${status} ${decision.name} v${decision.version} (${decision.model})  accuracy ${pct(decision.accuracy)} floor ${pct(decision.accuracyFloor)}  checks ${decision.checks.length}  act/confirm/escalate ${decision.outcomes.act}/${decision.outcomes.confirm}/${decision.outcomes.escalate}  automatic accuracy ${pct(decision.automaticAccuracy)}`,
    );
    if (decision.error !== undefined) lines.push(`      ${decision.error}`);
    for (const check of decision.checks) {
      lines.push(
        `      ${check.correct ? 'ok  ' : 'MISS'} ${check.fixture} [${check.aspect}] expected ${check.expected} got ${check.got}  signal ${check.signal.toFixed(2)} ${check.outcome}`,
      );
    }
    const bins = decision.bins.filter((bin) => bin.checks > 0);
    if (bins.length > 0) {
      lines.push(`      confidence vs accuracy: ${bins.map((bin) => `[${bin.from.toFixed(2)}-${bin.to.toFixed(2)}) ${bin.correct}/${bin.checks}`).join('  ')}`);
    }
  }
  const failed = report.decisions.filter((decision) => !decision.passed).length;
  lines.push('', `${report.decisions.length - failed}/${report.decisions.length} decisions at or above their accuracy floor`);
  return lines.join('\n');
}

export function formatSweep(name: string, points: readonly SweepPoint[]): string {
  return [
    `sweep ${name}`,
    ...points.map((point) => `  act at >= ${point.threshold.toFixed(2)}: automatic ${pct(point.automatic)}  accuracy ${pct(point.accuracy)}`),
  ].join('\n');
}
