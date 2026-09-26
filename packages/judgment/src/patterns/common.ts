import type { EntryType, JudgmentPort, JudgmentResult, Questions } from '../port/types.ts';

/** What every pattern instance declares about itself. */
export interface PatternHeader {
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly accuracyFloor: number;
  readonly model?: string;
}

export interface CallOptions {
  readonly signal?: AbortSignal;
  /** The decision site, recorded in the decision log. */
  readonly site?: string;
}

/** Asks on behalf of a pattern instance, attributing the call in the decision log. */
export function askAs<const Q extends Questions>(
  port: JudgmentPort,
  header: PatternHeader,
  pattern: string,
  state: EntryType,
  questions: Q,
  options: CallOptions = {},
): Promise<JudgmentResult<Q>> {
  return port.ask({
    state,
    questions,
    ...(header.model === undefined ? {} : { model: header.model }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    context: {
      battery: header.name,
      batteryVersion: header.version,
      pattern,
      ...(options.site === undefined ? {} : { site: options.site }),
    },
  });
}

/** Attaches a pattern's conclusions to the call's decision log entry. */
export function recordReadings(port: JudgmentPort, result: { readonly decisionId?: string }, readings: object): void {
  if (result.decisionId !== undefined && port.recorder !== undefined) {
    port.recorder.recordReadings(result.decisionId, readings as Readonly<Record<string, unknown>>);
  }
}

/** Records what code did with a decision; a no-op when the port keeps no log. */
export function recordAction(port: JudgmentPort, decisionId: string | undefined, action: string): void {
  if (decisionId !== undefined && port.recorder !== undefined) port.recorder.recordAction(decisionId, action);
}

/** Maps with at most `limit` calls in flight, preserving order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}
