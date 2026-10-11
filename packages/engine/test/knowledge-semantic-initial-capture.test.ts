import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { canonicalRepairSubjectNodes } from '../sdk/src/platform/knowledge/semantic/repair-subjects.js';
import { prepareRepairSourceAuthorities } from '../sdk/src/platform/knowledge/semantic/repair-fact-selection.js';

const roots: string[] = [], stores: KnowledgeStore[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => {
  installJudgmentPort(previous);
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const spaceId = 'initial-repair-capture', text = 'AC-7 has four HDMI inputs.';
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'semantic-initial-capture-')); roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite'), store = new KnowledgeStore({ dbPath }); stores.push(store);
  const observed = { id: 'device', kind: 'ha_device' as const, slug: 'ac-seven', title: 'AC-7', status: 'active' as const,
    metadata: { knowledgeSpaceId: spaceId, model: 'AC-7' } };
  const subject = await upsertObservedKnowledgeNode(store, observed, 'home-assistant-snapshot', observed, () => observed);
  const research = { id: 'gap', kind: 'knowledge_gap' as const, slug: 'gap', title: 'How many HDMI inputs does AC-7 have?', status: 'active' as const,
    metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [subject.id] } };
  const gap = await upsertObservedKnowledgeNode(store, research, 'research-task', research, () => research);
  const source = await store.upsertSource({ id: 'manual', connectorId: 'synthetic', sourceType: 'manual', title: 'AC-7 specifications',
    canonicalUri: 'https://example.test/ac-seven', status: 'indexed', metadata: { knowledgeSpaceId: spaceId, privateMarker: 'DO_NOT_TRANSMIT' } });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: text,
    sections: [], metadata: { knowledgeSpaceId: spaceId } });
  return { store, dbPath, subject, gap, source, extraction };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function native(store: KnowledgeStore): SQLiteStore {
  const sqlite: unknown = Reflect.get(store, 'sqlite');
  if (!(sqlite instanceof SQLiteStore)) throw new Error('Expected the actual native store.');
  return sqlite;
}
function readings() {
  const fake = fakePort((name, question) => {
    if (name === 'authority') return choiceAnswer(question, 'secondary', 0.99);
    if (['repairSubjectSelected', 'supported', 'attached', 'serve'].includes(name)) return noulAnswer(0.99);
    throw new Error(`Unscripted initial capture question ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
type Mode = 'authority' | 'subjects';
function prepare(mode: Mode, item: Fixture, signal?: AbortSignal) {
  return mode === 'authority'
    ? prepareRepairSourceAuthorities({ store: item.store, spaceId, gap: item.gap, subjects: [item.subject],
      sources: [{ source: item.source, extraction: item.extraction, text }], signal })
    : canonicalRepairSubjectNodes({ store: item.store, spaceId, nodes: [item.subject], excludedNodeIds: [],
      evidenceSources: [item.source], context: { gap: item.gap }, text, signal });
}
function observeCaptures(store: KnowledgeStore) {
  const sqlite = native(store), descriptor = Object.getOwnPropertyDescriptor(sqlite, 'openCurrentImage');
  const originalOpen: unknown = Reflect.get(sqlite, 'openCurrentImage');
  if (typeof originalOpen !== 'function') throw new Error('Missing actual private image constructor.');
  let images = 0;
  const measuredOpen = function (...args: unknown[]) { images++; return Reflect.apply(originalOpen, sqlite, args); };
  Reflect.set(sqlite, 'openCurrentImage', measuredOpen);
  const events: { kind: string; id: string; before: number; after: number }[] = [];
  const record = store.getRecordSnapshot.bind(store), source = store.getSourceSnapshot.bind(store);
  const recordSpy = spyOn(store, 'getRecordSnapshot').mockImplementation((kind, id) => {
    const before = images, result = record(kind, id); events.push({ kind, id, before, after: images }); return result;
  });
  const sourceSpy = spyOn(store, 'getSourceSnapshot').mockImplementation(input => {
    const before = images, result = source(input); events.push({ kind: 'source', id: 'id' in input ? input.id : input.canonicalUri, before, after: images }); return result;
  });
  return { events, count: () => images, restore() {
    recordSpy.mockRestore(); sourceSpy.mockRestore();
    if (Reflect.get(sqlite, 'openCurrentImage') !== measuredOpen) throw new Error('Observed image constructor changed.');
    if (descriptor) Object.defineProperty(sqlite, 'openCurrentImage', descriptor); else Reflect.deleteProperty(sqlite, 'openCurrentImage');
  } };
}

test.each(['authority', 'subjects'] as const)('%s initial complete admissions share one image and later assertions open a fresh image', async mode => {
  const item = await fixture(), fake = readings(), captures = observeCaptures(item.store);
  try {
    const prepared = await prepare(mode, item);
    const expected = mode === 'authority'
      ? [['node', item.gap.id], ['node', item.subject.id], ['source', item.source.id], ['extraction', item.extraction.id]]
      : [['source', item.source.id], ['extraction', item.extraction.id], ['node', item.subject.id], ['node', item.gap.id]];
    expect(captures.events.map(({ kind, id }) => [kind, id])).toEqual(expected);
    expect(captures.events[0]!.after - captures.events[0]!.before).toBe(1);
    expect(new Set(captures.events.map(event => event.after)).size).toBe(1);
    const images = captures.count(); prepared.assertCurrent(); expect(captures.count()).toBeGreaterThan(images);
    expect(JSON.stringify(fake.requests)).not.toContain('DO_NOT_TRANSMIT');
  } finally { captures.restore(); }
});

for (const mode of ['authority', 'subjects'] as const) test.each(['file-replacement', 'native-rollback', 'abort'] as const)(
  `${mode} initial capture rejects %s before semantic dispatch`, async mutation => {
    const item = await fixture(), fake = readings(), controller = new AbortController();
    const original = item.store.getRecordSnapshot.bind(item.store); let changed = false;
    const observer = spyOn(item.store, 'getRecordSnapshot').mockImplementation((kind, id) => {
      const result = original(kind, id);
      if (!changed) {
        changed = true;
        if (mutation === 'file-replacement') {
          copyFileSync(item.dbPath, `${item.dbPath}.replacement`); renameSync(`${item.dbPath}.replacement`, item.dbPath);
        } else if (mutation === 'native-rollback') {
          const sqlite = native(item.store);
          sqlite.run('BEGIN'); sqlite.run('UPDATE knowledge_nodes SET title=? WHERE id=?', ['Temporary unrelated meaning', id]); sqlite.run('ROLLBACK');
        } else controller.abort();
      }
      return result;
    });
    try {
      await expect(prepare(mode, item, controller.signal)).rejects.toMatchObject({ reason: mutation === 'abort' ? 'aborted' : 'stale' });
      expect(changed).toBe(true); expect(fake.requests).toHaveLength(0);
    } finally { observer.mockRestore(); }
  });

test.each(['authority', 'subjects'] as const)('%s cannot adopt empty results from a frame that ignores its callback', async mode => {
  const item = await fixture(), fake = readings();
  const observer = spyOn(item.store, 'assertRecordSnapshotFrame').mockImplementation(() => undefined);
  try {
    await expect(prepare(mode, item)).rejects.toMatchObject({ reason: 'stale' }); expect(fake.requests).toHaveLength(0);
  } finally { observer.mockRestore(); }
});
