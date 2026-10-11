import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeSemanticService } from '../sdk/src/platform/knowledge/semantic/service.js';
import { JudgmentInputError, judgmentInputProblem } from '../sdk/src/platform/gate/judgment-input.js';
import { prepareSourceLinkedRepairProfileFacts } from '../sdk/src/platform/knowledge/semantic/self-improvement-promotion.js';
import { writeSupportedRepairSubjectLinks } from '../sdk/src/platform/knowledge/semantic/repair-subject-write-plan.js';
import { createGeneratedClaimReferenceScope, generatedClaimSupportReferences } from '../sdk/src/platform/knowledge/semantic/verification/structural-references.js';
import { KnowledgeGeneratedFactSupportHeldError } from '../sdk/src/platform/knowledge/semantic/verification/types.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';
import { seedKnowledgeResearchTask } from './_helpers/knowledge-semantic-activation-fixtures.js';
import { repairProfileFixtureReading, repairUsefulFixtureReading } from './_helpers/repair-profile-fixture-readings.js';

const spaceId = 'support-test';
let previous: JudgmentPort | undefined;
const roots: string[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-repair-reference-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const fake = fakePort((name) => {
    if (!['supported', 'attached', 'serve'].includes(name)) throw new Error(`Unexpected reference fixture question: ${name}`);
    return noulAnswer(0.99);
  });
  installJudgmentPort(fake.port);
  const subject = await seedHomeAssistantObservation(store, { id: 'synthetic-repro-subject-767', kind: 'ha_device', slug: 'ac-7', title: 'AC-7', metadata: { knowledgeSpaceId: spaceId, model: 'AC-7' } });
  const source = await store.upsertSource({ id: 'synthetic-source', connectorId: 'synthetic', sourceType: 'manual', title: 'AC-7 reference', status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: 'AC-7 has four HDMI ports.', metadata: { knowledgeSpaceId: spaceId } });
  const gap = await seedKnowledgeResearchTask(store, { id: 'gap', kind: 'knowledge_gap', slug: 'gap', title: 'AC-7 ports', sourceId: source.id, metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [subject.id] } });
  const scope = createGeneratedClaimReferenceScope(store);
  const prepared = await prepareSourceLinkedRepairProfileFacts([{ store, spaceId, source, extraction, subjects: [subject], authority: 'secondary',
    title: 'HDMI ports', summary: 'AC-7 has four HDMI ports.', evidence: 'AC-7 has four HDMI ports.', extractor: 'synthetic',
    classification: { kind: 'specification', title: 'HDMI ports', summary: 'AC-7 has four HDMI ports.', value: 'four hdmi ports', labels: [], aliases: [] },
  }]);
  const [fact] = await prepared.write({ nodeWritten: scope.rememberGenerated });
  expect(judgmentInputProblem({ id: fact!.id })).toBe('card-material');
  return { store, source, extraction, subject, gap, fact: fact!, scope, fake };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function snapshot(store: KnowledgeStore) { return JSON.stringify({ nodes: store.listNodes(), edges: store.listEdges(), tasks: store.listRefinementTasks() }); }
function relink(item: Fixture, generatedClaims: object = item.scope.relinking, store = item.store) {
  return writeSupportedRepairSubjectLinks({ store, spaceId, gap: item.gap, subjects: [store.getNode(item.subject.id)!],
    sourceIds: [item.source.id], candidate: () => true, generatedClaims });
}

describe('repair operation generated-reference scope', () => {
  test('repeated verified relinks retain only the actual producer identity and persist exact receipts', async () => {
    const item = await fixture();
    await relink(item); await relink(item);
    expect(JSON.stringify(item.fake.requests)).not.toContain(item.fact.id);
    const current = item.store.getNode(item.fact.id)!;
    expect(generatedClaimSupportReferences(item.scope.relinking, item.store, current)?.claimId).toBe(item.fact.id);
    expect((current.metadata.generatedFactSupport as { receipts: { claimId: string }[] }).receipts.every((receipt) => receipt.claimId === item.fact.id)).toBe(true);
    const reopened = new KnowledgeStore({ dbPath: item.store.storagePath }); await reopened.init();
    expect(reopened.getNode(item.fact.id)).toEqual(current);
    expect(reopened.listEdges()).toEqual(item.store.listEdges());
  });
  test('forged and JSON-copied operation tokens hold before requests or writes', async () => {
    const item = await fixture();
    for (const token of [{}, JSON.parse(JSON.stringify(item.scope.relinking)) as object]) {
      const before = snapshot(item.store), calls = item.fake.requests.length;
      await expect(relink(item, token)).rejects.toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
      expect(snapshot(item.store)).toBe(before); expect(item.fake.requests).toHaveLength(calls);
    }
  });
  test('a valid token cannot cross store instances, including reopening the same SQLite file', async () => {
    const item = await fixture(); const reopened = new KnowledgeStore({ dbPath: item.store.storagePath }); await reopened.init();
    const before = snapshot(reopened), calls = item.fake.requests.length;
    await expect(relink(item, item.scope.relinking, reopened)).rejects.toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
    expect(snapshot(reopened)).toBe(before); expect(item.fake.requests).toHaveLength(calls);
  });
  test('a new operation and copied or replaced records cannot inherit producer authority', async () => {
    const item = await fixture();
    expect(generatedClaimSupportReferences(item.scope.relinking, item.store, structuredClone(item.fact))).toBeUndefined();
    let before = snapshot(item.store), calls = item.fake.requests.length;
    await expect(relink(item, createGeneratedClaimReferenceScope(item.store).relinking)).rejects.toBeInstanceOf(JudgmentInputError);
    expect(snapshot(item.store)).toBe(before); expect(item.fake.requests).toHaveLength(calls);
    await item.store.upsertNode({ ...item.fact, summary: 'AC-7 provides four HDMI ports.' });
    expect(() => generatedClaimSupportReferences(item.scope.relinking, item.store, item.fact)).toThrow(KnowledgeGeneratedFactSupportHeldError);
    before = snapshot(item.store); calls = item.fake.requests.length;
    await expect(relink(item)).rejects.toBeInstanceOf(JudgmentInputError);
    expect(snapshot(item.store)).toBe(before); expect(item.fake.requests).toHaveLength(calls);
  });
  test('a protected semantic source field still holds a valid generated scope before requests or writes', async () => {
    const item = await fixture();
    await item.store.upsertExtraction({ ...item.extraction, excerpt: 'AC-7 has four HDMI ports. Synthetic payment number 4111111111111111' });
    const before = snapshot(item.store), calls = item.fake.requests.length;
    await expect(relink(item)).rejects.toBeInstanceOf(JudgmentInputError);
    expect(snapshot(item.store)).toBe(before); expect(item.fake.requests).toHaveLength(calls);
  });
  test('a held relink reports no completed repair while preserving an earlier independently settled promotion', async () => {
    const item = await fixture(); await item.store.deleteNode(item.fact.id);
    const profile = [['Input and output ports', 'AC-7 has four HDMI ports.']] as const;
    const graph = () => JSON.stringify({ facts: item.store.listNodes().filter((node) => node.kind === 'fact'), edges: item.store.listEdges() });
    let atHold = '';
    const fake = fakePort((name, question, state) => {
      if (name === 'authority') {
        if ((state as { source?: { title?: string } }).source?.title !== 'AC-7 reference') throw new Error('Unexpected authority fixture source');
        return choiceAnswer(question, 'official-vendor', 0.99);
      }
      const reading = repairProfileFixtureReading(name, state, profile);
      if (reading !== undefined) return noulAnswer(reading);
      if (name === 'repairUseful') return noulAnswer(repairUsefulFixtureReading(state, profile));
      if (name === 'supported' && item.store.listNodes().some((node) => node.kind === 'fact')) {
        atHold ||= graph(); return noulAnswer(0.01);
      }
      if (['supported', 'attached', 'serve'].includes(name)) return noulAnswer(0.99);
      throw new Error(`Unexpected held relink fixture question: ${name}`);
    });
    installJudgmentPort(fake.port);
    const semantic = new KnowledgeSemanticService(item.store, { gapRepairer: async () => ({ searched: true,
      evidenceSufficient: true, acceptedSourceIds: [item.source.id], ingestedSourceIds: [], skippedUrls: [],
    }) });
    const result = await semantic.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [item.gap.id], force: true });
    expect(result.closedGaps).toBe(0); expect(result.promotedFactCount).toBe(0);
    expect(result.errors).toEqual([{ gapId: item.gap.id, error: new KnowledgeGeneratedFactSupportHeldError('no-support').message }]);
    expect(atHold).not.toBe(''); expect(graph()).toBe(atHold);
    expect(item.store.listNodes().filter((node) => node.kind === 'fact' && node.status === 'active')).toHaveLength(1);
    expect(item.store.getRefinementTask(result.taskIds[0]!)?.state).toBe('failed');
    const reopened = new KnowledgeStore({ dbPath: item.store.storagePath }); await reopened.init();
    expect(reopened.listNodes().filter((node) => node.kind === 'fact')).toEqual(item.store.listNodes().filter((node) => node.kind === 'fact'));
    expect(reopened.listEdges()).toEqual(item.store.listEdges());
    expect(reopened.getRefinementTask(result.taskIds[0]!)?.state).toBe('failed');
  });
});
