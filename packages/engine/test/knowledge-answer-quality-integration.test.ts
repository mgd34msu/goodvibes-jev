import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { createSchema } from '../sdk/src/platform/knowledge/store-schema.js';
import { writeKnowledgeNodeRow } from '../sdk/src/platform/knowledge/store-node-history.js';
import type { KnowledgeNodeRecord } from '../sdk/src/platform/knowledge/types.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { reviewKnowledgeIssue } from '../sdk/src/platform/knowledge/review.js';
import { reviewKnowledgeNodeRecord } from '../sdk/src/platform/knowledge/service-node-admin.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { answerKnowledgeQuery } from '../sdk/src/platform/knowledge/semantic/answer.js';
import { KnowledgeAnswerQualityHeldError } from '../sdk/src/platform/knowledge/semantic/answer-verification/types.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import type { KnowledgeSemanticLlm } from '../sdk/src/platform/knowledge/semantic/types.js';
let previous: JudgmentPort | undefined;
const roots: string[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
async function fixture(extracted = true) {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-answer-verification-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const source = await store.upsertSource({ id: 'source-local', connectorId: 'synthetic', sourceType: 'manual', title: 'AC-7 manual', status: 'indexed', metadata: { knowledgeSpaceId: 'fixture-space', sourceDiscovery: { trustReason: 'official-vendor-domain' } } });
  if (extracted) await store.upsertExtraction({ id: 'extraction-local', sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: 'AC-7 has four HDMI ports. It does not support Bluetooth. Its power draw is not specified.', metadata: { knowledgeSpaceId: 'fixture-space' } });
  // The initial fact is an authored faithful fixture when actual extraction exists.
  const oldPort = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
  const fact = await store.upsertNode({ id: 'fact-local', kind: 'fact', slug: 'ports', title: 'AC-7 HDMI ports', summary: 'AC-7 has four HDMI ports.', sourceId: source.id, metadata: { knowledgeSpaceId: 'fixture-space', semanticKind: 'fact', value: 'four HDMI ports' } });
  installJudgmentPort(oldPort);
  return { store, source, fact, input: { knowledgeSpaceId: 'fixture-space', query: 'How many HDMI ports does AC-7 have?', strictCandidates: true, candidateSourceIds: [source.id], autoRepairGaps: false } };
}
/** The answer boundary must also reject invalid active facts left by pre-gate versions. */
async function legacyFact(store: KnowledgeStore, fact: KnowledgeNodeRecord): Promise<KnowledgeStore> {
  const sqlite = new SQLiteStore(store.storagePath); await sqlite.init(createSchema);
  writeKnowledgeNodeRow(sqlite, fact); await sqlite.save();
  const reloaded = new KnowledgeStore({ dbPath: store.storagePath }); await reloaded.init(); return reloaded;
}
function snapshot(store: KnowledgeStore) { return { sources: store.listSources(), nodes: store.listNodes(), issues: store.listIssues(), edges: store.listEdges() }; }
function readings(options: { enough?: number; complete?: number; generated?: 'supported' | 'contradicted' | 'unsupported'; rendered?: 'supported' | 'contradicted' | 'unsupported'; confidence?: number } = {}) {
  const fake = fakePort((name, question, state) => {
    if (name === 'fidelity') return choiceAnswer(question, (state as { candidate: { id: string } }).candidate.id === 'generated' ? options.generated ?? 'supported' : options.rendered ?? 'supported', options.confidence ?? 0.97);
    if (name === 'preferred') return choiceAnswer(question, 'generated', 0.97);
    if (name === 'enough') return noulAnswer(options.enough ?? 0.97);
    if (name === 'complete') return noulAnswer(options.complete ?? 0.97);
    if (name === 'sameQuestion') return noulAnswer(0.99); // Repeated exact question fixtures.
    if (name === 'serve') return noulAnswer(0.99); // Faithful synthetic fixture content; not an answer-quality verdict.
    if (name === 'useful' && ['AC-7 manual', 'AC-7 HDMI ports', 'AC-7'].includes((state as { candidate?: { title?: string } }).candidate?.title ?? '')) return noulAnswer(0.99);
    if (name === 'excerptUseful') return noulAnswer(0.01); // Full-extraction fidelity is tested independently.
    if (name === 'features' || name === 'match') return noulAnswer(0.97);
    throw new Error(`Unexpected fixture question ${name}`);
  }); installJudgmentPort(fake.port); return fake;
}
function llm(completeText: KnowledgeSemanticLlm['completeText']): KnowledgeSemanticLlm { return { completeText, async completeJson() { throw new Error('Answer generation must use plain text'); } }; }
async function held(result: Promise<unknown>, reason: KnowledgeAnswerQualityHeldError['reason']) {
  const error = await result.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(KnowledgeAnswerQualityHeldError); expect((error as KnowledgeAnswerQualityHeldError).reason).toBe(reason);
}
describe('end-to-end answer quality barrier', () => {
  test('plain generation and returned facts are independently verified with exact citation provenance', async () => {
    const { store, source, input } = await fixture(); const fake = readings({ confidence: 0.93 }); let prompt = '';
    const result = await answerKnowledgeQuery({ store, llm: llm(async (request) => { prompt = request.prompt; return 'Four HDMI ports. [ref:evidence-1]'; }) }, input);
    expect(result.answer.confidence).toBe(93); expect(result.answer.quality?.status).toBe('verified');
    expect(result.answer.quality?.evidenceReferences).toEqual([{ reference: 'evidence-1', sourceId: source.id, extractionId: 'extraction-local' }]);
    expect(result.answer.facts).toHaveLength(1); expect(prompt).toContain('does not support Bluetooth'); expect(prompt).not.toContain(source.id);
    const requests = fake.requests.filter((request) => 'fidelity' in request.questions); expect(requests).toHaveLength(2); expect(JSON.stringify(requests)).toContain('AC-7 HDMI ports');
    expect(requests.every((request) => Object.isFrozen(request.state))).toBe(true);
  });
  test('unconfigured generation requires fidelity for the literal candidate', async () => {
    const { store, input } = await fixture(); const fake = readings(); const result = await answerKnowledgeQuery({ store }, input);
    expect(result.answer.text).toContain('four HDMI ports'); expect(result.answer.confidence).toBe(97); expect(fake.requests.filter((request) => 'fidelity' in request.questions)).toHaveLength(1);
  });
  test('settled contradictory generation is excluded rather than cleaned into a trusted answer', async () => {
    const { store, input } = await fixture(); const fake = readings({ generated: 'contradicted' });
    const result = await answerKnowledgeQuery({ store, llm: llm(async () => 'Eight ports, with Bluetooth.') }, input);
    expect(result.answer.text).toContain('four HDMI ports'); expect(result.answer.text).not.toContain('Eight'); expect(fake.requests.some((request) => 'preferred' in request.questions)).toBe(false);
  });
  for (const includeConfidence of [true, false]) test(`partial fidelity and insufficiency stay separate with includeConfidence=${includeConfidence}`, async () => {
    const { store, input } = await fixture(); readings({ enough: 0.03, complete: 0.03 });
    const result = await answerKnowledgeQuery({ store }, { ...input, includeConfidence, query: 'What HDMI ports and power draw does AC-7 have?' });
    expect(result.answer.confidence).toBe(includeConfidence ? 97 : 0); expect(result.answer.quality?.fidelity?.probability).toBe(0.97); expect(result.answer.quality?.status).toBe('partial');
    expect(result.answer.quality?.evidenceSufficient?.verdict).toBe('no'); expect(result.answer.gaps).toHaveLength(1); expect(store.listIssues()).toHaveLength(1);
  });
  test('unsupported candidates with sufficient evidence do not invent a repair gap', async () => {
    const { store, input } = await fixture(); readings({ generated: 'unsupported', rendered: 'unsupported' }); const before = snapshot(store);
    const result = await answerKnowledgeQuery({ store, llm: llm(async () => 'Unverified claim.') }, input);
    expect(result.answer.quality?.status).toBe('unsupported'); expect(result.answer.confidence).toBe(0); expect(result.answer.facts).toEqual([]); expect(result.answer.gaps).toEqual([]); expect(snapshot(store)).toEqual(before);
  });
  test('missing extraction produces only an observed availability gap', async () => {
    const { store, input } = await fixture(false); const fake = readings(); let generations = 0;
    const result = await answerKnowledgeQuery({ store, llm: llm(async () => { generations++; return 'Four ports.'; }) }, input);
    expect(generations).toBe(0); expect(result.answer.confidence).toBe(0); expect(result.answer.quality?.status).toBe('no-evidence'); expect(result.answer.facts).toEqual([]); expect(result.answer.gaps).toHaveLength(1);
    expect(fake.requests.some((request) => 'fidelity' in request.questions || 'enough' in request.questions)).toBe(false);
  });
  for (const mode of ['uncertain', 'unavailable', 'malformed'] as const) test(`${mode} quality holds all answer and gap writes`, async () => {
    const { store, input } = await fixture(); const fake = readings(mode === 'uncertain' ? { enough: 0.5 } : {});
    if (mode !== 'uncertain') installJudgmentPort({ ...fake.port, async ask(request) {
      if ('enough' in request.questions) {
        if (mode === 'unavailable') throw new Error('Synthetic offline quality reader');
        const response = await fake.port.ask(request);
        return { ...response, answers: { enough: { type: 'noul', noul: NaN } } } as typeof response;
      }
      return fake.port.ask(request);
    } });
    const before = snapshot(store); await held(answerKnowledgeQuery({ store }, input), mode); expect(snapshot(store)).toEqual(before);
  });
  test('source or operator changes during generation hold before repair writes', async () => {
    for (const change of ['source', 'operator'] as const) {
      const { store, source, fact, input } = await fixture(); readings({ enough: 0.03 });
      await held(answerKnowledgeQuery({ store, llm: llm(async () => {
        if (change === 'source') await store.upsertSource({ ...source, summary: 'Corrected source revision.' });
        else await reviewKnowledgeNodeRecord(store, { id: fact.id, decision: 'reject', reviewer: 'operator' });
        return 'Four ports.';
      }) }, input), 'stale');
      expect(store.listIssues()).toEqual([]); expect(store.listNodes().filter((node) => node.kind === 'knowledge_gap')).toEqual([]);
    }
  });
  test('a late resolved answer-gap issue is not reopened by an earlier quality read', async () => {
    const { store, input } = await fixture(); const fake = readings({ enough: 0.03, complete: 0.03 });
    await answerKnowledgeQuery({ store }, input); const issue = store.listIssues()[0]!;
    const nodeBefore = store.getNode(issue.nodeId!)!;
    installJudgmentPort({ ...fake.port, async ask(request) {
      if ('enough' in request.questions) await reviewKnowledgeIssue(store, { issueId: issue.id, action: 'resolve', reviewer: 'operator' });
      return fake.port.ask(request);
    } });
    await held(answerKnowledgeQuery({ store }, input), 'stale');
    expect(store.getIssue(issue.id)?.status).toBe('resolved'); expect(store.getNode(nodeBefore.id)).toEqual(nodeBefore);
  });
  test('returned fact subject descriptions are included in fidelity input', async () => {
    const { store, fact, input, source } = await fixture();
    readings();
    await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: 'AC-7 is a receiver with four HDMI ports.', metadata: { knowledgeSpaceId: 'fixture-space' } });
    const subject = await store.upsertNode({ sourceId: source.id, id: 'subject-local', kind: 'knowledge_entity', slug: 'ac7', title: 'AC-7', summary: 'The AC-7 receiver.', metadata: { knowledgeSpaceId: 'fixture-space', semanticKind: 'entity' } });
    await store.upsertNode({ ...fact, metadata: { ...fact.metadata, subjectIds: [subject.id], linkedObjectIds: [subject.id] } });
    const fake = readings(); await answerKnowledgeQuery({ store }, { ...input, linkedObjects: [subject] });
    const request = fake.requests.find((entry) => 'fidelity' in entry.questions)!;
    expect(JSON.stringify((request.state as { candidate: unknown }).candidate)).toContain('The AC-7 receiver.');
  });
  test('unknown returned subject references hold rather than silently removing their meaning', async () => {
    const initial = await fixture(); const { fact, input } = initial;
    const store = await legacyFact(initial.store, { ...fact, metadata: { ...fact.metadata, subjectIds: ['unknown-subject'] } });
    const fake = readings(); let generations = 0; const before = snapshot(store);
    await held(answerKnowledgeQuery({ store, llm: llm(async () => { generations++; return 'Four ports.'; }) }, input), 'malformed');
    expect(generations).toBe(0); expect(fake.requests.some((request) => 'fidelity' in request.questions)).toBe(false); expect(snapshot(store)).toEqual(before);
  });
  test('unknown-origin target hint IDs keep the normal protected-input gate', async () => {
    const initial = await fixture(); const { fact, input } = initial;
    const store = await legacyFact(initial.store, { ...fact, metadata: { ...fact.metadata, targetHints: [{ id: 'Authorization: Bearer synthetic-protected-hint' }] } });
    const fake = readings(); let generations = 0;
    await expect(answerKnowledgeQuery({ store, llm: llm(async () => { generations++; return 'Four ports.'; }) }, input)).rejects.toBeInstanceOf(JudgmentInputError);
    expect(generations).toBe(0); expect(fake.requests.some((request) => 'fidelity' in request.questions)).toBe(false); expect(store.listIssues()).toEqual([]);
  });
  test('numeric returned values remain claims instead of disappearing from fidelity input', async () => {
    const { store, fact, input } = await fixture();
    readings();
    await store.upsertNode({ ...fact, metadata: { ...fact.metadata, value: 4 } });
    const fake = readings(); const result = await answerKnowledgeQuery({ store }, input);
    const request = fake.requests.find((entry) => 'fidelity' in entry.questions)!;
    const candidate = (request.state as { candidate: { facts: string[] } }).candidate;
    expect(candidate.facts.map((claim) => JSON.parse(claim) as { value?: unknown }).some((claim) => claim.value === 4)).toBe(true);
    expect(result.answer.facts[0]?.metadata.value).toBe(4);
  });
  test('a protected late extraction suffix prevents generation and answer-quality requests', async () => {
    const { store, source, input } = await fixture(); const fake = readings(); let generations = 0;
    await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: `AC-7 has four HDMI ports. ${'Plain source information. '.repeat(1800)} Authorization: Bearer synthetic-protected`, metadata: { knowledgeSpaceId: 'fixture-space' } });
    await expect(answerKnowledgeQuery({ store, llm: llm(async () => { generations++; return 'Four ports.'; }) }, input)).rejects.toBeInstanceOf(JudgmentInputError);
    expect(generations).toBe(0); expect(fake.requests.some((request) => 'fidelity' in request.questions || 'enough' in request.questions)).toBe(false); expect(store.listIssues()).toEqual([]);
  });
  test('ignored-signal generation cannot keep the deadline alive or write after release', async () => {
    const { store, input } = await fixture(); const fake = readings(); const started = Promise.withResolvers<void>(), release = Promise.withResolvers<string>();
    const pending = answerKnowledgeQuery({ store, llm: llm(async () => { started.resolve(); return release.promise; }) }, { ...input, timeoutMs: 100 });
    await started.promise; await held(pending, 'budget'); release.resolve('Four HDMI ports.'); await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(fake.requests.some((request) => 'fidelity' in request.questions)).toBe(false); expect(store.listIssues()).toEqual([]);
  });
  test('ignored-signal retrieval stops subsequent requests after the total deadline', async () => {
    const { store, input } = await fixture(); const fake = readings(); const release = Promise.withResolvers<void>(); let requests = 0;
    installJudgmentPort({ ...fake.port, async ask(request) { requests++; await release.promise; return fake.port.ask(request); } });
    await held(answerKnowledgeQuery({ store }, { ...input, timeoutMs: 20 }), 'budget'); const atDeadline = requests; release.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 10)); expect(requests).toBe(atDeadline); expect(store.listIssues()).toEqual([]);
  });
  test('explicit abort stops generation and forbids later judgments or writes', async () => {
    const { store, input } = await fixture(); const fake = readings(); const controller = new AbortController(); const release = Promise.withResolvers<string>(), started = Promise.withResolvers<void>();
    const pending = answerKnowledgeQuery({ store, llm: llm(async () => { started.resolve(); return release.promise; }) }, { ...input, signal: controller.signal });
    await started.promise; controller.abort(); await held(pending, 'aborted'); release.resolve('Four HDMI ports.'); await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(fake.requests.some((request) => 'fidelity' in request.questions)).toBe(false); expect(store.listIssues()).toEqual([]);
  });
});
