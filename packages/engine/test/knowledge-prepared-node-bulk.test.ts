import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { SQLiteStore, type SqlDatabase } from '../sdk/src/platform/state/sqlite-store.js';
import { KnowledgeNodeActivationHeldError as Held, type KnowledgeNodeActivationOptions } from '../sdk/src/platform/knowledge/activation/types.js';
import { KnowledgeRecordAdmissionHeldError } from '../sdk/src/platform/knowledge/store-record-snapshot.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { markPreparedNodeWritten, preparedNodeWrite, preparedNodeWrites, prepareNodeActivationPass, type NodeMutationDraft } from '../sdk/src/platform/knowledge/store-node-activation.js';

const roots: string[] = [], stores: KnowledgeStore[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port); });
afterEach(async () => {
  installJudgmentPort(previous);
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function open(dbPath: string) {
  const store = new KnowledgeStore({ dbPath }); stores.push(store); await store.init(); return store;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prepared-node-bulk-')); roots.push(root);
  const init = SQLiteStore.prototype.init;
  let database: SqlDatabase | undefined;
  const capture = spyOn(SQLiteStore.prototype, 'init').mockImplementation(function (this: SQLiteStore, schema, options) {
    return init.call(this, db => { schema(db); database ??= db; }, options);
  });
  let store: KnowledgeStore;
  try { store = await open(join(root, 'knowledge.sqlite')); }
  finally { capture.mockRestore(); }
  if (!database) throw new Error('Missing native knowledge image');
  const drafts: NodeMutationDraft[] = [];
  for (const id of ['first', 'later']) {
    await store.upsertSource({ id: `source-${id}`, connectorId: 'fixture', sourceType: 'manual', title: `Device ${id} manual`, status: 'indexed' });
    await store.upsertExtraction({ id: `extraction-${id}`, sourceId: `source-${id}`, extractorId: 'fixture', format: 'text', excerpt: `Device ${id} has four HDMI inputs.` });
    const record = await store.upsertNode({ id, kind: 'fact', slug: id, title: `Device ${id} inputs`, summary: `Device ${id} has four HDMI inputs.`, sourceId: `source-${id}` });
    drafts.push({ input: record, existing: record, record, now: record.updatedAt, authority: false });
  }
  const scope = {};
  const prepare = (options: KnowledgeNodeActivationOptions = {}) => prepareNodeActivationPass(store, drafts, options, undefined, scope);
  return { store, database, drafts, scope, prepare };
}

test('bulk prepared nodes retain authentic owner, exact slots and one-use checks', async () => {
  const { store, scope, prepare } = await fixture();
  const prepared = await prepare(), before = store.listNodes();
  expect(() => preparedNodeWrites(store, { ...prepared }, scope)).toThrow(Held);
  const other = await fixture();
  expect(() => preparedNodeWrites(other.store, prepared, scope)).toThrow(Held);
  expect(() => preparedNodeWrites(store, prepared, {})).toThrow(Held);
  const nodes = preparedNodeWrites(store, prepared, scope);
  expect(nodes.map(({ record }) => record.id)).toEqual(['first', 'later']);
  expect(nodes).toEqual([preparedNodeWrite(store, prepared, 0, scope), preparedNodeWrite(store, prepared, 1, scope)]);
  expect(store.listNodes()).toEqual(before);
  markPreparedNodeWritten(prepared, 1);
  expect(() => preparedNodeWrites(store, prepared, scope)).toThrow(Held);
  expect(preparedNodeWrite(store, prepared, 0, scope).record.id).toBe('first');
});

test('bulk retrieval checks the complete later candidate evidence before returning any slots', async () => {
  const { store, scope, prepare } = await fixture();
  const prepared = await prepare(), before = store.listNodes();
  const later = store.getExtractionBySourceId('source-later');
  if (!later) throw new Error('Missing later extraction');
  Object.defineProperty(later, 'excerpt', { value: 'Changed complete later evidence', enumerable: true, writable: true, configurable: true });
  expect(() => preparedNodeWrites(store, prepared, scope)).toThrow(Held);
  expect(store.listNodes()).toEqual(before);
});

test('the exit guard rechecks mutable complete evidence changed by the original caller', async () => {
  const { store, scope, prepare } = await fixture();
  let collect = false, calls = 0;
  const prepared = await prepare({ assertCurrent() {
    if (!collect || ++calls !== 2) return;
    const later = store.getSource('source-later');
    if (!later) throw new Error('Missing later source');
    later.metadata.changedByOriginalOwner = 'Replacement during exit';
  } });
  collect = true;
  expect(() => preparedNodeWrites(store, prepared, scope)).toThrow(Held);
  expect(calls).toBe(2);
  expect(store.listNodeRevisions('later')).toHaveLength(1);
});

test('consuming a slot in the original exit callback retires the collected pass', async () => {
  const { store, scope, prepare } = await fixture();
  let collect = false, calls = 0, consume = () => {};
  const prepared = await prepare({ assertCurrent() {
    if (collect && ++calls === 2) consume();
  } });
  consume = () => markPreparedNodeWritten(prepared, 1);
  collect = true;
  expect(() => preparedNodeWrites(store, prepared, scope)).toThrow(Held);
  expect(calls).toBe(2);
  expect(store.listNodeRevisions('later')).toHaveLength(1);
});

test('a real separate persisted writer retires the full original prepared evidence', async () => {
  const { store, scope, prepare } = await fixture();
  const original = store.getSourceGeneration('source-later');
  const prepared = await prepare({ assertCurrent() {
    store.assertRecordSnapshotFrame(() => {
      if (store.getSourceGeneration('source-later') !== original) throw new Held('stale');
    });
  } });
  const writer = await open(store.storagePath);
  const later = writer.getSource('source-later');
  if (!later) throw new Error('Missing persisted source');
  await writer.replaceSourceRecord({ ...later, summary: 'Separate writer replacement' });
  expect(() => preparedNodeWrites(store, prepared, scope)).toThrow(Held);
  expect(store.getSource('source-later')?.summary).toBeUndefined();
  expect(store.getSourceSnapshot({ id: 'source-later' }).source?.summary).toBe('Separate writer replacement');
});

test('native replacement and restore during the exit callback cannot publish a bulk result', async () => {
  const { store, database, scope, prepare } = await fixture();
  let collect = false, calls = 0;
  const prepared = await prepare({ assertCurrent() {
    store.assertRecordSnapshotFrame(() => {
      store.getSourceGeneration('source-later');
      if (!collect || ++calls !== 2) return;
      database.run('UPDATE knowledge_sources SET summary = ? WHERE id = ?', ['Temporary native replacement', 'source-later']);
      database.run('UPDATE knowledge_sources SET summary = NULL WHERE id = ?', ['source-later']);
    });
  } });
  collect = true;
  expect(() => preparedNodeWrites(store, prepared, scope)).toThrow(KnowledgeRecordAdmissionHeldError);
  expect(calls).toBe(2);
  expect(store.getSourceSnapshot({ id: 'source-later' }).source?.summary).toBeUndefined();
});

test('a protected later draft still holds the entire preparation before a request', async () => {
  const { store, scope, drafts } = await fixture();
  const later = drafts[1];
  if (!later) throw new Error('Missing later draft');
  const record = { ...later.record, summary: 'api_key=synthetic-private-later-input' };
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  await expect(prepareNodeActivationPass(store, [drafts[0]!, { ...later, input: record, record }], {}, undefined, scope)).rejects.toBeInstanceOf(JudgmentInputError);
  expect(fake.requests).toHaveLength(0);
  expect(store.listNodes()).toHaveLength(2);
});
