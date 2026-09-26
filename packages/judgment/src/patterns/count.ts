import { checkEachFixture, decisionHeader, fixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { noul, type JsonValue, type JudgmentPort } from '../port/types.ts';
import { assertYesNoBand, type YesNoBand } from '../readings/bands.ts';
import { likelierSide, readYesNo, type YesNoReading } from '../readings/readings.ts';
import { askAs, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';

/**
 * Counting by yes/no (Jev 1.13 jaggedness, "Counting"): Jev does not tally
 * reliably, so the count is taken in code. Each item gets its own yes/no in
 * one request, pointed at `items[i]`, and code adds up the yeses. Uncertain
 * items are reported, never silently rounded into the count.
 */
export interface CounterSpec extends PatternHeader {
  /** The condition, asked of `item`, e.g. "Is `item` the name of a fruit?". */
  readonly condition: string;
  readonly band: YesNoBand;
  readonly fixtures: readonly { readonly name: string; readonly items: readonly JsonValue[]; readonly expect: number }[];
}

export interface Count {
  readonly count: number;
  /** Indexes of items the reading could not settle. */
  readonly uncertain: readonly number[];
  readonly readings: readonly YesNoReading[];
}

export interface Counter extends NamedDecision {
  count(port: JudgmentPort, items: readonly JsonValue[], options?: CallOptions): Promise<Count>;
}

function itemQuestion(condition: string, index: number) {
  return noul({ question: condition, item: `\`items[${index}]\`` });
}

export function defineCounter(spec: CounterSpec): Counter {
  const header = decisionHeader(spec);
  assertYesNoBand(spec.band);

  const counter: Counter = {
    ...header,
    async count(port, items, options = {}) {
      if (items.length === 0) return { count: 0, uncertain: [], readings: [] };
      const questions = Object.fromEntries(items.map((_, index) => [`item_${index}`, itemQuestion(spec.condition, index)]));
      const result = await askAs(port, spec, 'count', { items: [...items] }, questions, options);
      const answers = result.answers as Record<string, { type: 'noul'; noul: number }>;
      const readings = items.map((_, index) => readYesNo(answers[`item_${index}`]!, spec.band));
      const count = readings.filter((reading) => reading.verdict === 'yes').length;
      const uncertain = readings.flatMap((reading, index) => (reading.verdict === 'uncertain' ? [index] : []));
      recordReadings(port, result, { count, uncertain });
      return { count, uncertain, readings };
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => {
        const got = await counter.count(port, fixture.items, run);
        const weakest = Math.min(...got.readings.map((reading) => likelierSide(reading.probability)));
        return fixtureCheck(fixture.name, 'count', String(fixture.expect), String(got.count), weakest, got.uncertain.length === 0 ? 'act' : 'escalate');
      }),
  };
  return counter;
}
