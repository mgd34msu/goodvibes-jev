import { isDeepStrictEqual } from 'node:util';
import type { Question } from '@goodvibes-jev/judgment';
import { captureStrictJudgmentJson } from '../../sdk/src/platform/gate/judgment-result.js';
import type { KnowledgeNodeRecord } from '../../sdk/src/platform/knowledge/types.js';
import { repairProfileRequirement } from '../../sdk/src/platform/knowledge/semantic/repair-profile-requirement/battery.js';
import { subjectTitle } from '../../sdk/src/platform/knowledge/semantic/self-improvement-graph.js';
import { selfImprovementGapContext, selfImprovementEvidenceCoverage } from '../../sdk/src/platform/knowledge/semantic/self-improvement-assessment/battery.js';

export interface SelfImprovementFixtureValues {
  readonly query: string;
  readonly subjects: readonly string[];
  readonly fullProfileRequired?: number;
  readonly context?: readonly [applicable: number, concrete: number];
  readonly coverage?: readonly { readonly facts: readonly string[]; readonly probability: number }[];
}
export function gapAssessmentFixture(gap: Pick<KnowledgeNodeRecord, 'title' | 'summary'>,
  subjects: readonly Pick<KnowledgeNodeRecord, 'title'>[], applicable: number, concrete: number,
  coverage?: SelfImprovementFixtureValues['coverage'], fullProfileRequired?: number): SelfImprovementFixtureValues {
  return { query: [gap.title, gap.summary].filter(Boolean).join('\n\n'), subjects: subjects.map(subject => subject.title),
    context: [applicable, concrete], ...(coverage ? { coverage } : {}), ...(fullProfileRequired === undefined ? {} : { fullProfileRequired }) };
}
export function intrinsicAssessmentFixture(subject: KnowledgeNodeRecord,
  coverage: NonNullable<SelfImprovementFixtureValues['coverage']>): SelfImprovementFixtureValues {
  return { query: `What are the complete features and specifications for ${subjectTitle(subject)}?`,
    subjects: [subject.title], context: [0.99, 0.99], fullProfileRequired: 0.99, coverage };
}
/** Finite authored outcomes keyed by the exact question, query and ordered subject/fact vectors. */
export function selfImprovementFixtureReading(name: string, question: Question, state: unknown,
  values: readonly SelfImprovementFixtureValues[] = []): number | undefined {
  const sameQuestion = (expected: Question) => isDeepStrictEqual(captureStrictJudgmentJson(question), captureStrictJudgmentJson(expected));
  const contextQuestion = name === 'gapApplicable' && sameQuestion(selfImprovementGapContext.items.gapApplicable.question)
    || name === 'repairContextConcrete' && sameQuestion(selfImprovementGapContext.items.repairContextConcrete.question);
  const coverageQuestion = name === 'repairEvidenceSufficient' && sameQuestion(selfImprovementEvidenceCoverage.items.repairEvidenceSufficient.question);
  const requirementQuestion = name === 'fullProfileRequired' && sameQuestion(repairProfileRequirement.items.fullProfileRequired.question);
  if (!contextQuestion && !coverageQuestion && !requirementQuestion) {
    if (['gapApplicable', 'repairContextConcrete', 'repairEvidenceSufficient', 'fullProfileRequired'].includes(name)) throw new Error('Unscripted assessment fixture question');
    return undefined;
  }
  const input = state as { query?: unknown; subjects?: readonly { title?: unknown }[]; facts?: readonly { title?: unknown }[] };
  if (typeof input.query !== 'string' || !Array.isArray(input.subjects) || !requirementQuestion && !Array.isArray(input.facts)) throw new Error('Malformed assessment fixture');
  const titles = input.subjects.map(subject => subject.title);
  const same = (expected: readonly string[], actual: readonly unknown[]) => expected.length === actual.length
    && expected.every((title, index) => title === actual[index]);
  for (const fixture of values) {
    if (fixture.query !== input.query || !same(fixture.subjects, titles)) continue;
    if (requirementQuestion && name === 'fullProfileRequired' && fixture.fullProfileRequired !== undefined) return fixture.fullProfileRequired;
    if (contextQuestion && input.facts!.length === 0 && fixture.context) {
      if (name === 'gapApplicable') return fixture.context[0];
      if (name === 'repairContextConcrete') return fixture.context[1];
    }
    if (coverageQuestion && name === 'repairEvidenceSufficient') {
      const factTitles = input.facts!.map(fact => fact.title);
      const authored = fixture.coverage?.find(sample => same(sample.facts, factTitles));
      if (authored) return authored.probability;
    }
  }
  throw new Error('Unscripted self-improvement assessment');
}

/** Authored complete profile outcomes for the existing four-span semantic repair fixture. */
export const semanticRepairAssessmentCoverage: NonNullable<SelfImprovementFixtureValues['coverage']> = [
  { facts: [], probability: 0.01 },
  { facts: ['Display and picture specifications', 'Input and output ports', 'Smart TV platform and integrations', 'Network and wireless capabilities'], probability: 0.99 },
  { facts: ['Network and wireless capabilities', 'Smart TV platform and integrations', 'Input and output ports', 'Display and picture specifications'], probability: 0.99 },
];

/** Original answer-gap reasons are exact authored fixture contexts, not keyword inference. */
export function answerGapAssessmentFixtures(queries: readonly string[], subjects: readonly Pick<KnowledgeNodeRecord, 'title'>[], fullProfileRequired: number): readonly SelfImprovementFixtureValues[] {
  return queries.flatMap(query => ['Matching sources have no extracted evidence available for verification.',
    'Verified evidence does not establish every requested detail consistently.', 'No indexed evidence matched the question.'].map(summary =>
    gapAssessmentFixture({ title: query, summary }, subjects, 0.99, 0.99,
      semanticRepairAssessmentCoverage, fullProfileRequired)));
}
