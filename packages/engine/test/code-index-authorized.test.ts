import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexStore, type AuthorizedCodePrepareInput } from '../sdk/src/platform/state/code-index-store.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { MemoryEmbeddingProviderRegistry, embedMemoryText, type MemoryEmbeddingRequest } from '../sdk/src/platform/state/memory-embeddings.js';

const roots: string[] = [];
const stores: CodeIndexStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'authorized-index-'));
  roots.push(root);
  const registry = new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, '.config') }) });
  const calls: MemoryEmbeddingRequest[] = [];
  registry.register({ id: 'authorized-test', label: 'Authorized test', dimensions: 384, capturedInputAdmission: 'per-attempt',
    async embed(request) {
      calls.push(request);
      await request.beforeAttempt?.();
      return { vector: embedMemoryText(request.text), dimensions: 384 };
    },
  }, { makeDefault: true });
  const store = new CodeIndexStore(root, ':memory:', registry);
  stores.push(store);
  const controller = new AbortController();
  const phases: string[] = [];
  const input: AuthorizedCodePrepareInput = {
    snapshots: [{ path: 'never-created.txt', content: 'captured snapshot content', mtimeMs: 1 }],
    provider: registry.getDefaultProvider(), signal: controller.signal,
    guard: async (phase) => { phases.push(phase); },
  };
  return { store, registry, calls, input, controller, phases };
}

describe('receipt-authorized code index', () => {
  test('uses snapshots without reading nonexistent source, prepares stats, and queries async semantic provider', async () => {
    const { store, calls, input, phases } = setup();
    await store.prepareAuthorizedSnapshots(input);
    expect((await store.statsAuthorized()).indexedChunks).toBe(1);
    const results = await store.searchAuthorized('captured');
    expect(results[0]?.chunk.path).toBe('never-created.txt');
    expect(results[0]?.label).toBe('semantic');
    expect(calls.map((call) => call.usage)).toEqual(['record', 'query']);
    expect(calls.every((call) => call.signal === input.signal && typeof call.beforeAttempt === 'function')).toBe(true);
    expect(phases).toContain('chunk');
    expect(phases).toContain('cache');
    expect(phases.at(-1)).toBe('result');
  });
  test('fails closed on same-ID provider replacement', async () => {
    const { store, registry, input, calls } = setup();
    await store.prepareAuthorizedSnapshots(input);
    registry.register({ ...input.provider }, { replace: true });
    await expect(store.searchAuthorized('captured')).rejects.toThrow('unchanged registered');
    await expect(store.statsAuthorized()).rejects.toThrow('unchanged registered');
    expect(calls.length).toBe(1);
  });
  test('denied cache guard prevents writes after embedding', async () => {
    const { store, input, calls } = setup();
    await expect(store.prepareAuthorizedSnapshots({ ...input, guard: async (phase) => {
      if (phase === 'cache' && calls.length) throw new Error('receipt revoked');
    } })).rejects.toThrow('receipt revoked');
    await expect(store.statsAuthorized()).rejects.toThrow('not been prepared');
  });
  test('denied final guard prevents result release', async () => {
    const { store, input } = setup();
    let deny = false;
    await store.prepareAuthorizedSnapshots({ ...input, guard: async (phase) => {
      if (phase === 'result' && deny) throw new Error('receipt revoked');
    } });
    deny = true;
    await expect(store.searchAuthorized('captured')).rejects.toThrow('receipt revoked');
  });
  test('rejects hashed, missing, unsupported dimensions, and equivalent unregistered objects', async () => {
    for (const kind of ['hashed', 'missing', 'dimensions', 'copy']) {
      const { store, registry, input } = setup();
      if (kind === 'hashed') registry.setDefaultProvider('hashed-local');
      if (kind === 'missing') registry.unregister(input.provider.id);
      if (kind === 'dimensions') registry.register({ ...input.provider, dimensions: 5 }, { replace: true });
      const provider = kind === 'copy' ? { ...input.provider } : registry.getDefaultProviderOrNull() ?? input.provider;
      await expect(store.prepareAuthorizedSnapshots({ ...input, provider })).rejects.toThrow('registered semantic provider');
    }
  });
  test('enforces chunk bounds before any embedding and disallows a second prepare', async () => {
    const { store, input, calls } = setup();
    await expect(store.prepareAuthorizedSnapshots({ ...input, maxChunks: 1,
      snapshots: [{ path: 'big.txt', content: Array.from({ length: 120 }, () => 'line').join('\n'), mtimeMs: 1 }],
    })).rejects.toThrow('chunk budget');
    expect(calls.length).toBe(0);
    await expect(store.prepareAuthorizedSnapshots(input)).rejects.toThrow('fresh per-run');
  });
  test('abort and lifecycle closure prevent later query embedding', async () => {
    const { store, input, controller, calls } = setup();
    await store.prepareAuthorizedSnapshots(input);
    controller.abort(new Error('cancelled'));
    await expect(store.searchAuthorized('captured')).rejects.toThrow('cancelled');
    await expect(store.statsAuthorized()).rejects.toThrow('cancelled');
    expect(calls.length).toBe(1);
    const other = setup();
    await other.store.prepareAuthorizedSnapshots(other.input);
    other.store.close();
    await expect(other.store.searchAuthorized('captured')).rejects.toThrow('lifecycle changed');
  });
  test('cancels a non-cooperating pending provider and discards its late result', async () => {
    const { store, registry, input, controller } = setup();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    registry.register({ ...input.provider, async embed(request) {
      entered();
      await pending;
      return { vector: embedMemoryText(request.text), dimensions: 384 };
    } }, { replace: true });
    const prepared = store.prepareAuthorizedSnapshots({ ...input, provider: registry.getDefaultProvider() });
    await started;
    controller.abort(new Error('run revoked'));
    await expect(prepared).rejects.toThrow('run revoked');
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(store.statsAuthorized()).rejects.toThrow('not been prepared');
  });
  test('revocation after query embedding prevents vector cache lookup and result release', async () => {
    const { store, registry, input } = setup();
    let revoked = false;
    registry.register({ ...input.provider, async embed(request) {
      if (request.usage === 'query') revoked = true;
      return { vector: embedMemoryText(request.text), dimensions: 384 };
    } }, { replace: true });
    await store.prepareAuthorizedSnapshots({ ...input, provider: registry.getDefaultProvider(), guard: async () => {
      if (revoked) throw new Error('query revoked');
    } });
    await expect(store.searchAuthorized('captured')).rejects.toThrow('query revoked');
  });

  test('authorized stores reject ordinary live-tree entrypoints', async () => {
    const { store, input } = setup();
    await store.prepareAuthorizedSnapshots(input);
    await expect(store.search('captured')).rejects.toThrow('Live-tree operations');
    await expect(store.buildFull()).rejects.toThrow('Live-tree operations');
    await expect(store.reindexFile('/never-created.txt')).rejects.toThrow('Live-tree operations');
    expect(() => store.stats()).toThrow('guarded authorized');
    expect(() => store.hasSemanticProvider()).toThrow('guarded authorized');
    expect(() => store.getProviderMismatch()).toThrow('guarded authorized');
    expect(() => store.scheduleBuild()).toThrow('Live-tree operations');
    await expect(store.reroot('/never-created', ':memory:')).rejects.toThrow('Live-tree operations');
  });

  test('guards record boundaries by exact snapshot path and query/stats/result boundaries globally', async () => {
    const { store, input } = setup();
    const checks: { boundary: string; path: string | undefined }[] = [];
    await store.prepareAuthorizedSnapshots({ ...input, guard: async (boundary, path) => { checks.push({ boundary, path }); } });
    expect(checks.some((check) => check.boundary === 'chunk' && check.path === 'never-created.txt')).toBe(true);
    expect(checks.filter((check) => check.boundary === 'embedding').every((check) => check.path === 'never-created.txt')).toBe(true);
    expect(checks.some((check) => check.boundary === 'cache' && check.path === 'never-created.txt')).toBe(true);
    expect(checks.filter((check) => check.boundary === 'result').every((check) => check.path === undefined)).toBe(true);
    checks.length = 0;
    await store.statsAuthorized();
    await store.searchAuthorized('captured');
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((check) => check.path === undefined)).toBe(true);
  });

});
