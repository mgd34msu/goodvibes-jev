import { assertDecisionHeader, assertUniqueFixtures, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { noul, score, type JsonValue, type JudgmentPort, type NoulQuestion } from '../port/types.ts';
import { assertConfidenceBand, type ConfidenceBand } from '../readings/bands.ts';
import { readScore, readYesNo, type ScoreReading, type YesNoReading } from '../readings/readings.ts';
import { STAKES_BANDS } from '../readings/bands.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader } from './common.ts';

export type Alignment = 'distinct' | 'review' | 'same';
const ALIGNMENTS: readonly Alignment[] = ['distinct', 'review', 'same'];

/**
 * Entity alignment (knowledge graph entity alignment): one Score with three
 * levels (different, related but maybe not the same, the same) decides the
 * pair by the nearest level, and one Noul per compared field rides along to
 * tell a curator which fields disagree. The middle level is written as an
 * outcome of its own, so review cases need no fitted threshold.
 */
export interface AlignmentSpec extends PatternHeader {
  /** What the entities are, singular: "person", "contact", "product". */
  readonly noun: string;
  /** Fields compared one by one, as named in the entities. */
  readonly fields: readonly string[];
  /** Band on the score's confidence; a weak reading on any level goes to review. */
  readonly band: ConfidenceBand;
  readonly fixtures: readonly {
    readonly name: string;
    readonly a: JsonValue;
    readonly b: JsonValue;
    readonly expect: Alignment;
  }[];
}

export interface Aligned {
  readonly alignment: Alignment;
  readonly reading: ScoreReading;
  /** Per compared field: does it match between the two? */
  readonly fields: Readonly<Record<string, YesNoReading>>;
  readonly decisionId: string | undefined;
  recordAction(action: string): void;
}

export interface EntityAligner extends NamedDecision {
  align(port: JudgmentPort, a: JsonValue, b: JsonValue, options?: CallOptions): Promise<Aligned>;
}

export function defineEntityAligner(spec: AlignmentSpec): EntityAligner {
  assertDecisionHeader({ ...spec, fixtureCount: spec.fixtures.length });
  assertUniqueFixtures(spec.name, spec.fixtures);
  assertConfidenceBand(spec.band);
  const levels = [
    `They describe two different ${spec.noun}s.`,
    `They describe closely related ${spec.noun}s that may or may not be the same one: a variant, a special edition, a namesake, or a record that could plausibly refer to either.`,
    `They describe one and the same ${spec.noun}.`,
  ] as const;
  const questions: Record<string, ReturnType<typeof score> | NoulQuestion> = {
    link: score(`How do \`entity_a\` and \`entity_b\` relate as ${spec.noun}s?`, levels),
  };
  for (const field of spec.fields) {
    questions[`same_${field}`] = noul(`Do \`entity_a\` and \`entity_b\` state the same ${field}?`);
  }
  const fieldBand = STAKES_BANDS.medium.yesNo;

  const aligner: EntityAligner = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    accuracyFloor: spec.accuracyFloor,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    fixtureCount: spec.fixtures.length,
    async align(port, a, b, options = {}) {
      const result = await askAs(port, spec, 'alignment', { entity_a: a, entity_b: b }, questions, options);
      const answers = result.answers as Record<string, unknown>;
      const reading = readScore(answers['link'] as Parameters<typeof readScore>[0], spec.band);
      // A confident reading takes its nearest level; a weak one, whatever its level, goes to review.
      const alignment: Alignment = reading.outcome === 'escalate' ? 'review' : ALIGNMENTS[reading.level]!;
      const fields = Object.fromEntries(
        spec.fields.map((field) => [field, readYesNo(answers[`same_${field}`] as Parameters<typeof readYesNo>[0], fieldBand)]),
      );
      recordReadings(port, result, { alignment, link: reading, fields });
      return { alignment, reading, fields, decisionId: result.decisionId, recordAction: (action) => recordAction(port, result.decisionId, action) };
    },
    async checkFixtures(port, options = {}) {
      const checks: FixtureCheck[] = [];
      for (const fixture of spec.fixtures) {
        const aligned = await aligner.align(port, fixture.a, fixture.b, { site: 'calibration', ...options });
        checks.push({
          fixture: fixture.name,
          aspect: 'alignment',
          expected: fixture.expect,
          got: aligned.alignment,
          correct: aligned.alignment === fixture.expect,
          signal: aligned.reading.confidence,
          outcome: aligned.reading.outcome,
        });
      }
      return checks;
    },
  };
  return aligner;
}
