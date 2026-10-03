import {
  KnowledgeStore,
  ProjectPlanningService,
  type ProjectPlanningRevision,
  type ProjectPlanningStateActionInput,
  type ProjectPlanningStateActionResult,
  type KnowledgeSourceWriteResult,
} from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { SQLiteStore } from '@goodvibes-jev/engine/sdk/platform/state';

declare const store: KnowledgeStore;
declare const service: ProjectPlanningService;
declare const revision: ProjectPlanningRevision;
const selected: ProjectPlanningStateActionInput = {
  projectId: 'fixture', expected: { kind: 'revision', revision }, action: { kind: 'approve' },
};
const result: Promise<ProjectPlanningStateActionResult> = service.applyStateAction(selected);
const manual: Promise<ProjectPlanningStateActionResult> = service.applyStateAction({
  projectId: 'fixture', expected: { kind: 'current' }, action: { kind: 'answer', questionId: 'question', answer: 'Operator answer' },
});
const sourceHold: Extract<KnowledgeSourceWriteResult, { kind: 'held' }>['reason'] = 'pending-local-changes';
const planningHold: Extract<ProjectPlanningStateActionResult, { applied: false }>['reason'] = 'pending-local-changes';
const currentGeneration: string | null = store.getSourceGeneration('fixture');
// @ts-expect-error A selected producer cannot omit the captured precondition.
service.applyStateAction({ projectId: 'fixture', action: { kind: 'approve' } });
// @ts-expect-error A revision binding is readonly to its consumer.
revision.generation = 'different';

const legacyStore = new SQLiteStore(':memory:');
const coordinatedStore = new SQLiteStore(':memory:', { coordinated: true });
const transaction = coordinatedStore.transactPersisted(db => {
  const values = db.exec('SELECT 1');
  return { changed: false, value: values.length };
}, () => {});
const transactionResult: Promise<{ readonly kind: 'local-changes' } | { readonly kind: 'completed'; readonly value: number }> = transaction;

export { result, manual, sourceHold, planningHold, currentGeneration, legacyStore, transactionResult };
