import { CONFIDENCE_BIN_FLOORS, type Outcome } from '@goodvibes-jev/judgment';
import type { LoggedReading } from './log-readings.js';
import { UNNAMED } from './log-readings.js';
import { OBSERVE_THRESHOLDS } from './thresholds.js';

/** One time window of one decision's readings. */
export interface DriftWindow {
  /** ISO start (inclusive) and end (exclusive) of the window. */
  readonly from: string;
  readonly to: string;
  readonly readings: number;
  /** Mean signal of the window's readings. */
  readonly meanSignal: number;
  /** Readings per confidence bin, on the calibration bins' lower edges. */
  readonly signalBins: readonly { readonly from: number; readonly readings: number }[];
  /** Share of readings reaching each band outcome. */
  readonly outcomeMix: Readonly<Record<Outcome, number>>;
  /** The versioned models that answered in the window. */
  readonly models: readonly string[];
  /** Whether this window differs from the previous comparable one, and why. */
  readonly changed: boolean;
  readonly reasons: readonly string[];
}

export interface BatteryDrift {
  readonly battery: string;
  readonly windows: readonly DriftWindow[];
  /** Whether any window changed from the one before it. */
  readonly changed: boolean;
}

export interface DriftOptions {
  /** Window length in ms, aligned to the epoch (a day window starts at UTC midnight). */
  readonly windowMs?: number;
  /** Split the readings' time span into this many equal windows instead. */
  readonly windows?: number;
}

const OUTCOMES: readonly Outcome[] = ['act', 'confirm', 'escalate'];

/** The window length and first window start for a set of reading times. */
function windowing(times: readonly number[], options: DriftOptions): { readonly start: number; readonly length: number } {
  const first = Math.min(...times);
  if (options.windows !== undefined) {
    if (!(Number.isInteger(options.windows) && options.windows >= 1)) throw new RangeError('drift windows must be a positive integer');
    const span = Math.max(...times) - first + 1;
    return { start: first, length: Math.max(1, Math.ceil(span / options.windows)) };
  }
  const length = options.windowMs ?? OBSERVE_THRESHOLDS.drift.windowMs;
  if (!(length > 0)) throw new RangeError('drift window length must be positive');
  return { start: Math.floor(first / length) * length, length };
}

type WindowStats = Omit<DriftWindow, 'changed' | 'reasons'>;

/** A window's statistics; `readings` is never empty. */
function statsOf(from: number, to: number, readings: readonly LoggedReading[]): WindowStats {
  const count = readings.length;
  const mix: Record<Outcome, number> = { act: 0, confirm: 0, escalate: 0 };
  for (const reading of readings) mix[reading.outcome]++;
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    readings: count,
    meanSignal: readings.reduce((sum, reading) => sum + reading.signal, 0) / count,
    signalBins: CONFIDENCE_BIN_FLOORS.map((floor, index) => {
      const next = CONFIDENCE_BIN_FLOORS[index + 1];
      return { from: floor, readings: readings.filter((reading) => reading.signal >= floor && (next === undefined || reading.signal < next)).length };
    }),
    outcomeMix: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, mix[outcome] / count])) as Record<Outcome, number>,
    models: [...new Set(readings.map((reading) => reading.model))].sort(),
  };
}

/** Total variation distance between two outcome mixes: half the summed absolute share differences. */
export function outcomeShift(a: Readonly<Record<Outcome, number>>, b: Readonly<Record<Outcome, number>>): number {
  return OUTCOMES.reduce((sum, outcome) => sum + Math.abs(a[outcome] - b[outcome]), 0) / 2;
}

/** Why `current` differs from `previous`, by the drift thresholds; empty when it does not. */
function changesFrom(previous: WindowStats, current: WindowStats): string[] {
  const { outcomeShift: shiftAt, signalShift } = OBSERVE_THRESHOLDS.drift;
  const reasons: string[] = [];
  const shift = outcomeShift(previous.outcomeMix, current.outcomeMix);
  if (shift >= shiftAt) reasons.push(`outcome mix moved ${shift.toFixed(2)} (at least ${shiftAt})`);
  const moved = Math.abs(current.meanSignal - previous.meanSignal);
  if (moved >= signalShift) reasons.push(`mean signal moved ${moved.toFixed(2)} (at least ${signalShift})`);
  const newModels = current.models.filter((model) => !previous.models.includes(model));
  if (newModels.length > 0) reasons.push(`answered by ${newModels.join(', ')}, not seen in the previous window`);
  return reasons;
}

/**
 * Reading distributions and outcome mixes per decision per time window; a
 * window with no readings is left out. A window is compared with the previous
 * window that had enough readings, and flagged when its outcome mix or mean
 * signal moved past the drift thresholds or a model answered that had not
 * before (bands are tuned on a pinned model).
 */
export function readingDrift(readings: readonly LoggedReading[], options: DriftOptions = {}): BatteryDrift[] {
  const byBattery = new Map<string, LoggedReading[]>();
  for (const reading of readings) {
    const battery = reading.battery ?? UNNAMED;
    const list = byBattery.get(battery) ?? [];
    list.push(reading);
    byBattery.set(battery, list);
  }
  const { minReadings } = OBSERVE_THRESHOLDS.drift;
  return [...byBattery]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([battery, list]) => {
      const times = list.map((reading) => Date.parse(reading.at));
      const { start, length } = windowing(times, options);
      const buckets = new Map<number, LoggedReading[]>();
      list.forEach((reading, index) => {
        const slot = Math.floor((times[index]! - start) / length);
        const bucket = buckets.get(slot) ?? [];
        bucket.push(reading);
        buckets.set(slot, bucket);
      });
      let comparable: WindowStats | undefined;
      const windows: DriftWindow[] = [];
      for (const slot of [...buckets.keys()].sort((a, b) => a - b)) {
        const from = start + slot * length;
        const stats = statsOf(from, from + length, buckets.get(slot)!);
        const enough = stats.readings >= minReadings;
        const reasons = enough && comparable !== undefined ? changesFrom(comparable, stats) : [];
        windows.push({ ...stats, changed: reasons.length > 0, reasons });
        if (enough) comparable = stats;
      }
      return { battery, windows, changed: windows.some((window) => window.changed) };
    });
}
