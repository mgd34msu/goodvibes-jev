/**
 * memory-usage-detection.ts, reference detection (HOISTED to the SDK).
 *
 * Did the model's output USE an injected memory, or was the memory merely
 * present in the prompt? Jev reads each injected memory against the response
 * (the `engine.state.memory-usage` battery, one request per memory) so every
 * consumer shares the SAME two-tier signal.
 *
 * Exactly two tiers:
 *   - 'referenced': the reading says yes, the response uses the specific
 *     information in this memory.
 *   - 'present': the memory was injected but the reading does not say yes.
 *     An uncertain reading counts as present: the tier claims use only when
 *     the reading supports it.
 *
 * It is NOT a relevance score and NOT ground truth, a memory can shape an
 * answer without showing in it. Everywhere this signal is shown it is
 * labelled as a reading (see MEMORY_USAGE_SIGNAL_NOTE).
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { mapLimit } from '@goodvibes-jev/judgment';
import { memoryUsage } from './batteries/memory-usage.js';

export type MemoryReferenceTier = 'referenced' | 'present';

export interface MemoryReferenceInput {
  readonly id: string;
  readonly summary: string;
  readonly detail?: string | undefined;
}

export interface MemoryReferenceResult {
  readonly referenced: readonly string[];
  readonly present: readonly string[];
  readonly perId: ReadonlyMap<string, MemoryReferenceTier>;
}

const SITE = 'state.memory-usage-detection';

/** Usage readings in flight at once for one response. */
const USAGE_CONCURRENCY = 8;

async function classify(record: MemoryReferenceInput, responseText: string): Promise<MemoryReferenceTier> {
  const memory = { summary: record.summary, ...(record.detail ? { detail: record.detail } : {}) };
  const run = await memoryUsage.run(judgmentPort(SITE), { memory, response: responseText }, { site: SITE });
  const tier: MemoryReferenceTier = run.readings.used.verdict === 'yes' ? 'referenced' : 'present';
  run.recordAction(tier);
  return tier;
}

export async function detectReferencedMemoryIds(
  responseText: string,
  records: readonly MemoryReferenceInput[],
): Promise<MemoryReferenceResult> {
  const referenced: string[] = [];
  const present: string[] = [];
  const perId = new Map<string, MemoryReferenceTier>();
  const tiers = await mapLimit(records, USAGE_CONCURRENCY, (record) => classify(record, responseText));
  records.forEach((record, index) => {
    const tier = tiers[index]!;
    perId.set(record.id, tier);
    if (tier === 'referenced') referenced.push(record.id);
    else present.push(record.id);
  });
  return { referenced, present, perId };
}
