import { repairScoringFixtureReading } from './_helpers/repair-scoring-fixture-readings.js';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore, hasKnowledgeNodePublication } from '../sdk/src/platform/knowledge/store.js';
import { prepareSourceLinkedRepairProfileFacts } from '../sdk/src/platform/knowledge/semantic/self-improvement-promotion.js';
import { prepareKnowledgeRecordAdmission } from '../sdk/src/platform/knowledge/store-record-snapshot.js';
import { prepareGeneratedFactIdentity, projectGeneratedFactRecordAdmission, retainGeneratedFactRecordReferences } from '../sdk/src/platform/knowledge/generated-fact-record-references.js';
import { captureNativeGeneratedFactPlanReferences, createGeneratedFactWritePlanner, generatedFactSupportMetadata } from '../sdk/src/platform/knowledge/semantic/fact-support-write-plan.js';
import { createSemanticWriteGuard } from '../sdk/src/platform/knowledge/semantic/primary-source-plan.js';
import { JudgmentInputError, judgmentInputProblem } from '../sdk/src/platform/gate/judgment-input.js';
import { KnowledgeGeneratedFactSupportHeldError, type GeneratedFactSupportPlan } from '../sdk/src/platform/knowledge/semantic/verification/types.js';
import type { KnowledgeNodeRecord } from '../sdk/src/platform/knowledge/types.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';

let previous: JudgmentPort | undefined;
const roots: string[] = [], stores: KnowledgeStore[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => {
  installJudgmentPort(previous);
  await Promise.all(stores.splice(0).map(store => store.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(batched = false, extractionClock?: number) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-native-fact-proof-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store);
  const fake = fakePort((name, question, state) => {
    const scoring = repairScoringFixtureReading(name, question, state, [], [['HDMI ports', 'AC-7 has four HDMI ports.', 'AC-7 has four HDMI ports.']]);
    if (scoring !== undefined) return scoring;
    if (!['supported', 'attached', 'serve'].includes(name)) throw new Error('Unscripted native fact proof question');
    return noulAnswer(0.99);
  });
  installJudgmentPort(fake.port);
  const spaceId = 'support-test';
  const subject = await seedHomeAssistantObservation(store, { id: 'synthetic-repro-subject-767', kind: 'ha_device', slug: 'ac-7', title: 'AC-7', metadata: { knowledgeSpaceId: spaceId, model: 'AC-7' } });
  const source = await store.upsertSource({ id: 'synthetic-source', connectorId: 'synthetic', sourceType: 'manual', title: 'AC-7 reference', status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
  let extractionChecks = 0;
  let restoreExtractionClock: (() => void) | undefined;
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: 'AC-7 has four HDMI ports.', metadata: { knowledgeSpaceId: spaceId } }, extractionClock === undefined ? undefined : () => {
    extractionChecks += 1;
    if (extractionChecks === 2) {
      const clock = spyOn(Date, 'now').mockReturnValue(extractionClock);
      restoreExtractionClock = () => clock.mockRestore();
    } else if (extractionChecks === 3) {
      restoreExtractionClock?.();
      restoreExtractionClock = undefined;
    }
  }).finally(() => restoreExtractionClock?.());
  if (extractionClock !== undefined) expect(extractionChecks).toBe(3);
  const input = { store, spaceId, source, extraction, subjects: [subject], authority: 'secondary' as const,
    title: 'HDMI ports', summary: 'AC-7 has four HDMI ports.', evidence: 'AC-7 has four HDMI ports.', extractor: 'synthetic',
    factMetadata: { ordinaryTail: { description: 'Complete retained native metadata.' } },
    classification: { kind: 'specification' as const, title: 'HDMI ports', summary: 'AC-7 has four HDMI ports.', value: 'four hdmi ports', labels: [], aliases: [] },
  };
  const prepared = await prepareSourceLinkedRepairProfileFacts([input]);
  const [fact] = batched ? await store.batch(async () => {
    const written = await prepared.write();
    const pending = written[0];
    if (!pending) throw new Error('Native batch returned no pending fact');
    // Native publication identity cannot turn an unsaved row into read evidence.
    expect(() => prepareKnowledgeRecordAdmission(store, 'node', pending)).toThrow();
    return written;
  }) : await prepared.write();
  const plan = prepared.plans[0];
  if (!fact || !plan) throw new Error('Native fact producer returned no committed record');
  expect(judgmentInputProblem({ id: fact.id })).toBe('card-material');
  return { store, source, extraction, subject, fact, plan, fake, spaceId, input };
}

test('actual generated writer admits its exact current whole record without sending native identifiers', async () => {
  const item = await fixture(), calls = item.fake.requests.length;
  const admission = prepareKnowledgeRecordAdmission(item.store, 'node', item.fact);
  admission.assertCurrent();
  expect(item.fake.requests).toHaveLength(calls);
  expect(JSON.stringify(item.fake.requests)).not.toContain(item.fact.id);
  const snapshot = item.store.getRecordSnapshot('node', item.fact.id);
  if (!snapshot.raw) throw new Error('Native record snapshot missing');
  const projection = projectGeneratedFactRecordAdmission(item.store, item.fact, snapshot.raw);
  expect(projection).toBeDefined();
  const metadata: unknown = JSON.parse(String(projection?.raw.metadata));
  expect(metadata).toMatchObject({ ordinaryTail: { description: 'Complete retained native metadata.' } });
  expect(item.store.getRecordSnapshot('node', item.fact.id).raw).toEqual(snapshot.raw);
});

test('a genuine deferred native batch binds its exact write but admits it only after persistence', async () => {
  const item = await fixture(true), calls = item.fake.requests.length;
  const admission = prepareKnowledgeRecordAdmission(item.store, 'node', item.fact);
  admission.assertCurrent();
  expect(item.fake.requests).toHaveLength(calls);
  const snapshot = item.store.getRecordSnapshot('node', item.fact.id);
  expect(snapshot.record).toEqual(item.fact);
  expect(JSON.stringify(item.fake.requests)).not.toContain(item.fact.id);
  const changed = await item.store.upsertNode({ ...item.fact, summary: 'Replaced after batch publication.' });
  expect(() => admission.assertCurrent()).toThrow();
  expect(() => prepareKnowledgeRecordAdmission(item.store, 'node', changed)).toThrow(JudgmentInputError);
});

test('copied support plans and copied or foreign constructor tokens cannot issue a native exception', async () => {
  const item = await fixture();
  const plan = item.plan.supportPlans[0];
  if (!plan) throw new Error('Native support plan missing');
  expect(() => captureNativeGeneratedFactPlanReferences(item.store, structuredClone(plan))).toThrow(KnowledgeGeneratedFactSupportHeldError);
  expect(() => retainGeneratedFactRecordReferences(item.store, item.fact, item.plan.supportPlans, undefined, { ...item.plan.factIdentity })).toThrow(KnowledgeGeneratedFactSupportHeldError);
  const other = new KnowledgeStore({ dbPath: ':memory:' }); stores.push(other); await other.init();
  const foreign = prepareGeneratedFactIdentity(other, { spaceId: item.spaceId, kind: 'specification', title: 'HDMI ports', value: 'four hdmi ports', summary: 'AC-7 has four HDMI ports.', subjectIds: [item.subject.id], fallbackScope: item.source.id });
  expect(() => retainGeneratedFactRecordReferences(item.store, item.fact, item.plan.supportPlans, undefined, foreign)).toThrow(KnowledgeGeneratedFactSupportHeldError);
});

test('copies and reopened records retain ordinary complete admission', async () => {
  const item = await fixture();
  expect(() => prepareKnowledgeRecordAdmission(item.store, 'node', structuredClone(item.fact))).toThrow(JudgmentInputError);
  const reopened = new KnowledgeStore({ dbPath: item.store.storagePath }); stores.push(reopened); await reopened.init();
  const fact = reopened.getNode(item.fact.id);
  if (!fact) throw new Error('Reopened native fact missing');
  expect(() => prepareKnowledgeRecordAdmission(reopened, 'node', fact)).toThrow(JudgmentInputError);
});

test('ordinary replacement cannot inherit the previous committed record exception', async () => {
  const item = await fixture();
  const admission = prepareKnowledgeRecordAdmission(item.store, 'node', item.fact);
  const changed = await item.store.upsertNode({ ...item.fact, summary: 'AC-7 provides four HDMI ports.' });
  expect(() => admission.assertCurrent()).toThrow();
  expect(() => prepareKnowledgeRecordAdmission(item.store, 'node', changed)).toThrow(JudgmentInputError);
});

test.each(['source', 'extraction'] as const)('the original %s lifetime remains bound after publication', async kind => {
  const item = await fixture();
  const admission = prepareKnowledgeRecordAdmission(item.store, 'node', item.fact);
  if (kind === 'source') await item.store.upsertSource({ ...item.source, title: 'Changed native source' });
  else await item.store.upsertExtraction({ ...item.extraction, excerpt: 'Corrected native evidence.' });
  expect(() => admission.assertCurrent()).toThrow(KnowledgeGeneratedFactSupportHeldError);
  expect(() => prepareKnowledgeRecordAdmission(item.store, 'node', item.fact)).toThrow(KnowledgeGeneratedFactSupportHeldError);
});

test('proof never authorizes a modified raw row or unrecognized metadata field', async () => {
  const item = await fixture();
  const snapshot = item.store.getRecordSnapshot('node', item.fact.id);
  if (!snapshot.raw) throw new Error('Native record snapshot missing');
  const substituted = { ...snapshot.raw, metadata: JSON.stringify({ password: 'synthetic-protected' }) };
  expect(() => projectGeneratedFactRecordAdmission(item.store, item.fact, substituted)).toThrow(KnowledgeGeneratedFactSupportHeldError);
  const changed = await item.store.upsertNode({ ...item.fact, metadata: { ...item.fact.metadata, privateTail: { password: 'synthetic-protected' } } });
  retainGeneratedFactRecordReferences(item.store, changed, item.plan.supportPlans, item.fact);
  expect(() => prepareKnowledgeRecordAdmission(item.store, 'node', changed)).toThrow(JudgmentInputError);
});


test('a skipped native predecessor cannot transfer an archived generated proof', async () => {
  const item = await fixture();
  const intermediate = await item.store.upsertNode({ ...item.fact, summary: 'AC-7 provides four HDMI ports.' });
  const latest = await item.store.upsertNode({ ...intermediate, summary: 'AC-7 includes four HDMI ports.' });
  expect(hasKnowledgeNodePublication(item.store, latest, intermediate)).toBe(true);
  expect(hasKnowledgeNodePublication(item.store, latest, item.fact)).toBe(false);
  expect(() => retainGeneratedFactRecordReferences(item.store, latest, item.plan.supportPlans, item.fact)).toThrow(KnowledgeGeneratedFactSupportHeldError);
  expect(() => prepareKnowledgeRecordAdmission(item.store, 'node', latest)).toThrow(JudgmentInputError);
});

test('actual atomic publication retains only its own predecessor and complete native successor', async () => {
  const item = await fixture();
  const receipt = await item.store.applyPreparedIngest({ sources: [], extractions: [], nodes: [], edges: [], issues: [] }, async () => ({
    nodes: [{ ...item.fact, metadata: { ...item.fact.metadata, ordinaryPublication: 'Retained complete native receipt.' } }], edges: [], issues: [],
  }));
  const next = receipt.nodes[0];
  if (!next) throw new Error('Native atomic publication returned no record');
  expect(hasKnowledgeNodePublication(item.store, next, item.fact)).toBe(true);
  expect(hasKnowledgeNodePublication(item.store, structuredClone(next), item.fact)).toBe(false);
  const other = new KnowledgeStore({ dbPath: ':memory:' }); stores.push(other); await other.init();
  expect(hasKnowledgeNodePublication(other, next, item.fact)).toBe(false);
  retainGeneratedFactRecordReferences(item.store, next, item.plan.supportPlans, item.fact);
  prepareKnowledgeRecordAdmission(item.store, 'node', next).assertCurrent();
  expect(next.metadata.ordinaryPublication).toBe('Retained complete native receipt.');
});


test('a substituted collection constructor cannot expose the pending native publication image', async () => {
  const item = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const NativeMap = Map, exposed: Map<unknown, unknown>[] = [];
  const pending = item.store.applyPreparedIngest({ sources: [], extractions: [], nodes: [], edges: [], issues: [] }, async () => {
    entered.resolve(); await release.promise;
    return { nodes: [{ ...item.fact, metadata: { ...item.fact.metadata, ordinaryPublication: 'Exact pending constructor control.' } }], edges: [], issues: [] };
  });
  try {
    await entered.promise;
    globalThis.Map = new Proxy(NativeMap, { construct(target, args, newTarget) {
      const map: unknown = Reflect.construct(target, args, newTarget);
      if (!(map instanceof NativeMap)) throw new Error('Substituted constructor did not return a real map');
      exposed.push(map); return map;
    } });
    release.resolve();
    const receipt = await pending;
    globalThis.Map = NativeMap;
    expect(exposed.length).toBeGreaterThan(0);
    // An unpinned proof map would expose its actual snapshot here. Poisoning
    // that expectation must not change the authentic committed row's evidence.
    for (const map of exposed) for (const value of map.values()) {
      if (value && typeof value === 'object' && 'raw' in value && 'record' in value && 'generation' in value) {
        Object.defineProperty(value, 'generation', { value: 'substituted-publication-image', configurable: true });
      }
    }
    const next = receipt.nodes[0];
    if (!next) throw new Error('Native pending import returned no committed record');
    expect(hasKnowledgeNodePublication(item.store, next, item.fact)).toBe(true);
    retainGeneratedFactRecordReferences(item.store, next, item.plan.supportPlans, item.fact);
    prepareKnowledgeRecordAdmission(item.store, 'node', next).assertCurrent();
    expect(item.store.getRecordSnapshot('node', next.id).record).toEqual(next);
    expect(next.metadata.ordinaryPublication).toBe('Exact pending constructor control.');
  } finally {
    globalThis.Map = NativeMap; release.resolve(); await pending.catch(() => {});
  }
});

test('borrowed native publication methods reject foreign receivers before their callbacks', async () => {
  let callbacks = 0;
  const foreign = { async init() { callbacks++; } };
  await expect(Reflect.apply(KnowledgeStore.prototype.upsertPreparedNode, foreign, [{ count: 0 }, 0])).rejects.toThrow();
  await expect(Reflect.apply(KnowledgeStore.prototype.applyPreparedIngest, foreign, [
    { sources: [], extractions: [], nodes: [], edges: [], issues: [] },
    async () => { callbacks++; return { nodes: [], edges: [], issues: [] }; },
  ])).rejects.toThrow();
  expect(callbacks).toBe(0);
});


test('actual regeneration replaces retired receipt lifetimes with newly read source evidence', async () => {
  const item = await fixture();
  const originalAdmission = prepareKnowledgeRecordAdmission(item.store, 'node', item.fact);
  const extraction = await item.store.upsertExtraction({ ...item.extraction, excerpt: 'AC-7 has four HDMI ports. Revised reference confirms this count.' });
  expect(() => originalAdmission.assertCurrent()).toThrow();
  const prepared = await prepareSourceLinkedRepairProfileFacts([{ ...item.input, extraction }]);
  const [next] = await prepared.write();
  if (!next) throw new Error('Native regeneration returned no committed fact');
  expect(next === item.fact).toBe(false);
  expect(next.id === item.fact.id).toBe(true);
  expect(hasKnowledgeNodePublication(item.store, next, item.fact)).toBe(true);
  prepareKnowledgeRecordAdmission(item.store, 'node', next).assertCurrent();
  expect(() => originalAdmission.assertCurrent()).toThrow();
});


test('partial regeneration refreshes one source and retains the exact other receipt lifetime', async () => {
  const item = await fixture();
  const second = await item.store.upsertSource({ id: 'synthetic-second-source', connectorId: 'synthetic', sourceType: 'manual',
    title: 'Independent AC-7 reference', status: 'indexed', metadata: { knowledgeSpaceId: item.spaceId } });
  const secondExtraction = await item.store.upsertExtraction({ sourceId: second.id, extractorId: 'synthetic', format: 'text',
    excerpt: 'AC-7 has four HDMI ports.', metadata: { knowledgeSpaceId: item.spaceId } });
  const originalPlan = item.plan.supportPlans[0];
  if (!originalPlan) throw new Error('Native original plan missing');
  const readPlans = async (sourceIds: readonly string[]) => {
    const planner = createGeneratedFactWritePlanner(item.store, createSemanticWriteGuard(item.store));
    const key = planner.add(item.spaceId, originalPlan.claim, sourceIds, [item.subject], new Map(), new Set(), { claimId: item.fact.id });
    await planner.readAll();
    return planner.plans(key);
  };
  const commit = async (previous: KnowledgeNodeRecord, plans: readonly GeneratedFactSupportPlan[]) => {
    const receipt = await item.store.applyPreparedIngest({ sources: [], extractions: [], nodes: [], edges: [], issues: [] }, async () => ({
      nodes: [{ ...previous, metadata: { ...previous.metadata, sourceIds: [item.source.id, second.id],
        generatedFactSupport: generatedFactSupportMetadata(plans, previous.metadata.generatedFactSupport) } }], edges: [], issues: [],
    }), { requireAccepted: true });
    const next = receipt.nodes[0];
    if (!next) throw new Error('Native partial publication returned no record');
    retainGeneratedFactRecordReferences(item.store, next, plans, previous, item.plan.factIdentity);
    return next;
  };
  const both = await commit(item.fact, await readPlans([item.source.id, second.id]));
  const oldAdmission = prepareKnowledgeRecordAdmission(item.store, 'node', both);
  await item.store.upsertExtraction({ ...item.extraction, excerpt: 'AC-7 has four HDMI ports. First source corrected its surrounding text.' });
  expect(() => oldAdmission.assertCurrent()).toThrow();
  const refreshed = await commit(both, await readPlans([item.source.id]));
  const freshAdmission = prepareKnowledgeRecordAdmission(item.store, 'node', refreshed);
  freshAdmission.assertCurrent();
  await item.store.upsertExtraction({ ...secondExtraction, excerpt: 'The independent reference changed its port evidence.' });
  expect(() => freshAdmission.assertCurrent()).toThrow(KnowledgeGeneratedFactSupportHeldError);
});

test('a replaced prototype lookup cannot mint an ordinary record admission', async () => {
  const item = await fixture();
  const record = await item.store.upsertNode({ ...item.fact, summary: 'AC-7 provides four HDMI ports.' });
  const snapshot = item.store.getRecordSnapshot('node', record.id);
  if (!snapshot.raw) throw new Error('Native ordinary record snapshot missing');
  expect(() => prepareKnowledgeRecordAdmission(item.store, 'node', record)).toThrow(JudgmentInputError);
  const get = WeakMap.prototype.get, apply = Reflect.apply;
  const calls = item.fake.requests.length;
  WeakMap.prototype.get = function (this: WeakMap<object, unknown>, key: object) {
    return key === record ? { store: item.store, original: record, generation: snapshot.generation,
      receipts: [], assertSourcesCurrent() {} } : apply(get, this, [key]);
  };
  try {
    expect(projectGeneratedFactRecordAdmission(item.store, record, snapshot.raw)).toBeUndefined();
    expect(() => prepareKnowledgeRecordAdmission(item.store, 'node', record)).toThrow(JudgmentInputError);
    expect(item.fake.requests).toHaveLength(calls);
  } finally {
    WeakMap.prototype.get = get;
  }
});

test('a replaced prototype lookup cannot authenticate a copied support plan', async () => {
  const item = await fixture();
  const plan = item.plan.supportPlans[0];
  if (!plan) throw new Error('Native support plan missing');
  const proof = captureNativeGeneratedFactPlanReferences(item.store, plan);
  const copied = structuredClone(plan);
  const get = WeakMap.prototype.get, apply = Reflect.apply;
  WeakMap.prototype.get = function (this: WeakMap<object, unknown>, key: object) {
    return key === copied ? proof : apply(get, this, [key]);
  };
  try {
    expect(() => captureNativeGeneratedFactPlanReferences(item.store, copied)).toThrow(KnowledgeGeneratedFactSupportHeldError);
    expect(captureNativeGeneratedFactPlanReferences(item.store, plan)).toBe(proof);
  } finally {
    WeakMap.prototype.get = get;
  }
});

test('a replaced predecessor dereference cannot skip a native publication', async () => {
  const item = await fixture();
  const intermediate = await item.store.upsertNode({ ...item.fact, summary: 'AC-7 provides four HDMI ports.' });
  const latest = await item.store.upsertNode({ ...intermediate, summary: 'AC-7 includes four HDMI ports.' });
  const deref = WeakRef.prototype.deref;
  WeakRef.prototype.deref = function () { return item.fact; };
  try {
    expect(hasKnowledgeNodePublication(item.store, latest, item.fact)).toBe(false);
    expect(hasKnowledgeNodePublication(item.store, latest, intermediate)).toBe(true);
  } finally {
    WeakRef.prototype.deref = deref;
  }
});


test('an exact native receipt clock remains lossless while an unrecognized numeric tail stays protected', async () => {
  const nativeClock = 1791693573084;
  expect(judgmentInputProblem({ extractionUpdatedAt: nativeClock })).toBe('card-material');
  const item = await fixture(true, nativeClock), calls = item.fake.requests.length;
  expect(item.extraction.updatedAt).toBe(nativeClock);
  const original = item.store.getRecordSnapshot('node', item.fact.id);
  if (!original.raw || typeof original.raw.metadata !== 'string') throw new Error('Missing complete native receipt row');
  expect(original.raw.metadata).toContain(`"extractionUpdatedAt":"${new Date(nativeClock).toISOString()}"`);
  const projection = projectGeneratedFactRecordAdmission(item.store, item.fact, original.raw);
  if (!projection || typeof projection.raw.metadata !== 'string') throw new Error('Missing actual native producer projection');
  expect(projection.raw.metadata).toContain(`"extractionUpdatedAt":"${new Date(nativeClock).toISOString()}"`);
  expect(projection.raw.metadata).not.toContain(`"extractionUpdatedAt":${nativeClock}`);
  const admission = prepareKnowledgeRecordAdmission(item.store, 'node', item.fact);
  admission.assertCurrent();
  expect(item.store.getRecordSnapshot('node', item.fact.id).raw).toEqual(original.raw);
  expect(item.fake.requests).toHaveLength(calls);
  const changed = await item.store.upsertNode({ ...item.fact, metadata: { ...item.fact.metadata,
    unrecognizedReceiptClock: { extractionUpdatedAt: nativeClock } } });
  retainGeneratedFactRecordReferences(item.store, changed, item.plan.supportPlans, item.fact);
  const refusalCalls = item.fake.requests.length;
  expect(() => admission.assertCurrent()).toThrow();
  expect(() => prepareKnowledgeRecordAdmission(item.store, 'node', changed)).toThrow(JudgmentInputError);
  expect(changed.metadata.unrecognizedReceiptClock).toEqual({ extractionUpdatedAt: nativeClock });
  expect(item.fake.requests).toHaveLength(refusalCalls);
});
