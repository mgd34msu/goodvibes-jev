import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { readHomeGraphSearchState } from '../sdk/src/platform/knowledge/home-graph/search.js';
import { readHomeGraphSearchSelection } from '../sdk/src/platform/knowledge/home-graph/search-judgments.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { answerHomeGraphQuery } from '../sdk/src/platform/knowledge/home-graph/ask.js';
import { KnowledgeSemanticService } from '../sdk/src/platform/knowledge/semantic/service.js';
import { bindAnswerCandidateWindow } from '../sdk/src/platform/knowledge/semantic/answer-candidate-window.js';
import { collectAnswerEvidence, includeOfficialLinkedEvidence } from '../sdk/src/platform/knowledge/semantic/answer-evidence.js';
import type { KnowledgeSemanticAnswerInput } from '../sdk/src/platform/knowledge/semantic/types.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';

const spaceId = 'homeassistant:search-lifecycle';
const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => {
  installJudgmentPort(previous);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-search-lifecycle-'));
  roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  await store.init();
  const source = await store.upsertSource({ id: 'manual', connectorId: 'fixture', sourceType: 'manual', title: 'Manual', status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
  await store.upsertExtraction({ sourceId: source.id, extractorId: 'fixture', format: 'text', excerpt: 'A switch restores factory settings.', metadata: { knowledgeSpaceId: spaceId } });
  return { store, source };
}

test('mutation during relevance is a stale hold', async () => {
  const { store, source } = await fixture();
  const fake = fakePort(() => noulAnswer(0.99));
  installJudgmentPort({
    ...fake.port,
    async ask(request) {
      if (request.context?.site === 'engine.knowledge.answer-evidence-relevance') {
        await store.upsertSource({ ...source, summary: 'Changed during reading' });
      }
      return fake.port.ask(request);
    },
  });
  await expect(readHomeGraphSearchSelection({ store, spaceId, query: { query: 'Reset procedure' }, state: readHomeGraphSearchState(store, spaceId) })).rejects.toMatchObject({ reason: 'stale' });
});

test('later source protects before any request', async () => {
  const { store } = await fixture();
  const source = await store.upsertSource({ id: 'later', connectorId: 'fixture', sourceType: 'manual', title: 'Private source', status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
  await store.upsertExtraction({ sourceId: source.id, extractorId: 'fixture', format: 'text', sections: ['x'.repeat(128 * 1024) + '\nAuthorization: Bearer synthetic-fixture'], metadata: { knowledgeSpaceId: spaceId } });
  const fake = fakePort(() => noulAnswer(0.99));
  installJudgmentPort(fake.port);
  await expect(readHomeGraphSearchSelection({ store, spaceId, query: { query: 'Reset procedure' }, state: readHomeGraphSearchState(store, spaceId) })).rejects.toMatchObject({ problem: 'credential-material' });
  expect(fake.requests).toHaveLength(0);
});

test('original search query mutation during semantic generation remains guarded', async () => {
  const { store } = await fixture();
  const original = { query: 'Reset procedure' };
  const fake = fakePort((name, question) => {
    if (name === 'fidelity')
      return choiceAnswer(question, 'supported', 0.99);
    if (name === 'preferred')
      return choiceAnswer(question, 'generated', 0.99);
    return noulAnswer(['integrationIntent', 'gapSubject', 'sameQuestion', 'features'].includes(name) ? 0.01 : 0.99);
  });
  installJudgmentPort(fake.port);
  const state = readHomeGraphSearchState(store, spaceId);
  const selection = await readHomeGraphSearchSelection({ store, spaceId, query: original, state });
  const semanticService = new KnowledgeSemanticService(store, {
    llm: {
      async completeJson() { throw new Error('No enrichment'); },
      async completeText() { original.query = 'A changed query'; return 'A switch restores factory settings.'; },
    },
    isBackgroundPaused: () => true,
  });
  await expect(answerHomeGraphQuery({ store, spaceId, query: original, state, results: selection.results, semanticService })).rejects.toMatchObject({ reason: 'stale' });
});

test('rejected fact nodes cannot reenter through accepted source facts', async () => {
  const { store, source } = await fixture();
  const fake = fakePort(() => noulAnswer(0.99));
  installJudgmentPort(fake.port);
  const fact = await store.upsertNode({ id: 'rejected-fact', kind: 'fact', slug: 'rejected-fact', title: 'Rejected fact', summary: 'A switch restores factory settings.', status: 'active', sourceId: source.id,
    metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', evidence: 'A switch restores factory settings.' } });
  expect(fact.status).toBe('active');
  const input: KnowledgeSemanticAnswerInput = { query: 'Reset procedure', knowledgeSpaceId: spaceId, candidateSourceIds: [source.id], candidateNodeIds: [], strictCandidates: true };
  bindAnswerCandidateWindow(input, store, spaceId, [source.id], [], [], () => {});
  const evidence = await collectAnswerEvidence(store, input, spaceId, 8, []);
  expect(evidence.flatMap(row => row.facts.map(fact => fact.id))).toEqual([]);
});

test('accepted fact winner retains accepted backing source beyond display limit', async () => {
  const { store, source } = await fixture();
  installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
  const fact = await store.upsertNode({ id: 'accepted-fact', kind: 'fact', slug: 'accepted-fact', title: 'Reset fact', summary: 'A switch restores factory settings.', status: 'active', sourceId: source.id,
    metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', evidence: 'A switch restores factory settings.' } });
  expect(fact.status).toBe('active');
  const fake = fakePort((name, question, state) => {
    if (name === 'fidelity')
      return choiceAnswer(question, 'supported', 0.99);
    if (name === 'preferred')
      return choiceAnswer(question, 'generated', 0.99);
    if (name === 'useful')
      return noulAnswer((state as {
        candidate: {
          kind: string;
        };
      }).candidate.kind === 'node' ? 0.99 : 0.9);
    return noulAnswer(['integrationIntent', 'gapSubject', 'sameQuestion', 'features'].includes(name) ? 0.01 : 0.99);
  });
  installJudgmentPort(fake.port);
  const original = { query: 'Reset procedure', limit: 1 };
  const state = readHomeGraphSearchState(store, spaceId);
  const selection = await readHomeGraphSearchSelection({ store, spaceId, query: original, state });
  expect(selection.results.map(row => row.id)).toEqual([fact.id]);
  const semanticService = new KnowledgeSemanticService(store, {
    llm: {
      async completeJson() { throw new Error('No enrichment'); },
      async completeText() { return 'A switch restores factory settings.'; },
    },
    isBackgroundPaused: () => true,
  });
  const answer = await answerHomeGraphQuery({ store, spaceId, query: original, state, results: selection.results, semanticService });
  expect(answer.answer.text).toContain('A switch restores factory settings.');
});

test('settled empty window cannot reopen through linked evidence', async () => {
  const { store, source } = await fixture();
  const object = await seedHomeAssistantObservation(store, { id: 'device', kind: 'ha_entity', slug: 'device', title: 'Reset device', status: 'active', metadata: { knowledgeSpaceId: spaceId } });
  await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: object.id, relation: 'has_manual', metadata: { knowledgeSpaceId: spaceId } });
  const fake = fakePort(() => noulAnswer(0.99));
  installJudgmentPort(fake.port);
  const input: KnowledgeSemanticAnswerInput = { query: 'Reset procedure', knowledgeSpaceId: spaceId, candidateSourceIds: [], candidateNodeIds: [], strictCandidates: true, linkedObjects: [object] };
  bindAnswerCandidateWindow(input, store, spaceId, [], [], [], () => {});
  const evidence = await collectAnswerEvidence(store, input, spaceId, 8, []);
  const linked = await includeOfficialLinkedEvidence(store, spaceId, input.query, evidence, [object], 8);
  expect(evidence).toEqual([]);
  expect(linked).toEqual([]);
  expect(fake.requests).toHaveLength(0);
});

test('accepted object winner retains its accepted linked source beyond display limit', async () => {
  const { store, source } = await fixture();
  const object = await seedHomeAssistantObservation(store, { id: 'device', kind: 'ha_entity', slug: 'device', title: 'Reset device', summary: 'A switch restores factory settings.', status: 'active', metadata: { knowledgeSpaceId: spaceId } });
  await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: object.id, relation: 'has_manual', metadata: { knowledgeSpaceId: spaceId } });
  const fake = fakePort((name, question, state) => {
    if (name === 'fidelity')
      return choiceAnswer(question, 'supported', 0.99);
    if (name === 'preferred')
      return choiceAnswer(question, 'generated', 0.99);
    if (name === 'useful')
      return noulAnswer((state as {
        candidate: {
          kind: string;
        };
      }).candidate.kind === 'node' ? 0.99 : 0.9);
    return noulAnswer(['integrationIntent', 'integrationObject', 'gapSubject', 'sameQuestion', 'features'].includes(name) ? 0.01 : 0.99);
  });
  installJudgmentPort(fake.port);
  const original = { query: 'Reset procedure', limit: 1 };
  const state = readHomeGraphSearchState(store, spaceId);
  const selection = await readHomeGraphSearchSelection({ store, spaceId, query: original, state });
  expect(selection.results.map(row => row.id)).toEqual([object.id]);
  const semanticService = new KnowledgeSemanticService(store, {
    llm: {
      async completeJson() { throw new Error('No enrichment'); }, async completeText() { return 'A switch restores factory settings.'; },
    },
    isBackgroundPaused: () => true,
  });
  const answer = await answerHomeGraphQuery({ store, spaceId, query: original, state, results: selection.results, semanticService });
  expect(answer.answer.text).toContain('A switch restores factory settings.');
});

for (const stage of ['successful-repair', 'completed-wait'] as const) {
  test.each(['query', 'subject', 'configuration', 'protected-source'] as const)(`${stage} renewal rejects %s changes before new dispatch`, async (change) => {
    const { store } = await fixture();
    const object = await seedHomeAssistantObservation(store, {
      id: 'renewal-device', kind: 'ha_entity', slug: 'renewal-device', title: 'Reset device', status: 'active',
      metadata: { knowledgeSpaceId: spaceId },
    });
    const original = { query: 'Reset procedure for the device', limit: 1 };
    const fake = fakePort((name) => noulAnswer(['useful', 'integrationIntent', 'integrationObject', 'sameQuestion', 'features'].includes(name) ? 0.01 : 0.99));
    installJudgmentPort(fake.port);
    const state = readHomeGraphSearchState(store, spaceId);
    const selection = await readHomeGraphSearchSelection({ store, spaceId, query: original, state });
    expect(selection.linkedObjects.map(row => row.id)).toEqual([object.id]);
    const semanticService = new KnowledgeSemanticService(store, {
      isBackgroundPaused: () => true,
      gapRepairer: async () => ({ searched: true, ingestedSourceIds: [], skippedUrls: [] }),
    });
    let repairStarted = false, waitStarted = false, beforeRenewal = 0, baseline = '';
    const records = () => JSON.stringify({
      sources: store.listSources(), nodes: store.listNodes(), edges: store.listEdges(), issues: store.listIssues(),
    });
    const finishRepair = async () => {
      beforeRenewal = fake.requests.length;
      if (change === 'query')
        original.query = 'Changed lookup';
      if (change === 'subject')
        await seedHomeAssistantObservation(store, {
          id: object.id, kind: 'ha_entity', slug: object.slug, title: object.title, summary: 'Changed selected device',
          status: 'active', metadata: { knowledgeSpaceId: spaceId },
        });
      if (change === 'configuration')
        installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
      if (change === 'protected-source') {
        const next = await store.upsertSource({
          id: 'new-private', connectorId: 'repair', sourceType: 'manual', title: 'New repair source', status: 'indexed',
          metadata: { knowledgeSpaceId: spaceId },
        });
        await store.upsertExtraction({
          sourceId: next.id, extractorId: 'repair', format: 'text',
          sections: ['x'.repeat(128 * 1024) + '\nAuthorization: Bearer synthetic'], metadata: { knowledgeSpaceId: spaceId },
        });
      }
      baseline = records();
    };
    // Stub only the external repair outcome. The actual answer service decides
    // whether to renew and invokes the Home Graph's guarded retrieval callback.
    const repair = spyOn(semanticService, 'repairAnswerGaps').mockImplementation(async () => {
      repairStarted = true;
      if (stage === 'successful-repair')
        await finishRepair();
      return {
        scannedGaps: 1, createdGaps: 0, repairableGaps: 1, suppressedGaps: 0,
        skippedGaps: stage === 'completed-wait' ? 1 : 0, searched: 1, ingestedSources: 0,
        linkedRepairs: stage === 'successful-repair' ? 1 : 0, blockedGaps: 0,
        closedGaps: stage === 'successful-repair' ? 1 : 0, queuedTasks: 0,
        taskIds: [], ingestedSourceIds: [], errors: [],
      };
    });
    const waitable = semanticService as unknown as {
      waitForActiveAnswerGapRepairs(): Promise<boolean>;
    };
    const wait = spyOn(waitable, 'waitForActiveAnswerGapRepairs').mockImplementation(async () => {
      waitStarted = true;
      await finishRepair();
      return true;
    });
    try {
      await expect(answerHomeGraphQuery({
        store, spaceId, query: original, state, results: selection.results, semanticService,
      })).rejects.toMatchObject(change === 'protected-source' ? { problem: 'credential-material' } : { reason: 'stale' });
      expect(repairStarted).toBe(true);
      expect(waitStarted).toBe(stage === 'completed-wait');
      expect(fake.requests).toHaveLength(beforeRenewal);
      expect(records()).toBe(baseline);
    } finally {
      repair.mockRestore();
      wait.mockRestore();
    }
  });
}

test.each(['stale', 'foreign', 'generated'] as const)('fact with only %s backing is excluded before evidence projection', async (support) => {
  const { store, source } = await fixture();
  installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
  const fact = await store.upsertNode({
    id: 'unsupported-fact', kind: 'fact', slug: 'unsupported-fact', title: 'Previously supported fact',
    summary: 'A switch restores factory settings.', status: 'active', sourceId: source.id,
    metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', evidence: 'A switch restores factory settings.' },
  });
  await store.upsertSource({
    ...source, title: 'Excluded source header',
    status: support === 'stale' ? 'stale' : 'indexed',
    metadata: { ...source.metadata, knowledgeSpaceId: support === 'foreign' ? 'homeassistant:other' : spaceId,
      ...(support === 'generated' ? { generatedProjection: true } : {}) },
  });
  expect(store.getNode(fact.id)?.status).toBe('active');
  const fake = fakePort(() => noulAnswer(0.99));
  installJudgmentPort(fake.port);
  const selection = await readHomeGraphSearchSelection({ store, spaceId, query: { query: 'Reset procedure' }, state: readHomeGraphSearchState(store, spaceId) });
  expect(selection.results).toEqual([]);
  expect(JSON.stringify(fake.requests)).not.toContain('Previously supported fact');
  expect(JSON.stringify(fake.requests)).not.toContain('Excluded source header');
});

test('mixed valid and stale backing never projects the excluded source header', async () => {
  const { store, source } = await fixture();
  const secondary = await store.upsertSource({
    id: 'secondary', connectorId: 'fixture', sourceType: 'manual', title: 'Excluded secondary header', status: 'indexed',
    metadata: { knowledgeSpaceId: spaceId },
  });
  installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
  const fact = await store.upsertNode({
    id: 'mixed-fact', kind: 'fact', slug: 'mixed-fact', title: 'Supported fact',
    summary: 'A switch restores factory settings.', status: 'active', sourceId: source.id,
    metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', evidence: 'A switch restores factory settings.', sourceIds: [source.id, secondary.id] },
  });
  expect(fact.status).toBe('active');
  await store.upsertSource({ ...secondary, status: 'stale' });
  const fake = fakePort(() => noulAnswer(0.99));
  installJudgmentPort(fake.port);
  const selection = await readHomeGraphSearchSelection({ store, spaceId, query: { query: 'Reset procedure' }, state: readHomeGraphSearchState(store, spaceId) });
  expect(selection.results.some(row => row.id === fact.id)).toBe(true);
  expect(JSON.stringify(fake.requests)).not.toContain('Excluded secondary header');
});


test('active research gaps stay outside evidence projection', async () => {
  const { store, source } = await fixture();
  const gapInput = {
    id: 'research-gap', kind: 'knowledge_gap' as const, slug: 'research-gap', title: 'Excluded research gap',
    summary: 'Authorization: Bearer synthetic-gap', status: 'active' as const,
    metadata: { knowledgeSpaceId: spaceId, semanticKind: 'gap' },
  };
  const evidence = structuredClone(gapInput);
  const gap = await upsertObservedKnowledgeNode(store, gapInput, 'research-task', evidence, () => evidence);
  expect(gap.status).toBe('active');
  const fake = fakePort(() => noulAnswer(0.99));
  installJudgmentPort(fake.port);
  const selection = await readHomeGraphSearchSelection({
    store, spaceId, query: { query: 'Reset procedure' }, state: readHomeGraphSearchState(store, spaceId),
  });
  expect(selection.results.map(row => row.id)).toEqual([source.id]);
  expect(JSON.stringify(fake.requests)).not.toContain('Excluded research gap');
  expect(JSON.stringify(fake.requests)).not.toContain('synthetic-gap');
});

test('summary readability receives deadline cancellation before excerpt dispatch', async () => {
  const { store, source } = await fixture();
  await store.upsertSource({ ...source, summary: 'A readable source summary.' });
  const fake = fakePort(() => noulAnswer(0.99));
  let signal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  const entered = Promise.withResolvers<void>();
  installJudgmentPort({
    ...fake.port,
    async ask(request) {
      if ('readable' in request.questions) {
        signal = request.signal;
        entered.resolve();
        await new Promise<void>(resolve => { release = resolve; });
      }
      return fake.port.ask(request);
    },
  });
  const pending = readHomeGraphSearchSelection({
    store, spaceId, query: { query: 'Reset procedure', timeoutMs: 1_000 }, state: readHomeGraphSearchState(store, spaceId),
  });
  const held = expect(pending).rejects.toMatchObject({ reason: 'budget' });
  await entered.promise;
  await held;
  release?.();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(signal?.aborted).toBe(true);
  expect(fake.requests.some(request => 'excerptUseful' in request.questions)).toBe(false);
});
