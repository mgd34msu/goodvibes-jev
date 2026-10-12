import { isDeepStrictEqual } from 'node:util';
import type { Question } from '@goodvibes-jev/judgment';
import { captureStrictJudgmentJson } from '../../sdk/src/platform/gate/judgment-result.js';
import { sourceRankingContent } from '../../sdk/src/platform/knowledge/semantic/answer-source-ranking.js';
import { knowledgeExtractionValue } from '../../sdk/src/platform/knowledge/semantic/extraction-value/battery.js';
import type { KnowledgeExtractionValueInput } from '../../sdk/src/platform/knowledge/semantic/extraction-value/types.js';
import { sourceSemanticText } from '../../sdk/src/platform/knowledge/semantic/utils.js';
import { knowledgeSourceJudgmentUris } from '../../sdk/src/platform/knowledge/source-structural-references.js';
import type { KnowledgeSourceRecord, KnowledgeExtractionRecord } from '../../sdk/src/platform/knowledge/types.js';

export type ExtractionValueFixtures = ReadonlyArray<readonly [input: KnowledgeExtractionValueInput, probability: number]>;
const canonicalQuestion = captureStrictJudgmentJson(knowledgeExtractionValue.items.extractionValue.question);

/** Independently authored outcome, with the complete native transport input detached at registration. */
export function extractionValueFixtureFor(source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord | null, probability: number): ExtractionValueFixtures[number] {
  if (!extraction) throw new Error('Missing authored extraction-value fixture evidence');
  const input: KnowledgeExtractionValueInput = {
    source: sourceRankingContent(source),
    text: sourceSemanticText({ ...source, ...knowledgeSourceJudgmentUris(source) }, extraction),
    extraction: { format: extraction.format, sections: extraction.sections,
      ...(extraction.title !== undefined ? { title: extraction.title } : {}),
      ...(extraction.summary !== undefined ? { summary: extraction.summary } : {}),
      ...(extraction.excerpt !== undefined ? { excerpt: extraction.excerpt } : {}) },
  };
  const fixture: ExtractionValueFixtures[number] = [captureStrictJudgmentJson(input), probability];
  return Object.freeze(fixture);
}

/** Exact registered purpose and complete input equality; every unlisted request fails. */
export function extractionValueFixtureReading(name: string, question: Question, state: unknown, fixtures: ExtractionValueFixtures = []): number | undefined {
  const canonical = canonicalQuestion;
  if (name !== 'extractionValue' && (question.type !== 'noul' || question.instructions !== canonical.instructions)) return undefined;
  if (name !== 'extractionValue' || !isDeepStrictEqual(captureStrictJudgmentJson(question), canonical)) {
    throw new Error('Unscripted extraction-value fixture purpose');
  }
  const input = captureStrictJudgmentJson(state);
  const fixture = fixtures.find(([expected]) => isDeepStrictEqual(captureStrictJudgmentJson(expected), input));
  if (!fixture) throw new Error('Unscripted complete extraction-value fixture input');
  return fixture[1];
}
