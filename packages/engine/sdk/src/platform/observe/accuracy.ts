import {
  confidenceBins,
  sweep,
  truthOf,
  type ConfidenceBin,
  type DecisionEntry,
  type FixtureCheck,
  type Outcome,
  type TruthSource,
} from '@goodvibes-jev/judgment';
import type { LoggedReading } from './log-readings.js';
import { UNNAMED } from './log-readings.js';

/**
 * How accurate one named decision has been where the log holds ground truth
 * (calibration fixtures, owner corrections, observed outcomes), read against
 * how confident its readings were.
 */
export interface BatteryAccuracy {
  readonly battery: string;
  /** Checks with ground truth, and how many of them the decision got right. */
  readonly checks: number;
  readonly correct: number;
  readonly accuracy: number;
  /** Accuracy among the checks the band let code act on alone; null when none acted. */
  readonly automaticAccuracy: number | null;
  readonly outcomes: Readonly<Record<Outcome, number>>;
  /** Accuracy per confidence bin, the same bins calibration reports. */
  readonly bins: readonly ConfidenceBin[];
  /** Where the ground truth came from. */
  readonly sources: Readonly<Record<TruthSource, number>>;
  /** The decision's registered accuracy floor, when the registry knows it. */
  readonly accuracyFloor: number | undefined;
  /** Whether accuracy is below that floor; undefined without one. */
  readonly belowFloor: boolean | undefined;
}

/** Ground-truth checks per decision, from every entry carrying a truth note. */
export function truthChecksByBattery(entries: readonly DecisionEntry[]): Map<string, { checks: FixtureCheck[]; sources: Record<TruthSource, number> }> {
  const byBattery = new Map<string, { checks: FixtureCheck[]; sources: Record<TruthSource, number> }>();
  for (const entry of entries) {
    const truth = truthOf(entry);
    if (truth === undefined || truth.checks.length === 0) continue;
    const battery = entry.context.battery ?? UNNAMED;
    const group = byBattery.get(battery) ?? { checks: [], sources: { fixture: 0, owner: 0, outcome: 0 } };
    group.checks.push(...truth.checks);
    group.sources[truth.source] += truth.checks.length;
    byBattery.set(battery, group);
  }
  return byBattery;
}

/** Accuracy against confidence for every decision with ground truth in the entries. */
export function batteryAccuracy(
  entries: readonly DecisionEntry[],
  floors: ReadonlyMap<string, number> = new Map(),
): BatteryAccuracy[] {
  return [...truthChecksByBattery(entries)]
    .map(([battery, { checks, sources }]) => {
      const correct = checks.filter((check) => check.correct).length;
      const outcomes: Record<Outcome, number> = { act: 0, confirm: 0, escalate: 0 };
      for (const check of checks) outcomes[check.outcome]++;
      const automatic = checks.filter((check) => check.outcome === 'act');
      const accuracy = correct / checks.length;
      const accuracyFloor = floors.get(battery);
      return {
        battery,
        checks: checks.length,
        correct,
        accuracy,
        automaticAccuracy: automatic.length === 0 ? null : automatic.filter((check) => check.correct).length / automatic.length,
        outcomes,
        bins: confidenceBins(checks),
        sources,
        accuracyFloor,
        belowFloor: accuracyFloor === undefined ? undefined : accuracy < accuracyFloor,
      };
    })
    .sort((a, b) => a.battery.localeCompare(b.battery));
}

/** One threshold of a sweep over logged readings. */
export interface LoggedSweepPoint {
  readonly threshold: number;
  /** Share of every logged reading whose signal clears the threshold: what code would act on alone. */
  readonly automatic: number;
  /** Accuracy among ground-truth checks that clear it; null when none clear or none exist. */
  readonly accuracy: number | null;
}

/** A decision's readings re-banded at each threshold, with no new calls. */
export interface BatterySweep {
  readonly battery: string;
  readonly readings: number;
  readonly truthChecks: number;
  readonly points: readonly LoggedSweepPoint[];
}

/**
 * Re-bands every logged reading of each decision at each threshold. The
 * automatic share uses all readings; accuracy uses the ground-truth checks,
 * through the same sweep calibration uses. Moving a threshold is arithmetic
 * over what the log already holds.
 */
export function thresholdSweeps(
  readings: readonly LoggedReading[],
  entries: readonly DecisionEntry[],
  thresholds: readonly number[],
): BatterySweep[] {
  const truth = truthChecksByBattery(entries);
  const signals = new Map<string, number[]>();
  for (const reading of readings) {
    const battery = reading.battery ?? UNNAMED;
    const list = signals.get(battery) ?? [];
    list.push(reading.signal);
    signals.set(battery, list);
  }
  const batteries = [...new Set([...signals.keys(), ...truth.keys()])].sort();
  return batteries.map((battery) => {
    const logged = signals.get(battery) ?? [];
    const checks = truth.get(battery)?.checks ?? [];
    const accuracyAt = sweep(checks, thresholds);
    return {
      battery,
      readings: logged.length,
      truthChecks: checks.length,
      points: thresholds.map((threshold, index) => ({
        threshold,
        automatic: logged.length === 0 ? 0 : logged.filter((signal) => signal >= threshold).length / logged.length,
        accuracy: accuracyAt[index]!.accuracy,
      })),
    };
  });
}
