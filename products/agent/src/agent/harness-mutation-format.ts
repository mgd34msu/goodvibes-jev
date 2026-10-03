/**
 * harness-mutation-format.ts, how a completed settings write is reported.
 *
 * Its own file because the reply is where two hard-won facts have to show up
 * together, and both of them cost a real session:
 *
 *  - the OWNER and the STORE. "Saved" alone cannot distinguish a value the
 *    acting runtime will read from one written into a file it never opens.
 *  - the COMPANION row. `voice.wake.enabled` on a surface whose
 *    `voice.wake.surfaces.<surface>` row is off is a setting that configures
 *    nothing; the write takes that row with it, and this is where it says so.
 */
import type { HarnessSettingMutationResult } from './harness-control.ts';

/** Render a completed settings mutation, naming what else moved and where it landed. */
export function formatHarnessMutation(result: HarnessSettingMutationResult): string {
  return [
    `Setting ${result.action}`,
    `  key ${result.key}`,
    `  previous ${String(result.previous)}`,
    `  current ${String(result.current)}`,
    ...(result.alsoSet ? [`  also set ${result.alsoSet.key} to ${String(result.alsoSet.value)}, ${result.alsoSet.message}`] : []),
    ...(result.scope ? [`  owner ${result.scope}`] : []),
    ...(result.appliedBy ? [`  applied by ${result.appliedBy}`] : []),
    ...(result.persistedTo ? [`  stored in ${result.persistedTo}`] : []),
  ].join('\n');
}
