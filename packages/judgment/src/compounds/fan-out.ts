import type { Battery, BatteryItems, ReadingFor } from '../batteries/battery.ts';
import type { EntryType, JudgmentPort, Questions } from '../port/types.ts';
import { readChoice, readScore, readYesNo } from '../readings/readings.ts';
import type { ChoiceBand } from '../readings/bands.ts';
import { recordAction, recordReadings, type CallOptions } from '../patterns/common.ts';

type Parts = Readonly<Record<string, Battery<BatteryItems>>>;

export type FannedReadings<P extends Parts> = {
  readonly [K in keyof P]: P[K] extends Battery<infer Items>
    ? { readonly [I in keyof Items]: ReadingFor<Items[I]> }
    : never;
};

export interface FannedOut<P extends Parts> {
  readonly readings: FannedReadings<P>;
  readonly decisionId: string | undefined;
  recordAction(action: string): void;
}

const SEPARATOR = '__';

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
  const names = Object.keys(parts);
  if (names.length === 0) throw new RangeError('fan-out needs at least one battery');
  const models = new Set(names.map((name) => parts[name]!.model ?? port.model));
  if (models.size > 1) throw new RangeError(`fan-out batteries are tuned on different models (${[...models].join(', ')}); run them apart`);
  const questions: Record<string, unknown> = {};
  for (const name of names) {
    if (name.includes(SEPARATOR)) throw new RangeError(`fan-out part "${name}" may not contain "${SEPARATOR}"`);
    for (const [item, spec] of Object.entries(parts[name]!.items)) questions[`${name}${SEPARATOR}${item}`] = spec.question;
  }
  const model = [...models][0]!;
  const result = await port.ask({
    state,
    questions: questions as Questions,
    ...(model === port.model ? {} : { model }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    context: {
      battery: options.label ?? names.map((name) => parts[name]!.name).join('+'),
      pattern: 'fan-out',
      ...(options.site === undefined ? {} : { site: options.site }),
    },
  });
  const answers = result.answers as Record<string, unknown>;
  const readings: Record<string, Record<string, unknown>> = {};
  for (const name of names) {
    readings[name] = {};
    for (const [item, spec] of Object.entries(parts[name]!.items)) {
      const answer = answers[`${name}${SEPARATOR}${item}`];
      readings[name]![item] =
        spec.kind === 'yes-no'
          ? readYesNo(answer as Parameters<typeof readYesNo>[0], spec.band)
          : spec.kind === 'choice'
            ? readChoice(answer as Parameters<typeof readChoice>[0], spec.band as ChoiceBand)
            : readScore(answer as Parameters<typeof readScore>[0], spec.band);
    }
  }
  recordReadings(port, result, readings);
  return {
    readings: readings as FannedReadings<P>,
    decisionId: result.decisionId,
    recordAction: (action) => recordAction(port, result.decisionId, action),
  };
}

