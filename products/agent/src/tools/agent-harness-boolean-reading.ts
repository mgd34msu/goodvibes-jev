import { booleanValue, ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { personalOpsEntry } from './agent-harness-personal-ops-source.ts';
import { withCanonicalReading } from './agent-harness-canonical-reading.ts';

export interface HarnessBooleanSource {
  readonly tool: string;
  readonly parameter: string;
  readonly description: string;
  readonly value: unknown;
  readonly evidence: unknown;
}

/** JSON booleans and their exact JSON spellings are grammar; other strings require a reading. */
export async function readHarnessBoolean(source: HarnessBooleanSource, options: CatalogRankingOptions): Promise<boolean | undefined> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (source.value === undefined) return undefined;
  if (typeof source.value === 'boolean') return source.value;
  if (source.value === 'true' || source.value === 'false') return source.value === 'true';
  if (typeof source.value !== 'string') throw new ToolInputProjectionError('held');
  return withModelReadingSource(source, options, (captured, current) => withCanonicalReading('agent.harness.boolean-value', [booleanValue], current,
    async (port, assertCurrent, signal) => {
      const run = await booleanValue.run(port, personalOpsEntry(captured), { site: 'agent.harness.boolean-value', signal, beforeAttempt: assertCurrent });
      assertCurrent(); run.recordAction('read-only boolean interpretation');
      const reading = run.readings.boolean_value;
      if (reading.outcome !== 'act' || reading.choice === 'neither') throw new ToolInputProjectionError('held');
      return reading.choice === 'true';
    }));
}
