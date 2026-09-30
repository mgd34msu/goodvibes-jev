import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { judgmentInputProblem, JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { semanticFactId } from '../sdk/src/platform/knowledge/semantic/utils.js';
import { prepareSourceLinkedRepairProfileFacts } from '../sdk/src/platform/knowledge/semantic/self-improvement-promotion.js';
import { prepareGeneratedFactSupport, KnowledgeGeneratedFactSupportHeldError, type GeneratedFactSupportInput } from '../sdk/src/platform/knowledge/semantic/verification/generated-fact-support.js';
import { withEngineGeneratedSupportReferences } from '../sdk/src/platform/knowledge/semantic/verification/structural-references.js';
import { supportHash } from '../sdk/src/platform/knowledge/semantic/verification/projection.js';

const spaceId = 'support-test';
const actualClaimId = semanticFactId({ spaceId, kind: 'specification', title: 'HDMI ports', value: 'four hdmi ports', subjectIds: ['synthetic-repro-subject-767'] });
// A synthetic protected-shaped label tests path specificity; it is not a card.
const generatedSubjectId = 'sem-entity-4111111111111111';
let previous: JudgmentPort | undefined;
const roots: string[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function readings() { const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port); return fake; }
function input(claimId = actualClaimId, subjectId = 'subject'): GeneratedFactSupportInput {
  return {
    spaceId,
    claim: { id: claimId, kind: 'specification', title: 'HDMI ports', value: 'four hdmi ports', targetHints: [{ id: subjectId, kind: 'knowledge_entity', title: 'AC-7' }] },
    source: { id: 'source', connectorId: 'synthetic', sourceType: 'manual', title: 'AC-7 reference', tags: [], status: 'indexed', metadata: { knowledgeSpaceId: spaceId }, createdAt: 1, updatedAt: 1 },
    extraction: { id: 'extraction', sourceId: 'source', extractorId: 'synthetic', format: 'text', excerpt: 'AC-7 has four HDMI ports.', sections: [], links: [], estimatedTokens: 8, structure: {}, metadata: { knowledgeSpaceId: spaceId }, createdAt: 1, updatedAt: 1 },
    subjects: [{ id: subjectId, kind: 'knowledge_entity', slug: 'ac-7', title: 'AC-7', aliases: [], confidence: 90, status: 'active', metadata: { knowledgeSpaceId: spaceId, model: 'AC-7' }, createdAt: 1, updatedAt: 1 }],
  };
}
function branded(candidate: GeneratedFactSupportInput, subjectIds: readonly string[] = []) {
  return withEngineGeneratedSupportReferences(candidate, { claimId: candidate.claim.id, subjectIds: new Set(subjectIds) });
}

describe('engine-generated structural reference projection', () => {
  test('the actual deterministic generated-ID reproduction holds through the raw boundary', async () => {
    expect(judgmentInputProblem({ id: actualClaimId })).toBe('card-material');
    const fake = readings();
    await expect(prepareGeneratedFactSupport([input()])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test('trusted engine projection sends opaque references and keeps exact local provenance', async () => {
    const fake = readings(); const candidate = input(actualClaimId, generatedSubjectId);
    const [plan] = await prepareGeneratedFactSupport([branded(candidate, [generatedSubjectId])]);
    const wire = JSON.stringify(fake.requests);
    expect(wire).not.toContain(actualClaimId); expect(wire).not.toContain(generatedSubjectId);
    expect(wire).toContain('claim-1'); expect(wire).toContain('subject-1'); expect(wire).toContain('four hdmi ports');
    expect(plan!.claimId).toBe(actualClaimId); expect(plan!.claim.id).toBe(actualClaimId);
    expect(plan!.claimHash).toBe(supportHash(candidate.claim));
    expect(plan!.receipts.find((receipt) => receipt.field === 'subjectAttachment')?.subjectId).toBe(generatedSubjectId);
    expect(plan!.receipts.find((receipt) => receipt.field === 'targetHints[0]')?.fieldHash).toBe(supportHash(candidate.claim.targetHints![0]));
    for (const request of fake.requests) {
      const state = request.state as { claim: { targetHints: { id: string }[] }; subjects: { id: string }[]; field?: { name: string; value: { id?: string } } };
      expect(state.claim.targetHints[0]!.id).toBe(state.subjects[0]!.id);
      if (state.field?.name === 'targetHints[0]') expect(state.field.value.id).toBe(state.subjects[0]!.id);
    }
  });
  test('duplicate references share labels while distinct claims retain their own receipts', async () => {
    const fake = readings();
    const a = branded(input('engine-generated-a', generatedSubjectId), [generatedSubjectId]);
    const b = branded(input('engine-generated-b', generatedSubjectId), [generatedSubjectId]);
    const plans = await prepareGeneratedFactSupport([a, a, b]);
    expect(plans[0]).toEqual(plans[1]);
    expect(plans[2]!.receipts.every((receipt) => receipt.claimId === 'engine-generated-b')).toBe(true);
    const states = fake.requests.map(({ state }) => state as { claim: { id: string }; subjects: { id: string }[] });
    expect(new Set(states.map((state) => state.claim.id))).toEqual(new Set(['claim-1', 'claim-2']));
    expect(new Set(states.map((state) => state.subjects[0]!.id))).toEqual(new Set(['subject-1']));
  });
  test('JSON copies, lookalike flags and familiar ID prefixes do not carry authority', async () => {
    const fake = readings();
    const candidate = branded(input());
    const copy = JSON.parse(JSON.stringify({ ...candidate, structuralReferences: { claimId: actualClaimId }, engineGenerated: true })) as GeneratedFactSupportInput;
    await expect(prepareGeneratedFactSupport([copy])).rejects.toBeInstanceOf(JudgmentInputError);
    await expect(prepareGeneratedFactSupport([{ ...input('safe'), claim: { ...input('safe').claim, id: 'sem-fact-4111111111111111' } }])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test('a protected semantic field in a later branded input blocks the whole pass', async () => {
    const fake = readings(); const late = input('generated-later');
    await expect(prepareGeneratedFactSupport([branded(input()), branded({ ...late, claim: { ...late.claim, evidence: 'Synthetic payment number 4111111111111111' } })])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test('the capability cannot exempt source IDs, unregistered subjects or identity text', async () => {
    const fake = readings();
    await expect(prepareGeneratedFactSupport([branded(input(actualClaimId, generatedSubjectId))])).rejects.toBeInstanceOf(JudgmentInputError);
    const candidate = input();
    await expect(prepareGeneratedFactSupport([branded({ ...candidate, source: { ...candidate.source, id: '4111111111111111' },
      extraction: { ...candidate.extraction!, sourceId: '4111111111111111' },
    })])).rejects.toBeInstanceOf(JudgmentInputError);
    await expect(prepareGeneratedFactSupport([branded({ ...candidate, subjects: [{ ...candidate.subjects[0]!, title: '4111111111111111' }] })])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test('a changed structural identity after registration holds before the port', async () => {
    const fake = readings(); const candidate = input(); branded(candidate);
    Object.assign(candidate.claim, { id: 'changed-after-registration' });
    await expect(prepareGeneratedFactSupport([candidate])).rejects.toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
    expect(fake.requests).toHaveLength(0);
  });
  test('the actual repair-profile caller writes the reproduced ID without transmitting it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-structural-id-')); roots.push(root);
    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); const fake = readings();
    const subject = await store.upsertNode({ id: 'synthetic-repro-subject-767', kind: 'knowledge_entity', slug: 'ac-7', title: 'AC-7', status: 'active', metadata: { knowledgeSpaceId: spaceId } });
    const source = await store.upsertSource({ id: 'synthetic-source', connectorId: 'synthetic', sourceType: 'manual', title: 'AC-7 reference', status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
    const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: 'AC-7 has four HDMI ports.', metadata: { knowledgeSpaceId: spaceId } });
    const prepared = await prepareSourceLinkedRepairProfileFacts([{ store, spaceId, source, extraction, subjects: [subject], authority: 'secondary',
      title: 'HDMI ports', summary: 'AC-7 has four HDMI ports.', evidence: 'AC-7 has four HDMI ports.', extractor: 'synthetic',
      classification: { kind: 'specification', title: 'HDMI ports', summary: 'AC-7 has four HDMI ports.', value: 'four hdmi ports', labels: [], aliases: [] },
    }]);
    const [fact] = await prepared.write();
    expect(fact!.id).toBe(actualClaimId); expect(store.getNode(actualClaimId)).not.toBeNull();
    expect(JSON.stringify(fake.requests)).not.toContain(actualClaimId);
    expect((fact!.metadata.generatedFactSupport as { receipts: { claimId: string }[] }).receipts.every((receipt) => receipt.claimId === actualClaimId)).toBe(true);
  });
});
