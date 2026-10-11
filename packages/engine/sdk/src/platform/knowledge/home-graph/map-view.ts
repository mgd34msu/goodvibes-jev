import { snapshotNodeInput } from '../activation/projection.js';
import { prepareKnowledgeScopeSelection, KnowledgeScopeSelectionHeldError } from '../scope-selection.js';
import { sameKnowledgeRecord } from '../store-record-representation.js';
import type { KnowledgeStore } from '../store.js';
import { renderHomeGraphMap } from './rendering.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
import { renderHomeGraphState } from './state.js';
import type { HomeGraphMapInput, HomeGraphMapResult } from './types.js';

export async function mapHomeGraph(input: HomeGraphMapInput & {
  readonly store: KnowledgeStore;
  readonly assertCurrent?: (() => void) | undefined;
}): Promise<HomeGraphMapResult> {
  const { store, assertCurrent: callerCurrent, ...request } = input;
  const options = snapshotNodeInput(request);
  const requestCurrent = () => {
    const { store: currentStore, assertCurrent: currentOwner, ...current } = input;
    if (currentStore !== store || currentOwner !== callerCurrent || !sameKnowledgeRecord(snapshotNodeInput(current), options)) throw new KnowledgeScopeSelectionHeldError('stale');
    callerCurrent?.();
  };
  requestCurrent();
  await store.init();
  requestCurrent();
  const { spaceId } = resolveReadableHomeGraphSpace(store, options);
  const state = renderHomeGraphState(store, spaceId, 'Home Graph Map');
  const edgeGenerations = new Map<string, string | null>();
  const edgeWindowKeys = [...state.sources.map(source => `source:${source.id}`), ...state.nodes.map(node => `node:${node.id}`)];
  let edgeWindowGeneration: string | undefined;
  store.assertRecordSnapshotFrame(() => {
    edgeWindowGeneration = store.getEdgeWindowGeneration(edgeWindowKeys);
    const physical = new Map(store.getEdgeSnapshots().flatMap(snapshot => snapshot.record ? [[snapshot.record.id, snapshot] as const] : []));
    for (const edge of state.edges) {
      const snapshot = physical.get(edge.id);
      if (!snapshot || !sameKnowledgeRecord(snapshot.record, edge)) throw new KnowledgeScopeSelectionHeldError('stale');
      edgeGenerations.set(edge.id, snapshot.generation);
    }
  });
  if (edgeWindowGeneration === undefined) throw new KnowledgeScopeSelectionHeldError('stale');
  const originalEdgeWindowGeneration = edgeWindowGeneration;
  const assertCurrent = () => {
    requestCurrent();
    for (const source of state.sources) if (!sameKnowledgeRecord(store.getSource(source.id), source)) throw new KnowledgeScopeSelectionHeldError('stale');
    for (const node of state.nodes) if (!sameKnowledgeRecord(store.getNode(node.id), node)) throw new KnowledgeScopeSelectionHeldError('stale');
    for (const issue of state.issues) if (!sameKnowledgeRecord(store.getIssue(issue.id), issue)) throw new KnowledgeScopeSelectionHeldError('stale');
    const edges = new Map(store.listEdges().map(edge => [edge.id, edge]));
    for (const edge of state.edges) if (!sameKnowledgeRecord(edges.get(edge.id), edge)) throw new KnowledgeScopeSelectionHeldError('stale');
    store.assertRecordSnapshotFrame(() => {
      if (store.getEdgeWindowGeneration(edgeWindowKeys) !== originalEdgeWindowGeneration) throw new KnowledgeScopeSelectionHeldError('stale');
      const physical = new Map(store.getEdgeSnapshots().flatMap(snapshot => snapshot.record ? [[snapshot.record.id, snapshot] as const] : []));
      for (const edge of state.edges) {
        const snapshot = physical.get(edge.id);
        if (!snapshot || snapshot.generation !== edgeGenerations.get(edge.id) || !sameKnowledgeRecord(snapshot.record, edge)) throw new KnowledgeScopeSelectionHeldError('stale');
      }
    });
  };
  const selection = await prepareKnowledgeScopeSelection(store, { knowledgeSpaceId: spaceId }, {
    sourceIds: state.sources.map(source => source.id), nodeIds: state.nodes.map(node => node.id), issueIds: state.issues.map(issue => issue.id), assertCurrent,
  });
  const selectedEdgeIds = new Set(selection.edges.map(edge => edge.id));
  const edgesCurrent = selection.retainEdges(state.edges.filter(edge => selectedEdgeIds.has(edge.id)), {
    sourceIds: state.sources.map(source => source.id), nodeIds: state.nodes.map(node => node.id),
  });
  assertCurrent(); selection.assertCurrent(); edgesCurrent();
  const result = renderHomeGraphMap(state, selection, {
    ...options,
    ha: {
      objectKinds: preferNonEmpty(options.ha?.objectKinds, options.objectKinds),
      entityIds: preferNonEmpty(options.ha?.entityIds, options.entityIds),
      deviceIds: preferNonEmpty(options.ha?.deviceIds, options.deviceIds),
      areaIds: preferNonEmpty(options.ha?.areaIds, options.areaIds),
      integrationIds: preferNonEmpty(options.ha?.integrationIds, options.integrationIds),
      integrationDomains: preferNonEmpty(options.ha?.integrationDomains, options.integrationDomains),
      domains: preferNonEmpty(options.ha?.domains, options.domains),
      deviceClasses: preferNonEmpty(options.ha?.deviceClasses, options.deviceClasses),
      labels: preferNonEmpty(options.ha?.labels, options.labels),
    },
    knowledgeSpaceId: spaceId,
  });
  assertCurrent(); selection.assertCurrent(); edgesCurrent();
  return result;
}

function preferNonEmpty<T>(primary: readonly T[] | undefined, fallback: readonly T[] | undefined): readonly T[] | undefined {
  return primary && primary.length > 0 ? primary : fallback;
}
