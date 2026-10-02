/** Generic PR57 storage compatibility; intentionally no legacy planning actions. */
import { KnowledgeStore, type KnowledgeSourceSnapshot, type KnowledgeSourceWriteResult } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { SQLiteStore } from '@goodvibes-jev/engine/sdk/platform/state';
declare const store: KnowledgeStore;
const snapshot: KnowledgeSourceSnapshot = store.getSourceSnapshot({ id: 'source' });
const generation: string | null = store.getSourceGeneration('source');
const result: Promise<KnowledgeSourceWriteResult> = store.upsertSourceIfCurrent({ id: 'source', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' }, generation);
const held: Extract<KnowledgeSourceWriteResult, { kind: 'held' }>['reason'] = 'pending-local-changes';
// @ts-expect-error The conditional API requires an explicit generation or absence condition.
store.upsertSourceIfCurrent({ id: 'source', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' });
const coordinated = new SQLiteStore(':memory:', { coordinated: true });
const transaction: Promise<{ readonly kind: 'local-changes' } | { readonly kind: 'completed'; readonly value: number }> = coordinated.transactPersisted(db => ({ changed: false, value: db.exec('SELECT 1').length }), () => {});
export { snapshot, generation, result, held, transaction };
