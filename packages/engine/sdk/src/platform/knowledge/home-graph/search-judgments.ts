import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import { snapshotNodeInput } from '../activation/projection.js';
import { assertKnowledgeExtractionInput } from '../extraction-policy.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { knowledgeSourceJudgmentUris } from '../source-structural-references.js';
import { KnowledgeSourceQualityHeldError } from '../source-quality.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord } from '../types.js';
import { factHasUsableSource, factSourceIds, initialEvidenceCandidate, initialNodeReferenceContext, listAnswerNodes } from '../semantic/answer-evidence.js';
import { renderNodeEvidence } from '../semantic/answer-fact-selection.js';
import { prepareAnswerSourceExcerptBatches } from '../semantic/answer-excerpts/prepare.js';
import { KnowledgeAnswerExcerptHeldError } from '../semantic/answer-excerpts/types.js';
import { prepareAnswerLinkedObjects } from '../semantic/answer-object-alignment/prepare.js';
import { KnowledgeAnswerObjectAlignmentHeldError } from '../semantic/answer-object-alignment/types.js';
import { captureAnswerReadingPorts } from '../semantic/answer-reading-ports.js';
import { withAnswerVerificationBudget, assertAnswerVerificationActive } from '../semantic/answer-verification/budget.js';
import { KnowledgeAnswerQualityHeldError as Held } from '../semantic/answer-verification/types.js';
import { prepareAnswerEvidenceRelevanceBatches } from '../semantic/evidence-ranking/batch.js';
import { KnowledgeEvidenceRelevanceHeldError, type AnswerEvidenceCandidate } from '../semantic/evidence-ranking/types.js';
import { createSemanticWriteGuard } from '../semantic/primary-source-plan.js';
import { sourceSemanticText } from '../semantic/utils.js';
import { subjectIdentity } from './answer-scope.js';
import { buildSourceLinkIndex } from './source-links.js';
import { sourceLinkedObjectIds } from './state.js';
import { HOME_GRAPH_KNOWLEDGE_EXTENSION } from './extension.js';
import { readHomeGraphSearchState, type HomeGraphSearchState } from './search.js';
import type { HomeGraphAskInput, HomeGraphSearchResult } from './types.js';

interface HomeGraphSearchSelection {
  readonly results: readonly HomeGraphSearchResult[];
  readonly linkedObjects: readonly KnowledgeNodeRecord[];
  readonly acceptedFactIds: readonly string[];
  readonly candidateSourceIds: readonly string[];
  /** Read-set/configuration guard survives the completed reading budget. */
  readonly assertCurrent: () => void;
  readonly assertRenewalAllowed: () => void;
}

const selections = new WeakMap<readonly HomeGraphSearchResult[], {
  readonly selection: HomeGraphSearchSelection;
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly query: HomeGraphAskInput;
  readonly state: HomeGraphSearchState;
}>();

/** Only an exact completed local result array carries its settled scope. */
export function preparedHomeGraphSearchSelection(input: {
  readonly results: readonly HomeGraphSearchResult[];
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly query: HomeGraphAskInput;
  readonly state: HomeGraphSearchState;
}): HomeGraphSearchSelection | undefined {
  const known = selections.get(input.results);
  if (!known) return undefined;
  if (known.store !== input.store || known.spaceId !== input.spaceId || known.query !== input.query || known.state !== input.state) throw new Held('malformed');
  known.selection.assertCurrent();
  return known.selection;
}

/** Complete candidate discovery, independent of query tokens and producer scores.
 * Original records are protected one at a time before any request. Whole
 * candidates, never clipped document fragments, enter bounded shared readers.
 */
export async function readHomeGraphSearchSelection(input: {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly query: HomeGraphAskInput;
  readonly state: HomeGraphSearchState;
}): Promise<HomeGraphSearchSelection> {
  try {
    return await withAnswerVerificationBudget(async (signal, deadlineAt) => {
      if (input.state.spaceId !== input.spaceId) throw new Held('malformed');
      // Do not retain the completed budget's aborted signal in a later handoff.
      const guard = createSemanticWriteGuard(input.store);
      const originalQuestion = snapshotNodeInput(input.query);
      guard.watch('home-graph-query', () => input.query, originalQuestion);
      const renewalGuard = createSemanticWriteGuard(input.store);
      renewalGuard.watch('home-graph-original-question', () => input.query, originalQuestion);
      guard.watch('home-graph-search-context', () => {
        const state = readHomeGraphSearchState(input.store, input.spaceId);
        return { sources: state.sources, nodes: state.nodes, edges: state.edges };
      }, { sources: input.state.sources, nodes: input.state.nodes, edges: input.state.edges });
      const checkPorts = captureAnswerReadingPorts(['engine.knowledge.answer-evidence-relevance',
        'engine.knowledge.answer-excerpt-selection', 'engine.knowledge.answer-object-alignment',
        'engine.knowledge.answer-integration-intent']);
      guard.watch('home-graph-reading-ports', () => { checkPorts(); return true; });
      const assertCurrent = () => { guard.assertCurrent(); checkPorts(); };
      const check = () => { assertAnswerVerificationActive(signal); assertCurrent(); };
      const items: HomeGraphSearchResult[] = [];
      const candidates: AnswerEvidenceCandidate[] = [];
      for (const source of input.state.sources) {
        const original = snapshotNodeInput(guard.watch(`source:${source.id}`, () => input.store.getSource(source.id), source));
        if (!original) throw new Held('stale');
        const capturedExtraction = input.state.extractionBySourceId.get(source.id) ?? null;
        assertKnowledgeExtractionInput(capturedExtraction);
        const extraction = snapshotNodeInput(capturedExtraction);
        guard.watch(`extraction:${source.id}`, () => input.store.getExtractionBySourceId(source.id), extraction);
        if (extraction && (extraction.sourceId !== source.id || getKnowledgeSpaceId(extraction) !== getKnowledgeSpaceId(source))) throw new Held('malformed');
        assertKnowledgeExtractionInput(extraction);
        const text = sourceSemanticText({ ...original, ...knowledgeSourceJudgmentUris(source) }, extraction);
        const item = { kind: 'source' as const, id: source.id, title: source.title ?? source.sourceUri ?? source.id, score: 0, source };
        const candidate = initialEvidenceCandidate({ ...item, facts: [] }, `candidate-${items.length + 1}`, text, input.store, guard);
        assertJudgmentInput({ query: input.query.query, candidate });
        items.push(item); candidates.push(candidate);
      }
      const usableSourceIds = new Set(input.state.sources.filter((source) => source.status === 'indexed').map((source) => source.id));
      const admittedNodeIds = new Set(listAnswerNodes(input.store, input.spaceId)
        .filter((node) => node.metadata.semanticKind !== 'fact' || factHasUsableSource(node, usableSourceIds)).map((node) => node.id));
      for (const node of input.state.nodes) {
        if (!admittedNodeIds.has(node.id)) continue;
        const original = snapshotNodeInput(guard.watch(`node:${node.id}`, () => input.store.getNode(node.id), node));
        if (!original) throw new Held('stale');
        const text = [renderNodeEvidence(original), JSON.stringify(subjectIdentity(original.metadata)),
          initialNodeReferenceContext(input.store, original, input.spaceId, guard, usableSourceIds)].join('\n');
        const item = { kind: 'node' as const, id: node.id, title: node.title, score: 0, node };
        const candidate = initialEvidenceCandidate({ ...item, facts: node.metadata.semanticKind === 'fact' ? [original] : [] },
          `candidate-${items.length + 1}`, text, input.store, guard);
        assertJudgmentInput({ query: input.query.query, candidate });
        items.push(item); candidates.push(candidate);
      }
      // Complete source/node preflight precedes even the first object-intent read.
      const objects = prepareAnswerLinkedObjects(input.store, input.spaceId, { query: input.query.query },
        HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles ?? [], signal);
      check();
      const { linkedObjects } = await objects.read([], []);
      for (const node of linkedObjects) renewalGuard.watch(`original-subject:${node.id}`, () => input.store.getNode(node.id), node);
      const assertRenewalAllowed = () => { renewalGuard.assertCurrent(); checkPorts(); };
      check(); objects.assertCurrent();
      const subjects = linkedObjects.map((node) => ({ title: node.title, kind: node.kind, summary: node.summary,
        aliases: node.aliases, identity: subjectIdentity(node.metadata) }));
      const relevance = await prepareAnswerEvidenceRelevanceBatches({ query: input.query.query, candidates, subjects },
        { signal, timeoutMs: Math.max(1, deadlineAt - Date.now()), assertCurrent: () => {
          try { check(); objects.assertCurrent(); }
          catch { throw new KnowledgeEvidenceRelevanceHeldError(signal.aborted ? 'aborted' : 'stale'); }
        } });
      check(); objects.assertCurrent();
      const byReference = new Map(candidates.map((candidate, index) => [candidate.reference, items[index]!]));
      const selected = relevance.accepted.slice(0, Math.max(1, input.query.limit ?? 8)).map((reading) => byReference.get(reading.reference)!);
      // The reader's probability orders accepted rows; zero explicitly means no
      // legacy retrieval-point score was computed, never answer confidence.
      const excerpts = prepareAnswerSourceExcerptBatches(input.store, input.query.query,
        selected.flatMap((item) => item.source ? [{ source: item.source, context: JSON.stringify({ subjects }) }] : []), guard, signal);
      excerpts.start();
      check(); objects.assertCurrent();
      const spans = await excerpts.read(new Set(selected.flatMap((item) => item.source ? [item.id] : [])));
      const selectedText = new Map([...spans].map(([id, selection]) => [id, selection.map((span) => span.text).join('\n\n')]));
      check(); objects.assertCurrent();
      const results = selected.map((item) => ({ ...item,
        // A settled empty excerpt is explicit. The literal renderer must not
        // revive an unselected summary or description with its fallback chain.
        excerpt: item.source ? selectedText.get(item.id) ?? '' : renderNodeEvidence(item.node!),
      }));
      guard.watch('home-graph-selected-results', () => results, snapshotNodeInput(results));
      guard.watch('home-graph-selected-objects', () => linkedObjects, snapshotNodeInput(linkedObjects));
      const acceptedFactIds = relevance.accepted.flatMap((reading) => {
        const node = byReference.get(reading.reference)?.node;
        return node?.metadata.semanticKind === 'fact' ? [node.id] : [];
      });
      const neededSources = new Set(selected.flatMap((item) => item.node?.metadata.semanticKind === 'fact' ? factSourceIds(item.node) : []));
      const selectedNodes = new Set(selected.flatMap((item) => item.node ? [item.id] : []));
      const links = buildSourceLinkIndex(input.state.edges, input.state.nodes);
      for (const source of input.state.sources) if ([...(links.get(source.id) ?? []), ...sourceLinkedObjectIds(source)]
        .some((id) => selectedNodes.has(id))) neededSources.add(source.id);
      const candidateSourceIds = [...new Set([...selected.flatMap((item) => item.source ? [item.id] : []),
        ...relevance.accepted.flatMap((reading) => {
          const source = byReference.get(reading.reference)?.source;
          return source && neededSources.has(source.id) ? [source.id] : [];
        })])];
      const selection = { results, linkedObjects, acceptedFactIds: Object.freeze(acceptedFactIds),
        candidateSourceIds: Object.freeze(candidateSourceIds), assertCurrent, assertRenewalAllowed };
      selections.set(results, { selection, store: input.store, spaceId: input.spaceId, query: input.query, state: input.state });
      return selection;
    }, input.query.timeoutMs);
  } catch (error) {
    if (error instanceof JudgmentInputError || error instanceof Held) throw error;
    if (error instanceof KnowledgeAnswerExcerptHeldError || error instanceof KnowledgeEvidenceRelevanceHeldError
      || error instanceof KnowledgeAnswerObjectAlignmentHeldError) throw new Held(
        error.reason === 'unconfigured' ? 'unavailable' : error.reason === 'unsettled' ? 'uncertain' : error.reason);
    if (error instanceof KnowledgeSourceQualityHeldError) throw new Held(error.reason === 'aborted' ? 'aborted' : 'stale');
    throw new Held('unavailable');
  }
}
