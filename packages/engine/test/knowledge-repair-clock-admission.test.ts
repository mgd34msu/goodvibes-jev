import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import type { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { prepareKnowledgeRecordAdmission } from '../sdk/src/platform/knowledge/store-record-snapshot.js';
import { createKnowledgeNodeOperatorMutation } from '../sdk/src/platform/knowledge/store-node-authority.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { markGapRepairAttempt, suppressGap, SELF_IMPROVEMENT_RETRY_DELAY_MS } from '../sdk/src/platform/knowledge/semantic/self-improvement-gap-state.js';
import { classifyGap } from '../sdk/src/platform/knowledge/semantic/self-improvement-gap-context.js';
import { recoverNoRepairerTasks } from '../sdk/src/platform/knowledge/semantic/self-improvement-recovery.js';
import { discoverIntrinsicGaps } from '../sdk/src/platform/knowledge/semantic/self-improvement-intrinsic-gaps.js';
import { prepareSemanticSupersession } from '../sdk/src/platform/knowledge/semantic/supersession-plan.js';
import { createSemanticWriteGuard, createSemanticPrimarySourcePlanner } from '../sdk/src/platform/knowledge/semantic/primary-source-plan.js';
import { createGeneratedFactWritePlanner } from '../sdk/src/platform/knowledge/semantic/fact-support-write-plan.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';
import type { KnowledgeNodeRecord } from '../sdk/src/platform/knowledge/types.js';

const collision = 4_222_222_222_222;
const roots: string[] = [], stores: KnowledgeStore[] = [];
let clock: { mockRestore(): void } | undefined;
afterEach(async () => {
  clock?.mockRestore(); clock = undefined;
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(metadata: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-repair-clock-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store); await store.init();
  const input = { id: 'gap', kind: 'knowledge_gap' as const, slug: 'display-specifications', title: 'Display specifications',
    status: 'active' as const, metadata: { knowledgeSpaceId: 'repair-clock', ...metadata } };
  const gap = await upsertObservedKnowledgeNode(store, input, 'research-task', input, () => input);
  return { store, gap, root };
}
function rawMetadata(store: KnowledgeStore, gap: KnowledgeNodeRecord): Record<string, unknown> {
  return JSON.parse(String(store.getRecordSnapshot('node', gap.id).raw!.metadata));
}

test('actual repair and suppression writers retain owned colliding clocks and numeric fresh/reopened views', async () => {
  clock = spyOn(Date, 'now').mockReturnValue(collision);
  const { store, gap, root } = await fixture();
  expect(() => prepareKnowledgeRecordAdmission(store, 'node', gap).assertCurrent()).not.toThrow();
  const first = await markGapRepairAttempt(store, gap, 'repair-clock', { status: 'repaired' });
  const repaired = await markGapRepairAttempt(store, first, 'repair-clock', { status: 'repaired', reason: 'Confirmed again.' });
  expect(repaired.metadata.lastRepairAttemptAt).toBe(collision);
  expect(rawMetadata(store, repaired).lastRepairAttemptAt).toBe(new Date(collision).toISOString());
  expect(() => prepareKnowledgeRecordAdmission(store, 'node', repaired).assertCurrent()).not.toThrow();
  await suppressGap(store, repaired, 'Not applicable to this device.', 'repair-clock');
  const suppressed = store.getNode(gap.id)!;
  expect(suppressed.metadata.repairedAt).toBe(collision);
  expect(rawMetadata(store, suppressed).repairedAt).toBe(new Date(collision).toISOString());
  expect(rawMetadata(store, suppressed).lastRepairAttemptAt).toBe(new Date(collision).toISOString());
  expect(() => prepareKnowledgeRecordAdmission(store, 'node', suppressed).assertCurrent()).not.toThrow();
  await store.close();
  const reopened = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(reopened); await reopened.init();
  const loaded = reopened.getNode(gap.id)!;
  expect(loaded.metadata.lastRepairAttemptAt).toBe(collision); expect(loaded.metadata.repairedAt).toBe(collision);
  expect(() => prepareKnowledgeRecordAdmission(reopened, 'node', loaded).assertCurrent()).not.toThrow();
});

for (const status of ['searched_no_sources', 'failed', 'deferred']) test(`generated ${status} retry survives actual classification and reopening`, async () => {
  const now = collision - SELF_IMPROVEMENT_RETRY_DELAY_MS;
  clock = spyOn(Date, 'now').mockReturnValue(now);
  const { store, gap, root } = await fixture();
  const deferred = await markGapRepairAttempt(store, gap, 'repair-clock', { status });
  expect(deferred.metadata.lastRepairAttemptAt).toBe(now); expect(deferred.metadata.nextRepairAttemptAt).toBe(collision);
  expect(rawMetadata(store, deferred).nextRepairAttemptAt).toBe(new Date(collision).toISOString());
  expect(() => prepareKnowledgeRecordAdmission(store, 'node', deferred).assertCurrent()).not.toThrow();
  const context = { gap: deferred, sources: [], linkedObjects: [], facts: [], repairSourceIds: [] };
  expect((await classifyGap(context, false, [], store)).status).toBe('retry_wait');
  await store.close();
  const reopened = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(reopened); await reopened.init();
  const loaded = reopened.getNode(gap.id)!;
  expect(loaded.metadata.nextRepairAttemptAt).toBe(collision);
  expect(() => prepareKnowledgeRecordAdmission(reopened, 'node', loaded).assertCurrent()).not.toThrow();
  expect((await classifyGap({ ...context, gap: loaded }, false, [], reopened)).status).toBe('retry_wait');
});

test('caller numeric clock names and explicit retry arguments never acquire owned-clock representation', async () => {
  clock = spyOn(Date, 'now').mockReturnValue(collision);
  for (const field of ['lastRepairAttemptAt', 'nextRepairAttemptAt', 'repairedAt', 'supersededAt', 'sourceDetachedAt']) {
    const { store, gap } = await fixture({ [field]: collision });
    expect(rawMetadata(store, gap)[field]).toBe(collision);
    expect(() => prepareKnowledgeRecordAdmission(store, 'node', gap)).toThrow();
  }
  const { store, gap } = await fixture();
  const changed = await markGapRepairAttempt(store, gap, 'repair-clock', { status: 'deferred', nextRepairAttemptAt: collision });
  expect(rawMetadata(store, changed).nextRepairAttemptAt).toBe(collision);
  expect(() => prepareKnowledgeRecordAdmission(store, 'node', changed)).toThrow();
});

test('repair clock encoding never hides unknown private tails, stale raw generations, or cloned identities', async () => {
  clock = spyOn(Date, 'now').mockReturnValue(collision);
  const { store, gap } = await fixture({ unselectedTail: { payment: collision } });
  const changed = await markGapRepairAttempt(store, gap, 'repair-clock', { status: 'repaired' });
  expect(rawMetadata(store, changed).unselectedTail).toEqual({ payment: collision });
  expect(() => prepareKnowledgeRecordAdmission(store, 'node', changed)).toThrow();
  const clean = await fixture();
  const repaired = await markGapRepairAttempt(clean.store, clean.gap, 'repair-clock', { status: 'repaired' });
  const admission = prepareKnowledgeRecordAdmission(clean.store, 'node', repaired);
  expect(() => prepareKnowledgeRecordAdmission(clean.store, 'node', { ...repaired })).toThrow();
  const sql = (clean.store as unknown as { sqlite: SQLiteStore }).sqlite;
  sql.run('UPDATE knowledge_nodes SET metadata = ? WHERE id = ?', [JSON.stringify({ ...rawMetadata(clean.store, repaired),
    lastRepairAttemptAt: collision }), repaired.id]);
  await sql.save();
  expect(() => admission.assertCurrent()).toThrow();
  expect(() => prepareKnowledgeRecordAdmission(clean.store, 'node', repaired)).toThrow();
});


test('operator review and no-op writes compare the public clock view without losing canonical originals', async () => {
  clock = spyOn(Date, 'now').mockReturnValue(collision);
  const { store, gap } = await fixture();
  const repaired = await markGapRepairAttempt(store, gap, 'repair-clock', { status: 'repaired' });
  const input = { id: repaired.id, kind: repaired.kind, slug: repaired.slug, title: repaired.title,
    status: repaired.status, confidence: repaired.confidence };
  const reviewed = await store.upsertNode(input, createKnowledgeNodeOperatorMutation(repaired, { action: 'accept', reviewer: 'clock-test' }));
  expect(reviewed.metadata.lastRepairAttemptAt).toBe(collision);
  expect(() => prepareKnowledgeRecordAdmission(store, 'node', reviewed).assertCurrent()).not.toThrow();
  const unchanged = await store.upsertNode(input);
  expect(unchanged.metadata.lastRepairAttemptAt).toBe(collision);
  expect(rawMetadata(store, unchanged).lastRepairAttemptAt).toBe(new Date(collision).toISOString());
  expect(() => prepareKnowledgeRecordAdmission(store, 'node', unchanged).assertCurrent()).not.toThrow();
});


test('actual no-repairer recovery carries owned repair clocks and complete metadata at the colliding epoch', async () => {
  clock = spyOn(Date, 'now').mockReturnValue(collision);
  const extra = { nested: ['retained original'] };
  const { store, gap } = await fixture({ extra });
  const blocked = await markGapRepairAttempt(store, gap, 'repair-clock', { status: 'no_repairer' });
  expect(() => prepareKnowledgeRecordAdmission(store, 'node', blocked)).not.toThrow();
  await store.upsertRefinementTask({ id: 'recovery-task', spaceId: 'repair-clock', gapId: gap.id,
    state: 'blocked', trigger: 'manual', blockedReason: 'No semantic gap repairer is configured.' });
  await recoverNoRepairerTasks(store, 'repair-clock');
  const recovered = store.getNode(gap.id)!;
  expect(recovered).not.toBe(blocked); expect(recovered.metadata.repairStatus).toBe('open');
  expect(store.getRefinementTask('recovery-task')?.state).toBe('detected');
  expect(recovered.metadata.lastRepairAttemptAt).toBe(collision);
  expect(rawMetadata(store, recovered).lastRepairAttemptAt).toBe(new Date(collision).toISOString());
  expect(rawMetadata(store, recovered).extra).toEqual(extra);
  expect(() => prepareKnowledgeRecordAdmission(store, 'node', recovered).assertCurrent()).not.toThrow();
});

test('actual intrinsic rediscovery carries retry clocks when a subject change forces a rewrite', async () => {
  clock = spyOn(Date, 'now').mockReturnValue(collision);
  const { store } = await fixture();
  const subjectInput = { id: 'display-device', kind: 'ha_device' as const, slug: 'display-device', title: 'Display model XR100',
    status: 'active' as const, metadata: { knowledgeSpaceId: 'repair-clock', manufacturer: 'Example', model: 'XR100' } };
  await seedHomeAssistantObservation(store, subjectInput);
  expect(await discoverIntrinsicGaps(store, 'repair-clock', null, [])).toBe(1);
  const intrinsic = store.listNodesInSpace('repair-clock').find(node => node.metadata.gapKind === 'intrinsic_features')!;
  const extra = { nested: ['retained original'] };
  const withExtra = await upsertObservedKnowledgeNode(store, { id: intrinsic.id, kind: intrinsic.kind, slug: intrinsic.slug,
    title: intrinsic.title, status: intrinsic.status, metadata: { extra } }, 'research-task', intrinsic, () => store.getNode(intrinsic.id));
  const deferred = await markGapRepairAttempt(store, withExtra, 'repair-clock', { status: 'deferred' });
  expect(() => prepareKnowledgeRecordAdmission(store, 'node', deferred)).not.toThrow();
  await seedHomeAssistantObservation(store, { ...subjectInput, title: 'Living room display XR100' });
  expect(await discoverIntrinsicGaps(store, 'repair-clock', null, [])).toBe(0);
  const refreshed = store.getNode(intrinsic.id)!;
  expect(refreshed).not.toBe(deferred); expect(refreshed.title).toContain('Living room display');
  expect(refreshed.metadata.lastRepairAttemptAt).toBe(collision);
  expect(refreshed.metadata.nextRepairAttemptAt).toBe(collision + SELF_IMPROVEMENT_RETRY_DELAY_MS);
  expect(rawMetadata(store, refreshed).lastRepairAttemptAt).toBe(new Date(collision).toISOString());
  expect(rawMetadata(store, refreshed).nextRepairAttemptAt).toBe(new Date(collision + SELF_IMPROVEMENT_RETRY_DELAY_MS).toISOString());
  expect(rawMetadata(store, refreshed).extra).toEqual(extra);
  expect(() => prepareKnowledgeRecordAdmission(store, 'node', refreshed).assertCurrent()).not.toThrow();
  expect((await classifyGap({ gap: refreshed, sources: [], linkedObjects: [], facts: [], repairSourceIds: [] }, false, [], store)).status).toBe('retry_wait');
});

test('actual stale supersession preserves repair clocks and owns its new colliding supersededAt', async () => {
  clock = spyOn(Date, 'now').mockReturnValue(collision);
  const extra = { nested: ['retained original'] };
  const { store, gap, root } = await fixture({ semanticKind: 'gap', sourceId: 'superseded-source', extra });
  await store.upsertSource({ id: 'superseded-source', connectorId: 'clock-test', sourceType: 'document', title: 'Old display documentation',
    status: 'indexed', metadata: { knowledgeSpaceId: 'repair-clock' } });
  const repaired = await markGapRepairAttempt(store, gap, 'repair-clock', { status: 'repaired' });
  const guard = createSemanticWriteGuard(store);
  const plan = prepareSemanticSupersession(store, 'superseded-source', 'repair-clock', new Set(), guard,
    createSemanticPrimarySourcePlanner(store, guard), createGeneratedFactWritePlanner(store, guard), guard.assertCurrent);
  const commit = await plan(); await commit();
  const stale = store.getNode(gap.id)!;
  expect(stale).not.toBe(repaired); expect(stale.status).toBe('stale');
  expect(stale.metadata.lastRepairAttemptAt).toBe(collision); expect(stale.metadata.supersededAt).toBe(collision);
  expect(rawMetadata(store, stale).lastRepairAttemptAt).toBe(new Date(collision).toISOString());
  expect(rawMetadata(store, stale).supersededAt).toBe(new Date(collision).toISOString());
  expect(rawMetadata(store, stale).extra).toEqual(extra);
  expect(() => prepareKnowledgeRecordAdmission(store, 'node', stale).assertCurrent()).not.toThrow();
  await store.close();
  const reopened = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(reopened); await reopened.init();
  const loaded = reopened.getNode(gap.id)!;
  expect(loaded.metadata.supersededAt).toBe(collision);
  expect(() => prepareKnowledgeRecordAdmission(reopened, 'node', loaded).assertCurrent()).not.toThrow();
});
