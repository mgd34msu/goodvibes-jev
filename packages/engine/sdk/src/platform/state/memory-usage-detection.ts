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
import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { mapLimit } from '@goodvibes-jev/judgment';
import { memoryUsage } from './batteries/memory-usage.js';
import { retainOwnedJson, snapshotJudgmentInput } from '../gate/judgment-input.js';
import { prepareJudgmentResult } from '../gate/judgment-result.js';

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
  readonly assertCurrent: () => void;
}

const SITE = 'state.memory-usage-detection';

/** Usage readings in flight at once for one response. */
const USAGE_CONCURRENCY = 8;

export async function detectReferencedMemoryIds(
  responseText: string,
  records: readonly MemoryReferenceInput[],
  options: Pick<JudgmentReadingOptions, 'signal' | 'assertCurrent'> = {},
): Promise<MemoryReferenceResult> {
  const original = retainOwnedJson({ responseText, records });
  const input = snapshotJudgmentInput(original.snapshot) as { responseText: string; records: readonly MemoryReferenceInput[] };
  const current = () => { original.assertCurrent(); options.signal?.throwIfAborted();
    const checked: unknown = options.assertCurrent?.();
    if (checked !== undefined) { void Promise.resolve(checked).catch(() => {}); throw new Error('Memory usage guard must be synchronous.'); }
  };
  current();
  const referenced: string[] = [];
  const present: string[] = [];
  const perId = new Map<string, MemoryReferenceTier>();
  if (!input.records.length) return { referenced, present, perId, assertCurrent: current };
  const owner = captureJudgmentPort(SITE, { ...options, assertCurrent: current, prepareResultCapture: prepareJudgmentResult });
  const runs = await mapLimit(input.records, USAGE_CONCURRENCY, record => {
    const memory = { summary: record.summary, ...(record.detail === undefined ? {} : { detail: record.detail }) };
    return memoryUsage.run(owner.port, { memory, response: input.responseText }, { site: SITE, signal: owner.signal, beforeAttempt: owner.assertCurrent });
  });
  owner.assertCurrent();
  input.records.forEach((record, index) => {
    const run = runs[index]!;
    const tier = run.readings.used.outcome === 'act' && run.readings.used.verdict === 'yes' ? 'referenced' : 'present';
    // Presence is a native prompt fact. An unsettled reading never claims use.
    if (run.readings.used.outcome === 'act') run.recordAction(tier);
    perId.set(record.id, tier);
    if (tier === 'referenced') referenced.push(record.id);
    else present.push(record.id);
  });
  owner.assertCurrent();
  return { referenced, present, perId, assertCurrent: owner.assertCurrent };
}
