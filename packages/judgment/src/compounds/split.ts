import type { Battery, YesNoItem } from '../batteries/battery.ts';
import type { EntryType, JudgmentPort } from '../port/types.ts';
import type { YesNoReading } from '../readings/readings.ts';
import type { CallOptions } from '../patterns/common.ts';

export interface SplitResult {
  /** The request as one part, or the parts a generative splitter produced. */
  readonly parts: readonly string[];
  readonly reading: YesNoReading;
  /** The detector could not tell; the caller asks or treats the request whole. */
  readonly uncertain: boolean;
}

/**
 * Compound split (the smart home demo): a yes/no battery asks whether a
 * request holds more than one distinct action; only when it does is a
 * generative splitter called to break it into atomic requests, each of which
 * the caller then judges on its own. System One never writes the parts; a
 * text model does, and only when the reading says it is needed.
 */
export async function splitCompound(
  port: JudgmentPort,
  detector: Battery<{ readonly multiple: YesNoItem }>,
  split: (request: string) => Promise<readonly string[]>,
  request: string,
  options: CallOptions = {},
): Promise<SplitResult> {
  const run = await detector.run(port, request as EntryType, { pattern: 'compound-split', ...options });
  const reading = run.readings.multiple;
  if (reading.verdict !== 'yes') {
    run.recordAction(reading.verdict === 'no' ? 'whole' : 'uncertain');
    return { parts: [request], reading, uncertain: reading.verdict === 'uncertain' };
  }
  const parts = await split(request);
  run.recordAction(`split:${parts.length}`);
  return { parts: parts.length > 0 ? parts : [request], reading, uncertain: false };
}
