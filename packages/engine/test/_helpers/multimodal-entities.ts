import { createHash } from 'node:crypto';
import type { ArtifactDescriptor, ArtifactKind } from '../../sdk/src/platform/artifacts/types.js';
import { MultimodalService } from '../../sdk/src/platform/multimodal/service.js';

export function multimodalFixture(kind: ArtifactKind = 'image', text = 'receipt receipt receipt AI EU') {
  const records = new Map<string, ArtifactDescriptor>();
  const bodies = new Map<string, string>();
  const writes: unknown[] = [], ingests: unknown[] = [], usages: unknown[] = [];
  const add = (id: string, type: ArtifactKind, content = text, metadata: Record<string, unknown> = {}) => {
    const descriptor: ArtifactDescriptor = { id, kind: type, mimeType: type === 'document' ? 'text/plain' : `${type}/test`,
      filename: `${id}.txt`, sizeBytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), createdAt: 1,
      acquisitionMode: 'inline-data', fetchMode: 'not-applicable', metadata };
    records.set(id, descriptor); bodies.set(id, content); return descriptor;
  };
  add('source', kind);
  const artifactStore = {
    get: (id: string) => records.get(id) ?? null,
    delete: (id: string) => records.delete(id),
    readContent: async (id: string) => ({ record: { ...records.get(id)!, contentPath: '', metadataPath: '' }, buffer: Buffer.from(bodies.get(id)!) }),
    create: async (input: unknown, ownership?: { assertCurrent?: () => void }) => { ownership?.assertCurrent?.(); writes.push(input); return add(`write-${writes.length}`, 'document', 'analysis'); },
  };
  const mediaProviders = { status: async () => [], findProvider: () => ({ analyze: async () => ({ providerId: 'fixture-image', text, labels: [], metadata: {} }) }) };
  const voiceService = { getStatus: async () => ({ providers: [] }), transcribe: async () => ({ providerId: 'fixture-audio', text, segments: [{ text }], metadata: {} }) };
  const knowledgeService = { ingestArtifact: async (input: unknown, ownership?: { assertCurrent?: () => void; onCommitted?: (id: string) => void }) => { ownership?.assertCurrent?.(); ingests.push(input); ownership?.onCommitted?.('knowledge'); return { source: { id: 'knowledge' } }; },
    recordUsage: async (input: unknown) => { usages.push(input); } };
  const service = new MultimodalService(artifactStore as never, mediaProviders as never, voiceService as never, knowledgeService as never);
  return { service, records, bodies, writes, ingests, usages, add, artifactStore, mediaProviders, voiceService, knowledgeService };
}
