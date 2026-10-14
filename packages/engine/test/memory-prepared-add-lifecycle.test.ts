import { afterEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { createMemoryApi, prepareMemoryApiAdd, type MemoryAddPublication, type MemoryPreparedAdd } from '../sdk/src/platform/knowledge/index.ts';
import { MemoryEmbeddingProviderRegistry } from '../sdk/src/platform/state/memory-embeddings.ts';
import { MemoryStore, type MemoryRecord } from '../sdk/src/platform/state/memory-store.ts';
import { MemoryRegistry } from '../sdk/src/platform/state/memory-registry.ts';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.ts';
import { compareByTrust } from '../sdk/src/platform/state/memory-store-helpers.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function fixture() {
  const root = makeProjectTempDir('memory-prepared-add');
  const embeddings = new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, 'config') }) });
  const path = join(root, 'memory.sqlite');
  const store = new MemoryStore(path, { embeddingRegistry: embeddings, enableVectorIndex: false });
  cleanups.push(() => store.close());
  await store.init();
  const registry = new MemoryRegistry(store), api = createMemoryApi(registry);
  let notifications = 0;
  registry.subscribe(() => { notifications++; });
  return { path, store, registry, api, embeddings, notifications: () => notifications };
}

function mutableRow(record: MemoryPreparedAdd['record']): MemoryRecord {
  return { ...record, tags: [...record.tags], provenance: record.provenance.map(link => ({ ...link })) };
}

function exactTransition(api: ReturnType<typeof createMemoryApi>, plan: MemoryPreparedAdd) {
  let expected = api.getAll();
  const next = [...expected, mutableRow(plan.record)].sort(compareByTrust);
  let publications = 0;
  return {
    assertCurrent() { expect(api.getAll()).toEqual(expected); },
    onPublished(receipt: MemoryAddPublication) {
      plan.assertPublication(receipt);
      expect(api.getAll()).toEqual(next);
      expected = next;
      publications++;
    },
    publications: () => publications,
  };
}

test('native API preparation fixes the canonical complete row before exact SQL publication and durable notification', async () => {
  const f = await fixture();
  await f.api.add({ cls: 'fact', summary: 'Previously reviewed', review: { state: 'reviewed', confidence: 95 } });
  const initialNotifications = f.notifications();
  const plan = prepareMemoryApiAdd(f.api, { cls: 'pattern', summary: 'A planned native fact', detail: '  canonical detail  ',
    tags: ['ordinary'], provenance: [{ kind: 'event', ref: 'native-fixture', label: 'source' }],
    review: { confidence: 32.5, reviewedBy: '  reviewer  ', staleReason: '  ordinary reason  ' },
    validFrom: 10, validUntil: 20,
  });
  expect(f.api.getAll()).toHaveLength(1);
  expect(plan.record.detail).toBe('canonical detail');
  expect(plan.record.confidence).toBe(33);
  expect(plan.record.reviewedBy).toBe('reviewer');
  expect(Object.isFrozen(plan.record)).toBe(true);
  expect(Object.isFrozen(plan.record.tags)).toBe(true);
  const provenance = plan.record.provenance[0];
  if (!provenance) throw new Error('Planned provenance missing');
  expect(Object.isFrozen(provenance)).toBe(true);
  expect(() => plan.assertPublication({})).toThrow('not owned');
  const transition = exactTransition(f.api, plan);
  const record = await plan.commit(transition);
  expect<unknown>(record).toEqual(plan.record);
  expect(record).not.toBe(plan.record);
  expect(record.tags).not.toBe(plan.record.tags);
  expect(transition.publications()).toBe(1);
  expect(f.notifications()).toBe(initialNotifications + 1);
  const reopened = new MemoryStore(f.path, { embeddingRegistry: f.embeddings, enableVectorIndex: false });
  cleanups.push(() => reopened.close()); await reopened.init();
  expect<unknown>(reopened.get(record.id)).toEqual(plan.record);
  await expect(plan.commit(transition)).rejects.toThrow('not available');
});

test('publication proof cannot be forged, copied or used after the native callback', async () => {
  const f = await fixture();
  expect(() => prepareMemoryApiAdd({ ...f.api }, { cls: 'fact', summary: 'copied API' })).toThrow('API unavailable');
  const plan = prepareMemoryApiAdd(f.api, { cls: 'fact', summary: 'owned plan' });
  const copied = { ...plan };
  await expect(copied.commit()).rejects.toThrow('not available');
  expect(f.api.getAll()).toHaveLength(0);
  let observed: MemoryAddPublication | undefined;
  await plan.commit({ onPublished(receipt) {
    expect(() => plan.assertPublication({ ...receipt })).toThrow('not owned');
    plan.assertPublication(receipt); observed = receipt;
  } });
  if (!observed) throw new Error('Native publication was not observed');
  const completedReceipt = observed;
  expect(() => plan.assertPublication(completedReceipt)).toThrow('not owned');
  expect(f.api.getAll()).toHaveLength(1);
});

test('generic API add forwards the original caller lifecycle before any write', async () => {
  const f = await fixture();
  await expect(f.api.add({ cls: 'fact', summary: 'not authorized by callback' }, {
    assertCurrent() { throw new Error('Original caller retired'); },
  })).rejects.toThrow('Original caller retired');
  expect(f.api.getAll()).toHaveLength(0);
  expect(f.notifications()).toBe(0);
});

test('prepared input mutation and unrelated native additions retire the original plan', async () => {
  const f = await fixture();
  const input = { cls: 'fact', summary: 'original', tags: ['ordinary'] } satisfies Parameters<typeof prepareMemoryApiAdd>[1];
  const plan = prepareMemoryApiAdd(f.api, input);
  input.tags.push('changed tail');
  await expect(plan.commit()).rejects.toMatchObject({ problem: 'unsupported-input' });
  expect(f.api.getAll()).toHaveLength(0);
  const old = prepareMemoryApiAdd(f.api, { cls: 'fact', summary: 'superseded' });
  await f.api.add({ cls: 'fact', summary: 'independent native row' });
  await expect(old.commit()).rejects.toThrow('source changed');
  expect(f.api.getAll().map(record => record.summary)).toEqual(['independent native row']);
});

test('close/reopen ABA and original caller cancellation refuse the prepared effect', async () => {
  const f = await fixture();
  const old = prepareMemoryApiAdd(f.api, { cls: 'fact', summary: 'old backend' });
  f.store.close(); await f.store.init();
  await expect(old.commit()).rejects.toThrow();
  const controller = new AbortController(), stopped = new Error('Original caller cancelled');
  const plan = prepareMemoryApiAdd(f.api, { cls: 'fact', summary: 'cancelled' }, { signal: controller.signal });
  controller.abort(stopped);
  await expect(plan.commit()).rejects.toBe(stopped);
  expect(f.api.getAll()).toHaveLength(0);
  expect(f.notifications()).toBe(0);
});

test('a replacement native method accessor is refused without invoking its getter', async () => {
  const f = await fixture();
  const plan = prepareMemoryApiAdd(f.api, { cls: 'fact', summary: 'descriptor retained' });
  let getters = 0;
  const original = Object.getOwnPropertyDescriptor(f.store, 'save');
  Object.defineProperty(f.store, 'save', { configurable: true, get() { getters++; return () => Promise.resolve(true); } });
  try { await expect(plan.commit()).rejects.toThrow('binding changed'); }
  finally { if (original) Object.defineProperty(f.store, 'save', original); else Reflect.deleteProperty(f.store, 'save'); }
  expect(getters).toBe(0);
  expect(f.api.getAll()).toHaveLength(0);
});

test('commit-option replacement during publication and non-synchronous adoption cannot publish success', async () => {
  const f = await fixture();
  const first = prepareMemoryApiAdd(f.api, { cls: 'fact', summary: 'callback replaced' });
  const options = { assertCurrent() {}, onPublished(receipt: MemoryAddPublication) {
    first.assertPublication(receipt); options.assertCurrent = () => {};
  } };
  await expect(first.commit(options)).rejects.toThrow('binding changed');
  expect(f.notifications()).toBe(0);
  const second = prepareMemoryApiAdd(f.api, { cls: 'fact', summary: 'async callback' });
  await expect(second.commit({ onPublished: async () => {} })).rejects.toThrow('must be synchronous');
  expect(f.notifications()).toBe(0);
});

test('cancellation after real SQL retains the committed row but stops save and notification', async () => {
  const f = await fixture();
  const controller = new AbortController(), stopped = new Error('Cancelled after native INSERT');
  const original = SQLiteStore.prototype.run;
  const write = spyOn(SQLiteStore.prototype, 'run').mockImplementation(function(this: SQLiteStore, ...args: Parameters<SQLiteStore['run']>) {
    const result = Reflect.apply(original, this, args);
    if (args[0].includes('INSERT INTO memory_records')) controller.abort(stopped);
    return result;
  });
  cleanups.push(() => write.mockRestore());
  const plan = prepareMemoryApiAdd(f.api, { cls: 'fact', summary: 'native row already inserted' });
  let publications = 0;
  await expect(plan.commit({ signal: controller.signal, onPublished() { publications++; } })).rejects.toBe(stopped);
  expect<unknown>(f.api.getAll()).toEqual([plan.record]);
  expect(publications).toBe(0);
  expect(f.notifications()).toBe(0);
});

test('an unrelated reentrant publication cannot adopt an unconstrained current memory source', async () => {
  const f = await fixture();
  const plan = prepareMemoryApiAdd(f.api, { cls: 'fact', summary: 'planned record' });
  const transition = exactTransition(f.api, plan);
  await expect(plan.commit({ assertCurrent: transition.assertCurrent, onPublished(receipt) {
    plan.assertPublication(receipt);
    f.store.update(plan.record.id, { summary: 'reentrant replacement' });
    transition.onPublished(receipt);
  } })).rejects.toThrow();
  expect(f.api.getAll().map(record => record.summary)).toEqual(['reentrant replacement']);
  expect(transition.publications()).toBe(0);
  expect(f.notifications()).toBe(0);
});

test('listener retirement after exact durable publication cannot return a successful result', async () => {
  const f = await fixture();
  let callerCurrent = true;
  f.registry.subscribe(() => { callerCurrent = false; });
  const plan = prepareMemoryApiAdd(f.api, { cls: 'fact', summary: 'durable before listener retirement' }, {
    assertCurrent() { if (!callerCurrent) throw new Error('Original caller retired by listener'); },
  });
  const transition = exactTransition(f.api, plan);
  await expect(plan.commit(transition)).rejects.toThrow('Original caller retired by listener');
  expect(transition.publications()).toBe(1);
  const reopened = new MemoryStore(f.path, { embeddingRegistry: f.embeddings, enableVectorIndex: false });
  cleanups.push(() => reopened.close()); await reopened.init();
  expect<unknown>(reopened.get(plan.record.id)).toEqual(plan.record);
});

test('initial native method substitution and input accessors cannot issue a plan', async () => {
  const f = await fixture();
  let getters = 0;
  const input = { cls: 'fact', get summary() { getters++; return 'unread source'; } } satisfies Parameters<typeof prepareMemoryApiAdd>[1];
  expect(() => prepareMemoryApiAdd(f.api, input)).toThrow();
  expect(getters).toBe(0);
  const original = Object.getOwnPropertyDescriptor(f.registry, 'getAll');
  Object.defineProperty(f.registry, 'getAll', { configurable: true, value: () => [] });
  try { expect(() => prepareMemoryApiAdd(f.api, { cls: 'fact', summary: 'counterfeit retrieval' })).toThrow('native registry method changed'); }
  finally { if (original) Object.defineProperty(f.registry, 'getAll', original); else Reflect.deleteProperty(f.registry, 'getAll'); }
  expect(f.api.getAll()).toHaveLength(0);
});

test('a borrowed publication callback changed at the real SQL boundary is never invoked', async () => {
  const f = await fixture();
  let publications = 0;
  const options = { onPublished() { publications++; } };
  const original = SQLiteStore.prototype.run;
  const write = spyOn(SQLiteStore.prototype, 'run').mockImplementation(function(this: SQLiteStore, ...args: Parameters<SQLiteStore['run']>) {
    const result = Reflect.apply(original, this, args);
    if (args[0].includes('INSERT INTO memory_records')) options.onPublished = () => { publications++; };
    return result;
  });
  cleanups.push(() => write.mockRestore());
  const plan = prepareMemoryApiAdd(f.api, { cls: 'fact', summary: 'real insertion before callback retirement' });
  await expect(plan.commit(options)).rejects.toThrow('binding changed');
  expect<unknown>(f.api.getAll()).toEqual([plan.record]);
  expect(publications).toBe(0);
  expect(f.notifications()).toBe(0);
});

test('an original caller cannot install a provider accessor between native binding and scope checks', async () => {
  const f = await fixture();
  let armed = false, checks = 0, getters = 0;
  const original = Object.getOwnPropertyDescriptor(f.embeddings, 'getDefaultProviderOrNull');
  const plan = prepareMemoryApiAdd(f.api, { cls: 'fact', summary: 'retained provider binding' }, {
    assertCurrent() {
      if (armed && ++checks === 2) {
        Object.defineProperty(f.embeddings, 'getDefaultProviderOrNull', {
          configurable: true, get() { getters++; return () => null; },
        });
      }
    },
  });
  armed = true;
  try { expect(() => plan.assertCurrent()).toThrow('binding changed'); }
  finally {
    if (original) Object.defineProperty(f.embeddings, 'getDefaultProviderOrNull', original);
    else Reflect.deleteProperty(f.embeddings, 'getDefaultProviderOrNull');
  }
  expect(checks).toBe(2);
  expect(getters).toBe(0);
  expect(f.api.getAll()).toHaveLength(0);
  expect(f.notifications()).toBe(0);
});

test('an original caller cannot install a row getter during actual native publication', async () => {
  const f = await fixture();
  let inserted = false, replaced = false, getters = 0, publications = 0;
  const getDescriptor = Object.getOwnPropertyDescriptor(f.store, 'get');
  const originalRun = SQLiteStore.prototype.run;
  const write = spyOn(SQLiteStore.prototype, 'run').mockImplementation(function(this: SQLiteStore, ...args: Parameters<SQLiteStore['run']>) {
    const result = Reflect.apply(originalRun, this, args);
    if (args[0].includes('INSERT INTO memory_records')) inserted = true;
    return result;
  });
  cleanups.push(() => write.mockRestore());
  const plan = prepareMemoryApiAdd(f.api, { cls: 'fact', summary: 'committed before getter retirement' }, {
    assertCurrent() {
      if (inserted && !replaced) {
        replaced = true;
        Object.defineProperty(f.store, 'get', { configurable: true, get() { getters++; return () => null; } });
      }
    },
  });
  try { await expect(plan.commit({ onPublished() { publications++; } })).rejects.toThrow('binding changed'); }
  finally {
    if (getDescriptor) Object.defineProperty(f.store, 'get', getDescriptor);
    else Reflect.deleteProperty(f.store, 'get');
  }
  expect(inserted).toBe(true);
  expect(replaced).toBe(true);
  expect(getters).toBe(0);
  expect(publications).toBe(0);
  expect<unknown>(f.api.getAll()).toEqual([plan.record]);
  expect(f.notifications()).toBe(0);
});

test('a substituted issuer lookup cannot adopt a copied API while the genuine owner still commits', async () => {
  const f = await fixture();
  const copied = { ...f.api };
  const descriptor = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'get');
  if (!descriptor) throw new Error('Native issuer lookup descriptor missing');
  const originalGet = WeakMap.prototype.get, apply = Reflect.apply;
  let copyLookups = 0;
  Object.defineProperty(WeakMap.prototype, 'get', {
    ...descriptor,
    value: function(this: WeakMap<object, unknown>, key: Parameters<typeof WeakMap.prototype.get>[0]): unknown {
      if (key === copied) { copyLookups++; return f.registry; }
      return apply(originalGet, this, [key]);
    },
  });
  try {
    expect(() => prepareMemoryApiAdd(copied, { cls: 'fact', summary: 'counterfeit copied API' })).toThrow('API unavailable');
    expect(copyLookups).toBe(0);
    expect(f.api.getAll()).toHaveLength(0);
    const plan = prepareMemoryApiAdd(f.api, { cls: 'fact', summary: 'genuine owner under substituted lookup' });
    const transition = exactTransition(f.api, plan);
    expect<unknown>(await plan.commit(transition)).toEqual(plan.record);
    expect(transition.publications()).toBe(1);
    expect(f.notifications()).toBe(1);
  } finally { Object.defineProperty(WeakMap.prototype, 'get', descriptor); }
});
