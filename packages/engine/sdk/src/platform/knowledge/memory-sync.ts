import { upsertObservedKnowledgeNode } from './store-node-observation.js';
import type { MemoryRecord, MemoryRegistry } from '../state/index.js';
import { DEFAULT_KNOWLEDGE_SPACE_ID, knowledgeSpaceMetadata } from './spaces.js';
import type { KnowledgeStore } from './store.js';
import { slugify } from './shared.js';

export async function syncKnowledgeMemoryNodes(
  store: KnowledgeStore,
  registry: Pick<MemoryRegistry, 'getAll' | 'getStore'>,
): Promise<void> {
  await registry.getStore().init();
  const memoryRecords = registry.getAll().filter((record) => record.reviewState !== 'contradicted');
  for (const record of memoryRecords) {
    await upsertKnowledgeMemoryNode(store, record, () => registry.getAll().find((current) => current.id === record.id));
  }
}

async function upsertKnowledgeMemoryNode(store: KnowledgeStore, record: MemoryRecord, readCurrent: () => MemoryRecord | undefined): Promise<void> {
  await store.batch(async () => {
    const node = await upsertObservedKnowledgeNode(store, {
      id: `memory-${record.id}`,
      kind: 'memory',
      slug: slugify(record.id),
      title: record.summary,
      summary: record.detail ?? record.summary,
      aliases: record.tags,
      status: record.reviewState === 'stale' ? 'stale' : 'active',
      confidence: record.confidence,
      metadata: {
        ...knowledgeSpaceMetadata(DEFAULT_KNOWLEDGE_SPACE_ID),
        memoryId: record.id,
        scope: record.scope,
        cls: record.cls,
        reviewState: record.reviewState,
      },
    }, 'memory-mirror', record, readCurrent);

    for (const tag of record.tags) {
      const topicNode = await upsertObservedKnowledgeNode(store, {
        kind: 'topic',
        slug: slugify(tag),
        title: tag,
        summary: `Topic tag ${tag}.`,
        aliases: [tag],
        metadata: knowledgeSpaceMetadata(DEFAULT_KNOWLEDGE_SPACE_ID, { tag }),
      }, 'catalog-structure', record, readCurrent);
      await store.upsertEdge({
        fromKind: 'node',
        fromId: node.id,
        toKind: 'node',
        toId: topicNode.id,
        relation: 'memory_tagged_with',
      });
    }

    for (const provenance of record.provenance) {
      if (provenance.kind !== 'session') continue;
      await store.upsertEdge({
        fromKind: 'node',
        fromId: node.id,
        toKind: 'session',
        toId: provenance.ref,
        relation: 'derived_from_session',
      });
    }
  });
}
