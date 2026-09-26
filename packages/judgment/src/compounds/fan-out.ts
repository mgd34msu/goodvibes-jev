import type { Battery, BatteryItems, ReadingFor } from '../batteries/battery.ts';
import { readItem } from '../batteries/battery.ts';
import { recordAction, recordReadings, type CallOptions } from '../batteries/asking.ts';
import type { EntryType, JudgmentPort, Question, Questions } from '../port/types.ts';

type Parts = Readonly<Record<string, Battery<BatteryItems>>>;

export type FannedReadings<P extends Parts> = {
  readonly [K in keyof P]: P[K] extends Battery<infer Items> ? { readonly [I in keyof Items]: ReadingFor<Items[I]> } : never;
};

export interface FannedOut<P extends Parts> {
  readonly readings: FannedReadings<P>;
  readonly decisionId: string | undefined;
  recordAction(action: string): void;
}

/** A battery's question inside a fanned-out request: `<part>__<question>`. */
const SEPARATOR = '__';
const questionKey = (part: string, item: string): string => `${part}${SEPARATOR}${item}`;

/** The one model every part is tuned on; batteries on different models cannot share a request. */
function sharedModel(port: JudgmentPort, parts: Parts): string {
  const models = new Set(Object.values(parts).map((battery) => battery.model ?? port.model));
  if (models.size > 1) throw new RangeError(`fan-out batteries are tuned on different models (${[...models].join(', ')}); run them apart`);
  return [...models][0]!;
}

function mergedQuestions(parts: Parts): Questions {
  const questions: Record<string, Question> = {};
  for (const [part, battery] of Object.entries(parts)) {
    if (part.includes(SEPARATOR)) throw new RangeError(`fan-out part "${part}" may not contain "${SEPARATOR}"`);
    for (const [item, spec] of Object.entries(battery.items)) questions[questionKey(part, item)] = spec.question;
  }
  return questions;
}

function readParts(parts: Parts, answers: Readonly<Record<string, unknown>>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(parts).map(([part, battery]) => [
      part,
      Object.fromEntries(Object.entries(battery.items).map(([item, spec]) => [item, readItem(spec, answers[questionKey(part, item)])])),
    ]),
  );
}

/**
 * Speculative fan-out across batteries: every question of every battery about
 * the same state rides one request, and each battery reads its own answers
 * through its own bands. Questions are independent, so combining them changes
 * no answer and saves a round trip per battery (the parallel questions
 * cookbook). Code then decides which readings matter on its path. Each
 * battery stays calibrated on its own; the fan-out adds no judgment.
 */
export async function fanOut<const P extends Parts>(
  port: JudgmentPort,
  state: EntryType,
  parts: P,
  options: CallOptions & { readonly label?: string } = {},
): Promise<FannedOut<P>> {
  if (Object.keys(parts).length === 0) throw new RangeError('fan-out needs at least one battery');
  const model = sharedModel(port, parts);
  const result = await port.ask({
    state,
    questions: mergedQuestions(parts),
    ...(model === port.model ? {} : { model }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    context: {
      battery: options.label ?? Object.values(parts).map((battery) => battery.name).join('+'),
      pattern: 'fan-out',
      ...(options.site === undefined ? {} : { site: options.site }),
    },
  });
  const readings = readParts(parts, result.answers as Readonly<Record<string, unknown>>);
  recordReadings(port, result, readings);
  return { readings: readings as FannedReadings<P>, decisionId: result.decisionId, recordAction: (action) => recordAction(port, result.decisionId, action) };
}
