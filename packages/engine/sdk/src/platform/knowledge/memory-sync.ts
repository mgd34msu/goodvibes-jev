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
  await store.init();
  for (const node of store.iterateNodes()) {
    const memoryId = node.metadata.memoryId;
    if (node.kind !== 'memory' || typeof memoryId !== 'string' || node.id !== `memory-${memoryId}`) continue;
    const current = registry.getStore().get(memoryId);
    if (!current || current.reviewState === 'contradicted') await store.deleteNode(node.id);
  }
  const memoryRecords = registry.getAll().filter((record) => record.reviewState !== 'contradicted');
  for (const record of memoryRecords) {
    await upsertKnowledgeMemoryNode(store, record, () => registry.getStore().get(record.id) ?? undefined);
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

    const wantedTags = new Set(record.tags.map(slugify));
    const wantedSessions = new Set(record.provenance.filter(item => item.kind === 'session').map(item => item.ref));
    for (const edge of store.listEdges()) {
      if (edge.fromKind !== 'node' || edge.fromId !== node.id) continue;
      if ((edge.relation === 'memory_tagged_with' && edge.toKind === 'node' && !wantedTags.has(store.getNode(edge.toId)?.slug ?? ''))
        || (edge.relation === 'derived_from_session' && edge.toKind === 'session' && !wantedSessions.has(edge.toId))) {
        await store.deleteEdge(edge.id);
      }
    }

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
