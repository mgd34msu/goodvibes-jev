import { checkReading } from '../batteries/battery.ts';
import { checkEachFixture, decisionHeader, fixtureCheck, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';
import { choice, noul, type JudgmentPort, type Question } from '../port/types.ts';
import { LIMITS } from '../port/limits.ts';
import { assertYesNoBand, type YesNoBand } from '../readings/bands.ts';
import { readYesNo, type YesNoReading } from '../readings/readings.ts';

/**
 * Existence check (line-by-line search): the items are tagged with ids in the
 * state, a Choice over the ids ranks where the answer sits, and a Noul in the
 * same request says whether any item answers at all. A Choice always puts
 * some item first, so the ranking alone cannot tell a real answer from the
 * closest wrong one; the Noul can.
 */
export interface ExistenceSpec extends PatternHeader {
  /** Band on the probability that the items contain an answer. */
  readonly band: YesNoBand;
  readonly fixtures: readonly ExistenceFixture[];
}

export interface Item {
  readonly id: string;
  readonly text: string;
}

export interface ExistenceFixture {
  readonly name: string;
  readonly query: string;
  readonly items: readonly Item[];
  readonly expect: { readonly exists: 'yes' | 'no'; readonly item?: string };
}

export interface RankedItem {
  readonly id: string;
  /** The item's share of the where-probability. */
  readonly relevance: number;
}

export interface ExistenceResult {
  readonly exists: YesNoReading;
  /** Items best first. */
  readonly ranked: readonly RankedItem[];
  /** The best item when the answer exists; undefined otherwise. */
  readonly answer: string | undefined;
  readonly decisionId: string | undefined;
  recordAction(action: string): void;
}

export interface Existence extends NamedDecision {
  find(port: JudgmentPort, query: string, items: readonly Item[], options?: CallOptions): Promise<ExistenceResult>;
}

/** Items one Choice can rank: the documented option limit. Filter or rerank larger sets first. */
export const MAX_EXISTENCE_ITEMS = LIMITS.maxChoiceOptions;
const MIN_EXISTENCE_ITEMS = 2;
/** How many of the best items the decision log keeps beside the verdict. */
const LOGGED_TOP_ITEMS = 5;

function assertItems(decision: string, items: readonly Item[]): void {
  const inRange = items.length >= MIN_EXISTENCE_ITEMS && items.length <= MAX_EXISTENCE_ITEMS;
  if (!inRange) throw new RangeError(`existence ${decision}: needs ${MIN_EXISTENCE_ITEMS} to ${MAX_EXISTENCE_ITEMS} items, got ${items.length}; filter or rerank first`);
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new RangeError(`existence ${decision}: item ids must be unique`);
}

function existenceQuestions(query: string, items: readonly Item[]): Record<string, Question> {
  return {
    where: choice({ question: 'Which item contains the answer to `query`?', query }, Object.fromEntries(items.map((item) => [item.id, null]))),
    exists: noul({ question: 'Does any item address or answer `query`?', query }, {
      true: 'At least one item states or directly implies the answer.',
      false: 'No item addresses this.',
    }),
  };
}

function rankItems(items: readonly Item[], probabilities: Readonly<Record<string, number>>): RankedItem[] {
  return items.map((item) => ({ id: item.id, relevance: probabilities[item.id] ?? 0 })).sort((a, b) => b.relevance - a.relevance);
}

function fixtureChecks(fixture: ExistenceFixture, found: ExistenceResult): FixtureCheck[] {
  const existsCheck = checkReading(fixture.name, 'exists', fixture.expect.exists, found.exists);
  if (fixture.expect.item === undefined) return [existsCheck];
  const [best] = found.ranked as [RankedItem];
  return [existsCheck, fixtureCheck(fixture.name, 'item', fixture.expect.item, best.id, best.relevance, found.exists.outcome)];
}

export function defineExistence(spec: ExistenceSpec): Existence {
  const header = decisionHeader(spec);
  assertYesNoBand(spec.band);
  for (const fixture of spec.fixtures) {
    const known = fixture.expect.item === undefined || fixture.items.some((item) => item.id === fixture.expect.item);
    if (!known) throw new RangeError(`existence ${spec.name}: fixture ${fixture.name} expects unknown item "${fixture.expect.item}"`);
  }

  const existence: Existence = {
    ...header,
    async find(port, query, items, options = {}) {
      assertItems(spec.name, items);
      const state = items.map((item) => `${item.id}| ${item.text}`).join('\n');
      const result = await askAs(port, spec, 'existence', state, existenceQuestions(query, items), options);
      const { where, exists: existsAnswer } = result.answers as unknown as {
        where: { probabilities: Record<string, number> };
        exists: { type: 'noul'; noul: number };
      };
      const exists = readYesNo(existsAnswer, spec.band);
      const ranked = rankItems(items, where.probabilities);
      const answer = exists.verdict === 'yes' ? ranked[0]?.id : undefined;
      recordReadings(port, result, { exists, answer: answer ?? null, top: ranked.slice(0, LOGGED_TOP_ITEMS) });
      return { exists, ranked, answer, decisionId: result.decisionId, recordAction: (action) => recordAction(port, result.decisionId, action) };
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => fixtureChecks(fixture, await existence.find(port, fixture.query, fixture.items, run))),
  };
  return existence;
}
