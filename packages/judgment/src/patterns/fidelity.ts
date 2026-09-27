import { checkEachFixture, decisionHeader, fixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { choice, type JudgmentPort, type JudgmentResult, type Questions } from '../port/types.ts';
import { assertBand, type ChoiceBand, type Outcome } from '../readings/bands.ts';
import { readChoice, type ChoiceReading } from '../readings/readings.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';

export type Fidelity = 'supported' | 'contradicted' | 'unsupported' | 'fabricated';

const RELATIONS = {
  supports: 'The source states the claim or directly implies that it is true.',
  contradicts: 'The source states the opposite of the claim or implies it is false.',
  says_nothing: 'The source does not address what the claim asserts, either way.',
} as const;
type Relation = keyof typeof RELATIONS;
const TO_FIDELITY: Readonly<Record<Relation, Fidelity>> = {
  supports: 'supported',
  contradicts: 'contradicted',
  says_nothing: 'unsupported',
};

/**
 * Fidelity check (double-checking citations): is a claim faithful to its
 * source? A quote the claim rests on is first looked up in the source by
 * plain string match, since a missing quote is fabricated and needs no
 * model. Otherwise one Choice reads how the source relates to the claim.
 * Used for citations, compaction summaries and extracted facts alike.
 */
export interface FidelitySpec extends PatternHeader {
  readonly band: ChoiceBand<Relation>;
  readonly fixtures: readonly {
    readonly name: string;
    readonly claim: string;
    readonly source: string;
    readonly quote?: string;
    readonly expect: Fidelity;
  }[];
}

export interface FidelityResult {
  readonly fidelity: Fidelity;
  /** Absent when a missing quote settled the case without asking. */
  readonly reading: ChoiceReading<Relation> | undefined;
  readonly outcome: Outcome;
  readonly decisionId: string | undefined;
  /** The call's token usage; absent when a missing quote settled the case without asking. */
  readonly usage: JudgmentResult<Questions>['usage'] | undefined;
  recordAction(action: string): void;
}

export interface FidelityChecker extends NamedDecision {
  check(port: JudgmentPort, claim: string, source: string, quote?: string, options?: CallOptions): Promise<FidelityResult>;
}

/** Whitespace collapsed and curly quotes folded, so a quote matches across line wraps. */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function defineFidelityChecker(spec: FidelitySpec): FidelityChecker {
  const header = decisionHeader(spec);
  assertBand(spec.band);
  const question = choice('How does `source` relate to `claim`?', RELATIONS);

  const checker: FidelityChecker = {
    ...header,
    async check(port, claim, source, quote, options = {}) {
      if (quote !== undefined && !normalizeForMatch(source).includes(normalizeForMatch(quote))) {
        return { fidelity: 'fabricated', reading: undefined, outcome: 'act', decisionId: undefined, usage: undefined, recordAction: () => {} };
      }
      const result = await askAs(port, spec, 'fidelity', { claim, source }, { relation: question }, options);
      const reading = readChoice(result.answers.relation, spec.band as ChoiceBand) as ChoiceReading<Relation>;
      const fidelity = TO_FIDELITY[reading.choice];
      recordReadings(port, result, { fidelity, relation: reading });
      return {
        fidelity,
        reading,
        outcome: reading.outcome,
        decisionId: result.decisionId,
        usage: result.usage,
        recordAction: (action) => recordAction(port, result.decisionId, action),
      };
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => {
        const got = await checker.check(port, fixture.claim, fixture.source, fixture.quote, run);
        return fixtureCheck(fixture.name, 'fidelity', fixture.expect, got.fidelity, got.reading?.confidence ?? 1, got.outcome);
      }),
  };
  return checker;
}
