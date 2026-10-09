import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord, KnowledgeRefinementTaskRecord } from '../types.js';

export class KnowledgeRepairFailureWriteStaleError extends Error {
  constructor() { super('Repair failure disposition no longer owns the current records.'); }
}

/** One disposition owns exact records, not just a reusable gap/task ID. */
export function captureRepairFailureWrites(store: KnowledgeStore, gap: KnowledgeNodeRecord,
  task: KnowledgeRefinementTaskRecord, isOwnerCurrent: () => boolean) {
  let expectedGap = JSON.stringify(gap), expectedTask = JSON.stringify(task);
  const issues = () => JSON.stringify(store.listIssues(Number.MAX_SAFE_INTEGER)
    .filter((issue) => issue.nodeId === gap.id).sort((a, b) => a.id.localeCompare(b.id)));
  const expectedIssues = issues();
  const isCurrent = () => isOwnerCurrent()
    && JSON.stringify(store.getNode(gap.id)) === expectedGap
    && JSON.stringify(store.getRefinementTask(task.id)) === expectedTask
    && issues() === expectedIssues;
  return {
    isCurrent,
    assertCurrent() { if (!isCurrent()) throw new KnowledgeRepairFailureWriteStaleError(); },
    // Only the exact record returned by our own commit can advance authority.
    // Never adopt a live store reread after save() yields to a competing writer.
    acceptGap(record: KnowledgeNodeRecord) { expectedGap = JSON.stringify(record); },
    acceptTask(record: KnowledgeRefinementTaskRecord) { expectedTask = JSON.stringify(record); },
  };
}
