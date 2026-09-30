import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { reviewKnowledgeNodeRecord } from '../sdk/src/platform/knowledge/service-node-admin.js';
import { createRepairUsefulnessGuard, prepareRepairUsefulness } from '../sdk/src/platform/knowledge/semantic/repair-usefulness-plan.js';
import { createRepairFactUsefulnessReader } from '../sdk/src/platform/knowledge/semantic/repair-usefulness/reader.js';
import { KnowledgeRepairFactUsefulnessHeldError } from '../sdk/src/platform/knowledge/semantic/repair-usefulness/types.js';
import { writeSupportedRepairSubjectLinks } from '../sdk/src/platform/knowledge/semantic/repair-subject-write-plan.js';
import { promoteRepairSources } from '../sdk/src/platform/knowledge/semantic/self-improvement-promotion.js';
import { KnowledgeSourceQualityHeldError } from '../sdk/src/platform/knowledge/source-quality.js';
const spaceId = 'repair-usefulness-space';
const smart = 'Smart TV platform and integrations';
const useful = 'AC-7 supports webOS and an ATSC tuner.';
const furniture = 'Place AC-7 on a stable platform with supporting furniture.';
let previous: JudgmentPort | undefined;
const roots: string[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function readings(probability = 0.99) {
  const fake = fakePort((name, _question, state) => {
    const input = state as { fact?: { title: string; summary?: string } };
    if (name === 'repairUseful') return noulAnswer(input.fact?.title === smart && input.fact.summary === `${smart}: ${useful}` ? probability : 0.01);
    if (['supported', 'attached', 'serve'].includes(name)) return noulAnswer(0.99); // Synthetic stored facts, including preexisting bad claims under test.
    if (name === 'wanted') return noulAnswer(0.01); // This suite tests stored fact decisions, not profile derivation.
    throw new Error(`Unscripted usefulness boundary question ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-repair-usefulness-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const raw = { id: 'subject', kind: 'ha_device' as const, slug: 'ac-seven', title: 'AC-7', status: 'active' as const, metadata: { knowledgeSpaceId: spaceId, model: 'AC-7' } };
  const subject = await upsertObservedKnowledgeNode(store, raw, 'home-assistant-snapshot', raw, () => raw);
  const source = await store.upsertSource({ id: 'source', connectorId: 'synthetic', sourceType: 'manual', title: 'AC-7 manual', status: 'indexed', metadata: { knowledgeSpaceId: spaceId, privateState: 'UNRELATED_METADATA' } });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: `${useful}\n\n${furniture}\n\nAC-7 supports 4K, not 8K.`, metadata: { knowledgeSpaceId: spaceId } });
  readings();
  const facts = [];
  for (const [index, title, statement] of [['smart', smart, useful], ['furniture', 'Furniture placement', furniture], ['unsupported', '8K display', 'AC-7 supports 8K.']] as const) {
    facts.push(await store.upsertNode({ id: `fact-${index}`, kind: 'fact', slug: `fact-${index}`, title, summary: `${title}: ${statement}`, status: 'active', sourceId: source.id,
      metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', factKind: 'feature', evidence: statement, value: statement, sourceIds: [source.id], subjectIds: [subject.id], linkedObjectIds: [subject.id], subject: subject.title } }));
  }
  const research = { id: 'gap', kind: 'knowledge_gap' as const, slug: 'gap', title: 'Does AC-7 support webOS?', status: 'active' as const, metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [subject.id] } };
  const gap = await upsertObservedKnowledgeNode(store, research, 'research-task', research, () => research);
  return { store, subject, source, extraction, facts, gap };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function snapshot(store: KnowledgeStore) { return JSON.stringify({ nodes: store.listNodes(), edges: store.listEdges(), tasks: store.listRefinementTasks() }); }
function prepare(item: Fixture, reader = createRepairFactUsefulnessReader()) {
  const subjects = [item.subject];
  return prepareRepairUsefulness({ ...item, spaceId, subjects, candidates: item.facts.filter((fact) => item.store.getNode(fact.id)?.status === 'active'),
    guard: createRepairUsefulnessGuard(item.store, spaceId, item.gap, subjects), reader });
}
describe('repair usefulness write and count boundaries', () => {
  test('Smart TV platform plus tuner support is useful; actual furniture and unsupported claims remain negative', async () => {
    const item = await fixture(); const fake = readings(), before = snapshot(item.store);
    const prepared = await prepare(item);
    expect(prepared.count).toBe(1); expect(prepared.accepts(item.facts[0]!)).toBe(true);
    expect(prepared.accepts(item.facts[1]!)).toBe(false); expect(prepared.accepts(item.facts[2]!)).toBe(false);
    expect(snapshot(item.store)).toBe(before); expect(JSON.stringify(fake.requests)).not.toContain('UNRELATED_METADATA');
    await writeSupportedRepairSubjectLinks({ ...item, spaceId, subjects: [item.subject], sourceIds: [item.source.id], candidate: prepared.accepts, assertCurrent: prepared.assertCurrent });
    expect(item.store.listEdges().filter((edge) => edge.relation === 'describes').map((edge) => edge.fromId)).toEqual([item.facts[0]!.id]);
  });
  test('uncertain, unconfigured and unavailable existing-fact decisions stop linking and fallback writes', async () => {
    for (const mode of ['uncertain', 'unconfigured', 'unavailable'] as const) {
      const item = await fixture(); const task = await item.store.upsertRefinementTask({ spaceId, gapId: item.gap.id, state: 'applying', trigger: 'manual' });
      const fake = readings(mode === 'uncertain' ? 0.5 : 0.99); let enriched = false;
      if (mode === 'unconfigured') installJudgmentPort(undefined);
      if (mode === 'unavailable') installJudgmentPort({ ...fake.port, async ask() { throw new Error('Synthetic unavailable'); } });
      const before = snapshot(item.store);
      await expect(promoteRepairSources({ store: item.store, enrichSource: async () => { enriched = true; } }, spaceId, item.gap, [item.source.id], task, Date.now() + 5_000)).rejects.toBeInstanceOf(KnowledgeRepairFactUsefulnessHeldError);
      expect(snapshot(item.store)).toBe(before); expect(enriched).toBe(false);
    }
  });
  test('excluded-candidate operator rejection after preparation invalidates the entire linking pass', async () => {
    const item = await fixture(); readings(); const prepared = await prepare(item);
    await reviewKnowledgeNodeRecord(item.store, { id: item.facts[1]!.id, decision: 'reject' });
    const afterReview = snapshot(item.store);
    await expect(writeSupportedRepairSubjectLinks({ ...item, spaceId, subjects: [item.subject], sourceIds: [item.source.id], candidate: prepared.accepts, assertCurrent: prepared.assertCurrent })).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
    expect(snapshot(item.store)).toBe(afterReview);
  });
  test('source and operator changes during usefulness readings cannot authorize stale links', async () => {
    for (const change of ['source', 'operator'] as const) {
      const item = await fixture(); const fake = readings(), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(); let paused = false;
      installJudgmentPort({ ...fake.port, async ask(request) {
        const result = await fake.port.ask(request);
        if ('repairUseful' in request.questions && !paused) { paused = true; entered.resolve(); await released.promise; }
        return result;
      } });
      const pending = prepare(item); await entered.promise;
      if (change === 'source') await item.store.replaceSourceRecord({ ...item.source, title: 'Changed AC-8 source' });
      else await reviewKnowledgeNodeRecord(item.store, { id: item.facts[0]!.id, decision: 'reject' });
      const afterExternalChange = snapshot(item.store); released.resolve();
      await expect(pending).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
      expect(snapshot(item.store)).toBe(afterExternalChange);
    }
  });
  test('repeated repair counts remain useful counts and never revive rejected facts', async () => {
    const item = await fixture(); readings();
    await reviewKnowledgeNodeRecord(item.store, { id: item.facts[2]!.id, decision: 'reject' });
    const task = await item.store.upsertRefinementTask({ spaceId, gapId: item.gap.id, state: 'applying', trigger: 'manual' });
    for (let repeat = 0; repeat < 2; repeat++) {
      const result = await promoteRepairSources({ store: item.store, enrichSource: async () => { throw new Error('Useful existing fact should avoid enrichment'); } }, spaceId, item.gap, [item.source.id], task, Date.now() + 5_000);
      expect(result.promotedFactCount).toBe(1); expect(result.repairComplete).toBe(true);
      expect(item.store.getNode(item.facts[2]!.id)!.status).toBe('stale');
      expect(item.store.listNodes().filter((node) => node.kind === 'fact')).toHaveLength(3);
    }
  });
});
