import { captureKnowledgeSourceReferences, registerGeneratedKnowledgeSourceReferences } from '../sdk/src/platform/knowledge/source-structural-references.js';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertJudgmentInput } from '../sdk/src/platform/gate/judgment-input.js';
import type { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { prepareKnowledgeRecordAdmission } from '../sdk/src/platform/knowledge/store-record-snapshot.js';
import { knowledgeRawRepresentation, knowledgeSourceCrawledNow, knowledgeSearchStamp, retainKnowledgeRepresentation, sameKnowledgeRecord, isKnowledgeClock } from '../sdk/src/platform/knowledge/store-record-representation.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';

// A deliberately adversarial, valid 13-digit payment-card number, also within
// JavaScript's epoch range. This clock exposes collisions; it does not mask them.
const collision = 4_222_222_222_222;
const roots: string[] = [];
const stores: KnowledgeStore[] = [];
let clock: { mockRestore(): void } | undefined;
afterEach(async () => {
  clock?.mockRestore(); clock = undefined;
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-clock-admission-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store); await store.init();
  return { store, root };
}
function sourceInput(id = 'source') { return { id, connectorId: 'clock-test', sourceType: 'document' as const,
  status: 'indexed' as const, title: 'Router operations', metadata: { knowledgeSpaceId: 'default' } }; }
async function records(store: KnowledgeStore) {
  const source = await store.upsertSource(knowledgeSourceCrawledNow(sourceInput()));
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'clock-test', format: 'text',
    sections: ['Router operations reference'], metadata: { knowledgeSpaceId: 'default' } });
  const node = await seedHomeAssistantObservation(store, { id: 'device', kind: 'ha_device', slug: 'router', title: 'Router',
    status: 'active', metadata: { knowledgeSpaceId: 'default' } });
  return { source, extraction, node };
}
test('generated colliding clocks persist as ISO; source, extraction, node and review views remain numeric', async () => {
  expect(() => assertJudgmentInput(collision)).toThrow();
  clock = spyOn(Date, 'now').mockReturnValue(collision);
  const { store } = await fixture(); const rows = await records(store);
  for (const [kind, record] of [['source', rows.source], ['extraction', rows.extraction], ['node', rows.node]] as const) {
    expect(record.createdAt).toBe(collision); expect(record.updatedAt).toBe(collision);
    expect(() => prepareKnowledgeRecordAdmission(store, kind, record).assertCurrent()).not.toThrow();
  }
  const source = store.getSourceSnapshot({ id: rows.source.id });
  expect(source.raw?.created_at).toBe(new Date(collision).toISOString());
  expect(source.raw?.last_crawled_at).toBe(new Date(collision).toISOString());
  const rawNode = store.getRecordSnapshot('node', rows.node.id);
  expect(JSON.parse(String(rawNode.raw?.metadata)).reviewProvenance.decidedAt).toBe(new Date(collision).toISOString());
  expect((rows.node.metadata.reviewProvenance as { decidedAt: number }).decidedAt).toBe(collision);
  const revision = store.listNodeRevisions(rows.node.id)[0]!;
  expect(revision.nodeCreatedAt).toBe(collision); expect(revision.recordedAt).toBe(collision);
  expect(knowledgeRawRepresentation(revision).recordedAt as unknown).toBe(new Date(collision).toISOString());
});
test('reopening retains raw admission and exact public numeric metadata/revisions', async () => {
  clock = spyOn(Date, 'now').mockReturnValue(collision);
  const { store, root } = await fixture(); const rows = await records(store); await store.close();
  const reopened = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(reopened); await reopened.init();
  const source = reopened.getSource(rows.source.id)!, node = reopened.getNode(rows.node.id)!;
  expect(() => prepareKnowledgeRecordAdmission(reopened, 'source', source)).not.toThrow();
  expect(() => prepareKnowledgeRecordAdmission(reopened, 'node', node)).not.toThrow();
  expect((node.metadata.reviewProvenance as { decidedAt: number }).decidedAt).toBe(collision);
  expect(reopened.listNodeRevisions(node.id)[0]?.recordedAt).toBe(collision);
});
test('caller clock fields and arbitrary replacement numeric values remain original and held', async () => {
  clock = spyOn(Date, 'now').mockReturnValue(collision);
  const { store } = await fixture();
  const source = await store.upsertSource({ ...sourceInput(), lastCrawledAt: collision });
  expect(store.getSourceSnapshot({ id: source.id }).raw?.last_crawled_at).toBe(collision);
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', source)).toThrow();
  const clean = await store.upsertSource(sourceInput('replacement'));
  await store.replaceSourceRecord({ ...clean, createdAt: collision, updatedAt: collision });
  const restored = store.getSource(clean.id)!;
  expect(store.getSourceSnapshot({ id: clean.id }).raw?.created_at).toBe(collision);
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', restored)).toThrow();
  const next = await store.upsertSource({ ...sourceInput(clean.id), title: 'Updated title' });
  expect(store.getSourceSnapshot({ id: next.id }).raw?.created_at).toBe(collision);
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', next)).toThrow();
});
test('equal-content clones, unknown extra tails and arbitrary numeric metadata never gain provenance', async () => {
  clock = spyOn(Date, 'now').mockReturnValue(collision);
  const { store } = await fixture(); const rows = await records(store);
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', { ...rows.source })).toThrow();
  Object.assign(rows.source, { unselectedTail: `do not transmit ${collision}` });
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', rows.source)).toThrow();
  const untrusted = await store.upsertSource({ ...sourceInput('untrusted'), metadata: { createdAt: collision,
    reviewProvenance: { decidedAt: collision }, nested: { lastCrawledAt: collision } } });
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', untrusted)).toThrow();
});
test('generation proof is invalidated by equal-value replacement and never revived by an old object', async () => {
  const { store } = await fixture(); const source = await store.upsertSource(sourceInput());
  const admission = prepareKnowledgeRecordAdmission(store, 'source', source);
  await store.replaceSourceRecord(source);
  expect(() => admission.assertCurrent()).toThrow();
  expect(store.getSource(source.id)).not.toBe(source);
});
test('original decoded JSON is scanned in addition to SQL bytes; canonical aliases are strict', async () => {
  const { store } = await fixture();
  const source = await store.upsertSource({ ...sourceInput(), metadata: { secretTail: String(collision) } });
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', source)).toThrow();
  for (const value of ['0x1234', '2026-10-10', '2026-10-10T00:00:00Z', '1760000000000', NaN, Infinity, 0.25]) expect(isKnowledgeClock(value)).toBe(false);
  expect(isKnowledgeClock('2026-10-10T00:00:00.000Z')).toBe(true);
});
test('prepared ingest transports only original owned clocks; ordinary imported numeric caller clocks stay held', async () => {
  clock = spyOn(Date, 'now').mockReturnValue(collision);
  const { store } = await fixture();
  await store.applyPreparedIngest({ sources: [knowledgeSourceCrawledNow(sourceInput())], extractions: [], nodes: [], edges: [], issues: [] },
    async () => ({ nodes: [], edges: [], issues: [] }));
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', store.getSource('source')!)).not.toThrow();
  await store.applyImport({ sources: [{ ...sourceInput('imported'), lastCrawledAt: collision }], extractions: [], nodes: [], edges: [], issues: [] });
  expect(store.getSourceSnapshot({ id: 'imported' }).raw?.last_crawled_at).toBe(collision);
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', store.getSource('imported')!)).toThrow();
});

test('raw SQL extra columns and escaped JSON tails are screened without mapper loss', async () => {
  const { store, root } = await fixture(); const source = await store.upsertSource(sourceInput());
  const sql = (store as unknown as { sqlite: SQLiteStore }).sqlite;
  sql.run('ALTER TABLE knowledge_sources ADD COLUMN unprojected_tail TEXT');
  sql.run('UPDATE knowledge_sources SET unprojected_tail = ? WHERE id = ?', [String(collision), source.id]);
  await sql.save();
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', source)).toThrow();
  sql.run('UPDATE knowledge_sources SET unprojected_tail = NULL, metadata = ? WHERE id = ?',
    ['{"secretTail":"' + [...String(collision)].map(character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"}', source.id]);
  await sql.save(); await store.close();
  const reopened = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(reopened); await reopened.init();
  expect(() => prepareKnowledgeRecordAdmission(reopened, 'source', reopened.getSource(source.id)!)).toThrow();
});
test('raw generation guards detect changes invisible to the numeric mapped view', async () => {
  const { store } = await fixture(); const source = await store.upsertSource(sourceInput());
  const admitted = prepareKnowledgeRecordAdmission(store, 'source', source);
  const sql = (store as unknown as { sqlite: SQLiteStore }).sqlite;
  sql.run('ALTER TABLE knowledge_sources ADD COLUMN owner_comment TEXT');
  sql.run('UPDATE knowledge_sources SET owner_comment = ? WHERE id = ?', ['changed', source.id]);
  await sql.save();
  expect(store.getSource(source.id)).toBe(source);
  expect(() => admitted.assertCurrent()).toThrow();
});

test('complete representation binding preserves named array extras, holes and undefined key sets', async () => {
  expect(sameKnowledgeRecord(new Array(1), [undefined])).toBe(false);
  expect(sameKnowledgeRecord([undefined], [null])).toBe(false);
  expect(sameKnowledgeRecord({}, { extra: undefined })).toBe(false);
  const { store } = await fixture();
  const source = await store.upsertSource({ ...sourceInput(), metadata: { values: ['visible'] } });
  const admitted = prepareKnowledgeRecordAdmission(store, 'source', source);
  const values = source.metadata.values as string[];
  Object.assign(values, { privateTail: 'Authorization: Bearer protected-array-tail' });
  expect((knowledgeRawRepresentation(values) as unknown as { privateTail: string }).privateTail).toContain('protected-array-tail');
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', source)).toThrow();
  expect(() => admitted.assertCurrent()).toThrow();
});
test('array accessors and symbols hold without invoking caller getters', async () => {
  for (const kind of ['accessor', 'symbol']) {
    const { store } = await fixture();
    const source = await store.upsertSource({ ...sourceInput(), metadata: { values: ['visible'] } });
    const values = source.metadata.values as string[]; let calls = 0;
    if (kind === 'accessor') Object.defineProperty(values, 'privateTail', { enumerable: true, get() { calls++; return 'Authorization: Bearer protected'; } });
    else Object.defineProperty(values, Symbol('privateTail'), { value: 'Authorization: Bearer protected' });
    expect(() => prepareKnowledgeRecordAdmission(store, 'source', source)).toThrow();
    expect(calls).toBe(0);
  }
});
test('ordinary large and Date metadata retains storage behavior; strict admission still holds', async () => {
  const { store, root } = await fixture();
  const source = await store.upsertSource({ ...sourceInput(), metadata: { text: 'x'.repeat(1_000_001), dated: new Date('2026-10-10T00:00:00.000Z') } });
  const raw = store.getSourceSnapshot({ id: source.id }).raw!;
  expect(JSON.parse(String(raw.metadata)).dated).toBe('2026-10-10T00:00:00.000Z');
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', source)).toThrow();
  await store.close(); const reopened = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(reopened); await reopened.init();
  expect((reopened.getSource(source.id)!.metadata.text as string).length).toBe(1_000_001);
});
test('ordinary over-budget node metadata hydration does not become a new store-wide rejection', async () => {
  const { store, root } = await fixture(); const { node } = await records(store);
  const sql = (store as unknown as { sqlite: SQLiteStore }).sqlite;
  const raw = store.getRecordSnapshot('node', node.id).raw!;
  sql.run('UPDATE knowledge_nodes SET metadata = ? WHERE id = ?', [JSON.stringify({ ...JSON.parse(String(raw.metadata)), text: 'x'.repeat(1_000_001) }), node.id]);
  await sql.save(); await store.close();
  const reopened = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(reopened); await reopened.init();
  expect((reopened.getNode(node.id)!.metadata.text as string).length).toBe(1_000_001);
  expect(() => prepareKnowledgeRecordAdmission(reopened, 'node', reopened.getNode(node.id)!)).toThrow();
});
test('raw transport does not itself invoke unsupported getter or toJSON behavior', () => {
  let calls = 0; const value = { get tail() { calls++; return 'value'; } };
  expect(knowledgeRawRepresentation(value)).toBe(value); expect(calls).toBe(0);
  expect(JSON.stringify(value)).toBe('{"tail":"value"}'); expect(calls).toBe(1);
});
test('owned repair-search stamp survives ordinary ingest copies while caller numeric searchedAt stays held', async () => {
  clock = spyOn(Date, 'now').mockReturnValue(collision);
  const { store } = await fixture();
  const metadata = structuredClone({ sourceDiscovery: knowledgeSearchStamp({ query: 'router operations' }) });
  const source = await store.upsertSource({ ...sourceInput(), metadata });
  expect((source.metadata.sourceDiscovery as { searchedAt: number }).searchedAt).toBe(collision);
  expect(JSON.parse(String(store.getSourceSnapshot({ id: source.id }).raw!.metadata)).sourceDiscovery.searchedAt).toBe(new Date(collision).toISOString());
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', source)).not.toThrow();
  const arbitrary = await store.upsertSource({ ...sourceInput('arbitrary-search'), metadata: { sourceDiscovery: { searchedAt: collision } } });
  expect(JSON.parse(String(store.getSourceSnapshot({ id: arbitrary.id }).raw!.metadata)).sourceDiscovery.searchedAt).toBe(collision);
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', arbitrary)).toThrow();
});

test('known structural references project immutably while original raw rows stay complete', async () => {
  const { store } = await fixture(); const canonicalUri = `homegraph://generated/${collision}`;
  const source = await store.upsertSource({ ...sourceInput(), canonicalUri });
  registerGeneratedKnowledgeSourceReferences(store, source, { id: source.id, canonicalUri });
  const proof = { source, extraction: null, proof: captureKnowledgeSourceReferences(store, source, null) };
  const raw = store.getSourceSnapshot({ id: source.id }).raw!;
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', source, proof)).not.toThrow();
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', source, { source, extraction: null, proof: {} })).toThrow();
  expect(raw.canonical_uri).toBe(canonicalUri);
  expect(store.getSourceSnapshot({ id: source.id }).raw!.canonical_uri).toBe(canonicalUri);
});

test('fresh source and extraction caches match persisted undefined-value normalization', async () => {
  clock = spyOn(Date, 'now').mockReturnValue(collision);
  const { store } = await fixture();
  const source = await store.upsertSource({ ...sourceInput(), metadata: { optional: undefined,
    sourceDiscovery: knowledgeSearchStamp({ providerId: undefined, sourceRank: undefined, query: 'router' }) } });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'fixture', format: 'text',
    metadata: { optional: undefined }, structure: { nested: { absent: undefined }, cells: [undefined] } });
  expect(Object.hasOwn(source.metadata, 'optional')).toBe(false);
  expect(Object.hasOwn(source.metadata.sourceDiscovery as object, 'providerId')).toBe(false);
  expect(extraction.structure.cells).toEqual([null]);
  expect(() => prepareKnowledgeRecordAdmission(store, 'source', source)).not.toThrow();
  expect(() => prepareKnowledgeRecordAdmission(store, 'extraction', extraction)).not.toThrow();
});
test('ordinary and prepared imports retain named caller-array tails rather than silently dropping them', async () => {
  for (const prepared of [false, true]) {
    const { store } = await fixture();
    const values = Object.assign(['visible'], { privateTail: 'Authorization: Bearer protected-import-tail' });
    const input = { sources: [{ ...sourceInput(), metadata: { values } }], extractions: [], nodes: [], edges: [], issues: [] };
    if (prepared) await store.applyPreparedIngest(input, async () => ({ nodes: [], edges: [], issues: [] }));
    else await store.applyImport(input);
    const source = store.getSource('source')!;
    expect((source.metadata.values as { privateTail: string }).privateTail).toContain('protected-import-tail');
    expect(() => prepareKnowledgeRecordAdmission(store, 'source', source)).toThrow();
  }
});
test('failed replacement proof binding revokes the old root entry', () => {
  const value = { clock: collision };
  retainKnowledgeRepresentation(value, { clock: new Date(collision).toISOString() });
  expect(knowledgeRawRepresentation(value).clock as unknown).toBe(new Date(collision).toISOString());
  retainKnowledgeRepresentation(value, { unsupported: Symbol('not-json') });
  expect(knowledgeRawRepresentation(value).clock).toBe(collision);
});
