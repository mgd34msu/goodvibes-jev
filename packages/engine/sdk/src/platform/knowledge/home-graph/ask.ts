import { withKnowledgeSourceAnswerAliases } from '../source-structural-references.js';
import type { KnowledgeSemanticService } from '../semantic/index.js';
import { logger } from '../../utils/logger.js';
import { scheduleBackground } from '../cooperative.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeSourceRecord } from '../types.js';
import { collectLinkedObjects, renderAskAnswer } from './state.js';
import type { HomeGraphAskInput, HomeGraphAskResult, HomeGraphSearchResult } from './types.js';
import type { HomeGraphSearchState } from './search.js';
import { prepareHomeGraphAnswerScope } from './answer-scope.js';

export async function answerHomeGraphQuery(input: {
  readonly store: KnowledgeStore;
  readonly semanticService?: KnowledgeSemanticService | undefined;
  readonly spaceId: string;
  readonly query: HomeGraphAskInput;
  readonly state: HomeGraphSearchState;
  readonly results: readonly HomeGraphSearchResult[];
}): Promise<HomeGraphAskResult> {
  return answerHomeGraphQueryOnce(input);
}

async function answerHomeGraphQueryOnce(input: {
  readonly store: KnowledgeStore;
  readonly semanticService?: KnowledgeSemanticService | undefined;
  readonly spaceId: string;
  readonly query: HomeGraphAskInput;
  readonly state: HomeGraphSearchState;
  readonly results: readonly HomeGraphSearchResult[];
}): Promise<HomeGraphAskResult> {
  // The configured semantic service already owns typed alignment and source
  // selection. Do not pre-empt it with another anchor guess or duplicate read.
  const scoped = input.semanticService ? undefined : await prepareHomeGraphAnswerScope(input);
  const results = scoped?.results ?? input.results;
  const sources = results.flatMap((result) => result.source ? [result.source] : []).map(withAnswerSourceAliases);
  const linkedObjects = scoped?.linkedObjects ?? collectLinkedObjects(results, input.state);
  if (input.semanticService) {
    const answer = await input.semanticService.answer({
      query: input.query.query,
      knowledgeSpaceId: input.spaceId,
      mode: input.query.mode ?? 'standard',
      limit: input.query.limit ?? 8,
      includeSources: input.query.includeSources,
      includeConfidence: input.query.includeConfidence,
      includeLinkedObjects: input.query.includeLinkedObjects,
      candidateSourceIds: sources.map((source) => source.id),
      candidateNodeIds: results.flatMap((result) => result.node ? [result.node.id] : []),
      strictCandidates: true,
      linkedObjects,
      noMatchMessage: `No Home Graph knowledge matched "${input.query.query}".`,
      autoRepairGaps: true,
      timeoutMs: input.query.timeoutMs,
    });
    const selectedSources = uniqueSources(answer.results.flatMap((result) => result.source ? [result.source] : []));
    scheduleBackground(() => {
      // Governor backpressure: skip the post-answer enrichment tail while
      // background knowledge work is paused for memory pressure.
      if (input.semanticService?.isBackgroundWorkPaused()) return;
      void input.semanticService?.enrichSources(selectedSources, {
        knowledgeSpaceId: input.spaceId,
        limit: Math.min(3, Math.max(1, selectedSources.length)),
      }).catch((error: unknown) => {
        logger.warn('Home Graph post-answer enrichment failed', {
          spaceId: input.spaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    return {
      ok: true,
      spaceId: input.spaceId,
      query: input.query.query,
      answer: {
        text: answer.answer.text,
        mode: answer.answer.mode,
        confidence: answer.answer.confidence,
        sources: answer.answer.sources,
        linkedObjects: answer.answer.linkedObjects,
        facts: answer.answer.facts,
        gaps: answer.answer.gaps,
        refinementTaskIds: answer.answer.refinementTaskIds,
        refinement: answer.answer.refinement,
        synthesized: answer.answer.synthesized,
      },
      results: answer.results.map((result) => ({ ...result,
        title: result.source?.title ?? result.node?.title ?? result.id,
        summary: result.source?.summary ?? result.node?.summary,
      })),
    };
  }
  // Retrieval points and relevance probabilities do not establish fidelity.
  const confidence = 0;
  return {
    ok: true,
    spaceId: input.spaceId,
    query: input.query.query,
    answer: {
      text: renderAskAnswer(input.query.query, results, input.query.mode ?? 'standard'),
      mode: input.query.mode ?? 'standard',
      confidence,
      sources: input.query.includeSources === false ? [] : sources,
      linkedObjects: input.query.includeLinkedObjects === false ? [] : linkedObjects,
    },
    results,
  };
}

function uniqueSources(sources: readonly KnowledgeSourceRecord[]): KnowledgeSourceRecord[] {
  const seen = new Set<string>();
  const out: KnowledgeSourceRecord[] = [];
  for (const source of sources) {
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    out.push(source);
  }
  return out;
}

function withAnswerSourceAliases(source: KnowledgeSourceRecord): KnowledgeSourceRecord {
  return withKnowledgeSourceAnswerAliases(source);
}
