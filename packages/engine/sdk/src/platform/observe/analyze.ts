import { CALIBRATION_SITE, truthOf, type DecisionEntry, type DecisionLog, type NamedDecision } from '@goodvibes-jev/judgment';
import type { ResolvePricing } from '../runtime/cost/attribution.js';
import { batteryAccuracy, thresholdSweeps, type BatteryAccuracy, type BatterySweep } from './accuracy.js';
import { stuckQuestions, unregisteredCalls, type StuckQuestion, type UnregisteredCalls } from './discovery.js';
import { readingDrift, type BatteryDrift, type DriftOptions } from './drift.js';
import { judgmentCost, type JudgmentCost } from './judgment-cost.js';
import { loggedReadings } from './log-readings.js';
import { OBSERVE_THRESHOLDS } from './thresholds.js';

export interface ObserveOptions {
  /** Inclusive ISO lower bound on when a call was made. */
  readonly since?: string;
  /** Exclusive ISO upper bound. */
  readonly until?: string;
  /** Only this named decision. */
  readonly battery?: string;
  /** Only this decision site. */
  readonly site?: string;
  /** Leave out calibration calls, to read production traffic alone. */
  readonly excludeCalibration?: boolean;
  /**
   * The registered decisions. Their accuracy floors mark decisions below
   * floor, and a logged call naming none of them is reported as made outside
   * a registered battery. Without it neither is judged.
   */
  readonly registered?: readonly Pick<NamedDecision, 'name' | 'accuracyFloor'>[];
  /** Thresholds to re-band logged readings at. */
  readonly thresholds?: readonly number[];
  readonly drift?: DriftOptions;
  /** Prices Jev calls by model; unpriced without it. */
  readonly resolvePricing?: ResolvePricing;
  /** Most entries to read; newest first. */
  readonly limit?: number;
}

/** Every analysis the observe subsystem reads from a decision log. */
export interface ObserveReport {
  readonly window: { readonly since: string | undefined; readonly until: string | undefined; readonly first: string | null; readonly last: string | null };
  readonly entries: number;
  readonly answered: number;
  readonly failed: number;
  readonly readings: number;
  /** Entries carrying ground truth (a fixture, owner or outcome truth note). */
  readonly withTruth: number;
  readonly accuracy: readonly BatteryAccuracy[];
  readonly sweeps: readonly BatterySweep[];
  readonly drift: readonly BatteryDrift[];
  readonly stuck: readonly StuckQuestion[];
  /** Undefined when no registry was given. */
  readonly unregistered: readonly UnregisteredCalls[] | undefined;
  readonly cost: JudgmentCost;
  /** True when the entry limit was reached, so older entries were left out. */
  readonly truncated: boolean;
}

/** Runs every analysis over a set of decision log entries. */
export function analyzeEntries(entries: readonly DecisionEntry[], options: Omit<ObserveOptions, 'since' | 'until' | 'battery' | 'site' | 'limit'> = {}): Omit<ObserveReport, 'window' | 'truncated'> {
  const readings = loggedReadings(entries);
  const floors = new Map((options.registered ?? []).map((decision) => [decision.name, decision.accuracyFloor]));
  return {
    entries: entries.length,
    answered: entries.filter((entry) => entry.status === 'answered').length,
    failed: entries.filter((entry) => entry.status === 'failed').length,
    readings: readings.length,
    withTruth: entries.filter((entry) => truthOf(entry) !== undefined).length,
    accuracy: batteryAccuracy(entries, floors),
    sweeps: thresholdSweeps(readings, entries, options.thresholds ?? OBSERVE_THRESHOLDS.sweep),
    drift: readingDrift(readings, options.drift),
    stuck: stuckQuestions(readings),
    unregistered: options.registered === undefined ? undefined : unregisteredCalls(entries, new Set(floors.keys())),
    cost: judgmentCost(entries, options.resolvePricing),
  };
}

/** Reads the log for the options' window and filters, and runs every analysis over what it holds. */
export function analyzeDecisionLog(log: DecisionLog, options: ObserveOptions = {}): ObserveReport {
  const limit = options.limit ?? OBSERVE_THRESHOLDS.entryLimit;
  const queried = log.query({
    ...(options.since === undefined ? {} : { since: options.since }),
    ...(options.until === undefined ? {} : { until: options.until }),
    ...(options.battery === undefined ? {} : { battery: options.battery }),
    ...(options.site === undefined ? {} : { site: options.site }),
    limit,
  });
  const entries = options.excludeCalibration === true ? queried.filter((entry) => entry.context.site !== CALIBRATION_SITE) : queried;
  const times = entries.map((entry) => entry.at).sort();
  return {
    window: { since: options.since, until: options.until, first: times[0] ?? null, last: times.at(-1) ?? null },
    ...analyzeEntries(entries, options),
    truncated: queried.length >= limit,
  };
}
