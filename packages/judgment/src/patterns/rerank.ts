import { assertDecisionHeader, assertUniqueFixtures, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { noul, type EntryType, type JsonValue, type JudgmentPort } from '../port/types.ts';
import { assertYesNoBand, type YesNoBand } from '../readings/bands.ts';
import { readYesNo, type YesNoReading } from '../readings/readings.ts';
import { askAs, mapLimit, recordReadings, type CallOptions, type PatternHeader } from './common.ts';

/**
 * Rerank: one yes/no per query-candidate pair, each in its own request so no
 * candidate becomes context for another, then sorted by probability (the
 * re-ranking cookbook). Fast search builds the shortlist; this orders it.
 */
export interface RerankSpec extends PatternHeader {
  /** What makes a candidate right for the query. Refer to `query` and `candidate`. */
  readonly instructions?: EntryType;
  readonly criteria?: { readonly true: EntryType; readonly false: EntryType };
  /** Band on the top candidate's probability; below it nothing is a confident match. */
  readonly band: YesNoBand;
  /** Pair requests in flight at once; default 8. */
  readonly concurrency?: number;
  readonly fixtures: readonly RerankFixture[];
}

export interface Candidate {
  readonly id: string;
  readonly content: JsonValue;
}

export interface RerankFixture {
  readonly name: string;
  readonly query: JsonValue;
  readonly candidates: readonly Candidate[];
  /** The candidate that should rank first, or 'none' when no candidate fits. */
  readonly expect: { readonly top: string };
}

export interface Ranked {
  readonly id: string;
  readonly probability: number;
  readonly reading: YesNoReading;
  readonly decisionId: string | undefined;
}

export interface Reranking {
  /** Every candidate, best first. */
  readonly ranked: readonly Ranked[];
  /** The best candidate when its reading is a yes; undefined when nothing fits. */
  readonly top: Ranked | undefined;
}

export interface Rerank extends NamedDecision {
  rerank(port: JudgmentPort, query: JsonValue, candidates: readonly Candidate[], options?: CallOptions): Promise<Reranking>;
}

const DEFAULT_INSTRUCTIONS = 'Does `candidate` answer or satisfy `query`?';
const DEFAULT_CRITERIA = {
  true: 'The candidate directly provides what the query is looking for.',
  false: 'The candidate is only on a similar topic, or does not provide what the query asks for.',
};

export function defineRerank(spec: RerankSpec): Rerank {
  assertDecisionHeader({ ...spec, fixtureCount: spec.fixtures.length });
  assertUniqueFixtures(spec.name, spec.fixtures);
  assertYesNoBand(spec.band);
  for (const fixture of spec.fixtures) {
    const ids = new Set(fixture.candidates.map((candidate) => candidate.id));
    if (ids.size !== fixture.candidates.length) throw new RangeError(`rerank ${spec.name}: fixture ${fixture.name} repeats a candidate id`);
    if (fixture.expect.top !== 'none' && !ids.has(fixture.expect.top)) {
      throw new RangeError(`rerank ${spec.name}: fixture ${fixture.name} expects unknown candidate "${fixture.expect.top}"`);
    }
  }
  const question = noul(spec.instructions ?? DEFAULT_INSTRUCTIONS, spec.criteria ?? DEFAULT_CRITERIA);

  const rerank: Rerank = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    accuracyFloor: spec.accuracyFloor,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    fixtureCount: spec.fixtures.length,
    async rerank(port, query, candidates, options = {}) {
      const ranked = await mapLimit(candidates, spec.concurrency ?? 8, async (candidate) => {
        const result = await askAs(port, spec, 'rerank', { query, candidate: candidate.content }, { match: question }, options);
        const reading = readYesNo(result.answers.match, spec.band);
        recordReadings(port, result, { candidate: candidate.id, match: reading });
        return { id: candidate.id, probability: reading.probability, reading, decisionId: result.decisionId };
      });
      ranked.sort((a, b) => b.probability - a.probability);
      const best = ranked[0];
      return { ranked, top: best !== undefined && best.reading.verdict === 'yes' ? best : undefined };
    },
    async checkFixtures(port, options = {}) {
      const checks: FixtureCheck[] = [];
      for (const fixture of spec.fixtures) {
        const { ranked, top } = await rerank.rerank(port, fixture.query, fixture.candidates, { site: 'calibration', ...options });
        const best = ranked[0]!;
        const got = top?.id ?? 'none';
        checks.push({
          fixture: fixture.name,
          aspect: 'top',
          expected: fixture.expect.top,
          got,
          correct: got === fixture.expect.top,
          signal: got === 'none' ? 1 - best.probability : best.probability,
          outcome: best.reading.outcome,
        });
      }
      return checks;
    },
  };
  return rerank;
}
