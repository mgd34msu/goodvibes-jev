/** Per-run passive code source. Receipt provenance never substitutes for live read policy. */
import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  assertContractInputAuthority, authorizeContractInputPath, contractInputAuthoritySourceRoot, contractInputAuthorityFiles,
  registerContractInputReadAssertion, type ContractInputAuthority,
} from '../contract/input-authority.js';
import { CONTRACT_INPUT_EXCLUSIONS } from '../contract/input-snapshot.js';
import { executePolicyCheck } from '../gate/execute-policy-check.js';
import { rankCodeInjectionSnapshots } from '../state/code-injection-ranking.js';
import { CodeIndexStore } from '../state/code-index-store.js';
import { sha256 } from '../state/code-index-chunking.js';
import { MEMORY_VECTOR_DIMS } from '../state/memory-vector-store.js';
import { HASHED_MEMORY_EMBEDDING_PROVIDER, type MemoryEmbeddingProvider, type MemoryEmbeddingProviderRegistry } from '../state/memory-embeddings.js';
import type { ReadAccessFilter } from '../tools/shared/read-access.js';
import type { TurnCodeIndexSource } from './turn-knowledge-injection.js';

const LIMITS = Object.freeze({ entries: 1024, files: 64, fileBytes: 128 * 1024, bytes: 1024 * 1024, chunks: 128, ms: 15_000 });
const excluded = new Set<string>([...CONTRACT_INPUT_EXCLUSIONS, 'node_modules']);
const fingerprint = (s: BigIntStats): string => `${s.dev}:${s.ino}:${s.mode}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
interface Snapshot { readonly path: string; readonly content: string; readonly mtimeMs: number; readonly fingerprint: string; readonly digest: string }
interface Generation { readonly files: readonly Snapshot[]; readonly directories: ReadonlyMap<string, string>; readonly id: string }

export function createCapturedCodeContext(input: {
  readonly authority: ContractInputAuthority;
  readonly root: string;
  readonly readAccessFilter?: ReadAccessFilter | undefined;
  readonly registry?: MemoryEmbeddingProviderRegistry | undefined;
  readonly signal?: AbortSignal | undefined;
}): TurnCodeIndexSource {
  const { authority, root, readAccessFilter, registry } = input;
  let store: CodeIndexStore | undefined;
  let cachedStats: ReturnType<TurnCodeIndexSource['stats']> | undefined;
  let current: Generation | undefined;
  let assertReadingCurrent: (() => Promise<void>) | undefined;
  let pinnedProvider: MemoryEmbeddingProvider | null = null;
  let operation: AbortController | undefined;
  let disposed = false;
  let sequence = 0;
  let unavailable: string | undefined;
  let deadline = Number.POSITIVE_INFINITY;
  const checkSignal = (): void => { if (Date.now() > deadline) operation?.abort(new Error('captured code operation time budget exceeded')); input.signal?.throwIfAborted(); operation?.signal.throwIfAborted(); if (disposed) throw new Error('captured code context is closed'); };
  const checkProvider = (): void => {
    checkSignal();
    if (!pinnedProvider || registry?.getDefaultProviderOrNull() !== pinnedProvider || pinnedProvider.capturedInputAdmission !== 'per-attempt') throw new Error('captured code embedding provider changed');
  };
  const authorize = async (path: string, signal: AbortSignal): Promise<void> => {
    checkSignal();
    if (path === root) {
      await executePolicyCheck(() => assertContractInputAuthority(authority, root, signal), signal);
      if (!readAccessFilter || !(await executePolicyCheck(() => readAccessFilter(contractInputAuthoritySourceRoot(authority)), signal)) ||
          !(await executePolicyCheck(() => readAccessFilter(root), signal))) throw new Error('captured code root is access-restricted');
      await executePolicyCheck(() => assertContractInputAuthority(authority, root, signal), signal);
    } else await executePolicyCheck(() => authorizeContractInputPath(authority, path, readAccessFilter, signal), signal);
    checkProvider();
  };
  // No async gap between the final alias check and the bounded, no-follow byte open.
  const bytes = (path: string, expected?: string): { content: string; fingerprint: string; mtimeMs: number } => {
    checkProvider();
    if (realpathSync(root) !== root || realpathSync(path) !== path) throw new Error('captured code path is redirected');
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(LIMITS.fileBytes)) throw new Error('captured code file is unsupported or over budget');
    const fp = fingerprint(before);
    if (expected !== undefined && fp !== expected) throw new Error('captured code generation changed');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (fingerprint(fstatSync(fd, { bigint: true })) !== fp) throw new Error('captured code file changed before open');
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let offset = 0;
      while (offset < buffer.length) { checkSignal(); const count = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count; }
      if (offset !== Number(before.size) || fingerprint(fstatSync(fd, { bigint: true })) !== fp || fingerprint(lstatSync(path, { bigint: true })) !== fp)
        throw new Error('captured code generation changed during read');
      return { content: buffer.subarray(0, offset).toString('utf8'), fingerprint: fp, mtimeMs: Number(before.mtimeMs) };
    } finally { closeSync(fd); }
  };
  const assertGeneration = async (generation: Generation, signal: AbortSignal, onlyPath?: string): Promise<void> => {
    checkProvider();
    await authorize(root, signal);
    for (const [path, fp] of generation.directories) {
      if (fingerprint(lstatSync(path, { bigint: true })) !== fp) throw new Error('captured code directory generation changed');
    }
    for (const file of generation.files) {
      if (onlyPath !== undefined && file.path !== onlyPath) continue;
      const path = join(root, file.path);
      await authorize(path, signal);
      if (sha256(bytes(path, file.fingerprint).content) !== file.digest) throw new Error('captured code content generation changed');
    }
    // Recheck every metadata identity synchronously after the last yielding policy
    // check. Other member writes cannot silently alter an already-checked file.
    for (const [path, fp] of generation.directories) if (fingerprint(lstatSync(path, { bigint: true })) !== fp) throw new Error('captured code directory generation changed');
    for (const file of generation.files) if (fingerprint(lstatSync(join(root, file.path), { bigint: true })) !== file.fingerprint) throw new Error('captured code generation changed');
    checkProvider();
  };
  registerContractInputReadAssertion(authority, async () => {
    if (current && operation && !disposed) { const selected = current; await bounded(signal => assertGeneration(selected, signal)); }
  });
  const watch = (generation: Generation, signal: AbortSignal): (() => Promise<void>) => {
    const owner = operation!;
    let running = false;
    let pending: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      if (running || signal.aborted) return;
      running = true;
      pending = executePolicyCheck(() => assertGeneration(generation, signal), signal)
        .catch((error: unknown) => { owner.abort(error); }).finally(() => { running = false; });
    }, 100);
    timer.unref?.();
    return async () => { clearInterval(timer); await pending; };
  };
  const bounded = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    checkSignal();
    if (!operation) throw new Error('captured code operation is unavailable');
    const owner = operation;
    deadline = Date.now() + LIMITS.ms;
    const signal = input.signal ? AbortSignal.any([input.signal, owner.signal]) : owner.signal;
    const timer = setTimeout(() => owner.abort(new Error('captured code operation time budget exceeded')), LIMITS.ms);
    timer.unref?.();
    try { return await executePolicyCheck(() => work(signal), signal); }
    finally { clearTimeout(timer); deadline = Number.POSITIVE_INFINITY; }
  };
  const source: TurnCodeIndexSource = {
    async prepare() {
      input.signal?.throwIfAborted();
      if (disposed) throw new Error('captured code context is closed');
      assertReadingCurrent = undefined; current = undefined; cachedStats = undefined; operation?.abort(); store?.close(); store = undefined;
      operation = new AbortController();
      deadline = Date.now() + LIMITS.ms;
      const signal = input.signal ? AbortSignal.any([input.signal, operation.signal]) : operation.signal;
      pinnedProvider = registry?.getDefaultProviderOrNull() ?? null;
      unavailable = undefined;
      if (pinnedProvider && pinnedProvider.id !== HASHED_MEMORY_EMBEDDING_PROVIDER.id && pinnedProvider.capturedInputAdmission !== 'per-attempt') {
        unavailable = 'captured code unavailable: embedding provider lacks per-attempt admission'; deadline = Number.POSITIVE_INFINITY; return;
      }
      if (!registry || !pinnedProvider || pinnedProvider.id === HASHED_MEMORY_EMBEDDING_PROVIDER.id || pinnedProvider.dimensions !== MEMORY_VECTOR_DIMS || (!pinnedProvider.embed && !pinnedProvider.embedSync)) {
        unavailable = 'no semantic embedding provider'; deadline = Number.POSITIVE_INFINITY; return;
      }
      const timer = setTimeout(() => operation?.abort(new Error('captured code preparation time budget exceeded')), LIMITS.ms);
      timer.unref?.();
      const files: Snapshot[] = []; const directories = new Map<string, string>();
      let visited = 0; let total = 0;
      let stopWatching: (() => Promise<void>) | undefined;
      try {
        const membership = contractInputAuthorityFiles(authority);
        if (membership) {
          await authorize(root, signal);
          directories.set(root, fingerprint(lstatSync(root, { bigint: true })));
          for (const rel of membership) {
            signal.throwIfAborted();
            if (++visited > LIMITS.entries) throw new Error('captured code entry budget exceeded');
            if (rel.split('/').some(part => excluded.has(part))) continue;
            const path = join(root, rel);
            try { await authorize(path, signal); } catch (error) {
              if (error instanceof Error && error.message === 'captured input path is access-restricted') continue;
              throw error;
            }
            const stat = lstatSync(path, { bigint: true });
            if (stat.size > BigInt(LIMITS.fileBytes)) continue;
            if (files.length >= LIMITS.files || total + Number(stat.size) > LIMITS.bytes) throw new Error('captured code file/byte budget exceeded');
            const read = bytes(path); total += Buffer.byteLength(read.content);
            if (read.content.includes('\0')) continue;
            files.push({ path: rel, ...read, digest: sha256(read.content) });
            for (let directory = dirname(path); directory !== root; directory = dirname(directory)) {
              await authorize(directory, signal);
              directories.set(directory, fingerprint(lstatSync(directory, { bigint: true })));
            }
          }
        }
        const queue = membership ? [] : [root];
        while (queue.length) {
          const directory = queue.shift()!;
          await authorize(directory, signal);
          const stat = lstatSync(directory, { bigint: true });
          if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('captured code directory is redirected');
          directories.set(directory, fingerprint(stat));
          const dir = opendirSync(directory);
          try {
            for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
              checkSignal(); signal.throwIfAborted();
              if (++visited > LIMITS.entries) throw new Error('captured code entry budget exceeded');
              if (excluded.has(entry.name)) continue;
              const path = join(directory, entry.name);
              try { await authorize(path, signal); } catch (error) {
                if (error instanceof Error && error.message === 'captured input path is access-restricted') continue;
                throw error;
              }
              if (entry.isDirectory()) { queue.push(path); continue; }
              if (!entry.isFile()) throw new Error('captured code special-file access is unsupported');
              const stat = lstatSync(path, { bigint: true });
              if (stat.size > BigInt(LIMITS.fileBytes)) continue;
              if (files.length >= LIMITS.files || total + Number(stat.size) > LIMITS.bytes) throw new Error('captured code file/byte budget exceeded');
              const read = bytes(path); total += Buffer.byteLength(read.content);
              // Binary filtering consumes only the already-authorized bounded bytes.
              if (read.content.includes('\0')) continue;
              files.push({ path: relative(root, path), ...read, digest: sha256(read.content) });
            }
          } finally { dir.closeSync(); }
        }
        const generation: Generation = Object.freeze({ files: Object.freeze(files), directories, id: `${++sequence}:${sha256(files.map(f => `${f.path}:${f.digest}`).join('\n'))}` });
        await assertGeneration(generation, signal);
        stopWatching = watch(generation, signal);
        store = new CodeIndexStore(root, ':memory:', registry);
        await store.init(); checkProvider(); signal.throwIfAborted();
        if (!store.stats().available) { unavailable = 'code index unavailable'; store.close(); store = undefined; return; }
        await store.prepareAuthorizedSnapshots({ snapshots: files, provider: pinnedProvider, signal, maxChunks: LIMITS.chunks,
          guard: async (_boundary, path) => { signal.throwIfAborted(); await assertGeneration(generation, signal, path); } });
        cachedStats = Object.freeze({ ...await store.statsAuthorized() });
        await assertGeneration(generation, signal);
        current = generation;
      } catch (error) {
        current = undefined; cachedStats = undefined; store?.close(); store = undefined;
        if (error instanceof Error && /^(captured code (?:preparation time|operation time|entry|file\/byte) budget exceeded|Authorized code index chunk budget exceeded)$/.test(error.message)) {
          unavailable = error.message;
        } else throw error;
      } finally { try { await stopWatching?.(); } finally { clearTimeout(timer); deadline = Number.POSITIVE_INFINITY; } }
    },
    async search(query, options) {
      checkSignal();
      if (!store || !current || !operation) return [];
      const selected = current; const selectedStore = store;
      return bounded(async (signal) => {
        await assertGeneration(selected, signal);
        const stopWatching = watch(selected, signal);
        try {
          const results = await selectedStore.searchAuthorized(query, options);
          await assertGeneration(selected, signal);
          return results;
        } finally { await stopWatching(); }
      });
    },
    async rankForInjection(query, hits) {
      checkSignal();
      const selected = current;
      if (!selected || !operation) throw new Error('captured code generation unavailable');
      return bounded(async signal => {
        const assertCurrent = async () => {
          if (current !== selected) throw new Error('captured code generation replaced');
          await assertGeneration(selected, signal);
        };
        await assertCurrent();
        const snapshots = hits.map(hit => {
          const file = selected.files.find(file => file.path === hit.chunk.path);
          if (!file || file.digest !== hit.chunk.fileHash) throw new Error('captured code hit is stale');
          return { hit, code: file.content };
        });
        const stopWatching = watch(selected, signal);
        try {
          const reading = await rankCodeInjectionSnapshots(query, snapshots, { signal, assertCurrent });
          assertReadingCurrent = reading.assertCurrent;
          return reading;
        }
        finally { await stopWatching(); }
      });
    },
    stats() {
      if (cachedStats) return cachedStats;
      return { available: false, indexedChunks: 0, semanticRetrievalAvailable: unavailable !== 'no semantic embedding provider', ...(unavailable ? { error: unavailable } : {}) };
    },
    generation: () => current?.id,
    async assertCurrent(expected) {
      if (!current || !operation) { if (expected !== undefined) throw new Error('captured code generation unavailable'); return; }
      if (expected !== undefined && current.id !== expected) throw new Error('captured code generation replaced');
      const selected = current;
      await bounded(async signal => { await assertGeneration(selected, signal); await assertReadingCurrent?.(); });
    },
    finishTurn() { assertReadingCurrent = undefined; cachedStats = undefined; current = undefined; operation?.abort(); store?.close(); store = undefined; },
    dispose() { assertReadingCurrent = undefined; cachedStats = undefined; disposed = true; operation?.abort(); current = undefined; store?.close(); store = undefined; },
  };
  return source;
}
