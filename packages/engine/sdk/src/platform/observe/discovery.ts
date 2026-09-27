import type { DecisionEntry } from '@goodvibes-jev/judgment';
import type { LoggedReading } from './log-readings.js';
import { UNNAMED } from './log-readings.js';
import { OBSERVE_THRESHOLDS } from './thresholds.js';

/**
 * One question at one site whose readings keep landing in confirm or
 * escalate: code could not act on them alone, so a person or a stronger model
 * had to. These are where a sharper question, a new battery item or a
 * re-tuned band would save the most hand-offs.
 */
export interface StuckQuestion {
  readonly battery: string;
  readonly site: string;
  readonly question: string;
  /** Every reading of this question at this site. */
  readonly readings: number;
  readonly confirm: number;
  readonly escalate: number;
  /** Share of the readings that were stuck. */
  readonly stuckShare: number;
  /** Mean signal of the stuck readings. */
  readonly stuckMeanSignal: number;
  /** A few stuck decisions to open in the log. */
  readonly examples: readonly string[];
  /** What code most often did with the stuck decisions, most frequent first. */
  readonly actions: readonly { readonly action: string; readonly count: number }[];
}

const keyOf = (reading: LoggedReading): string => JSON.stringify([reading.battery ?? UNNAMED, reading.site ?? UNNAMED, reading.question]);

/** Questions with readings stuck in confirm or escalate, grouped by decision, site and question, most stuck first. */
export function stuckQuestions(readings: readonly LoggedReading[]): StuckQuestion[] {
  const groups = new Map<string, LoggedReading[]>();
  for (const reading of readings) {
    const key = keyOf(reading);
    const list = groups.get(key) ?? [];
    list.push(reading);
    groups.set(key, list);
  }
  const { examples, actions } = OBSERVE_THRESHOLDS.discovery;
  const stuck: StuckQuestion[] = [];
  for (const [key, list] of groups) {
    const held = list.filter((reading) => reading.outcome !== 'act');
    if (held.length === 0) continue;
    const [battery, site, question] = JSON.parse(key) as [string, string, string];
    const actionCounts = new Map<string, number>();
    for (const reading of held) if (reading.action !== undefined) actionCounts.set(reading.action, (actionCounts.get(reading.action) ?? 0) + 1);
    stuck.push({
      battery,
      site,
      question,
      readings: list.length,
      confirm: held.filter((reading) => reading.outcome === 'confirm').length,
      escalate: held.filter((reading) => reading.outcome === 'escalate').length,
      stuckShare: held.length / list.length,
      stuckMeanSignal: held.reduce((sum, reading) => sum + reading.signal, 0) / held.length,
      examples: [...new Set(held.map((reading) => reading.decisionId))].slice(0, examples),
      actions: [...actionCounts]
        .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
        .slice(0, actions)
        .map(([action, count]) => ({ action, count })),
    });
  }
  return stuck.sort(
    (a, b) => b.confirm + b.escalate - (a.confirm + a.escalate) || b.stuckShare - a.stuckShare || keyCompare(a, b),
  );
}

const keyCompare = (a: StuckQuestion, b: StuckQuestion): number =>
  a.battery.localeCompare(b.battery) || a.site.localeCompare(b.site) || a.question.localeCompare(b.question);

/** Calls in the log made outside any registered decision. */
export interface UnregisteredCalls {
  readonly battery: string;
  readonly site: string;
  readonly calls: number;
  readonly examples: readonly string[];
}

/**
 * Logged calls whose decision is not in the registry, or that named no
 * decision at all: a site asked Jev outside a registered battery, so nothing
 * calibrates, sweeps or lints what it asked.
 */
export function unregisteredCalls(entries: readonly DecisionEntry[], registered: ReadonlySet<string>): UnregisteredCalls[] {
  const groups = new Map<string, DecisionEntry[]>();
  for (const entry of entries) {
    const { battery } = entry.context;
    if (battery !== undefined && registered.has(battery)) continue;
    const key = JSON.stringify([battery ?? UNNAMED, entry.context.site ?? UNNAMED]);
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  return [...groups]
    .map(([key, list]) => {
      const [battery, site] = JSON.parse(key) as [string, string];
      return { battery, site, calls: list.length, examples: list.slice(0, OBSERVE_THRESHOLDS.discovery.examples).map((entry) => entry.id) };
    })
    .sort((a, b) => b.calls - a.calls || a.battery.localeCompare(b.battery) || a.site.localeCompare(b.site));
}
