import type { DecisionEntry } from '@goodvibes-jev/judgment';
import { CostAttributionService, type CostAttributionState, type CostUsageRecord, type ResolvePricing } from '../runtime/cost/attribution.js';
import { UNNAMED } from './log-readings.js';

/** What Jev calls for one decision at one site cost. */
export interface JudgmentCostRow {
  readonly battery: string;
  readonly site: string;
  readonly calls: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Mean latency of the calls, answered and failed. */
  readonly meanLatencyMs: number;
  /** Sum of the priced calls; null when none was priced. */
  readonly costUsd: number | null;
  readonly costState: CostAttributionState;
}

export interface JudgmentCost {
  readonly rows: readonly JudgmentCostRow[];
  readonly calls: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
  readonly costState: CostAttributionState;
}

/** The usage record an answered call contributes; a failed call used no tokens. */
export function judgmentUsageRecord(entry: DecisionEntry): CostUsageRecord | undefined {
  if (entry.status !== 'answered') return undefined;
  return {
    at: Date.parse(entry.at),
    model: entry.model,
    inputTokens: entry.usage.inputTokens,
    outputTokens: entry.usage.outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

interface Tally {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  priced: number;
  unpriced: number;
}

const emptyTally = (): Tally => ({ calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0, priced: 0, unpriced: 0 });

/** Priced, estimated (some calls unpriced) or unpriced, the attribution service's own states. */
function stateOf(tally: Tally): CostAttributionState {
  if (tally.unpriced === 0 && tally.priced > 0) return 'priced';
  return tally.priced === 0 ? 'unpriced' : 'estimated';
}

/**
 * Jev spend per decision and site, from the decision log. Prices come from
 * the same resolver and cache-aware pricing the cost attribution service
 * uses; a model the resolver does not know stays unpriced, never $0.
 */
export function judgmentCost(entries: readonly DecisionEntry[], resolvePricing: ResolvePricing = () => null): JudgmentCost {
  const pricing = new CostAttributionService({ resolvePricing });
  const groups = new Map<string, Tally>();
  const total = emptyTally();
  for (const entry of entries) {
    const key = JSON.stringify([entry.context.battery ?? UNNAMED, entry.context.site ?? UNNAMED]);
    const group = groups.get(key) ?? emptyTally();
    groups.set(key, group);
    const record = judgmentUsageRecord(entry);
    const price = record === undefined ? undefined : pricing.priceRecord(record);
    for (const tally of [group, total]) {
      tally.calls += 1;
      tally.latencyMs += entry.latencyMs;
      if (record === undefined) {
        tally.failed += 1;
        continue;
      }
      tally.inputTokens += record.inputTokens;
      tally.outputTokens += record.outputTokens;
      if (price?.state === 'priced' && price.costUsd !== null) {
        tally.costUsd += price.costUsd;
        tally.priced += 1;
      } else {
        tally.unpriced += 1;
      }
    }
  }
  const rows = [...groups]
    .map(([key, tally]): JudgmentCostRow => {
      const [battery, site] = JSON.parse(key) as [string, string];
      return {
        battery,
        site,
        calls: tally.calls,
        failed: tally.failed,
        inputTokens: tally.inputTokens,
        outputTokens: tally.outputTokens,
        meanLatencyMs: tally.latencyMs / tally.calls,
        costUsd: tally.priced === 0 ? null : tally.costUsd,
        costState: stateOf(tally),
      };
    })
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) || a.battery.localeCompare(b.battery) || a.site.localeCompare(b.site));
  return {
    rows,
    calls: total.calls,
    failed: total.failed,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    costUsd: total.priced === 0 ? null : total.costUsd,
    costState: stateOf(total),
  };
}
