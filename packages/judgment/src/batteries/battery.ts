import type {
  ChoiceCriteria,
  ChoiceQuestion,
  EntryType,
  JudgmentPort,
  JudgmentResult,
  NoulQuestion,
  Questions,
  ScoreCriteria,
  ScoreQuestion,
} from '../port/types.ts';
import { choice, noul, score } from '../port/types.ts';
import {
  assertConfidenceBand,
  assertYesNoBand,
  type ChoiceBand,
  type ConfidenceBand,
  type YesNoBand,
} from '../readings/bands.ts';
import {
  readChoice,
  readScore,
  readYesNo,
  type ChoiceReading,
  type ScoreReading,
  type YesNoReading,
} from '../readings/readings.ts';

/** One question in a battery, with the band that reads its answer. */
export type BatteryItem =
  | { readonly kind: 'yes-no'; readonly question: NoulQuestion; readonly band: YesNoBand }
  | { readonly kind: 'choice'; readonly question: ChoiceQuestion; readonly band: ChoiceBand }
  | { readonly kind: 'score'; readonly question: ScoreQuestion; readonly band: ConfidenceBand };

export interface YesNoItem {
  readonly kind: 'yes-no';
  readonly question: NoulQuestion;
  readonly band: YesNoBand;
}
export interface ChoiceItem<C extends ChoiceCriteria> {
  readonly kind: 'choice';
  readonly question: ChoiceQuestion<C>;
  readonly band: ChoiceBand<keyof C & string>;
}
export interface ScoreItem<L extends ScoreCriteria> {
  readonly kind: 'score';
  readonly question: ScoreQuestion<L>;
  readonly band: ConfidenceBand;
}

export type BatteryItems = Readonly<Record<string, YesNoItem | ChoiceItem<ChoiceCriteria> | ScoreItem<ScoreCriteria>>>;

/** A yes/no question read through a yes/no band. */
export const yesNo = (
  instructions: EntryType,
  band: YesNoBand,
  criteria?: { readonly true?: EntryType; readonly false?: EntryType },
): YesNoItem => ({ kind: 'yes-no', question: noul(instructions, criteria), band });

/** A choice over fixed options read through a confidence band. */
export const oneOf = <const C extends ChoiceCriteria>(
  instructions: EntryType,
  criteria: C,
  band: ChoiceBand<keyof C & string>,
): ChoiceItem<C> => ({ kind: 'choice', question: choice(instructions, criteria), band });

/** A score on an ordered rubric read through a confidence band. */
export const rated = <const L extends ScoreCriteria>(
  instructions: EntryType,
  levels: L,
  band: ConfidenceBand,
): ScoreItem<L> => ({ kind: 'score', question: score(instructions, levels), band });

export type ReadingFor<I> = I extends YesNoItem
  ? YesNoReading
  : I extends ChoiceItem<infer C>
    ? ChoiceReading<keyof C & string>
    : I extends ScoreItem<ScoreCriteria>
      ? ScoreReading
      : never;

/** What a fixture expects from one question: a verdict, an option or a level. */
export type ExpectedFor<I> = I extends YesNoItem
  ? 'yes' | 'no'
  : I extends ChoiceItem<infer C>
    ? keyof C & string
    : I extends ScoreItem<ScoreCriteria>
      ? number
      : never;

/** A labelled example: a state and what each question should conclude about it. */
export interface Fixture<Items extends BatteryItems> {
  readonly name: string;
  readonly state: EntryType;
  readonly expect: { readonly [K in keyof Items]?: ExpectedFor<Items[K]> };
}

/**
 * A named decision: its questions, the band that reads each answer, the
 * fixtures that say what correct looks like, the accuracy it must hold, and
 * the model it is tuned on. Everything a reviewer needs to judge the decision
 * lives in this one definition.
 */
export interface BatteryDefinition<Items extends BatteryItems> {
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly items: Items;
  readonly fixtures: readonly Fixture<Items>[];
  /** Share of fixture expectations calibration must meet, in (0, 1]. */
  readonly accuracyFloor: number;
  /** Versioned model the bands were tuned on; omitted uses the port's pinned model. */
  readonly model?: string;
}

export interface BatteryRun<Items extends BatteryItems> {
  readonly readings: { readonly [K in keyof Items]: ReadingFor<Items[K]> };
  readonly result: Omit<JudgmentResult<Questions>, 'answers'>;
}

export interface RunOptions<Items extends BatteryItems> {
  readonly signal?: AbortSignal;
  /** Ask only these questions; the rest are left out of the request. */
  readonly only?: readonly (keyof Items & string)[];
  /** The decision site, recorded in the decision log. */
  readonly site?: string;
  /** The pattern running this battery, recorded in the decision log. */
  readonly pattern?: string;
}

export interface Battery<Items extends BatteryItems> extends BatteryDefinition<Items> {
  /** Asks every question (or the `only` subset) about one state in a single request. */
  run(port: JudgmentPort, state: EntryType, options?: RunOptions<Items>): Promise<BatteryRun<Items>>;
}

const NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

function readItem(item: BatteryItems[string], answer: unknown): YesNoReading | ChoiceReading | ScoreReading {
  switch (item.kind) {
    case 'yes-no':
      return readYesNo(answer as Parameters<typeof readYesNo>[0], item.band);
    case 'choice':
      return readChoice(answer as Parameters<typeof readChoice>[0], item.band as ChoiceBand);
    case 'score':
      return readScore(answer as Parameters<typeof readScore>[0], item.band);
  }
}

export function defineBattery<const Items extends BatteryItems>(definition: BatteryDefinition<Items>): Battery<Items> {
  const { name, version, items, fixtures, accuracyFloor } = definition;
  if (!NAME.test(name)) throw new RangeError(`battery name "${name}" must be lowercase dotted or dashed words`);
  if (!Number.isInteger(version) || version < 1) throw new RangeError(`battery ${name}: version must be a positive integer`);
  if (!(accuracyFloor > 0 && accuracyFloor <= 1)) throw new RangeError(`battery ${name}: accuracyFloor must be in (0, 1]`);
  const itemNames = Object.keys(items);
  if (itemNames.length === 0) throw new RangeError(`battery ${name}: needs at least one question`);
  for (const [itemName, item] of Object.entries(items)) {
    if (item.kind === 'yes-no') assertYesNoBand(item.band);
    else assertConfidenceBand(item.band);
    if (item.kind === 'choice') {
      const perOption = (item.band as ChoiceBand).perOption ?? {};
      for (const [option, band] of Object.entries(perOption)) {
        if (!(option in item.question.criteria)) {
          throw new RangeError(`battery ${name}: question ${itemName} has a band for unknown option "${option}"`);
        }
        assertConfidenceBand(band as ConfidenceBand);
      }
    }
  }
  const fixtureNames = new Set<string>();
  const covered = new Set<string>();
  for (const fixture of fixtures) {
    if (fixtureNames.has(fixture.name)) throw new RangeError(`battery ${name}: duplicate fixture "${fixture.name}"`);
    fixtureNames.add(fixture.name);
    for (const [itemName, expected] of Object.entries(fixture.expect)) {
      const item = items[itemName];
      if (item === undefined) throw new RangeError(`battery ${name}: fixture ${fixture.name} expects unknown question "${itemName}"`);
      const valid =
        item.kind === 'yes-no'
          ? expected === 'yes' || expected === 'no'
          : item.kind === 'choice'
            ? typeof expected === 'string' && expected in item.question.criteria
            : Number.isInteger(expected) && (expected as number) >= 0 && (expected as number) < item.question.criteria.length;
      if (!valid) throw new RangeError(`battery ${name}: fixture ${fixture.name} expects an impossible answer for "${itemName}"`);
      covered.add(itemName);
    }
  }
  const uncovered = itemNames.filter((itemName) => !covered.has(itemName));
  if (uncovered.length > 0) {
    throw new RangeError(`battery ${name}: no fixture covers ${uncovered.join(', ')}; every question needs a labelled example`);
  }

  return {
    ...definition,
    async run(port, state, options = {}) {
      const asked = options.only ?? (itemNames as (keyof Items & string)[]);
      const questions: Record<string, BatteryItems[string]['question']> = {};
      for (const itemName of asked) {
        const item = items[itemName];
        if (item === undefined) throw new RangeError(`battery ${name}: no question "${itemName}"`);
        questions[itemName] = item.question;
      }
      const { answers, ...result } = await port.ask({
        state,
        questions: questions as Questions,
        ...(definition.model === undefined ? {} : { model: definition.model }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        context: {
          battery: name,
          batteryVersion: version,
          ...(options.site === undefined ? {} : { site: options.site }),
          ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
        },
      });
      const readings: Record<string, unknown> = {};
      for (const itemName of asked) {
        readings[itemName] = readItem(items[itemName]!, (answers as Record<string, unknown>)[itemName]);
      }
      return { readings: readings as BatteryRun<Items>['readings'], result };
    },
  };
}
