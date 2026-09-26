import { assertDecisionHeader, assertUniqueFixtures, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { choice, noul, type JudgmentPort } from '../port/types.ts';
import { LIMITS } from '../port/limits.ts';
import { assertYesNoBand, type YesNoBand } from '../readings/bands.ts';
import { readYesNo, type YesNoReading } from '../readings/readings.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader } from './common.ts';

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

export interface ExistenceResult {
  readonly exists: YesNoReading;
  /** Items with their share of the where-probability, best first. */
  readonly ranked: readonly { readonly id: string; readonly relevance: number }[];
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

export function defineExistence(spec: ExistenceSpec): Existence {
  assertDecisionHeader({ ...spec, fixtureCount: spec.fixtures.length });
  assertUniqueFixtures(spec.name, spec.fixtures);
  assertYesNoBand(spec.band);
  for (const fixture of spec.fixtures) {
    if (fixture.expect.item !== undefined && !fixture.items.some((item) => item.id === fixture.expect.item)) {
      throw new RangeError(`existence ${spec.name}: fixture ${fixture.name} expects unknown item "${fixture.expect.item}"`);
    }
  }

  const existence: Existence = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    accuracyFloor: spec.accuracyFloor,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    fixtureCount: spec.fixtures.length,
    async find(port, query, items, options = {}) {
      if (items.length < 2 || items.length > MAX_EXISTENCE_ITEMS) {
        throw new RangeError(
          `existence ${spec.name}: needs 2 to ${MAX_EXISTENCE_ITEMS} items, got ${items.length}; filter or rerank first`,
        );
      }
      const ids = new Set(items.map((item) => item.id));
      if (ids.size !== items.length) throw new RangeError(`existence ${spec.name}: item ids must be unique`);
      const state = items.map((item) => `${item.id}| ${item.text}`).join('\n');
      const where = choice(
        { question: 'Which item contains the answer to `query`?', query },
        Object.fromEntries(items.map((item) => [item.id, null])) as Record<string, null>,
      );
      const exists = noul(
        { question: 'Does any item address or answer `query`?', query },
        {
          true: 'At least one item states or directly implies the answer.',
          false: 'No item addresses this.',
        },
      );
      const result = await askAs(port, spec, 'existence', state, { where, exists }, options);
      const existsReading = readYesNo(result.answers.exists, spec.band);
      const probabilities = result.answers.where.probabilities as Readonly<Record<string, number>>;
      const ranked = items
        .map((item) => ({ id: item.id, relevance: probabilities[item.id] ?? 0 }))
        .sort((a, b) => b.relevance - a.relevance);
      const answer = existsReading.verdict === 'yes' ? ranked[0]?.id : undefined;
      recordReadings(port, result, { exists: existsReading, answer: answer ?? null, top: ranked.slice(0, 5) });
      return {
        exists: existsReading,
        ranked,
        answer,
        decisionId: result.decisionId,
        recordAction: (action) => recordAction(port, result.decisionId, action),
      };
    },
    async checkFixtures(port, options = {}) {
      const checks: FixtureCheck[] = [];
      for (const fixture of spec.fixtures) {
        const found = await existence.find(port, fixture.query, fixture.items, { site: 'calibration', ...options });
        const p = found.exists.probability;
        const gotExists = p >= 0.5 ? 'yes' : 'no';
        checks.push({
          fixture: fixture.name,
          aspect: 'exists',
          expected: fixture.expect.exists,
          got: gotExists,
          correct: gotExists === fixture.expect.exists,
          signal: Math.max(p, 1 - p),
          outcome: found.exists.outcome,
        });
        if (fixture.expect.item !== undefined) {
          const best = found.ranked[0]!;
          checks.push({
            fixture: fixture.name,
            aspect: 'item',
            expected: fixture.expect.item,
            got: best.id,
            correct: best.id === fixture.expect.item,
            signal: best.relevance,
            outcome: found.exists.outcome,
          });
        }
      }
      return checks;
    },
  };
  return existence;
}
