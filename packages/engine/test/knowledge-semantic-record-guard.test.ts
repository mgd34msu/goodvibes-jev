import { afterEach, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { createSemanticWriteGuard } from '../sdk/src/platform/knowledge/semantic/primary-source-plan.js';
import { KnowledgeSourceQualityHeldError } from '../sdk/src/platform/knowledge/source-quality.js';

const stores: KnowledgeStore[] = [], roots: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'semantic-record-guard-')); roots.push(root);
  const filename = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath: filename }); stores.push(store);
  const metadata = { knowledgeSpaceId: 'default', nested: { label: 'Original meaning' } };
  const source = await store.upsertSource({ id: 'source', connectorId: 'record-guard', sourceType: 'document', title: 'Original reference', status: 'indexed', metadata });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'record-guard', format: 'text', excerpt: 'Original evidence', sections: [], metadata });
  const observed = { id: 'area', kind: 'ha_area', slug: 'area', title: 'Original area', status: 'active', metadata } satisfies Parameters<typeof upsertObservedKnowledgeNode>[1];
  const node = await upsertObservedKnowledgeNode(store, observed, 'home-assistant-snapshot', observed, () => observed);
  const currentSource = store.getSource(source.id), currentExtraction = store.getExtractionBySourceId(source.id), currentNode = store.getNode(node.id);
  if (!currentSource || !currentExtraction || !currentNode) throw new Error('Fixture records missing');
  return { store, source: currentSource, extraction: currentExtraction, node: currentNode, filename, root };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Kind = 'source' | 'node' | 'extraction';
const kinds: readonly Kind[] = ['source', 'node', 'extraction'];
function watch(item: Fixture, kind: Kind, guard = createSemanticWriteGuard(item.store)) {
  switch (kind) {
    case 'source': guard.source(item.source.id, structuredClone(item.source)); break;
    case 'node': guard.node(item.node.id, structuredClone(item.node)); break;
    case 'extraction': guard.extraction(item.source.id, structuredClone(item.extraction)); break;
  }
  return guard;
}
function record(item: Fixture, kind: Kind) {
  switch (kind) { case 'source': return item.source; case 'node': return item.node; case 'extraction': return item.extraction; }
}
function nested(value: { readonly metadata: Readonly<Record<string, unknown>> }): object {
  const valueObject = value.metadata.nested;
  if (!valueObject || typeof valueObject !== 'object') throw new Error('Fixture nested metadata missing');
  return valueObject;
}

test('typed records keep every actual getter and generic callback in the original order', async () => {
  const item = await fixture(), guard = createSemanticWriteGuard(item.store), calls: string[] = [];
  const sourceRead = item.store.getSource.bind(item.store), nodeRead = item.store.getNode.bind(item.store), extractionRead = item.store.getExtractionBySourceId.bind(item.store);
  const sourceSpy = spyOn(item.store, 'getSource').mockImplementation(id => { calls.push('source'); return sourceRead(id); });
  const nodeSpy = spyOn(item.store, 'getNode').mockImplementation(id => { calls.push('node'); return nodeRead(id); });
  const extractionSpy = spyOn(item.store, 'getExtractionBySourceId').mockImplementation(id => { calls.push('extraction'); return extractionRead(id); });
  try {
    watch(item, 'source', guard); watch(item, 'node', guard); watch(item, 'extraction', guard);
    guard.watch('owner', () => { calls.push('owner'); return true; });
    calls.length = 0;
    for (let pass = 0; pass < 3; pass++) guard.assertCurrent();
    expect(calls).toEqual(Array.from({ length: 3 }, () => ['source', 'node', 'extraction', 'owner']).flat());
  } finally { sourceSpy.mockRestore(); nodeSpy.mockRestore(); extractionSpy.mockRestore(); }
});

test.each(kinds.filter(kind => kind !== 'node'))('an in-place nested %s change cannot publish after the original record check', async kind => {
  const item = await fixture(), guard = watch(item, kind), target = nested(record(item, kind));
  let published = false;
  Object.defineProperty(target, 'label', { value: 'Changed meaning', enumerable: true, writable: true, configurable: true });
  expect(() => { guard.assertCurrent(); published = true; }).toThrow(KnowledgeSourceQualityHeldError);
  expect(published).toBe(false);
  Object.defineProperty(target, 'label', { value: 'Original meaning', enumerable: true, writable: true, configurable: true });
  expect(() => guard.assertCurrent()).not.toThrow();
});

test.each(kinds.filter(kind => kind !== 'node'))('every serialized primitive in the original %s remains current', async kind => {
  const item = await fixture(), guard = watch(item, kind), value = record(item, kind);
  const key = kind === 'extraction' ? 'excerpt' : 'title';
  Object.defineProperty(value, key, { value: 'Changed evidence', enumerable: true, writable: true, configurable: true });
  expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError);
});

test('a real immutable-node replacement retains the original complete expected node', async () => {
  const item = await fixture(), guard = watch(item, 'node');
  expect(Object.isFrozen(item.node)).toBe(true);
  const changed = { id: item.node.id, kind: 'ha_area', slug: item.node.slug, title: 'Changed area', status: 'active',
    metadata: { knowledgeSpaceId: 'default', nested: { label: 'Changed meaning' } } } satisfies Parameters<typeof upsertObservedKnowledgeNode>[1];
  await upsertObservedKnowledgeNode(item.store, changed, 'home-assistant-snapshot', changed, () => changed);
  expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError);
});

test('equal replacement getter results retain the original value baseline', async () => {
  const item = await fixture(), guard = watch(item, 'source');
  let current = structuredClone(item.source);
  const reading = spyOn(item.store, 'getSource').mockImplementation(() => current);
  try {
    expect(() => guard.assertCurrent()).not.toThrow();
    current = { ...current, title: 'Changed reference' };
    expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError);
    current = structuredClone(item.source);
    expect(() => guard.assertCurrent()).not.toThrow();
    current = { ...current, description: 'Different support' };
    expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError);
  } finally { reading.mockRestore(); }
});

test('a missing or mismatched first getter never replaces the supplied expected baseline', async () => {
  const item = await fixture(), guard = createSemanticWriteGuard(item.store);
  const reading = spyOn(item.store, 'getSource').mockImplementation(() => null);
  try { expect(() => guard.source(item.source.id, item.source)).toThrow(KnowledgeSourceQualityHeldError); }
  finally { reading.mockRestore(); }
  expect(() => guard.assertCurrent()).not.toThrow();
  expect(() => guard.source(item.source.id, { ...item.source, title: 'Unexpected baseline' })).toThrow(KnowledgeSourceQualityHeldError);
  Object.defineProperty(item.source, 'title', { value: 'Unexpected baseline', enumerable: true, writable: true, configurable: true });
  expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError);
});

test('an initial serialization hook cannot adopt the content it changed after returning the original value', async () => {
  const item = await fixture(), expected = structuredClone(item.source), guard = createSemanticWriteGuard(item.store);
  Object.defineProperty(item.source, 'toJSON', { enumerable: true, configurable: true, value() {
    Reflect.deleteProperty(item.source, 'toJSON');
    Object.defineProperty(item.source, 'title', { value: 'Hidden changed reference', enumerable: true, writable: true, configurable: true });
    return expected;
  } });
  guard.source(item.source.id, expected);
  expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError);
});

test('late inherited object and array serialization hooks keep the full original comparison', async () => {
  for (const prototype of [Object.prototype, Array.prototype]) {
    const item = await fixture(), guard = watch(item, 'source');
    const previous = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
    try {
      Object.defineProperty(prototype, 'toJSON', { configurable: true, value() { return 'Changed serialized support'; } });
      expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError);
    } finally { if (previous) Object.defineProperty(prototype, 'toJSON', previous); else Reflect.deleteProperty(prototype, 'toJSON'); }
  }
});

test('a serialization hook in a changed array ancestor cannot inherit original record slots', async () => {
  const item = await fixture(), guard = watch(item, 'source');
  const expected = JSON.stringify(item.source), parent = Object.getPrototypeOf(Array.prototype);
  let current: string | undefined, held: unknown;
  try {
    Object.setPrototypeOf(Array.prototype, { toJSON(this: unknown) { return this === item.source.tags ? 'Changed serialized tags' : this; } });
    current = JSON.stringify(item.source);
    try { guard.assertCurrent(); } catch (error) { held = error; }
  } finally { Object.setPrototypeOf(Array.prototype, parent); }
  expect(current).not.toBe(expected);
  expect(held).toBeInstanceOf(KnowledgeSourceQualityHeldError);
});

test('a replaced serializer runs the full comparison and cannot hide a record changed inside it', async () => {
  const item = await fixture(), guard = watch(item, 'source'), stringify = JSON.stringify;
  let observed = 0;
  const serializer = spyOn(JSON, 'stringify').mockImplementation(value => {
    observed++;
    Object.defineProperty(item.source, 'title', { value: 'Changed in serializer', enumerable: true, writable: true, configurable: true });
    return stringify(value);
  });
  try { expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError); expect(observed).toBeGreaterThan(0); }
  finally { serializer.mockRestore(); }
});

test('unsupported original JSON shapes retain the actual original serialization behavior', async () => {
  const item = await fixture();
  const date = new Date('2000-01-01T00:00:00Z');
  Object.defineProperty(item.source.metadata, 'date', { value: date, enumerable: true, configurable: true });
  const guard = watch(item, 'source');
  expect(() => guard.assertCurrent()).not.toThrow();
  date.setUTCFullYear(2001);
  expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError);
});

test('an accessor replacement executes the original comparison rather than inheriting old slots', async () => {
  const item = await fixture(), guard = watch(item, 'source'), target = nested(item.source); let reads = 0;
  Object.defineProperty(target, 'label', { enumerable: true, configurable: true, get() { reads++; return 'Changed from getter'; } });
  expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError);
  expect(reads).toBe(1);
});

test('array shape and named-property changes cannot conceal a changed serialized member', async () => {
  const item = await fixture(), guard = watch(item, 'source');
  Object.defineProperty(item.source.tags, 'metadata', { value: 'Named tail', enumerable: true, configurable: true });
  expect(() => guard.assertCurrent()).not.toThrow();
  Reflect.apply(Array.prototype.push, item.source.tags, ['Changed tag']);
  expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError);
});

test('arbitrary callbacks still execute and a changed earlier record holds at the next original check', async () => {
  const item = await fixture(), guard = watch(item, 'source'); let change = false, callbacks = 0;
  guard.watch('external-owner', () => {
    callbacks++;
    if (change) Object.defineProperty(item.source, 'title', { value: 'Changed by owner', enumerable: true, writable: true, configurable: true });
    return true;
  });
  callbacks = 0; change = true;
  guard.assertCurrent(); expect(callbacks).toBe(1);
  expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError);
  expect(callbacks).toBe(1);
});

test('signal and cooperative cancellation remain checked before typed record callbacks', async () => {
  for (const kind of ['signal', 'cooperative']) {
    const item = await fixture(), controller = new AbortController(); let stop = false;
    const guard = watch(item, 'source', createSemanticWriteGuard(item.store, controller.signal, () => stop));
    const reading = spyOn(item.store, 'getSource');
    try {
      if (kind === 'signal') controller.abort(); else stop = true;
      expect(() => guard.assertCurrent()).toThrow(KnowledgeSourceQualityHeldError);
      expect(reading).not.toHaveBeenCalled();
    } finally { reading.mockRestore(); }
  }
});

test('a callback replacing and restoring the physical file still retires the current native frame', async () => {
  const item = await fixture(), guard = watch(item, 'source'); let replace = false;
  const original = readFileSync(item.filename);
  guard.watch('external-file-owner', () => {
    if (replace) { const substitute = join(item.root, 'replacement.sqlite'); copyFileSync(item.filename, substitute); renameSync(substitute, item.filename); }
    return true;
  });
  replace = true;
  expect(() => item.store.assertRecordSnapshotFrame(() => {
    item.store.getSourceGeneration(item.source.id);
    guard.assertCurrent();
  })).toThrow();
  expect(readFileSync(item.filename)).toEqual(original);
});

test('a callback native update and rollback ABA cannot publish through typed record equality', async () => {
  const item = await fixture(), guard = watch(item, 'source'); let mutate = false;
  guard.watch('external-sql-owner', () => {
    if (mutate) {
      const sqlite: unknown = Reflect.get(item.store, 'sqlite');
      if (!sqlite || typeof sqlite !== 'object') throw new Error('Native sqlite missing');
      const getDb: unknown = Reflect.get(sqlite, 'getDb');
      if (typeof getDb !== 'function') throw new Error('Native getter missing');
      const db: unknown = Reflect.apply(getDb, sqlite, []);
      if (!db || typeof db !== 'object') throw new Error('Native database missing');
      const run: unknown = Reflect.get(db, 'run');
      if (typeof run !== 'function') throw new Error('Native writer missing');
      Reflect.apply(run, db, ['BEGIN']);
      Reflect.apply(run, db, ["UPDATE knowledge_sources SET title='Changed native reference' WHERE id='source'"]);
      Reflect.apply(run, db, ['ROLLBACK']);
    }
    return true;
  });
  mutate = true;
  expect(() => item.store.assertRecordSnapshotFrame(() => {
    item.store.getSourceGeneration(item.source.id);
    guard.assertCurrent();
  })).toThrow(KnowledgeSourceQualityHeldError);
  expect(item.store.getSourceSnapshot({ id: item.source.id }).source?.title).toBe(item.source.title);
});
