import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { answerKnowledgeQuery } from '../sdk/src/platform/knowledge/semantic/answer.js';
import { prepareAnswerGapUniverse } from '../sdk/src/platform/knowledge/semantic/answer-gaps.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';
import { reviewKnowledgeIssue } from '../sdk/src/platform/knowledge/review.js';
import { ANSWER_GAP_LIMITS, prepareAnswerGapReadings, type AnswerGapInput } from '../sdk/src/platform/knowledge/semantic/answer-gap-plan/reader.js';
const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const spaceId = 'homeassistant:gap-integration';
async function fixture(withEvidence = false) {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-gap-integration-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init();
  if (withEvidence) {
    await store.upsertSource({ id: 'source', connectorId: 'fixture', sourceType: 'manual', title: 'Device manual', status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
    await store.upsertExtraction({ sourceId: 'source', extractorId: 'fixture', format: 'text', excerpt: 'The device has four connectors.', metadata: { knowledgeSpaceId: spaceId } });
  }
  return store;
}
async function seedGap(store: KnowledgeStore, query: string, id = 'legacy-gap', extra: Record<string, unknown> = {}) {
  const input = { id, kind: 'knowledge_gap' as const, slug: id, title: query, summary: 'Missing observed information.',
    metadata: { knowledgeSpaceId: spaceId, semanticKind: 'gap', gapKind: 'answer', query, repairStatus: 'open', ...extra } };
  return upsertObservedKnowledgeNode(store, input, 'research-task', input, () => input);
}
function readings(options: { equivalents?: readonly (readonly [string, string])[]; enough?: number; subject?: number } = {}) {
  const fake = fakePort((name, question, state) => {
    if (name === 'sameQuestion') {
      const input = state as { question: { query: string }; candidate: { query: string } };
      return noulAnswer(options.equivalents?.some(([a, b]) => a === input.question.query && b === input.candidate.query) ? 0.99 : 0.01);
    }
    if (name === 'gapSubject') return noulAnswer(options.subject ?? 0.99);
    if (name === 'fidelity') return choiceAnswer(question, 'supported', 0.99);
    if (name === 'enough' || name === 'complete') return noulAnswer(options.enough ?? 0.01);
    if (['useful', 'match', 'features', 'excerptUseful'].includes(name)) return noulAnswer(0.99);
    throw new Error(`Unexpected gap integration reading: ${name}`);
  }); installJudgmentPort(fake.port); return fake;
}
const input = (query: string, space = spaceId) => ({ query, knowledgeSpaceId: space, includeLinkedObjects: false, autoRepairGaps: false });
function snapshot(store: KnowledgeStore) {
  const sort = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
  return structuredClone({ nodes: sort(store.listNodes(Number.MAX_SAFE_INTEGER)), sources: sort(store.listSources(Number.MAX_SAFE_INTEGER)),
    extractions: sort(store.listExtractions(Number.MAX_SAFE_INTEGER)), edges: sort(store.listEdges()), issues: sort(store.listIssues(Number.MAX_SAFE_INTEGER)) });
}
async function unchanged(store: KnowledgeStore, before: ReturnType<typeof snapshot>) {
  expect(snapshot(store)).toEqual(before); const reopened = new KnowledgeStore({ dbPath: store.storagePath }); await reopened.init(); expect(snapshot(reopened)).toEqual(before);
}

describe('answer gap admission and equivalence in actual answer callers', () => {
  for (const withEvidence of [false, true]) test(`${withEvidence ? 'matched insufficient' : 'no-match'} requests keep distinct needs and reuse genuine paraphrases`, async () => {
    const store = await fixture(withEvidence);
    const count = 'What do the specifications say about the number of HDMI inputs?';
    const hdr = 'What do the specifications say about HDR support?';
    const runtime = 'How long does the battery last between charges?';
    const replacement = 'How do I replace the battery?';
    const paraphrase = 'How many HDMI sockets are available?';
    readings({ equivalents: [[paraphrase, count]] });
    const ids: string[] = [];
    for (const query of [count, hdr, runtime, replacement, paraphrase]) {
      const result = await answerKnowledgeQuery({ store }, input(query));
      expect(result.answer.gaps).toHaveLength(1); ids.push(result.answer.gaps[0]!.id);
    }
    expect(new Set(ids.slice(0, 4)).size).toBe(4); expect(ids[4]).toBe(ids[0]);
    expect(store.listNodes().filter((node) => node.kind === 'knowledge_gap')).toHaveLength(4);
    const reopened = new KnowledgeStore({ dbPath: store.storagePath }); await reopened.init(); expect(snapshot(reopened)).toEqual(snapshot(store));
  });

  test('original non-Latin questions survive and exact spaces never merge', async () => {
    const store = await fixture(); readings();
    const questions = ['テレビの消費電力は？', 'テレビの重量は？'];
    const first = await answerKnowledgeQuery({ store }, input(questions[0]!));
    const second = await answerKnowledgeQuery({ store }, input(questions[1]!));
    readings({ equivalents: [[questions[0]!, questions[0]!], [questions[0]!, questions[1]!]] });
    const foreign = await answerKnowledgeQuery({ store }, input(questions[0]!, 'homeassistant:other-room'));
    expect(new Set([first, second, foreign].map((result) => result.answer.gaps[0]!.id)).size).toBe(3);
    expect(first.answer.gaps[0]!.metadata.query).toBe(questions[0]); expect(second.answer.gaps[0]!.metadata.query).toBe(questions[1]);
  });

  test('subject context is complete and order independent; different explicit subjects cannot merge', async () => {
    const store = await fixture();
    const a = await seedHomeAssistantObservation(store, { id: '4111111111111111', kind: 'ha_device', slug: 'a', title: '台所のスピーカー', metadata: { knowledgeSpaceId: spaceId } });
    const b = await seedHomeAssistantObservation(store, { id: 'second-local-id', kind: 'ha_device', slug: 'b', title: '書斎のコンピューター', metadata: { knowledgeSpaceId: spaceId } });
    const question = 'Can the speaker wake the computer?';
    readings();
    const first = await (await prepareAnswerGapUniverse(store, spaceId, question).prepare({ spaceId, linkedObjects: [a, b] }).read()).persist('Observed missing relation.');
    const fake = readings({ equivalents: [[question, question]] });
    const second = await (await prepareAnswerGapUniverse(store, spaceId, question).prepare({ spaceId, linkedObjects: [b, a] }).read()).persist('Repeated observation.');
    expect(second?.id).toBe(first?.id);
    expect(JSON.stringify(fake.requests)).toContain(a.title); expect(JSON.stringify(fake.requests)).toContain(b.title);
    expect(JSON.stringify(fake.requests)).not.toContain(a.id); expect(JSON.stringify(fake.requests)).not.toContain(b.id);
    const third = await (await prepareAnswerGapUniverse(store, spaceId, question).prepare({ spaceId, linkedObjects: [a] }).read()).persist('Different subject set.');
    expect(third?.id).not.toBe(first?.id);
  });

  test('broad no-match admission reads meaning while default and settled subjectless requests create no gap', async () => {
    const store = await fixture(); const query = '厨房の温度計の電池を交換するには？'; const fake = readings({ subject: 0.99 });
    const admitted = await answerKnowledgeQuery({ store }, input(query, 'homeassistant'));
    expect(admitted.answer.gaps).toHaveLength(1); expect(fake.requests.filter((request) => 'gapSubject' in request.questions)).toHaveLength(1);
    readings({ subject: 0.01 }); const before = snapshot(store);
    const rejected = await answerKnowledgeQuery({ store }, input('What features are supported?', 'homeassistant'));
    expect(rejected.answer.gaps).toEqual([]); await unchanged(store, before);
  });

  test('fully useful answers do not read protected or overbudget historic gaps', async () => {
    const store = await fixture(true);
    for (let index = 0; index <= ANSWER_GAP_LIMITS.candidates; index++) await seedGap(store, `Historic question ${index}`, `old-${index}`,
      index === ANSWER_GAP_LIMITS.candidates ? { subject: 'Authorization: Bearer synthetic-unused-history' } : {});
    const fake = readings({ enough: 0.99 }), before = snapshot(store);
    const result = await answerKnowledgeQuery({ store }, input('How many connectors does the device have?'));
    expect(result.answer.quality?.status).toBe('verified'); expect(result.answer.gaps).toEqual([]);
    expect(fake.requests.some((request) => 'sameQuestion' in request.questions || 'gapSubject' in request.questions)).toBe(false);
    await unchanged(store, before);
  });

  test('a useful broad answer can span installations while cross-space gap writes hold', async () => {
    const store = await fixture(true);
    await store.upsertSource({ id: 'other-source', connectorId: 'fixture', sourceType: 'manual', title: 'Second installation manual', status: 'indexed', metadata: { knowledgeSpaceId: 'homeassistant:other-installation' } });
    await store.upsertExtraction({ sourceId: 'other-source', extractorId: 'fixture', format: 'text', excerpt: 'The other device has two connectors.', metadata: { knowledgeSpaceId: 'homeassistant:other-installation' } });
    const fake = readings({ enough: 0.99 }), before = snapshot(store);
    const result = await answerKnowledgeQuery({ store }, input('How many connectors do the devices have?', 'homeassistant'));
    expect(result.answer.quality?.status).toBe('verified'); expect(result.answer.sources).toHaveLength(2);
    expect(fake.requests.some((request) => 'sameQuestion' in request.questions || 'gapSubject' in request.questions)).toBe(false);
    await unchanged(store, before);
    readings({ enough: 0.01 });
    await expect(answerKnowledgeQuery({ store }, input('What else is unknown about these devices?', 'homeassistant'))).rejects.toMatchObject({ reason: 'malformed' });
    await unchanged(store, before);
  });

  for (const change of ['query', 'extraction', 'provider'] as const) test(`a ${change} change during gap equivalence invalidates the full earlier answer read-set`, async () => {
    const store = await fixture(true), request = input('How many connectors does the device have?');
    await seedGap(store, request.query); const fake = readings({ equivalents: [[request.query, request.query]] });
    let changed = false, after: ReturnType<typeof snapshot> | undefined;
    installJudgmentPort({ ...fake.port, async ask(reading) {
      const result = await fake.port.ask(reading);
      if ('sameQuestion' in reading.questions && !changed) {
        changed = true;
        if (change === 'query') request.query = 'An entirely different question.';
        if (change === 'extraction') await store.upsertExtraction({ sourceId: 'source', extractorId: 'fixture', format: 'text', excerpt: 'A corrected newer extraction.', metadata: { knowledgeSpaceId: spaceId } });
        if (change === 'provider') installJudgmentPort(fake.port);
        after = snapshot(store);
      }
      return result;
    } });
    await expect(answerKnowledgeQuery({ store }, request)).rejects.toMatchObject({ reason: 'stale' });
    expect(changed).toBe(true); await unchanged(store, after!);
  });

  test('two equivalent candidates are ambiguous and cannot be arbitrarily merged', async () => {
    const store = await fixture(); await seedGap(store, 'First wording', 'old-a'); await seedGap(store, 'Second wording', 'old-b');
    readings({ equivalents: [['New wording', 'First wording'], ['New wording', 'Second wording']] }); const before = snapshot(store);
    await expect(answerKnowledgeQuery({ store }, input('New wording'))).rejects.toMatchObject({ reason: 'uncertain' }); await unchanged(store, before);
  });

  test('terminal matched gaps remain observations and are never returned as repair work', async () => {
    const store = await fixture(); const query = 'How long is the battery runtime?';
    const node = await seedGap(store, query, 'cancelled-gap', { repairStatus: 'cancelled', acceptedSourceIds: ['retained-source'], promotedFactCount: 2 });
    readings({ equivalents: [[query, query]] }); const before = snapshot(store);
    const result = await answerKnowledgeQuery({ store }, input(query));
    expect(result.answer.quality?.status).toBe('no-evidence'); expect(result.answer.gaps).toEqual([]);
    expect(store.getNode(node.id)).toEqual(node); await unchanged(store, before);
  });

  for (const order of ['cancel-then-reopen', 'reopen-then-cancel', 'same-time'] as const) {
    test(`${order} respects the later operator lifecycle in the actual answer caller`, async () => {
      const store = await fixture(), query = 'How long is the battery runtime?';
      const node = await seedGap(store, query);
      const issue = await store.upsertIssue({ id: 'gap-issue', nodeId: node.id, code: 'knowledge.answer_gap', severity: 'info', message: query,
        metadata: { knowledgeSpaceId: spaceId, query } });
      const clock = spyOn(Date, 'now'), base = Date.now();
      const cancel = () => store.upsertRefinementTask({ id: 'terminal-task', spaceId, gapId: node.id, issueId: issue.id, state: 'cancelled', trigger: 'manual' });
      const reopen = () => reviewKnowledgeIssue(store, { issueId: issue.id, action: 'reopen', reviewer: 'owner' });
      try {
        clock.mockReturnValue(base + 1);
        await (order === 'reopen-then-cancel' ? reopen() : cancel());
        clock.mockReturnValue(base + (order === 'same-time' ? 1 : 2));
        await (order === 'reopen-then-cancel' ? cancel() : reopen());
      } finally { clock.mockRestore(); }
      const before = snapshot(store), task = store.getRefinementTask('terminal-task');
      readings({ equivalents: [[query, query]] });
      const result = await answerKnowledgeQuery({ store }, input(query));
      expect(result.answer.gaps.map((gap) => gap.id)).toEqual(order === 'cancel-then-reopen' ? [node.id] : []);
      expect(store.getRefinementTask('terminal-task')).toEqual(task); await unchanged(store, before);
    });
  }
});

describe('gap reader strict boundaries', () => {
  const question = { query: 'How much power?', subjects: [], sources: [] };
  function projection(count = 1): AnswerGapInput { return { question, needsSubject: false,
    candidates: Array.from({ length: count }, (_, index) => ({ reference: `gap-${index + 1}`, title: 'Previous need', ...question })) }; }
  const options = () => ({ deadlineAt: Date.now() + 1_000, assertCurrent() {} });
  test('preflights the late protected candidate before oversized-pass rejection or any request', () => {
    const fake = readings(); const value = projection(ANSWER_GAP_LIMITS.candidates + 1);
    const candidates = [...value.candidates]; candidates[candidates.length - 1] = { ...candidates.at(-1)!, query: 'Authorization: Bearer synthetic-late-gap' };
    expect(() => prepareAnswerGapReadings({ ...value, candidates }, options())).toThrow(JudgmentInputError); expect(fake.requests).toHaveLength(0);
    expect(() => prepareAnswerGapReadings(value, options())).toThrow(/budget/); expect(fake.requests).toHaveLength(0);
  });
  for (const mode of ['unavailable', 'malformed', 'uncertain'] as const) test(`${mode} never resolves a guessed target`, async () => {
    const fake = readings();
    if (mode === 'unavailable') installJudgmentPort(undefined);
    else installJudgmentPort({ ...fake.port, async ask(request) { const result = await fake.port.ask(request); return { ...result,
      answers: { sameQuestion: noulAnswer(mode === 'uncertain' ? 0.5 : Number.NaN) } } as typeof result; } });
    await expect(prepareAnswerGapReadings(projection(), options()).read()).rejects.toMatchObject({ reason: mode });
  });
});
