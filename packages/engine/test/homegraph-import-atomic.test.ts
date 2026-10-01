import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import type { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { KnowledgeNodeActivationHeldError as Held } from '../sdk/src/platform/knowledge/activation/types.js';
import { importHomeGraphSpace } from '../sdk/src/platform/knowledge/home-graph/import-export.js';
import { buildHomeGraphMetadata } from '../sdk/src/platform/knowledge/home-graph/helpers.js';
import type { HomeGraphExport } from '../sdk/src/platform/knowledge/home-graph/types.js';
import { reviewKnowledgeNodeRecord } from '../sdk/src/platform/knowledge/service-node-admin.js';
import { createKnowledgeIssueOperatorMutation } from '../sdk/src/platform/knowledge/store-lifecycle-authority.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';

const spaceId = 'homeassistant:import-test', installationId = 'import-test';
const roots: string[] = [], opened: KnowledgeStore[] = [];
let previous: JudgmentPort | undefined;
const sqlite = (store: KnowledgeStore) => (store as unknown as { sqlite: SQLiteStore }).sqlite;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => {
  installJudgmentPort(previous);
  opened.splice(0).forEach((store) => sqlite(store).close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function reading(probability = 0.99) {
  const fake = fakePort(() => noulAnswer(probability)); installJudgmentPort(fake.port); return fake;
}
function state(store: KnowledgeStore) {
  const byId = <T extends { id: string }>(rows: T[]) => rows.sort((left, right) => left.id.localeCompare(right.id));
  return { sources: byId(store.listSources()), extractions: byId(store.listExtractions()), nodes: byId(store.listNodes()),
    edges: byId(store.listEdges()), issues: byId(store.listIssues()),
    revisions: byId(store.listNodes()).map((node) => store.listNodeRevisions(node.id)) };
}
async function held(promise: Promise<unknown>, reason: Held['reason']) {
  let error: unknown; try { await promise; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Held); expect((error as Held).reason).toBe(reason);
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'homegraph-import-')); roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath }); opened.push(store); await store.init();
  const metadata = buildHomeGraphMetadata(spaceId, installationId, { taint: 'external' });
  await store.upsertSource({ id: 'manual', connectorId: 'synthetic', sourceType: 'manual', title: 'Old manual', status: 'indexed', metadata });
  await store.upsertExtraction({ id: 'extract', sourceId: 'manual', extractorId: 'synthetic', format: 'text', excerpt: 'Old device label.', metadata });
  const node = await seedHomeAssistantObservation(store, { id: 'device', kind: 'ha_device', slug: 'device', title: 'Old device',
    sourceId: 'manual', status: 'active', metadata });
  await store.upsertEdge({ fromKind: 'source', fromId: 'manual', toKind: 'node', toId: node.id, relation: 'source_for', metadata });
  await store.upsertIssue({ id: 'issue', severity: 'warning', code: 'fixture', message: 'Old issue', nodeId: node.id, metadata });
  const data: HomeGraphExport = { version: 1, exportedAt: 1, spaceId, installationId,
    sources: store.listSources().map((row) => ({ ...row, title: 'New manual', metadata: { ...row.metadata, provenance: 'imported reference' } })),
    extractions: store.listExtractions().map((row) => ({ ...row, excerpt: 'New device label from updated manual.' })),
    nodes: [{ ...node, title: 'New device' }],
    edges: store.listEdges().map((row) => ({ ...row, weight: 2 })),
    issues: store.listIssues().map((row) => ({ ...row, message: 'New issue' })) };
  const run = (next = data, options: Parameters<typeof importHomeGraphSpace>[2] = {}) => importHomeGraphSpace(store, { spaceId, installationId, data: next }, options);
  const reopen = async () => {
    sqlite(store).close();
    const reopened = new KnowledgeStore({ dbPath }); opened.push(reopened); await reopened.init(); return reopened;
  };
  return { store, dbPath, data, run, reopen };
}

describe('atomic Home Graph import', () => {
  for (const mode of ['unconfigured', 'uncertain', 'unavailable'] as const) {
    test(`${mode} activation retains every live and reopened record and revision`, async () => {
      const { store, dbPath, run, reopen } = await fixture();
      const before = state(store), bytes = readFileSync(dbPath);
      if (mode === 'uncertain') reading(0.5);
      if (mode === 'unavailable') { const fake = reading(); installJudgmentPort({ ...fake.port, ask: async () => { throw new Error('fixture unavailable'); } }); }
      await held(run(), mode);
      expect(state(store)).toEqual(before); expect(readFileSync(dbPath)).toEqual(bytes);
      expect(state(await reopen())).toEqual(before);
    });
  }
  test('a later held candidate prevents earlier source, extraction, node, edge and issue writes', async () => {
    const { store, dbPath, data, run, reopen } = await fixture();
    const second = await seedHomeAssistantObservation(store, { ...store.getNode('device')!, id: 'second', slug: 'second', title: 'Second old device' });
    const before = state(store), bytes = readFileSync(dbPath);
    const fake = fakePort((_name, _question, request) => noulAnswer((request as { candidate: { title: string } }).candidate.title === 'Second new device' ? 0.5 : 0.99));
    installJudgmentPort(fake.port);
    await held(run({ ...data, nodes: [...data.nodes, { ...second, title: 'Second new device' }] }), 'uncertain');
    expect(fake.requests).toHaveLength(2); expect(state(store)).toEqual(before); expect(readFileSync(dbPath)).toEqual(bytes);
    expect(state(await reopen())).toEqual(before);
  });
  test('judgment sees proposed evidence while live and on-disk records remain unchanged', async () => {
    const { store, dbPath, run, reopen } = await fixture(); const before = state(store), bytes = readFileSync(dbPath);
    const fake = reading();
    installJudgmentPort({ ...fake.port, async ask(request) {
      expect(state(store)).toEqual(before); expect(readFileSync(dbPath)).toEqual(bytes);
      const text = JSON.stringify(request.state); expect(text).toContain('New manual'); expect(text).toContain('New device label from updated manual.');
      return fake.port.ask(request);
    } });
    const result = await run(); expect(result.imported).toEqual({ sources: 1, extractions: 1, nodes: 1, edges: 1, issues: 1 });
    const current = store.getNode('device')!;
    expect(current.title).toBe('New device'); expect(current.status).toBe('active');
    expect(current.metadata.taint).toBe('external'); expect(current.metadata.review).toBeUndefined();
    expect(current.metadata.reviewProvenance).toMatchObject({ state: 'auto-accepted' });
    expect(current.metadata.nodeActivation).toMatchObject({ outcome: 'accepted', probability: 0.99, evidence: [{ sourceId: 'manual', extractionId: 'extract' }] });
    expect(store.listNodeRevisions('device')).toHaveLength(2);
    const after = state(store); expect(state(await reopen())).toEqual(after);
  });
  for (const change of ['source', 'operator', 'issue', 'cancel'] as const) {
    test(`${change} during judgment holds import and preserves the intervening state`, async () => {
      const { store, dbPath, run, reopen } = await fixture(); const fake = reading(); const controller = new AbortController();
      let release!: () => void, started!: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; }), entered = new Promise<void>((resolve) => { started = resolve; });
      installJudgmentPort({ ...fake.port, async ask(request) { started(); await wait; return fake.port.ask(request); } });
      const pending = run(undefined, { signal: controller.signal }); await entered;
      if (change === 'source') await store.upsertSource({ ...store.getSource('manual')!, title: 'Concurrent manual' });
      if (change === 'operator') await reviewKnowledgeNodeRecord(store, { id: 'device', decision: 'reject', reviewer: 'fixture operator' });
      if (change === 'issue') {
        const issue = store.getIssue('issue')!;
        await store.upsertIssue({ ...issue, status: 'resolved', metadata: { ...issue.metadata, review: { action: 'resolve', reviewer: 'fixture operator' } } }, createKnowledgeIssueOperatorMutation(issue));
      }
      const expected = state(store), bytes = readFileSync(dbPath);
      if (change === 'cancel') controller.abort();
      release(); await held(pending, change === 'cancel' ? 'aborted' : 'stale');
      expect(state(store)).toEqual(expected); expect(readFileSync(dbPath)).toEqual(bytes);
      expect(state(await reopen())).toEqual(expected);
    });
  }
  test('a later SQL failure rolls back all rows and leaves caches and disk untouched', async () => {
    const { store, dbPath, run, reopen } = await fixture(); reading();
    const before = state(store), bytes = readFileSync(dbPath), database = sqlite(store), originalRun = database.run.bind(database);
    database.run = (sql, params) => { if (sql.includes('INSERT OR REPLACE INTO knowledge_issues')) throw new Error('fixture late SQL failure'); originalRun(sql, params); };
    try { await expect(run()).rejects.toThrow('fixture late SQL failure'); }
    finally { database.run = originalRun; }
    expect(state(store)).toEqual(before); expect(readFileSync(dbPath)).toEqual(bytes);
    // Persist the actual in-memory SQL after rollback, then close/reopen it.
    await database.save(); expect(state(await reopen())).toEqual(before);
  });
  test('idempotent reviewed nodes and terminal issue authority survive a successful import', async () => {
    const { store, data, run, reopen } = await fixture();
    const reviewed = (await reviewKnowledgeNodeRecord(store, { id: 'device', decision: 'accept', reviewer: 'fixture operator' })).node!;
    const issue = store.getIssue('issue')!;
    const resolved = await store.upsertIssue({ ...issue, status: 'resolved', metadata: { ...issue.metadata, review: { action: 'resolve', reviewer: 'fixture operator' } } }, createKnowledgeIssueOperatorMutation(issue));
    await run({ ...data, nodes: [reviewed] });
    expect(store.getNode('device')!.metadata.review).toEqual(reviewed.metadata.review);
    expect(store.getNode('device')!.metadata.reviewProvenance).toEqual(reviewed.metadata.reviewProvenance);
    expect(store.getIssue('issue')).toEqual(resolved);
    const after = state(store); expect(state(await reopen())).toEqual(after);
  });
  test('a conflicting operator-reviewed node holds before changing imported evidence', async () => {
    const { store, dbPath, run, reopen } = await fixture();
    await reviewKnowledgeNodeRecord(store, { id: 'device', decision: 'accept', reviewer: 'fixture operator' });
    const before = state(store), bytes = readFileSync(dbPath); const fake = reading();
    await expect(run()).rejects.toMatchObject({ name: 'KnowledgeNodeMutationHeldError', reason: 'operator-reviewed' });
    expect(fake.requests).toHaveLength(0); expect(state(store)).toEqual(before); expect(readFileSync(dbPath)).toEqual(bytes);
    expect(state(await reopen())).toEqual(before);
  });
  test('changed evidence rereads an unchanged observed node and does not retain its stale observation', async () => {
    const { store, data, run, dbPath, reopen } = await fixture();
    const observed = await upsertObservedKnowledgeNode(store, { ...store.getNode('device')! }, 'home-assistant-snapshot', store.getSource('manual'), () => store.getSource('manual'));
    const next = { ...data, nodes: [observed] }, before = state(store), bytes = readFileSync(dbPath);
    await held(run(next), 'unconfigured');
    expect(state(store)).toEqual(before); expect(readFileSync(dbPath)).toEqual(bytes);
    const fake = reading(); await run(next); expect(fake.requests).toHaveLength(1);
    expect(JSON.stringify(fake.requests[0])).not.toContain('observedEvidence');
    const imported = store.getNode('device')!;
    expect(imported.title).toBe(observed.title); expect(imported.metadata.nodeObservation).toBeUndefined();
    expect(imported.metadata.nodeActivation).toMatchObject({ outcome: 'accepted' });
    const updated = await store.upsertNode({ ...imported, title: 'Later device label' });
    expect(updated.status).toBe('active'); expect(fake.requests).toHaveLength(2);
    const after = state(store); expect(state(await reopen())).toEqual(after);
  });
  test('an imported source-less catalog observation cannot hide its changed source dependency', async () => {
    const { store, data, run, dbPath, reopen } = await fixture();
    const catalog = await upsertObservedKnowledgeNode(store, { id: 'catalog', kind: 'topic', slug: 'catalog', title: 'Catalog topic',
      metadata: buildHomeGraphMetadata(spaceId, installationId) }, 'catalog-structure', store.getSource('manual'), () => store.getSource('manual'));
    const before = state(store), bytes = readFileSync(dbPath), fake = reading();
    await held(run({ ...data, nodes: [catalog] }), 'observation-revalidation');
    expect(fake.requests).toHaveLength(0); expect(state(store)).toEqual(before); expect(readFileSync(dbPath)).toEqual(bytes);
    // Independent extracted evidence can support a fresh reading, without the hidden old receipt.
    await run({ ...data, nodes: [{ ...catalog, sourceId: 'manual' }] });
    expect(store.getNode(catalog.id)!.metadata.nodeObservation).toBeUndefined();
    expect(store.getNode(catalog.id)!.metadata.nodeActivation).toMatchObject({ outcome: 'accepted' });
    await store.upsertNode({ ...store.getNode(catalog.id)!, title: 'Later catalog topic' });
    const after = state(store); expect(state(await reopen())).toEqual(after);
  });
  test('replaced evidence cannot borrow an old observation when new extraction has no text', async () => {
    const { store, data, run, dbPath, reopen } = await fixture(); const before = state(store), bytes = readFileSync(dbPath), fake = reading();
    await held(run({ ...data, extractions: data.extractions.map((row) => ({ ...row, id: 'empty-extraction', excerpt: '', sections: [], structure: {} })) }), 'observation-revalidation');
    expect(fake.requests).toHaveLength(0); expect(state(store)).toEqual(before); expect(readFileSync(dbPath)).toEqual(bytes);
    expect(state(await reopen())).toEqual(before);
  });
  test('a staged producer callback cannot grant authority through observation-shaped JSON', async () => {
    const { store, reopen } = await fixture();
    const copied = { ...store.getNode('device')!, id: 'copied-device', slug: 'copied-device' };
    await store.applyPreparedIngest({ sources: [], extractions: [], nodes: [], edges: [], issues: [] }, async () => ({ nodes: [copied], edges: [], issues: [] }));
    const node = store.getNode(copied.id)!;
    expect(node.status).toBe('draft'); expect(node.metadata.nodeObservation).toBeUndefined(); expect(node.metadata.review).toBeUndefined();
    expect(node.metadata.nodeActivation).toMatchObject({ outcome: 'pending-review', reason: 'unconfigured' });
    const after = state(store); expect(state(await reopen())).toEqual(after);
  });
  test('the producer graph guard is rechecked after activation and before any import write', async () => {
    const { store, data, dbPath, reopen } = await fixture(); const before = state(store), bytes = readFileSync(dbPath);
    const fake = reading(); let current = true;
    installJudgmentPort({ ...fake.port, async ask(request) { current = false; return fake.port.ask(request); } });
    await held(store.applyPreparedIngest({ ...data, nodes: [], edges: [], issues: [] }, async (stage) => ({
      nodes: data.nodes, edges: data.edges, issues: data.issues,
      assertCurrent: () => { stage.assertCurrent(); if (!current) throw new Held('stale'); },
    })), 'stale');
    expect(state(store)).toEqual(before); expect(readFileSync(dbPath)).toEqual(bytes);
    expect(state(await reopen())).toEqual(before);
  });
  test('a source without ID or URI creates a fresh record just like ordinary upsert', async () => {
    const { store, reopen } = await fixture(); const original = store.getSource('manual');
    const source = { connectorId: 'synthetic', sourceType: 'manual' as const, status: 'indexed' as const, title: 'Independent source' };
    await store.applyImport({ sources: [source], extractions: [], nodes: [], edges: [], issues: [] });
    expect(store.getSource('manual')).toEqual(original);
    const imported = store.listSources().find((record) => record.id !== 'manual')!;
    expect(imported.title).toBe(source.title); expect(imported.id).toStartWith('source-');
    const ordinary = await store.upsertSource(source);
    const content = ({ id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...record }: typeof ordinary) => record;
    expect(content(imported)).toEqual(content(ordinary)); expect(store.listSources()).toHaveLength(3);
    const after = state(store); expect(state(await reopen())).toEqual(after);
  });
  test('source-unique extraction replacement has identical cache and reopened identities', async () => {
    const { store, data, run, reopen } = await fixture(); reading();
    await run({ ...data, extractions: data.extractions.map((row) => ({ ...row, id: 'replacement-extraction' })) });
    expect(store.getExtraction('extract')).toBeNull(); expect(store.getExtractionBySourceId('manual')!.id).toBe('replacement-extraction');
    const after = state(store); expect(state(await reopen())).toEqual(after);
  });
});
