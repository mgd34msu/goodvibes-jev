import { toJson, type JsonValue } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import { assertKnowledgeExtractionInput } from '../extraction-policy.js';
import { snapshotNodeInput } from '../activation/projection.js';
import { getExplicitKnowledgeSpaceId, getKnowledgeSpaceId, isHomeAssistantKnowledgeSpace } from '../spaces.js';
import type { KnowledgeStore } from '../store.js';
import { KnowledgeSourceQualityHeldError } from '../source-quality.js';
import { prepareAnswerLinkedObjects } from '../semantic/answer-object-alignment/prepare.js';
import { KnowledgeAnswerObjectAlignmentHeldError } from '../semantic/answer-object-alignment/types.js';
import { prepareAnswerEvidenceRelevance, KnowledgeEvidenceRelevanceHeldError,
  type AnswerEvidenceCandidate } from '../semantic/evidence-ranking/reader.js';
import { captureAnswerReadingPorts } from '../semantic/answer-reading-ports.js';
import { createSemanticWriteGuard } from '../semantic/primary-source-plan.js';
import { withAnswerVerificationBudget } from '../semantic/answer-verification/budget.js';
import { KnowledgeAnswerQualityHeldError } from '../semantic/answer-verification/types.js';
import { HOME_GRAPH_KNOWLEDGE_EXTENSION } from './extension.js';
import { readHomeGraphSearchState, type HomeGraphSearchState } from './search.js';
import type { HomeGraphAskInput, HomeGraphSearchResult } from './types.js';

/** Read-only scope for the literal Home Graph renderer. Upstream search ranking,
 * candidate/excerpt windows and extraction repair are separate, retained policy.
 */
export async function prepareHomeGraphAnswerScope(input: {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly query: HomeGraphAskInput;
  readonly results: readonly HomeGraphSearchResult[];
  readonly state: HomeGraphSearchState;
}) {
  try {
    return await withAnswerVerificationBudget(async (signal, deadlineAt) => {
      const guard = createSemanticWriteGuard(input.store, signal);
      const checkPorts = captureAnswerReadingPorts(['engine.knowledge.answer-integration-intent',
        'engine.knowledge.answer-object-alignment', 'engine.knowledge.answer-evidence-relevance']);
      guard.watch('home-graph-question', () => input.query, snapshotNodeInput(input.query));
      guard.watch('home-graph-results', () => input.results, snapshotNodeInput(input.results));
      if (input.state.spaceId !== input.spaceId) throw new KnowledgeAnswerQualityHeldError('malformed');
      guard.watch('home-graph-retrieval-context', () => {
        const state = readHomeGraphSearchState(input.store, input.spaceId);
        return { sources: state.sources, nodes: state.nodes, edges: state.edges };
      }, { sources: input.state.sources, nodes: input.state.nodes, edges: input.state.edges });
      const objects = prepareAnswerLinkedObjects(input.store, input.spaceId,
        { query: input.query.query }, HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles ?? [], signal);
      // Guard the exact retrieval/extraction lineage and protect full original
      // selected fields before using the existing bounded display excerpt. This
      // does not concatenate every manual in the space into a new request.
      const admitted = new Set([...input.state.sources.map((source) => `source:${source.id}`),
        ...input.state.nodes.map((node) => `node:${node.id}`)]);
      const seen = new Set<string>();
      const candidates: AnswerEvidenceCandidate[] = input.results.map((result, index) => {
        const key = `${result.kind}:${result.id}`;
        if (!admitted.has(key) || seen.has(key)) throw new KnowledgeAnswerQualityHeldError('malformed');
        seen.add(key);
        const record = result.kind === 'source' ? result.source : result.node;
        const actualSpace = getExplicitKnowledgeSpaceId(record);
        if (!record || record.id !== result.id || (result.kind === 'source' ? result.node : result.source)
          || (actualSpace !== input.spaceId && !(input.spaceId === 'homeassistant' && actualSpace && isHomeAssistantKnowledgeSpace(actualSpace)))) {
          throw new KnowledgeAnswerQualityHeldError('malformed');
        }
        if (result.source) {
          guard.watch(`source:${result.id}`, () => input.store.getSource(result.id), result.source);
          assertJudgmentInput({ title: result.source.title, summary: result.source.summary, description: result.source.description });
          // Search consumed the captured row, not whichever extraction happens
          // to be current after its asynchronous readability work completed.
          const extraction = input.state.extractionBySourceId.get(result.id) ?? null;
          guard.watch(`extraction:${result.id}`, () => input.store.getExtractionBySourceId(result.id), extraction);
          if (extraction && (extraction.sourceId !== result.id || getKnowledgeSpaceId(extraction) !== getKnowledgeSpaceId(result.source))) {
            throw new KnowledgeAnswerQualityHeldError('malformed');
          }
          assertKnowledgeExtractionInput(extraction);
        }
        if (result.node) guard.watch(`node:${result.id}`, () => input.store.getNode(result.id), result.node);
        const row = snapshotNodeInput(result);
        return { reference: `candidate-${index + 1}`, kind: row.kind,
          title: row.source?.title ?? row.node?.title ?? '',
          text: [row.summary, row.excerpt, row.source?.description].filter((part): part is string => typeof part === 'string').join('\n'),
          ...(row.source ? { sourceType: row.source.sourceType } : {}),
          ...(row.node ? { nodeKind: row.node.kind } : {}),
        };
      });
      assertJudgmentInput({ query: input.query.query, candidates });
      const check = () => { guard.assertCurrent(); objects.assertCurrent(); checkPorts(); };
      check();
      const { linkedObjects } = await objects.read([], []);
      check();
      const subjects = linkedObjects.map((node) => ({ title: node.title, kind: node.kind, summary: node.summary,
        aliases: node.aliases, identity: subjectIdentity(node.metadata) }));
      const plan = await prepareAnswerEvidenceRelevance({ query: input.query.query, candidates, subjects },
        { signal, timeoutMs: Math.max(1, deadlineAt - Date.now()) });
      check();
      const selected = new Set(plan.accepted.map((reading) => reading.reference));
      // A settled rejection remains rejected. This scope pass changes membership,
      // not the existing retrieval score units or order; no reading is confidence.
      return { results: input.results.filter((_result, index) => selected.has(`candidate-${index + 1}`)), linkedObjects };
    }, input.query.timeoutMs);
  } catch (error) {
    if (error instanceof JudgmentInputError || error instanceof KnowledgeAnswerQualityHeldError) throw error;
    if (error instanceof KnowledgeAnswerObjectAlignmentHeldError) throw new KnowledgeAnswerQualityHeldError(
      error.reason === 'unconfigured' ? 'unavailable' : error.reason);
    if (error instanceof KnowledgeEvidenceRelevanceHeldError) throw new KnowledgeAnswerQualityHeldError(
      error.reason === 'unsettled' ? 'uncertain' : error.reason === 'unconfigured' ? 'unavailable' : error.reason);
    if (error instanceof KnowledgeSourceQualityHeldError) throw new KnowledgeAnswerQualityHeldError(
      error.reason === 'aborted' ? 'aborted' : 'stale');
    throw new KnowledgeAnswerQualityHeldError('unavailable');
  }
}

function subjectIdentity(metadata: Readonly<Record<string, unknown>>): Readonly<Record<string, JsonValue>> {
  const fields = Object.fromEntries(['manufacturer', 'brand', 'vendor', 'model', 'modelNumber', 'variant', 'entityKind', 'subject', 'homeAssistant']
    .filter((key) => metadata[key] !== undefined).map((key) => [key, metadata[key]]));
  assertJudgmentInput(fields);
  const value = toJson(fields);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KnowledgeAnswerQualityHeldError('malformed');
  return value;
}
