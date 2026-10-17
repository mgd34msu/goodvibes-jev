import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { assertCurrentToolEffect, ToolRegistry } from '../sdk/src/platform/tools/index.ts';
import { DEFAULT_CONFIG } from '../sdk/src/platform/config/index.ts';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { PermissionManager } from '../sdk/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { MemorySpineClient, createLocalMemoryAccess } from '../sdk/src/platform/runtime/memory-spine/client.ts';
import { createMemorySpineRestTransport } from '../sdk/src/platform/runtime/memory-spine/rest-transport.ts';
import { MemoryEmbeddingProviderRegistry, HASHED_MEMORY_EMBEDDING_PROVIDER } from '../sdk/src/platform/state/memory-embeddings.ts';
import { createBuiltinMemoryEmbeddingProviders } from '../sdk/src/platform/state/memory-embedding-http.ts';
import { MemoryStore, MemoryRegistry, type MemoryRecord } from '../sdk/src/platform/state/memory-store.ts';
import { SqliteVecMemoryIndex, memoryVectorSourceHash } from '../sdk/src/platform/state/memory-vector-store.ts';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.ts';
import type { Tool } from '../sdk/src/platform/types/tools.ts';
import { forgetGateReadings, gateReadingsPort, READ_ONLY } from './_helpers/gate-readings.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const TOOL = 'memory_lifecycle_fixture';
const cleanups: Array<() => void> = [];
let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;

beforeEach(() => {
  forgetGateReadings();
  log = new SqliteDecisionLog(':memory:');
  const gate = gateReadingsPort([[TOOL, READ_ONLY]]);
  const semantic = fakePort((_name, question) => choiceAnswer(question, 'act', 0.99));
  const port: JudgmentPort = { model: gate.port.model, ask(request) {
    request.signal?.throwIfAborted(); request.beforeAttempt?.();
    return 'disposition' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } };
  previous = installJudgmentPort(withDecisionLog(port, log));
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const root = makeProjectTempDir('memory-operation-lifecycle');
  const config = new ConfigManager({ configDir: join(root, 'config') });
  const embeddings = new MemoryEmbeddingProviderRegistry({ configManager: config });
  const vectorPath = join(root, 'memory.vec.sqlite');
  const store = new MemoryStore(join(root, 'memory.sqlite'), { embeddingRegistry: embeddings, vectorDbPath: vectorPath });
  cleanups.push(() => store.close());
  await store.init();
  expect(store.vectorStats().available).toBe(true);
  const registry = new MemoryRegistry(store);
  const client = new MemorySpineClient({ local: createLocalMemoryAccess(registry) });
  return { root, embeddings, vectorPath, store, registry, client };
}

function memoryTool(client: MemorySpineClient, mode: 'prompt' | 'plan') {
  const directory = '/synthetic/memory-lifecycle';
  const permissions = { ...DEFAULT_CONFIG.permissions, mode };
  const config = {
    getAutonomousSnapshot: () => ({ permissions, autoApprove: false, directory, incarnation: 0 }),
    getSnapshot: () => ({ permissions }), getWorkingDirectory: () => directory, isAutoApproveEnabled: () => false,
  };
  const manager = new PermissionManager(undefined, config, new PolicyRuntimeState());
  const tools = new ToolRegistry(manager);
  const tool: Tool = {
    definition: { name: TOOL, description: 'Store one synthetic memory.', parameters: {
      type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false,
    } },
    async execute(args, options) {
      const record = await client.add({ cls: 'fact', summary: String(args.summary) }, {
        signal: options?.signal,
        assertCurrent: () => {
          if (!assertCurrentToolEffect(args, options, 'write')) throw new Error('No authentic memory effect');
        },
      });
      return { success: true, output: record.id };
    },
  };
  tools.register(tool);
  return { tool, async run() {
    const call = await tools.prepareCall('memory-call', TOOL, { summary: 'Synthetic admitted memory' });
    const source = { goal: 'Store this synthetic fact', criteria: ['Store one fact'] };
    const admission = await manager.admitAutonomous('memory-source', TOOL, call.args, {
      sourceOf: () => source, schemaRevision: call.schemaRevision, preparedCall: { registry: tools, call },
    });
    if (!admission.result.approved) throw new Error(admission.result.reasonCode);
    expect(admission.result.autonomousDecision).toBeUndefined();
    return tools.executePrepared(call, admission);
  } };
}

test('authentic recorded action reaches the real memory SQL and vector stores', async () => {
  const f = await fixture();
  expect(await memoryTool(f.client, 'prompt').run()).toMatchObject({ success: true });
  expect(f.store.retrieve({})).toHaveLength(1);
  expect(f.store.vectorStats().indexedRecords).toBe(1);
});

test('a misclassified action in plan mode is held before native memory writes', async () => {
  const f = await fixture();
  await expect(memoryTool(f.client, 'plan').run()).rejects.toThrow();
  expect(f.store.retrieve({})).toHaveLength(0);
  expect(f.store.vectorStats().indexedRecords).toBe(0);
});

test('a caller callback without authentic admission cannot authorize the memory tool', async () => {
  const f = await fixture();
  await expect(memoryTool(f.client, 'prompt').tool.execute({ summary: 'raw' }, { assertCurrent() {} })).rejects.toThrow('No authentic memory effect');
  expect(f.store.retrieve({})).toHaveLength(0);
});

test('cancellation after the actual SQL insert stops vector writes and notifications', async () => {
  const controller = new AbortController(), stopped = new Error('cancel after native SQL');
  const original = SQLiteStore.prototype.run;
  const native = spyOn(SQLiteStore.prototype, 'run').mockImplementation(function(this: SQLiteStore, ...args: Parameters<SQLiteStore['run']>) {
    const result = Reflect.apply(original, this, args);
    if (args[0].includes('INSERT INTO memory_records')) controller.abort(stopped);
    return result;
  });
  cleanups.push(() => native.mockRestore());
  const f = await fixture();
  let notifications = 0;
  f.registry.subscribe(() => { notifications++; });
  await expect(f.client.add({ cls: 'fact', summary: 'SQL already committed' }, { signal: controller.signal })).rejects.toBe(stopped);
  expect(f.store.retrieve({}).map(record => record.summary)).toEqual(['SQL already committed']);
  expect(f.store.vectorStats().indexedRecords).toBe(0);
  expect(notifications).toBe(0);
});

test('a notification listener cannot publish a successful result after retiring the outer source', async () => {
  const f = await fixture();
  let current = true, notifications = 0;
  const unsubscribe = f.registry.subscribe(() => { notifications++; current = false; });
  cleanups.push(unsubscribe);
  await expect(f.registry.add({ cls: 'fact', summary: 'committed before listener retirement' }, {
    assertCurrent: () => { if (!current) throw new Error('retired by memory notification'); },
  })).rejects.toThrow('retired by memory notification');
  expect(notifications).toBe(1);
  expect(f.store.retrieve({})).toHaveLength(1);
  expect(f.store.vectorStats().indexedRecords).toBe(1);
});

test('a reentrant store mutation prevents the older operation from overwriting its vector', async () => {
  const f = await fixture();
  let reentered = false, id = '';
  f.embeddings.register({ ...HASHED_MEMORY_EMBEDDING_PROVIDER, id: 'local-reentrant', label: 'Local controlled provider',
    embedSync(request) {
      if (!reentered && request.recordId) {
        reentered = true; id = request.recordId;
        f.store.update(id, { summary: 'newer canonical record' });
      }
      return { vector: new Float32Array(request.dimensions).fill(1), dimensions: request.dimensions };
    },
  }, { makeDefault: true });
  await expect(f.client.add({ cls: 'fact', summary: 'older record' })).rejects.toThrow('source changed');
  const current = f.store.get(id);
  expect(current?.summary).toBe('newer canonical record');
  if (!current) throw new Error('Native canonical record missing');
  const native = new Database(f.vectorPath, { readonly: true });
  try {
    expect(native.query<{ source_hash: string }, [string]>('SELECT source_hash FROM memory_vector_ids WHERE record_id = ?').get(id)?.source_hash).toBe(memoryVectorSourceHash(current));
  } finally { native.close(); }
});

test('prepared local backend scope rejects close and reopen ABA', async () => {
  const f = await fixture();
  const current = f.client.captureOperationScope();
  f.store.close(); await f.store.init();
  expect(() => current()).toThrow('store changed');
  expect(await f.client.add({ cls: 'fact', summary: 'new incarnation' })).toMatchObject({ summary: 'new incarnation' });
});

test('changing a borrowed lifecycle callback during an await cannot remove its restriction', async () => {
  const f = await fixture();
  const started = deferred<void>(), release = deferred<MemoryRecord | null>();
  const local = createMemorySpineRestTransport({ baseUrl: 'http://127.0.0.1:1', authToken: 'synthetic' });
  const wire = { ...local, get: async () => { started.resolve(); return release.promise; } };
  f.client.activate(wire);
  const lifecycle = { assertCurrent() {} };
  const pending = f.client.get('synthetic', lifecycle);
  await started.promise;
  lifecycle.assertCurrent = () => {};
  release.resolve(null);
  await expect(pending).rejects.toThrow('lifecycle changed');
});

test('adoption ABA retires a pending read and never reaches the local fallback', async () => {
  const f = await fixture();
  const started = deferred<void>(), release = deferred<MemoryRecord | null>();
  const original = createMemorySpineRestTransport({ baseUrl: 'http://127.0.0.1:1', authToken: 'synthetic' });
  const wire = { ...original, get: async () => { started.resolve(); return release.promise; } };
  f.client.activate(wire);
  const current = f.client.captureOperationScope(), pending = f.client.get('remote');
  await started.promise;
  f.client.deactivate('synthetic switch'); f.client.activate(wire);
  expect(() => current()).toThrow('route changed');
  release.resolve(null);
  await expect(pending).rejects.toThrow('route changed');
  expect(f.store.retrieve({})).toHaveLength(0);
});

test('abort promptly rejects a noncooperative embedding and blocks its later native vector write', async () => {
  const f = await fixture();
  const record = await f.client.add({ cls: 'fact', summary: 'actual source for pending embedding' });
  const index = new SqliteVecMemoryIndex(join(f.root, 'async.vec.sqlite'), 384, f.embeddings);
  cleanups.push(() => index.close()); await index.init();
  expect(index.stats().available).toBe(true);
  const started = deferred<void>(), release = deferred<void>(), completed = deferred<void>();
  f.embeddings.register({ id: 'controlled-async', label: 'Controlled local provider', dimensions: 384, local: true,
    async embed(request) {
      request.beforeAttempt?.(); started.resolve(); await release.promise;
      completed.resolve();
      return { vector: new Float32Array(384).fill(1), dimensions: 384 };
    },
  }, { makeDefault: true });
  const controller = new AbortController(), stopped = new Error('stop embedding');
  const pending = index.upsertAsync(record, { signal: controller.signal });
  await started.promise; controller.abort(stopped);
  await expect(pending).rejects.toBe(stopped);
  expect(index.stats().indexedRecords).toBe(0);
  release.resolve(); await completed.promise; await Promise.resolve(); await Promise.resolve();
  expect(index.stats().indexedRecords).toBe(0);
});

test('async embedding currentness is checked again before a provider retry', async () => {
  const f = await fixture();
  const record = await f.client.add({ cls: 'fact', summary: 'controlled retry source' });
  const index = new SqliteVecMemoryIndex(join(f.root, 'retry.vec.sqlite'), 384, f.embeddings);
  cleanups.push(() => index.close()); await index.init();
  const started = deferred<void>(), release = deferred<void>();
  let current = true, attempts = 0;
  f.embeddings.register({ id: 'controlled-retry', label: 'Controlled local retries', dimensions: 384, local: true,
    async embed(request) {
      await request.beforeAttempt?.(); attempts++; started.resolve(); await release.promise;
      await request.beforeAttempt?.(); attempts++;
      return { vector: new Float32Array(384).fill(1), dimensions: 384 };
    },
  }, { makeDefault: true });
  const pending = index.upsertAsync(record, { assertCurrent: () => { if (!current) throw new Error('retired before retry'); } });
  await started.promise; current = false; release.resolve();
  await expect(pending).rejects.toThrow('retired before retry');
  expect(attempts).toBe(1); expect(index.stats().indexedRecords).toBe(0);
});

test('the built-in HTTP embedding reaches loopback and commits the native vector', async () => {
  const f = await fixture();
  const record = await f.client.add({ cls: 'fact', summary: 'actual HTTP embedding source' });
  const index = new SqliteVecMemoryIndex(join(f.root, 'http.vec.sqlite'), 384, f.embeddings);
  cleanups.push(() => index.close()); await index.init();
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests++;
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-embedding-token');
    expect(await request.json()).toMatchObject({ input: expect.stringContaining(record.summary) });
    return Response.json({ data: [{ embedding: new Array(384).fill(1) }] });
  } });
  cleanups.push(() => server.stop(true));
  const provider = createBuiltinMemoryEmbeddingProviders({ env: {
    OPENAI_COMPATIBLE_BASE_URL: server.url.origin,
    OPENAI_COMPATIBLE_API_KEY: 'synthetic-embedding-token',
  } }).find(provider => provider.id === 'openai-compatible');
  if (!provider) throw new Error('Missing built-in compatible embedding provider');
  f.embeddings.register(provider, { replace: true, makeDefault: true });
  await index.upsertAsync(record, { assertCurrent: () => {} });
  expect(requests).toBe(1);
  expect(index.stats().indexedRecords).toBe(1);
});

test('built-in embedding currentness is checked after credentials are prepared and before HTTP dispatch', async () => {
  const f = await fixture();
  const record = await f.client.add({ cls: 'fact', summary: 'retired embedding source' });
  const index = new SqliteVecMemoryIndex(join(f.root, 'retired-http.vec.sqlite'), 384, f.embeddings);
  cleanups.push(() => index.close()); await index.init();
  let current = true, requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    requests++;
    return Response.json({ data: [{ embedding: new Array(384).fill(1) }] });
  } });
  cleanups.push(() => server.stop(true));
  const env = { OPENAI_COMPATIBLE_BASE_URL: server.url.origin };
  Object.defineProperty(env, 'OPENAI_COMPATIBLE_API_KEY', { get() {
    current = false;
    return 'synthetic-embedding-token';
  } });
  const provider = createBuiltinMemoryEmbeddingProviders({ env }).find(provider => provider.id === 'openai-compatible');
  if (!provider) throw new Error('Missing built-in compatible embedding provider');
  f.embeddings.register(provider, { replace: true, makeDefault: true });
  await expect(index.upsertAsync(record, { assertCurrent: () => {
    if (!current) throw new Error('retired during embedding preparation');
  } })).rejects.toThrow('retired during embedding preparation');
  expect(requests).toBe(0);
  expect(index.stats().indexedRecords).toBe(0);
});

test('loopback REST holds a stale successful response before publication', async () => {
  const f = await fixture();
  const record = await f.client.add({ cls: 'fact', summary: 'loopback native source' });
  let current = true, requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    requests++; current = false;
    return Response.json({ record });
  } });
  cleanups.push(() => server.stop(true));
  const transport = createMemorySpineRestTransport({ baseUrl: server.url.origin, authToken: 'synthetic' });
  await expect(transport.get(record.id, { assertCurrent: () => { if (!current) throw new Error('retired REST response'); } })).rejects.toThrow('retired REST response');
  expect(requests).toBe(1);
});

test('loopback REST add and get reach one actual native host store', async () => {
  const f = await fixture();
  let authorized = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    authorized = request.headers.get('authorization') === 'Bearer synthetic';
    if (request.method === 'POST') {
      const record = await f.registry.add({ cls: 'fact', summary: 'loopback committed fact' });
      return Response.json({ record });
    }
    const id = new URL(request.url).pathname.split('/').at(-1) ?? '';
    return Response.json({ record: f.registry.get(id) });
  } });
  cleanups.push(() => server.stop(true));
  const transport = createMemorySpineRestTransport({ baseUrl: server.url.origin, authToken: 'synthetic' });
  const record = await transport.add({ cls: 'fact', summary: 'loopback committed fact' });
  expect(await transport.get(record.id)).toEqual(record);
  expect(f.store.get(record.id)?.summary).toBe('loopback committed fact');
  expect(f.store.vectorStats().indexedRecords).toBe(1);
  expect(authorized).toBe(true);
});

test('loopback REST cancellation settles before a held server response is released', async () => {
  const started = deferred<void>(), release = deferred<void>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
    started.resolve(); await release.promise; return Response.json({ record: null });
  } });
  cleanups.push(() => { release.resolve(); server.stop(true); });
  const controller = new AbortController(), stopped = new Error('cancel loopback response');
  const transport = createMemorySpineRestTransport({ baseUrl: server.url.origin, authToken: 'synthetic' });
  const pending = transport.get('held', { signal: controller.signal });
  await started.promise; controller.abort(stopped);
  await expect(pending).rejects.toBe(stopped);
  release.resolve();
});
