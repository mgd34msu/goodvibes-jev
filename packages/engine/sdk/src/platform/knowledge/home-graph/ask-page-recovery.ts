import { captureJudgmentPort, JudgmentPortMissingError, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import type { KnowledgeSourceRecord } from '../types.js';
import { KnowledgeFactReadSetStaleError } from '../semantic/fact-quality.js';
import type { KnowledgeStore } from '../store.js';
import { KnowledgeRepairFactUsefulnessHeldError as Held } from '../semantic/repair-usefulness/types.js';
import { isGeneratedKnowledgeSource } from '../generated-projections.js';

/** One fresh reading after real fact churn, never a replacement authorization. */
export function createAskPageRecovery(store: KnowledgeStore, spaceId: string, assertRequest: () => void, signal?: AbortSignal) {
  let owner: JudgmentPortCapture | undefined;
  try { owner = captureJudgmentPort('engine.knowledge.page-fact-quality', { signal }); }
  catch (error) { if (!(error instanceof JudgmentPortMissingError)) throw error; }
  const subjects = store.listNodesInSpace(spaceId).filter((node) => node.kind === 'ha_device' || node.kind === 'ha_entity').map((node) => ({ node, version: JSON.stringify(node) }));
  const rows = store.listSourcesInSpace(spaceId).filter((source) => !isGeneratedKnowledgeSource(source)).map((source) => {
    const extraction = store.getExtractionBySourceId(source.id);
    return { source, extraction, extractionVersion: JSON.stringify(extraction), version: JSON.stringify([source, extraction]) };
  });
  const devicesAndSourcesCurrent = (exceptSourceId?: string) => {
    if (signal?.aborted) throw new Held('aborted');
    assertRequest();
    try { owner?.assertCurrent(); } catch { throw new Held('stale'); }
    for (const { node, version } of subjects) if (store.getNode(node.id) !== node || JSON.stringify(store.getNode(node.id)) !== version) throw new Held('stale');
    for (const { source, extraction, version } of rows) {
      if (source.id === exceptSourceId) continue;
      const current = store.getSource(source.id), currentExtraction = store.getExtractionBySourceId(source.id);
      if (current !== source || currentExtraction !== extraction || JSON.stringify([current, currentExtraction]) !== version) throw new Held('stale');
    }
  };
  const facts = () => store.listNodesInSpace(spaceId).filter((node) => node.kind === 'fact' || node.metadata.semanticKind === 'fact');
  return {
    assertCurrent: () => devicesAndSourcesCurrent(),
    acknowledgeSourceWritten(source: KnowledgeSourceRecord) {
      devicesAndSourcesCurrent(source.id);
      if (store.getSource(source.id) !== source) throw new Held('stale');
      const row = rows.find((candidate) => candidate.source.id === source.id);
      const extraction = store.getExtractionBySourceId(source.id);
      if (row && (extraction !== row.extraction || JSON.stringify(extraction) !== row.extractionVersion)) throw new Held('stale');
      const next = { source, extraction, extractionVersion: JSON.stringify(extraction), version: JSON.stringify([source, extraction]) };
      if (row) Object.assign(row, next); else rows.push(next);
      devicesAndSourcesCurrent();
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      devicesAndSourcesCurrent();
      const previous = new Map(facts().map((fact) => [fact.id, { fact, version: JSON.stringify(fact) }]));
      const edges = store.listEdges();
      try { const value = await operation(); devicesAndSourcesCurrent(); return value; }
      catch (error) {
        if (!(error instanceof KnowledgeFactReadSetStaleError) || !owner) throw error;
        devicesAndSourcesCurrent();
        const old = previous.get(error.factId), current = store.getNode(error.factId);
        const relevant = (edge: (typeof edges)[number]) => (edge.relation === 'supports_fact' && edge.toId === error.factId)
          || (edge.relation === 'describes' && edge.fromId === error.factId);
        const oldEdges = edges.filter(relevant), currentEdges = store.listEdges().filter(relevant);
        const factChanged = current !== old?.fact || JSON.stringify(current) !== old?.version;
        const edgesChanged = oldEdges.length !== currentEdges.length || oldEdges.some((edge, index) => edge !== currentEdges[index]);
        if (!factChanged && !edgesChanged) throw error;
        // The second operation owns an entirely new data read-set and judgments.
        // Its failure escapes; it cannot become an unbounded retry loop.
        const value = await operation(); devicesAndSourcesCurrent(); return value;
      }
    },
  };
}
