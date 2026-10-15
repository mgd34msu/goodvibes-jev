/** Receipt-authorized snapshots only: no filesystem discovery, reads, or lexical fallback. */
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { chunkFileContent, sha256, type ChunkingIntelligence } from './code-index-chunking.js';
import { countIndexedChunks, countIndexedFiles, getChunkById, writeChunk, type VectorRow } from './code-index-db.js';
import {
  HASHED_MEMORY_EMBEDDING_PROVIDER, type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderRegistry, type MemoryEmbeddingRequest,
} from './memory-embeddings.js';
import { MEMORY_VECTOR_DIMS } from './memory-vector-store.js';
import type { CodeContextResult, CodeIndexStats } from './code-index-types.js';

export type AuthorizedIndexBoundary = 'chunk' | 'cache' | 'embedding' | 'result';
export interface AuthorizedCodeSnapshot {
  readonly path: string;
  readonly content: string;
  readonly mtimeMs: number;
}
export interface AuthorizedCodePrepareInput {
  readonly snapshots: readonly AuthorizedCodeSnapshot[];
  /** Exact object obtained from this store's registry, not an equivalent provider ID. */
  readonly provider: MemoryEmbeddingProvider;
  readonly signal: AbortSignal;
  /**
   * Must throw if receipt, scope, provider, or run is no longer authorized.
   * path identifies the current snapshot only; undefined requires the whole generation.
   * Every check still validates global receipt/root/generation metadata.
   */
  readonly guard: (boundary: AuthorizedIndexBoundary, path?: string) => Promise<void>;
  readonly maxChunks?: number;
  /** Load one authorized file at a time, avoiding a second copy of the entire tree. */
  readonly loadSnapshot?: (snapshot: AuthorizedCodeSnapshot) => Promise<AuthorizedCodeSnapshot>;
}

export interface AuthorizedCodeIndex {
  search(query: string, options?: { limit?: number }): Promise<CodeContextResult[]>;
  stats(): Promise<CodeIndexStats>;
}

/** Internal implementation; the public entry is the one-shot CodeIndexStore method. */
export async function prepareAuthorizedCodeSnapshots(
  input: AuthorizedCodePrepareInput,
  registry: MemoryEmbeddingProviderRegistry,
  db: Database,
  intelligence: ChunkingIntelligence,
  checkLifecycle: () => void,
): Promise<AuthorizedCodeIndex> {
  const { provider, signal, guard, loadSnapshot } = input;
  const embed = provider.embed;
  const embedSync = provider.embedSync;
  const check = async (boundary: AuthorizedIndexBoundary, path?: string): Promise<void> => {
    signal.throwIfAborted();
    checkLifecycle();
    await guard(boundary, path);
    signal.throwIfAborted();
    checkLifecycle();
    if (registry.getDefaultProviderOrNull() !== provider || registry.get(provider.id) !== provider
      || provider.capturedInputAdmission !== 'per-attempt'
      || provider.id === HASHED_MEMORY_EMBEDDING_PROVIDER.id
      || provider.dimensions !== MEMORY_VECTOR_DIMS || (!embed && !embedSync)
      || provider.embed !== embed || provider.embedSync !== embedSync) {
      throw new Error('Authorized code index requires the unchanged registered semantic provider');
    }
  };
  const maxChunks = input.maxChunks ?? Infinity;
  if (input.maxChunks !== undefined && (!Number.isSafeInteger(maxChunks) || maxChunks < 1)) {
    throw new Error('Authorized code index bounds are invalid');
  }
  // Copy caller-owned containers before the first await. Never retain mutable input views.
  const snapshots = input.snapshots.map(({ path, content, mtimeMs }) => ({ path, content, mtimeMs }));
  const paths = new Set<string>();
  for (const snapshot of snapshots) {
    if (!snapshot.path || snapshot.path.startsWith('/') || snapshot.path.includes('\\')
      || snapshot.path.split('/').some((part) => !part || part === '.' || part === '..')
      || /^[a-z]:/i.test(snapshot.path) || snapshot.path.includes('\0')
      || paths.has(snapshot.path) || !Number.isFinite(snapshot.mtimeMs)) {
      throw new Error('Authorized code snapshot path or metadata is invalid');
    }
    paths.add(snapshot.path);
  }
  await check('cache');
  if (countIndexedChunks(db) !== 0) throw new Error('Authorized code index requires an empty per-run database');
  const embedText = async (text: string, usage: MemoryEmbeddingRequest['usage'], path?: string): Promise<Float32Array> => {
    await check('embedding', path);
    const request: MemoryEmbeddingRequest = { text, dimensions: MEMORY_VECTOR_DIMS, usage, signal, beforeAttempt: () => check('embedding', path) };
    const result = embed
      ? await awaitAbortable(() => embed.call(provider, request), signal)
      : embedSync!.call(provider, request);
    await check('embedding', path);
    if (result.dimensions !== MEMORY_VECTOR_DIMS || result.vector.length !== MEMORY_VECTOR_DIMS
      || Array.from(result.vector).some((value) => !Number.isFinite(value))) {
      throw new Error('Authorized code index received an unsupported embedding vector');
    }
    return new Float32Array(result.vector);
  };
  let chunkCount = 0;
  for (const descriptor of snapshots) {
    const snapshot = loadSnapshot ? await loadSnapshot(descriptor) : descriptor;
    if (snapshot.path !== descriptor.path || snapshot.mtimeMs !== descriptor.mtimeMs) throw new Error('Authorized code snapshot identity changed');
    await check('chunk', snapshot.path);
    const { drafts } = await chunkFileContent({
      intelligence, absPath: snapshot.path, relPath: snapshot.path,
      content: snapshot.content, fileHash: sha256(snapshot.content), mtimeMs: snapshot.mtimeMs,
    });
    await check('chunk', snapshot.path);
    if (chunkCount + drafts.length > maxChunks) {
      throw new Error('Authorized code index chunk budget exceeded');
    }
    chunkCount += drafts.length;
    for (const draft of drafts) {
      const vector = await embedText(draft.embedText, 'record', snapshot.path);
      await check('cache', snapshot.path);
      writeChunk(db, draft.chunk, vector);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  await check('result');
  return {
    async stats() {
      await check('cache');
      const stats: CodeIndexStats = { backend: 'sqlite-vec', enabled: true, available: true, path: ':memory:',
        dimensions: MEMORY_VECTOR_DIMS, indexedFiles: countIndexedFiles(db), indexedChunks: countIndexedChunks(db),
        embeddingProviderId: provider.id, embeddingProviderLabel: provider.label, semanticRetrievalAvailable: true,
        building: false, lastBuild: null };
      await check('result');
      return stats;
    },
    async search(query, options = {}) {
      const limit = options.limit ?? 5;
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error('Authorized code query exceeds bounds');
      }
      await check('result');
      if (!query.trim() || !chunkCount) return [];
      const vector = await embedText(query.trim(), 'query');
      await check('cache');
      const rows = db.query<VectorRow, SQLQueryBindings[]>(
        'SELECT rowid, chunk_id, distance FROM code_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance',
      ).all(vector, limit);
      const results: CodeContextResult[] = [];
      for (const row of rows) {
        await check('cache');
        const chunk = getChunkById(db, row.chunk_id);
        if (!chunk) continue;
        const distance = Number(row.distance);
        results.push({ chunk, distance, similarity: Math.max(0, Math.min(1, 1 - distance / 2)), label: 'semantic' });
      }
      await check('result');
      return results;
    },
  };
}

/** A non-cooperating custom provider may finish late, but cannot keep this run pending or publish its result. */
function awaitAbortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('Authorized code embedding aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      signal.throwIfAborted();
      operation().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    }
  });
}
