/** Temporary SQLite stores and explicit promises only: no provider or user state. */
import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeService } from '../sdk/src/platform/knowledge/service.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { createKnowledgeIssueOperatorMutation } from '../sdk/src/platform/knowledge/store-lifecycle-authority.js';
import { reviewKnowledgeIssue } from '../sdk/src/platform/knowledge/review.js';
import { reviewHomeGraphFact } from '../sdk/src/platform/knowledge/home-graph/review.js';
import { runKnowledgeSemanticSelfImprovement as improve } from '../sdk/src/platform/knowledge/semantic/self-improvement.js';
import { upsertRefinementTaskForGap } from '../sdk/src/platform/knowledge/semantic/self-improvement-tasks.js';
import { createStores } from './_helpers/knowledge-semantic-fixtures.js';

const services: KnowledgeService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.dispose(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const { store, artifactStore } = createStores();
  const spaceId = 'terminal-fixture';
  const source = await store.upsertSource({ id: 'manual', connectorId: 'manual', sourceType: 'document', title: 'Synthetic device manual', status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
  const gap = await store.upsertNode({ id: 'manual-gap', kind: 'knowledge_gap', slug: 'manual-gap', title: 'What ports does this device provide?', status: 'active', confidence: 90, sourceId: source.id, metadata: { knowledgeSpaceId: spaceId, semanticKind: 'gap', gapKind: 'manual' } });
  const service = new KnowledgeService(store, artifactStore, undefined, { memoryRegistry: {
    async add() { throw new Error('Unexpected memory write'); }, getAll() { return []; }, getStore() { throw new Error('Unexpected memory read'); },
  } });
  services.push(service);
  const task = await upsertRefinementTaskForGap(store, spaceId, { gap, sources: [source], linkedObjects: [] }, 'scheduled', 'queued', 'Synthetic queued repair');
  return { store, source, gap, task, service, input: { knowledgeSpaceId: spaceId, gapIds: [gap.id], force: true, reason: 'scheduled' as const } };
}

describe('terminal knowledge refinement decisions', () => {
  test('cancelled deterministic tasks survive forced rediscovery, replacement payloads and reload', async () => {
    const h = await fixture();
    const cancelled = await h.service.cancelRefinementTask(h.task.id);
    if (!cancelled) throw new Error('Expected the fixture task to exist.');
    let searches = 0;
    const context = { store: h.store, activeGapRepairs: new Set<string>(), gapRepairer: async () => { searches += 1; } };
    expect((await improve(context, h.input)).skippedGaps).toBe(1);
    const replaced = await h.store.upsertRefinementTask({ ...h.task, state: 'evaluating', trigger: 'manual', metadata: { forced: true }, trace: [] });
    expect(replaced).toEqual(cancelled);
    expect(searches).toBe(0);
    const reloaded = new KnowledgeStore({ dbPath: h.store.status().storagePath });
    await reloaded.init();
    expect(reloaded.getRefinementTask(h.task.id)).toEqual(cancelled);
    await improve({ ...context, store: reloaded }, h.input);
    expect(reloaded.getRefinementTask(h.task.id)).toEqual(cancelled);
  });

  test.each(['closed', 'suppressed'] as const)('%s stays terminal while blocked and failed tasks can retry and new IDs remain independent', async (state) => {
    const h = await fixture();
    const settled = await h.store.upsertRefinementTask({ ...h.task, state });
    expect(await h.store.upsertRefinementTask({ ...h.task, state: 'detected' })).toEqual(settled);
    for (const retryable of ['blocked', 'failed'] as const) {
      const task = await h.store.upsertRefinementTask({ ...h.task, id: `retry-${retryable}`, gapId: `new-${retryable}`, state: retryable });
      expect((await h.store.upsertRefinementTask({ ...task, state: 'searching' })).state).toBe('searching');
    }
  });

  test.each([false, true])('cancellation during search prevents late success/failure writes (reject=%s)', async (reject) => {
    const h = await fixture(); const started = deferred(); const release = deferred(); let enrichments = 0;
    const pending = improve({ store: h.store, activeGapRepairs: new Set(),
      gapRepairer: async () => { started.resolve(); await release.promise; if (reject) throw new Error('Late search failure'); return { searched: true, acceptedSourceIds: [h.source.id], ingestedSourceIds: [], skippedUrls: [] }; },
      enrichSource: async () => { enrichments += 1; },
    }, h.input);
    await started.promise;
    const cancelled = await h.service.cancelRefinementTask(h.task.id);
    if (!cancelled) throw new Error('Expected the fixture task to exist.');
    const gap = h.store.getNode(h.gap.id); const edges = h.store.listEdges();
    release.resolve(); const result = await pending;
    expect(result.skippedGaps).toBe(1);
    expect(result.promotedFactCount).toBe(0);
    expect(result.errors).toEqual([]);
    expect(h.store.getRefinementTask(h.task.id)).toEqual(cancelled);
    expect(h.store.getNode(h.gap.id)).toEqual(gap);
    expect(h.store.listEdges()).toEqual(edges);
    expect(enrichments).toBe(0);
  });

  test('cancellation during promotion judgment prevents late fact writes through the complete repair path', async () => {
    const h = await fixture(); const started = deferred(); const release = deferred();
    const subject = await h.store.upsertNode({ kind: 'ha_device', slug: 'lg-tv', title: 'LG 86NANO90UNA', status: 'active', metadata: { knowledgeSpaceId: h.input.knowledgeSpaceId, manufacturer: 'LG', model: '86NANO90UNA' } });
    await h.store.upsertNode({ ...h.gap, metadata: { ...h.gap.metadata, linkedObjectIds: [subject.id] } });
    await h.store.upsertExtraction({ sourceId: h.source.id, extractorId: 'synthetic', format: 'text', structure: { searchText: 'LG 86NANO90UNA has four HDMI inputs and supports HDMI eARC.' }, excerpt: 'LG 86NANO90UNA has four HDMI inputs and supports HDMI eARC.' });
    const fake = fakePort((name, question) => name === 'authority' ? choiceAnswer(question, 'secondary', 0.99) : noulAnswer(0.99));
    const previous = installJudgmentPort({ ...fake.port, async ask(request) { started.resolve(); await release.promise; return fake.port.ask(request); } });
    try {
      const pending = improve({ store: h.store, activeGapRepairs: new Set(), gapRepairer: async () => ({ searched: true, acceptedSourceIds: [h.source.id], ingestedSourceIds: [], skippedUrls: [] }) }, h.input);
      await Promise.race([started.promise, pending.then((result) => { throw new Error(`Repair finished before promotion judgment: ${JSON.stringify(result)}`); })]);
      const cancelled = await h.service.cancelRefinementTask(h.task.id);
      if (!cancelled) throw new Error('Expected the fixture task to exist.');
      const gap = h.store.getNode(h.gap.id); const edges = h.store.listEdges();
      release.resolve(); expect((await pending).skippedGaps).toBe(1);
      expect(h.store.getRefinementTask(h.task.id)).toEqual(cancelled);
      expect(h.store.getNode(h.gap.id)).toEqual(gap);
      expect(h.store.listNodes().filter((node) => node.kind === 'fact')).toEqual([]);
      expect(h.store.listEdges()).toEqual(edges);
    } finally { release.resolve(); installJudgmentPort(previous); }
  });

  test('resolve then reopen before search settles still invalidates the old open lifecycle', async () => {
    const h = await fixture(); const started = deferred(); const release = deferred();
    const issue = await h.store.upsertIssue({ nodeId: h.gap.id, severity: 'info', code: 'gap', message: h.gap.title });
    const pending = improve({ store: h.store, activeGapRepairs: new Set(), gapRepairer: async () => {
      started.resolve(); await release.promise;
      return { searched: true, acceptedSourceIds: [h.source.id], ingestedSourceIds: [], skippedUrls: [] };
    } }, h.input);
    await started.promise;
    await reviewKnowledgeIssue(h.store, { issueId: issue.id, action: 'resolve' });
    const reopened = (await reviewKnowledgeIssue(h.store, { issueId: issue.id, action: 'reopen' })).issue;
    release.resolve(); expect((await pending).skippedGaps).toBe(1);
    expect(h.store.getIssue(issue.id)).toEqual(reopened);
    expect(h.store.getNode(h.gap.id)).toEqual(h.gap);
    expect(h.store.listEdges()).toEqual([]);
  });

  test('issue resolution and explicit reopen during search invalidate the captured repair without blocking a fresh run', async () => {
    const h = await fixture(); const started = deferred(); const release = deferred();
    const issue = await h.store.upsertIssue({ id: 'gap-issue', nodeId: h.gap.id, severity: 'info', code: 'knowledge.answer_gap', message: h.gap.title });
    let searches = 0;
    const context = { store: h.store, activeGapRepairs: new Set<string>(), gapRepairer: async () => { searches += 1; started.resolve(); await release.promise; return { searched: true, ingestedSourceIds: [], skippedUrls: [] }; } };
    const pending = improve(context, h.input); await started.promise;
    await reviewKnowledgeIssue(h.store, { issueId: issue.id, action: 'resolve', reviewer: 'owner' });
    const resolved = h.store.getIssue(issue.id);
    release.resolve(); expect((await pending).skippedGaps).toBe(1);
    expect(h.store.getIssue(issue.id)).toEqual(resolved);
    expect(h.store.getNode(h.gap.id)).toEqual(h.gap);
    expect((await improve(context, h.input)).skippedGaps).toBe(1);
    expect(searches).toBe(1);
    await reviewKnowledgeIssue(h.store, { issueId: issue.id, action: 'reopen', reviewer: 'owner' });
    expect((await improve(context, h.input)).searched).toBe(1);
    expect(searches).toBe(2);
  });
});

describe('knowledge issue lifecycle authority', () => {
  test('explicit producer status and forged review cannot reopen a decision, but explicit review can', async () => {
    const { store } = createStores();
    const issue = await store.upsertIssue({ id: 'same-issue', severity: 'warning', code: 'missing', message: 'Missing property', metadata: { subjectFingerprint: 'property-v1' } });
    const resolved = (await reviewKnowledgeIssue(store, { issueId: issue.id, action: 'reject', reviewer: 'owner' })).issue;
    expect(await store.upsertIssue({ ...issue, status: 'open', metadata: { subjectFingerprint: 'property-v1', review: { action: 'reopen', reviewer: 'fake' } } })).toEqual(resolved);
    await store.replaceIssueRecord(issue);
    expect(store.getIssue(issue.id)).toEqual(resolved);
    const reopened = (await reviewKnowledgeIssue(store, { issueId: issue.id, action: 'reopen', reviewer: 'owner' })).issue;
    expect(reopened.status).toBe('open');
    expect(reopened.metadata.suppression).toBeUndefined();
    expect(reopened.metadata.review).toMatchObject({ action: 'reopen', reviewer: 'owner' });
    // A captured resolve from the previous lifecycle cannot close the reopened one.
    expect(await store.upsertIssue({ ...resolved, status: 'resolved' })).toEqual(reopened);
  });

  test('new content fingerprint starts clean and a delayed prior fingerprint cannot take it back', async () => {
    const { store } = createStores();
    const input = { id: 'content-issue', severity: 'warning' as const, code: 'missing', message: 'Missing property' };
    await store.upsertIssue({ ...input, metadata: { subjectFingerprint: 'property-v1' } });
    await reviewKnowledgeIssue(store, { issueId: input.id, action: 'resolve', reviewer: 'owner' });
    const next = await store.upsertIssue({ ...input, status: 'open', metadata: { subjectFingerprint: 'property-v2' } });
    expect(next.status).toBe('open');
    expect(next.metadata.review).toBeUndefined();
    expect(next.metadata.suppression).toBeUndefined();
    expect(await store.upsertIssue({ ...input, status: 'open', metadata: { subjectFingerprint: 'property-v1' } })).toEqual(next);
    const edited = await reviewKnowledgeIssue(store, { issueId: input.id, action: 'edit', reviewer: 'owner' });
    expect(edited.issue.status).toBe('open');
  });

  test('an older issue edit stops before node writes when a newer decision lands during its source await', async () => {
    const h = await fixture(); const started = deferred(); const release = deferred();
    const issue = await h.store.upsertIssue({ nodeId: h.gap.id, sourceId: h.source.id, severity: 'info', code: 'gap', message: h.gap.title });
    const upsert = h.store.upsertSource.bind(h.store);
    h.store.upsertSource = async (input) => { const result = await upsert(input); started.resolve(); await release.promise; return result; };
    const old = reviewKnowledgeIssue(h.store, { issueId: issue.id, action: 'edit', value: { fact: { summary: 'An older correction' } } });
    await started.promise;
    const resolved = (await reviewKnowledgeIssue(h.store, { issueId: issue.id, action: 'resolve', reviewer: 'newer reviewer' })).issue;
    release.resolve();
    await expect(old).rejects.toThrow('changed before its explicit review');
    expect(h.store.getIssue(issue.id)).toEqual(resolved);
    expect(h.store.getNode(h.gap.id)).toEqual(h.gap);
  });

  test('a serialized review capability cannot forge operator authority', async () => {
    const { store } = createStores();
    const issue = await store.upsertIssue({ id: 'held-issue', severity: 'info', code: 'gap', message: 'A gap' });
    const resolved = (await reviewKnowledgeIssue(store, { issueId: issue.id, action: 'resolve' })).issue;
    const mutation = createKnowledgeIssueOperatorMutation(resolved);
    await expect(store.upsertIssue({ ...resolved, status: 'open' }, { ...mutation })).rejects.toThrow('explicit review');
    expect(store.getIssue(issue.id)).toEqual(resolved);
  });

  test('Home Graph operator edit opens a resolved issue through the same authority boundary', async () => {
    const { store } = createStores(); const spaceId = 'homegraph:synthetic';
    const issue = await store.upsertIssue({ id: 'home-issue', severity: 'warning', code: 'missing', message: 'Missing battery type', metadata: { knowledgeSpaceId: spaceId } });
    const resolved = await reviewHomeGraphFact(store, spaceId, 'synthetic', { issueId: issue.id, action: 'resolve', reviewer: 'owner' });
    expect(resolved.issue?.status).toBe('resolved');
    const reopened = await reviewHomeGraphFact(store, spaceId, 'synthetic', { issueId: issue.id, action: 'edit', reviewer: 'owner' });
    expect(reopened.issue?.status).toBe('open');
    expect(reopened.issue?.metadata.suppression).toBeUndefined();
  });
});
