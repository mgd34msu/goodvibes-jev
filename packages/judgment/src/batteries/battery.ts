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
  assertBand,
  type ChoiceBand,
  type ConfidenceBand,
  type YesNoBand,
} from '../readings/bands.ts';
import {
  leansYes,
  likelierSide,
  readChoice,
  readScore,
  readYesNo,
  type ChoiceReading,
  type ScoreReading,
  type YesNoReading,
} from '../readings/readings.ts';
import { askAs, recordAction, recordReadings, type PatternName } from './asking.ts';
import { checkEachFixture, decisionHeader, fixtureCheck, type FixtureCheck, type NamedDecision } from './decision.ts';

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

/** One question in a battery, with the band that reads its answer. */
export type BatteryItem = YesNoItem | ChoiceItem<ChoiceCriteria> | ScoreItem<ScoreCriteria>;
export type BatteryItems = Readonly<Record<string, BatteryItem>>;

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
  /** Records what code did with these readings in the decision log. */
  recordAction(action: string): void;
}

export interface RunOptions<Items extends BatteryItems> {
  readonly signal?: AbortSignal;
  /** Ask only these questions; the rest are left out of the request. */
  readonly only?: readonly (keyof Items & string)[];
  /** The decision site, recorded in the decision log. */
  readonly site?: string;
  /** The pattern running this battery, recorded in the decision log. */
  readonly pattern?: PatternName;
}

export interface Battery<Items extends BatteryItems> extends BatteryDefinition<Items>, NamedDecision {
  /** Asks every question (or the `only` subset) about one state in a single request. */
  run(port: JudgmentPort, state: EntryType, options?: RunOptions<Items>): Promise<BatteryRun<Items>>;
}

export type AnyReading = YesNoReading | ChoiceReading | ScoreReading;

/** Reads one answer through its item's band. */
export function readItem(item: BatteryItem, answer: unknown): AnyReading {
  if (item.kind === 'yes-no') return readYesNo(answer as Parameters<typeof readYesNo>[0], item.band);
  if (item.kind === 'choice') return readChoice(answer as Parameters<typeof readChoice>[0], item.band as ChoiceBand);
  return readScore(answer as Parameters<typeof readScore>[0], item.band);
}

/** The answer a reading settles on: the likelier side of a yes/no, the chosen option, the nearest level. */
export function concludedAnswer(reading: AnyReading): string {
  if (reading.kind === 'yes-no') return leansYes(reading.probability) ? 'yes' : 'no';
  return reading.kind === 'choice' ? reading.choice : String(reading.level);
}

/** How strongly the reading backs its answer: the winning probability of a yes/no, else the confidence. */
export function readingSignal(reading: AnyReading): number {
  return reading.kind === 'yes-no' ? likelierSide(reading.probability) : reading.confidence;
}

/**
 * Scores one reading against a fixture's expectation. Correctness is what
 * the model concluded; the outcome says whether the band would have let
 * code act on it.
 */
export function checkReading(fixture: string, aspect: string, expected: string, reading: AnyReading): FixtureCheck {
  return fixtureCheck(fixture, aspect, expected, concludedAnswer(reading), readingSignal(reading), reading.outcome);
}

function assertItemBands(battery: string, itemName: string, item: BatteryItem): void {
  assertBand(item.band);
  if (item.kind !== 'choice') return;
  for (const [option, band] of Object.entries((item.band as ChoiceBand).perOption ?? {})) {
    if (!(option in item.question.criteria)) throw new RangeError(`battery ${battery}: question ${itemName} has a band for unknown option "${option}"`);
    assertBand(band as ConfidenceBand);
  }
}

/** Whether an expectation is an answer the question could give. */
function isPossibleAnswer(item: BatteryItem, expected: unknown): boolean {
  if (item.kind === 'yes-no') return expected === 'yes' || expected === 'no';
  if (item.kind === 'choice') return typeof expected === 'string' && expected in item.question.criteria;
  const levels = item.question.criteria.length;
  return typeof expected === 'number' && Number.isInteger(expected) && expected >= 0 && expected < levels;
}

/** Checks every expectation is possible and every question has one; returns nothing, throws on a gap. */
function assertFixturesCover<Items extends BatteryItems>(battery: string, items: Items, fixtures: readonly Fixture<Items>[]): void {
  const covered = new Set<string>();
  for (const fixture of fixtures) {
    for (const [itemName, expected] of Object.entries(fixture.expect)) {
      const item = items[itemName];
      if (item === undefined) throw new RangeError(`battery ${battery}: fixture ${fixture.name} expects unknown question "${itemName}"`);
      if (!isPossibleAnswer(item, expected)) throw new RangeError(`battery ${battery}: fixture ${fixture.name} expects an impossible answer for "${itemName}"`);
      covered.add(itemName);
    }
  }
  const uncovered = Object.keys(items).filter((itemName) => !covered.has(itemName));
  if (uncovered.length > 0) throw new RangeError(`battery ${battery}: no fixture covers ${uncovered.join(', ')}; every question needs a labelled example`);
}

function questionsFor<Items extends BatteryItems>(battery: string, items: Items, asked: readonly string[]): Questions {
  return Object.fromEntries(
    asked.map((itemName) => {
      const item = items[itemName];
      if (item === undefined) throw new RangeError(`battery ${battery}: no question "${itemName}"`);
      return [itemName, item.question];
    }),
  );
}

export function defineBattery<const Items extends BatteryItems>(definition: BatteryDefinition<Items>): Battery<Items> {
  const { name, items, fixtures } = definition;
  const header = decisionHeader(definition);
  if (Object.keys(items).length === 0) throw new RangeError(`battery ${name}: needs at least one question`);
  for (const [itemName, item] of Object.entries(items)) assertItemBands(name, itemName, item);
  assertFixturesCover(name, items, fixtures);

  const battery: Battery<Items> = {
    ...definition,
    ...header,
    async run(port, state, options = {}) {
      const asked = options.only ?? Object.keys(items);
      const { answers, ...result } = await askAs(port, definition, options.pattern ?? 'battery', state, questionsFor(name, items, asked), options);
      const readings = Object.fromEntries(asked.map((itemName) => [itemName, readItem(items[itemName]!, answers[itemName])]));
      recordReadings(port, result, readings);
      return {
        readings: readings as BatteryRun<Items>['readings'],
        result,
        recordAction: (action) => recordAction(port, result.decisionId, action),
      };
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(fixtures, options, async (fixture, run) => {
        const asked = Object.keys(fixture.expect) as (keyof Items & string)[];
        const { readings } = await battery.run(port, fixture.state, { ...run, only: asked });
        return asked.map((itemName) => checkReading(fixture.name, itemName, String(fixture.expect[itemName]), readings[itemName] as AnyReading));
      }),
  };
  return battery;
}
