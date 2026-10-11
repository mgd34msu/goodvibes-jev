import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { sameKnowledgeRecord } from '../sdk/src/platform/knowledge/store-record-representation.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { canonicalRepairSubjectNodes } from '../sdk/src/platform/knowledge/semantic/repair-subjects.js';
import { buildGapContext, linkRepairSources } from '../sdk/src/platform/knowledge/semantic/self-improvement-gap-context.js';
import { enrichKnowledgeSource } from '../sdk/src/platform/knowledge/semantic/enrichment.js';
import { promoteRepairSources } from '../sdk/src/platform/knowledge/semantic/self-improvement-promotion.js';
import { repairSubjectSelection } from '../sdk/src/platform/knowledge/semantic/repair-subject-selection/battery.js';
import { KnowledgeRepairSubjectSelectionHeldError as Held, type RepairSubjectSelectionInput } from '../sdk/src/platform/knowledge/semantic/repair-subject-selection/reader.js';
import { isKnowledgeSourceQualityFailure } from '../sdk/src/platform/knowledge/source-quality.js';

let previous: JudgmentPort | undefined;
const roots: string[] = [];
const stores: KnowledgeStore[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => { installJudgmentPort(previous); for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const spaceId = 'subject-selection';
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repair-subject-selection-')); roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath }); stores.push(store);
  const input = { id: 'display', kind: 'ha_device' as const, slug: 'display', title: 'Living room display', status: 'active' as const,
    metadata: { knowledgeSpaceId: spaceId } };
  const display = await upsertObservedKnowledgeNode(store, input, 'home-assistant-snapshot', input, () => input);
  const bridgeInput = { ...input, id: 'bridge', kind: 'ha_integration' as const, slug: 'bridge', title: 'Display bridge',
    metadata: { knowledgeSpaceId: spaceId, model: 'XX-999', entityKind: 'device' } };
  const bridge = await upsertObservedKnowledgeNode(store, bridgeInput, 'home-assistant-snapshot', bridgeInput, () => bridgeInput);
  const gapInput = { id: 'gap', kind: 'knowledge_gap' as const, slug: 'gap', title: 'What inputs does the living room display have?', status: 'active' as const,
    metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [display.id, bridge.id] } };
  const gap = await upsertObservedKnowledgeNode(store, gapInput, 'research-task', gapInput, () => gapInput);
  const source = await store.upsertSource({ id: 'manual', connectorId: 'synthetic', sourceType: 'manual', title: 'Living room display documentation',
    canonicalUri: 'https://example.test/display', status: 'indexed', metadata: { knowledgeSpaceId: spaceId,
      sourceDiscovery: { linkedObjectIds: [display.id, bridge.id] } } });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text',
    excerpt: 'The living room display has two HDMI inputs and one USB input. The bridge authenticates separately.',
    sections: [], metadata: { knowledgeSpaceId: spaceId } });
  const task = await store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
  return { dbPath, store, display, bridge, gap, source, extraction, task };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Historical persisted-input fixture: preserve every raw field and store clock,
 * then reopen so the protected row has genuine current-store identity. Never
 * mutate a frozen live observation or pass a fabricated row to admission. */
async function protectedFixture(field: 'display' | 'gap' | 'source' | 'extraction'): Promise<Fixture> {
  const item = await fixture();
  const row = item[field];
  const raw = field === 'source' ? item.store.getSourceSnapshot({ id: row.id }).raw!
    : item.store.getRecordSnapshot(field === 'extraction' ? 'extraction' : 'node', row.id).raw!;
  const table = field === 'source' ? 'knowledge_sources' : field === 'extraction' ? 'knowledge_extractions' : 'knowledge_nodes';
  const sql = (item.store as unknown as { sqlite: SQLiteStore }).sqlite;
  sql.run(`UPDATE ${table} SET metadata = ? WHERE id = ?`, [
    JSON.stringify({ ...JSON.parse(String(raw.metadata)), late: 'Authorization: Bearer do-not-transmit' }), row.id,
  ]);
  await sql.save(); await item.store.close();
  const store = new KnowledgeStore({ dbPath: item.dbPath }); stores.push(store); await store.init();
  const current = { ...item, store, display: store.getNode(item.display.id)!, bridge: store.getNode(item.bridge.id)!,
    gap: store.getNode(item.gap.id)!, source: store.getSource(item.source.id)!,
    extraction: store.getExtractionBySourceId(item.source.id)!, task: store.getRefinementTask(item.task.id)! };
  const snapshot = field === 'source' ? store.getSourceSnapshot({ id: row.id }).source
    : store.getRecordSnapshot(field === 'extraction' ? 'extraction' : 'node', row.id).record;
  expect(current[field].metadata.late).toBe('Authorization: Bearer do-not-transmit');
  expect(sameKnowledgeRecord(current[field], snapshot)).toBe(true);
  const currentRow = field === 'source' ? store.getSource(row.id)
    : field === 'extraction' ? store.getExtraction(row.id) : store.getNode(row.id);
  if (!currentRow) throw new Error('Protected persisted fixture did not reopen its current row');
  expect(current[field]).toBe(currentRow);
  return current;
}
async function credentialHeld(pending: Promise<unknown>) {
  const error: unknown = await pending.catch(error => error);
  expect(error).toBeInstanceOf(JudgmentInputError);
  expect((error as JudgmentInputError).problem).toBe('credential-material');
}
function state(store: KnowledgeStore) { return JSON.stringify({ nodes: store.listNodes(), edges: store.listEdges(), tasks: store.listRefinementTasks(), sources: store.listSources(), extractions: store.listExtractions() }); }
function readings(selectedTitle = 'Living room display', probability = 0.99) {
  const fake = fakePort((name, question, state) => {
    if (question !== repairSubjectSelection.items.repairSubjectSelected.question || name !== 'repairSubjectSelected') throw new Error(`Unexpected question: ${name}`);
    const input = state as unknown as RepairSubjectSelectionInput;
    return noulAnswer(input.candidates.find(candidate => candidate.reference === input.candidate)?.title === selectedTitle ? probability : 0.01);
  });
  installJudgmentPort(fake.port); return fake;
}
function select(item: Fixture, options: { signal?: AbortSignal } = {}) {
  return canonicalRepairSubjectNodes({ store: item.store, spaceId, nodes: [item.display, item.bridge], context: { gap: item.gap },
    evidenceSources: [item.source], text: item.gap.title, ...options });
}
async function held(promise: Promise<unknown>, reason: Held['reason']) {
  const error: unknown = await promise.catch(error => error);
  expect(error).toBeInstanceOf(Held); expect((error as Held).reason).toBe(reason);
  expect(isKnowledgeSourceQualityFailure(error)).toBe(true);
}

describe('canonical repair subject selection through real consumers', () => {
  test('gap context follows canonical selection, not model-number or entityKind labels, and retains exact node identity', async () => {
    const item = await fixture(), fake = readings();
    const result = await buildGapContext(item.store, spaceId, item.gap, []);
    expect(result.linkedObjects).toEqual([item.display]); expect(result.linkedObjects[0]).toBe(item.display);
    expect(fake.requests).toHaveLength(2); expect(() => result.assertCurrent?.()).not.toThrow();
    readings('Display bridge');
    const reversed = await buildGapContext(item.store, spaceId, item.gap, []);
    expect(reversed.linkedObjects).toEqual([item.bridge]);
  });
  test('settled no is empty, while unconfigured, unavailable and uncertain are explicit holds without writes', async () => {
    const item = await fixture(), before = state(item.store);
    await held(buildGapContext(item.store, spaceId, item.gap, []), 'unconfigured');
    readings('none'); expect((await select(item)).nodes).toEqual([]);
    readings('Living room display', 0.5);
    await held(linkRepairSources(item.store, spaceId, item.gap, [item.source.id], item.gap.title, []), 'uncertain');
    installJudgmentPort({ model: 'offline', async ask() { throw new Error('offline'); } });
    await held(buildGapContext(item.store, spaceId, item.gap, []), 'unavailable');
    expect(state(item.store)).toBe(before);
  });
  test('source linking publishes exactly the selected subject and repair edge as one prepared ingest', async () => {
    const item = await fixture(); readings();
    expect(await linkRepairSources(item.store, spaceId, item.gap, [item.source.id], item.gap.title, [])).toBe(1);
    const edges = item.store.listEdges().filter(edge => edge.fromId === item.source.id);
    expect(edges.filter(edge => edge.relation === 'source_for').map(edge => edge.toId)).toEqual([item.display.id]);
    expect(edges.some(edge => edge.toId === item.gap.id)).toBe(true);
  });
  test('complete protected candidate, context and evidence metadata are screened before selection requests', async () => {
    for (const field of ['display', 'gap', 'source', 'extraction'] as const) {
      const item = await protectedFixture(field);
      const fake = readings(), before = state(item.store);
      await credentialHeld(select(item));
      expect(fake.requests).toHaveLength(0); expect(state(item.store)).toBe(before);
    }
  });
  test('promotion screens the complete source and extraction before the new selection request', async () => {
    for (const field of ['source', 'extraction'] as const) {
      const item = await protectedFixture(field), fake = readings(), before = state(item.store);
      await credentialHeld(promoteRepairSources({ store: item.store }, spaceId, item.gap, [item.source.id], item.task, Date.now() + 5_000));
      expect(fake.requests).toHaveLength(0); expect(state(item.store)).toBe(before);
    }
  });
  test('enrichment and promotion do not fall back or write on subject uncertainty', async () => {
    const item = await fixture(); readings('Living room display', 0.5); const before = state(item.store);
    await held(enrichKnowledgeSource({ store: item.store }, item.source, { force: true }), 'uncertain');
    expect(state(item.store)).toBe(before);
    readings('Living room display', 0.5);
    await held(promoteRepairSources({ store: item.store }, spaceId, item.gap, [item.source.id], item.task, Date.now() + 5_000), 'uncertain');
    expect(state(item.store)).toBe(before);
  });
  test('raw-record compatibility admits current numeric records but never a caller clone or changed clock', async () => {
    const item = await fixture(), fake = readings();
    expect((await select(item)).nodes[0]).toBe(item.display);
    const count = fake.requests.length;
    await expect(canonicalRepairSubjectNodes({ store: item.store, spaceId, nodes: [{ ...item.display, updatedAt: 1 }],
      context: { gap: item.gap }, text: item.gap.title })).rejects.toThrow();
    expect(fake.requests).toHaveLength(count);
  });
  test('schema-excluded input still receives complete privacy screening', async () => {
    const item = await fixture(), fake = readings();
    const generated = { ...item.display, metadata: { ...item.display.metadata, generatedProjection: true, late: 'Authorization: Bearer do-not-transmit' } };
    await expect(canonicalRepairSubjectNodes({ store: item.store, spaceId, nodes: [generated], context: { gap: item.gap },
      text: item.gap.title })).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test('source ABA invalidates a settled selection even if all descriptive fields are restored', async () => {
    const item = await fixture(); readings(); const plan = await select(item);
    await item.store.replaceSourceRecord({ ...item.source, title: 'Temporary replacement' });
    await item.store.replaceSourceRecord(item.source);
    expect(() => plan.assertCurrent()).toThrow(Held);
  });
  test('source replacement during a suspended reading holds all source links', async () => {
    const item = await fixture(), fake = readings();
    let release!: () => void, started!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    installJudgmentPort({ model: fake.port.model, async ask(request) { started(); await wait; return fake.port.ask(request); } });
    const pending = linkRepairSources(item.store, spaceId, item.gap, [item.source.id], item.gap.title, []);
    await entered;
    await item.store.replaceSourceRecord({ ...item.source, title: 'Replaced during judgment' });
    release(); await held(pending, 'stale'); expect(item.store.listEdges()).toEqual([]);
  });
  test('a requested source absent before selection cannot be adopted if it appears during judgment', async () => {
    const item = await fixture(), fake = readings();
    let release!: () => void, started!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    installJudgmentPort({ model: fake.port.model, async ask(request) { started(); await wait; return fake.port.ask(request); } });
    const pending = linkRepairSources(item.store, spaceId, item.gap, [item.source.id, 'late-source'], item.gap.title, []);
    await entered;
    await item.store.upsertSource({ id: 'late-source', connectorId: 'synthetic', sourceType: 'manual', title: 'Inserted during selection',
      status: 'indexed', metadata: { knowledgeSpaceId: spaceId, late: 'Authorization: Bearer do-not-transmit' } });
    release();
    const error: unknown = await pending.catch(error => error);
    expect(isKnowledgeSourceQualityFailure(error)).toBe(true);
    expect(item.store.listEdges()).toEqual([]);
    expect(JSON.stringify(fake.requests)).not.toContain('do-not-transmit');
  });
  test('missing candidate IDs stay absent-bound through suspended context, link, promotion and enrichment consumers', async () => {
    for (const consumer of ['context', 'link', 'promotion', 'enrichment'] as const) {
      const item = await fixture();
      const gapInput = { id: item.gap.id, kind: item.gap.kind, slug: item.gap.slug, title: item.gap.title, status: item.gap.status,
        metadata: { ...item.gap.metadata, linkedObjectIds: [item.display.id, item.bridge.id, 'late-candidate'] } };
      const gap = await upsertObservedKnowledgeNode(item.store, gapInput, 'research-task', gapInput, () => gapInput);
      await item.store.replaceSourceRecord({ ...item.source, metadata: { ...item.source.metadata,
        sourceDiscovery: { linkedObjectIds: [item.display.id, item.bridge.id, 'late-candidate'] } } });
      const source = item.store.getSource(item.source.id)!;
      const fake = readings(); let release!: () => void, started!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      const entered = new Promise<void>(resolve => { started = resolve; });
      installJudgmentPort({ model: fake.port.model, async ask(request) { started(); await wait; return fake.port.ask(request); } });
      const pending = consumer === 'context' ? buildGapContext(item.store, spaceId, gap, [])
        : consumer === 'link' ? linkRepairSources(item.store, spaceId, gap, [source.id], gap.title, [])
        : consumer === 'promotion' ? promoteRepairSources({ store: item.store }, spaceId, gap, [source.id], item.task, Date.now() + 5_000)
        : enrichKnowledgeSource({ store: item.store }, source, { force: true });
      await entered;
      const lateInput = { id: 'late-candidate', kind: 'ha_device' as const, slug: 'late-candidate', title: 'Newly appeared display', status: 'active' as const,
        metadata: { knowledgeSpaceId: spaceId } };
      await upsertObservedKnowledgeNode(item.store, lateInput, 'home-assistant-snapshot', lateInput, () => lateInput);
      const afterAuthorizedInsertion = state(item.store);
      release(); const error: unknown = await pending.catch(error => error);
      expect(isKnowledgeSourceQualityFailure(error)).toBe(true);
      expect(state(item.store)).toBe(afterAuthorizedInsertion);
      expect(item.store.listEdges()).toEqual([]);
    }
  });
  test('caller cancellation revokes a settled plan and prevents late links from a suspended model', async () => {
    const item = await fixture(), controller = new AbortController(), fake = readings();
    const plan = await select(item, { signal: controller.signal }); controller.abort();
    expect(() => plan.assertCurrent()).toThrow(Held);
    const pendingController = new AbortController();
    let release!: () => void, started!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    installJudgmentPort({ model: fake.port.model, async ask(request) { started(); await wait; return fake.port.ask(request); } });
    const pending = linkRepairSources(item.store, spaceId, item.gap, [item.source.id], item.gap.title, [], () => false, pendingController.signal);
    await entered; pendingController.abort(); await held(pending, 'aborted'); release();
    expect(item.store.listEdges()).toEqual([]);
  });
});
