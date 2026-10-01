import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import type { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { reviewKnowledgeIssue } from '../sdk/src/platform/knowledge/review.js';
import { reviewKnowledgeNodeRecord } from '../sdk/src/platform/knowledge/service-node-admin.js';
import { isActionableAnswerGap, prepareAnswerGapUniverse } from '../sdk/src/platform/knowledge/semantic/answer-gaps.js';
import { ANSWER_GAP_LIMITS, prepareAnswerGapReadings } from '../sdk/src/platform/knowledge/semantic/answer-gap-plan/reader.js';
import type { KnowledgeNodeRecord } from '../sdk/src/platform/knowledge/types.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';

const spaceId = 'homeassistant:answer-gap-plan';
const query = 'Which kind of battery powers the kitchen sensor?';
const reason = 'The selected evidence does not establish the battery type.';
const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => {
  installJudgmentPort(previous);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function gap(store: KnowledgeStore, id = 'legacy-answer-gap', extra: Partial<KnowledgeNodeRecord> = {}) {
  const input = { id, kind: 'knowledge_gap' as const, slug: id, title: query, summary: 'Original missing battery information.',
    status: 'active' as const, confidence: 70, ...extra,
    metadata: { knowledgeSpaceId: spaceId, semanticKind: 'gap', gapKind: 'answer', query,
      repairStatus: 'open', ...extra.metadata } };
  return upsertObservedKnowledgeNode(store, input, 'research-task', input, () => input);
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-answer-gap-plan-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init();
  const subject = await seedHomeAssistantObservation(store, { id: 'sensor', kind: 'ha_device', slug: 'sensor', title: 'Kitchen sensor',
    status: 'active', metadata: { knowledgeSpaceId: spaceId, model: 'KS-7' } });
  const source = await store.upsertSource({ id: 'manual', connectorId: 'synthetic', sourceType: 'manual', title: 'Kitchen sensor manual',
    status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
  await store.upsertExtraction({ id: 'manual-extraction', sourceId: source.id, extractorId: 'fixture', format: 'text',
    excerpt: 'The kitchen sensor reports room temperature.', metadata: { knowledgeSpaceId: spaceId } });
  const existing = await gap(store, 'legacy-answer-gap', { sourceId: source.id,
    metadata: { subject: subject.title, linkedObjectIds: [subject.id], sourceIds: [source.id] } });
  const issue = await store.upsertIssue({ id: 'legacy-answer-gap-issue', severity: 'info', code: 'knowledge.answer_gap', message: query,
    status: 'open', nodeId: existing.id, sourceId: source.id,
    metadata: { knowledgeSpaceId: spaceId, query, subjectFingerprint: 'legacy-fingerprint' } });
  const edge = await store.upsertEdge({ fromKind: 'node', fromId: subject.id, toKind: 'node', toId: existing.id, relation: 'has_gap',
    metadata: { knowledgeSpaceId: spaceId, gapKind: 'answer' } });
  return { store, subject, source, existing, issue, edge };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function readings(sameQuestion = 0.99, gapSubject = 0.99) {
  const fake = fakePort((name) => {
    if (name === 'gapSubject') return noulAnswer(gapSubject);
    if (name === 'sameQuestion') return noulAnswer(sameQuestion);
    throw new Error(`Unscripted answer-gap plan question: ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
function prepare(item: Fixture, options: { signal?: AbortSignal; timeoutMs?: number } = {}, assertCurrent?: () => void) {
  return prepareAnswerGapUniverse(item.store, spaceId, query, options)
    .prepare({ spaceId, linkedObjects: [item.subject], sources: [item.source], noMatch: true, ...(assertCurrent ? { assertCurrent } : {}) });
}
function snapshot(store: KnowledgeStore) {
  const sort = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
  const nodes = sort(store.listNodes(Number.MAX_SAFE_INTEGER));
  return structuredClone({ nodes, sources: sort(store.listSources(Number.MAX_SAFE_INTEGER)),
    extractions: sort(store.listExtractions(Number.MAX_SAFE_INTEGER)), edges: sort(store.listEdges()),
    issues: sort(store.listIssues(Number.MAX_SAFE_INTEGER)),
    tasks: sort(store.listRefinementTasks(Number.MAX_SAFE_INTEGER)),
    revisions: nodes.map((node) => ({ nodeId: node.id, rows: store.listNodeRevisions(node.id) })) });
}
async function unchanged(store: KnowledgeStore, before: ReturnType<typeof snapshot>) {
  expect(snapshot(store)).toEqual(before);
  const reopened = new KnowledgeStore({ dbPath: store.storagePath }); await reopened.init();
  expect(snapshot(reopened)).toEqual(before);
}

describe('prepared answer-gap universe and write guards', () => {
  test('matching an active legacy row retains its node and issue identities', async () => {
    const item = await fixture(); const fake = readings();
    expect(item.existing.metadata.subjectFingerprint).toBeUndefined();
    const prepared = await prepare(item).read();
    const result = await prepared.persist(reason);
    expect(result?.id).toBe(item.existing.id);
    expect(item.store.listNodes().filter((node) => node.kind === 'knowledge_gap').map((node) => node.id)).toEqual([item.existing.id]);
    expect(item.store.listIssues().map((issue) => issue.id)).toEqual([item.issue.id]);
    expect(item.store.getIssue(item.issue.id)?.metadata.subjectFingerprint).toBe(item.issue.metadata.subjectFingerprint);
    expect(item.store.getIssue(item.issue.id)?.metadata.issueLifecycle).toEqual(item.issue.metadata.issueLifecycle);
    expect(fake.requests.some((request) => 'sameQuestion' in request.questions)).toBe(true);
    const reopened = new KnowledgeStore({ dbPath: item.store.storagePath }); await reopened.init();
    expect(reopened.getNode(item.existing.id)).toEqual(result);
    expect(reopened.getIssue(item.issue.id)).toEqual(item.store.getIssue(item.issue.id));
  });

  test('case-distinct local subject IDs survive reordered equivalent requests', async () => {
    const item = await fixture(); await item.store.deleteNode(item.existing.id);
    const upper = await seedHomeAssistantObservation(item.store, { id: 'sensor-A', kind: 'ha_device', slug: 'north-sensor',
      title: 'North kitchen sensor', status: 'active', metadata: { knowledgeSpaceId: spaceId } });
    const lower = await seedHomeAssistantObservation(item.store, { id: 'sensor-a', kind: 'ha_device', slug: 'south-sensor',
      title: 'South kitchen sensor', status: 'active', metadata: { knowledgeSpaceId: spaceId } });
    const relation = 'Do the north and south kitchen sensors use the same battery?'; const fake = readings();
    const selected = (linkedObjects: readonly KnowledgeNodeRecord[]) => prepareAnswerGapUniverse(item.store, spaceId, relation)
      .prepare({ spaceId, linkedObjects, sources: [item.source] });
    const first = await (await selected([upper, lower]).read()).persist(reason);
    expect(first?.metadata.linkedObjectIds).toEqual([upper.id, lower.id]);
    const second = await (await selected([lower, upper]).read()).persist(reason);
    expect(second?.id).toBe(first?.id); expect(second?.metadata.linkedObjectIds).toEqual([upper.id, lower.id]);
    const equivalence = fake.requests.find((request) => 'sameQuestion' in request.questions);
    const state = equivalence?.state as { question: { subjects: unknown[] }; candidate: { subjects: unknown[] } };
    expect(state.question.subjects).toHaveLength(2); expect(state.candidate.subjects).toHaveLength(2);
    expect(item.store.listNodes().filter((node) => node.kind === 'knowledge_gap')).toHaveLength(1);
    expect(item.store.listEdges().filter((edge) => edge.toId === second?.id && edge.fromKind === 'node').map((edge) => edge.fromId).sort())
      .toEqual([upper.id, lower.id].sort());
    const reopened = new KnowledgeStore({ dbPath: item.store.storagePath }); await reopened.init();
    expect(snapshot(reopened)).toEqual(snapshot(item.store));
  });

  test('a confidently different question allocates a new identity without changing the legacy gap', async () => {
    const item = await fixture(); readings(0.01);
    const oldNode = structuredClone(item.existing), oldIssue = structuredClone(item.issue);
    const result = await (await prepare(item).read()).persist(reason);
    expect(result).not.toBeNull(); expect(result?.id).not.toBe(oldNode.id);
    expect(result?.id).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
    expect(item.store.getNode(oldNode.id)).toEqual(oldNode); expect(item.store.getIssue(oldIssue.id)).toEqual(oldIssue);
    expect(item.store.listIssues().filter((issue) => issue.nodeId === result?.id)).toHaveLength(1);
    expect(item.store.listEdges().filter((edge) => edge.toId === result?.id && edge.relation === 'has_gap')).toHaveLength(2);
    const reopened = new KnowledgeStore({ dbPath: item.store.storagePath }); await reopened.init();
    expect(snapshot(reopened)).toEqual(snapshot(item.store));
  });

  for (const terminal of ['repaired', 'not_applicable', 'reviewed-node', 'rejected-node', 'resolved-issue', 'reviewed-issue'] as const) {
    test(`${terminal} matching state is reused without changing any persisted row`, async () => {
      const item = await fixture();
      if (terminal === 'repaired' || terminal === 'not_applicable') {
        await gap(item.store, item.existing.id, { ...item.existing, metadata: { ...item.existing.metadata,
          repairStatus: terminal, acceptedSourceIds: [item.source.id], promotedFactCount: 2, nextRepairAttemptAt: 123456,
          repairAttempts: [{ outcome: 'retained original outcome' }] } });
      } else if (terminal === 'reviewed-node' || terminal === 'rejected-node') {
        await reviewKnowledgeNodeRecord(item.store, { id: item.existing.id, decision: terminal === 'reviewed-node' ? 'accept' : 'reject', reviewer: 'owner' });
      } else {
        await reviewKnowledgeIssue(item.store, { issueId: item.issue.id, action: terminal === 'resolved-issue' ? 'resolve' : 'edit', reviewer: 'owner' });
      }
      const before = snapshot(item.store); readings();
      const result = await (await prepare(item).read()).persist('A paraphrased request must retain the existing decision.');
      expect(result?.id).toBe(item.existing.id); expect(result).toBe(item.store.getNode(item.existing.id));
      await unchanged(item.store, before);
    });
  }

  for (const state of ['queued', 'searching', 'evaluating', 'extracting', 'applying'] as const) {
    test(`a matched gap with ${state} repair work is returned without invalidating its snapshot`, async () => {
      const item = await fixture();
      await item.store.upsertRefinementTask({ id: 'active-repair', spaceId, gapId: item.existing.id, issueId: item.issue.id, state, trigger: 'manual' });
      const before = snapshot(item.store); readings();
      expect(await (await prepare(item).read()).persist(reason)).toBe(item.store.getNode(item.existing.id));
      expect(isActionableAnswerGap(item.store, item.existing)).toBe(true);
      await unchanged(item.store, before);
    });
  }

  test('an active repair phase transition during equivalence invalidates even read-only reuse', async () => {
    const item = await fixture();
    const task = await item.store.upsertRefinementTask({ id: 'active-repair', spaceId, gapId: item.existing.id, state: 'queued', trigger: 'manual' });
    const fake = readings(); let after: ReturnType<typeof snapshot> | undefined;
    installJudgmentPort({ ...fake.port, async ask(request) {
      const result = await fake.port.ask(request);
      if ('sameQuestion' in request.questions) {
        await item.store.upsertRefinementTask({ ...task, state: 'searching' }); after = snapshot(item.store);
      }
      return result;
    } });
    await expect(prepare(item).read().then((prepared) => prepared.persist(reason))).rejects.toMatchObject({ reason: 'stale' });
    expect(after).toBeDefined(); await unchanged(item.store, after!);
  });

  const mutations = ['insert', 'delete', 'node', 'issue', 'source', 'subject', 'edge', 'task'] as const;
  async function mutate(item: Fixture, mutation: typeof mutations[number]) {
    if (mutation === 'insert') await gap(item.store, 'late-candidate', { title: 'What battery does the same sensor take?' });
    if (mutation === 'delete') await item.store.deleteNode(item.existing.id);
    if (mutation === 'node') await gap(item.store, item.existing.id, { ...item.existing, summary: 'A newer repair attempt changed this gap.' });
    if (mutation === 'issue') await reviewKnowledgeIssue(item.store, { issueId: item.issue.id, action: 'resolve', reviewer: 'owner' });
    if (mutation === 'source') await item.store.upsertSource({ ...item.source, title: 'Revised kitchen sensor manual' });
    if (mutation === 'subject') await seedHomeAssistantObservation(item.store, { ...item.subject, aliases: ['Replacement sensor'] });
    if (mutation === 'edge') await item.store.upsertEdge({ ...item.edge, metadata: { ...item.edge.metadata, deleted: true } });
    if (mutation === 'task') await item.store.upsertRefinementTask({ id: 'cancelled-task', spaceId,
      gapId: item.existing.id, issueId: item.issue.id, state: 'cancelled', trigger: 'manual' });
  }
  for (const stage of ['reading', 'persistence'] as const) {
    for (const mutation of mutations) {
      test(`${mutation} during ${stage} invalidates the complete plan without fallback writes`, async () => {
        const item = await fixture(); const fake = readings(); const plan = prepare(item);
        let afterMutation: ReturnType<typeof snapshot> | undefined;
        if (stage === 'reading') {
          let changed = false;
          installJudgmentPort({ ...fake.port, async ask(request) {
            const response = await fake.port.ask(request);
            if (!changed && 'sameQuestion' in request.questions) {
              changed = true; await mutate(item, mutation); afterMutation = snapshot(item.store);
            }
            return response;
          } });
          await expect(plan.read().then((prepared) => prepared.persist(reason))).rejects.toMatchObject({ reason: 'stale' });
          expect(changed).toBe(true);
        } else {
          const prepared = await plan.read(); await mutate(item, mutation); afterMutation = snapshot(item.store);
          await expect(prepared.persist(reason)).rejects.toMatchObject({ reason: 'stale' });
        }
        expect(afterMutation).toBeDefined(); await unchanged(item.store, afterMutation!);
      });
    }
  }

  test('the universe is captured before any later evidence or object-selection await', async () => {
    const item = await fixture(); const fake = readings();
    const universe = prepareAnswerGapUniverse(item.store, spaceId, query);
    await gap(item.store, 'appeared-before-prepare'); const before = snapshot(item.store);
    expect(() => universe.prepare({ spaceId, linkedObjects: [item.subject], sources: [item.source], noMatch: true }))
      .toThrow(/stale/);
    expect(fake.requests).toHaveLength(0); await unchanged(item.store, before);
  });

  test('a rejected equivalence candidate remains part of the guarded universe', async () => {
    const item = await fixture(); const unrelated = 'Which mounting bracket fits the hallway sensor?';
    const rejected = await gap(item.store, 'unmatched-gap', { title: unrelated, metadata: { query: unrelated } });
    installJudgmentPort(fakePort((name, _question, state) => {
      if (name === 'gapSubject') return noulAnswer(0.99);
      if (name === 'sameQuestion') return noulAnswer((state as { candidate: { query: string } }).candidate.query === unrelated ? 0.01 : 0.99);
      throw new Error(`Unexpected universe question: ${name}`);
    }).port);
    const prepared = await prepare(item).read();
    await gap(item.store, rejected.id, { ...rejected, summary: 'The rejected alternative changed after selection.' });
    const before = snapshot(item.store);
    await expect(prepared.persist(reason)).rejects.toMatchObject({ reason: 'stale' });
    await unchanged(item.store, before);
  });

  for (const late of ['uncertain', 'unavailable', 'malformed'] as const) {
    test(`a settled match followed by a ${late} candidate leaves the entire batch unchanged`, async () => {
      const item = await fixture(); await gap(item.store, 'second-candidate');
      const before = snapshot(item.store), fake = readings(); let count = 0;
      installJudgmentPort({ ...fake.port, async ask(request) {
        const response = await fake.port.ask(request);
        if ('sameQuestion' in request.questions && ++count === 2) {
          if (late === 'unavailable') throw new Error('Synthetic late reader failure');
          return { ...response, answers: { sameQuestion: noulAnswer(late === 'uncertain' ? 0.5 : Number.NaN) } } as typeof response;
        }
        return response;
      } });
      await expect(prepare(item).read().then((prepared) => prepared.persist(reason))).rejects.toMatchObject({ reason: late });
      expect(count).toBe(2); await unchanged(item.store, before);
    });
  }

  test('a late issue SQL failure rolls back the new gap, edges and revisions together', async () => {
    const item = await fixture(), before = snapshot(item.store), bytes = readFileSync(item.store.storagePath);
    readings(0.01); const prepared = await prepare(item).read();
    const database = (item.store as unknown as { sqlite: SQLiteStore }).sqlite;
    const originalRun = database.run.bind(database); let reachedIssue = false;
    database.run = (sql, params) => {
      if (sql.includes('INSERT OR REPLACE INTO knowledge_issues')) {
        reachedIssue = true; throw new Error('Synthetic late answer-gap SQL failure');
      }
      originalRun(sql, params);
    };
    try { await expect(prepared.persist(reason)).rejects.toThrow('Synthetic late answer-gap SQL failure'); }
    finally { database.run = originalRun; }
    expect(reachedIssue).toBe(true); expect(snapshot(item.store)).toEqual(before);
    expect(readFileSync(item.store.storagePath)).toEqual(bytes);
    await database.save(); await unchanged(item.store, before);
  });

  test('cancellation after graph preparation prevents every gap write', async () => {
    const item = await fixture(), before = snapshot(item.store), controller = new AbortController(); readings(0.01);
    const prepared = await prepare(item, { signal: controller.signal }).read();
    const apply = item.store.applyPreparedIngest.bind(item.store); let preparedGraph = false;
    item.store.applyPreparedIngest = (input, prepareGraph, options) => apply(input, async (stage) => {
      const graph = await prepareGraph(stage); preparedGraph = true; controller.abort(); return graph;
    }, options);
    await expect(prepared.persist(reason)).rejects.toMatchObject({ reason: 'aborted' });
    expect(preparedGraph).toBe(true); await unchanged(item.store, before);
  });

  for (const stage of ['reading', 'persistence'] as const) {
    test(`external context invalidation during ${stage} prevents all gap writes`, async () => {
      const item = await fixture(), before = snapshot(item.store), fake = readings(); let revision = 0;
      const plan = prepare(item, {}, () => {
        if (revision !== 0) throw Object.assign(new Error('External answer context changed.'), { reason: 'stale' });
      });
      if (stage === 'reading') {
        installJudgmentPort({ ...fake.port, async ask(request) {
          const response = await fake.port.ask(request); if ('sameQuestion' in request.questions) revision += 1; return response;
        } });
        await expect(plan.read().then((prepared) => prepared.persist(reason))).rejects.toMatchObject({ reason: 'stale' });
      } else {
        const prepared = await plan.read(); revision += 1;
        await expect(prepared.persist(reason)).rejects.toMatchObject({ reason: 'stale' });
      }
      expect(revision).toBeGreaterThan(0); await unchanged(item.store, before);
    });
  }

  for (const target of ['node', 'issue'] as const) {
    test(`an absent ${target} target inserted during commit preparation cannot be overwritten`, async () => {
      const item = await fixture(); readings(0.01); const prepared = await prepare(item).read();
      const apply = item.store.applyPreparedIngest.bind(item.store);
      let afterInsert: ReturnType<typeof snapshot> | undefined;
      item.store.applyPreparedIngest = (input, prepareGraph, options) => apply(input, async (stage) => {
        expect(input.sources).toEqual([]); expect(input.extractions).toEqual([]);
        const graph = await prepareGraph(stage), nodeId = graph.nodes[0]?.id, issueId = graph.issues[0]?.id;
        expect(nodeId).toBeDefined(); expect(issueId).toBeDefined();
        if (target === 'node') await gap(item.store, nodeId!, { title: 'A concurrent producer already owns this identity.' });
        else await item.store.upsertIssue({ id: issueId!, severity: 'warning', code: 'concurrent-issue', message: 'A concurrent issue owns this identity.',
          metadata: { knowledgeSpaceId: spaceId } });
        afterInsert = snapshot(item.store); return graph;
      }, options);
      await expect(prepared.persist(reason)).rejects.toMatchObject({ reason: 'stale' });
      expect(afterInsert).toBeDefined(); await unchanged(item.store, afterInsert!);
    });
  }

  test('all candidate questions receive protected-data preflight before the first request', async () => {
    for (const field of ['title', 'summary', 'query', 'subject'] as const) {
      const item = await fixture();
      const secret = 'Authorization: Bearer synthetic-plan-protected';
      await gap(item.store, 'zz-protected-candidate', field === 'title' || field === 'summary'
        ? { [field]: secret } : { metadata: { [field]: secret } });
      await gap(item.store, 'aa-first-safe-candidate');
      const before = snapshot(item.store), fake = readings();
      const plan = prepare(item);
      await expect(plan.read()).rejects.toBeInstanceOf(JudgmentInputError);
      expect(fake.requests).toHaveLength(0); await unchanged(item.store, before);
    }
  });

  for (const context of ['subject', 'source'] as const) {
    test(`protected selected ${context} is preflighted before an oversized candidate universe`, async () => {
      const item = await fixture();
      for (let index = 0; index < ANSWER_GAP_LIMITS.candidates; index++) await gap(item.store, `historic-${index}`);
      const secret = 'Authorization: Bearer synthetic-selected-context';
      const subject = context === 'subject' ? await seedHomeAssistantObservation(item.store, {
        ...item.subject, id: 'protected-subject', slug: 'protected-subject', title: secret,
      }) : item.subject;
      const source = context === 'source' ? await item.store.upsertSource({
        ...item.source, id: 'protected-source', title: secret,
      }) : item.source;
      const before = snapshot(item.store), fake = readings();
      const plan = prepareAnswerGapUniverse(item.store, spaceId, query).prepare({ spaceId, linkedObjects: [subject], sources: [source] });
      await expect(plan.read()).rejects.toMatchObject({ name: 'JudgmentInputError', problem: 'credential-material' });
      expect(fake.requests).toHaveLength(0); await unchanged(item.store, before);
    });
  }

  test('a hidden selected source summary is retained for privacy preflight', async () => {
    const item = await fixture(), fake = readings();
    Object.defineProperty(item.source, 'summary', { value: 'Authorization: Bearer synthetic-hidden-summary', enumerable: false });
    await expect(prepare(item).read()).rejects.toMatchObject({ name: 'JudgmentInputError', problem: 'credential-material' });
    expect(fake.requests).toHaveLength(0);
  });

  for (const kind of ['subject', 'source'] as const) {
    test(`an unresolved claimed ${kind} ID retains protected-input checks`, async () => {
      const item = await fixture();
      await gap(item.store, item.existing.id, { ...item.existing, metadata: { ...item.existing.metadata,
        ...(kind === 'subject' ? { linkedObjectIds: ['4111111111111111'] } : { sourceIds: ['4111111111111111'] }),
      } });
      const before = snapshot(item.store), fake = readings();
      await expect(prepare(item).read()).rejects.toMatchObject({ name: 'JudgmentInputError', problem: 'card-material' });
      expect(fake.requests).toHaveLength(0); await unchanged(item.store, before);
    });
  }

  test('a mismatched source copy cannot borrow a locally resolved identity', async () => {
    const item = await fixture(), before = snapshot(item.store), fake = readings();
    expect(() => prepareAnswerGapUniverse(item.store, spaceId, query).prepare({ spaceId,
      sources: [{ ...item.source, title: '4111111111111111' }],
    })).toThrow(/changed|stale/);
    expect(fake.requests).toHaveLength(0); await unchanged(item.store, before);
  });

  for (const shape of ['extra-field', 'constructor', 'toJSON', 'accessor'] as const) {
    test(`selected arrays with ${shape} cannot lose data or execute hooks before preflight`, async () => {
      const item = await fixture(), fake = readings(), sources = [item.source]; let invoked = false;
      if (shape === 'extra-field') Object.defineProperty(sources, 'hidden', { value: 'Authorization: Bearer synthetic-array-extra' });
      if (shape === 'constructor') Object.defineProperty(sources, 'constructor', { value: { [Symbol.species]: () => { invoked = true; return []; } } });
      if (shape === 'toJSON') Object.defineProperty(sources, 'toJSON', { value: () => { invoked = true; return []; } });
      if (shape === 'accessor') Object.defineProperty(sources, '0', { get() { invoked = true; return item.source; } });
      expect(() => prepareAnswerGapUniverse(item.store, spaceId, query).prepare({ spaceId, sources })).toThrow(JudgmentInputError);
      expect(invoked).toBe(false); expect(fake.requests).toHaveLength(0);
    });
  }

  test('draft and stale candidates retain protected-data preflight', async () => {
    for (const status of ['draft', 'stale'] as const) {
      const item = await fixture();
      await gap(item.store, 'zz-inactive-gap', { status, title: 'Authorization: Bearer synthetic-inactive' });
      await gap(item.store, 'aa-first-safe-candidate');
      const before = snapshot(item.store), fake = readings();
      const plan = prepare(item);
      await expect(plan.read()).rejects.toBeInstanceOf(JudgmentInputError);
      expect(fake.requests).toHaveLength(0); await unchanged(item.store, before);
    }
  });

  for (const field of ['message', 'reason'] as const) {
    test(`protected associated issue ${field} prevents every gap request`, async () => {
      const item = await fixture(), secret = 'Authorization: Bearer synthetic-issue-protected';
      await item.store.upsertIssue({ ...item.issue, ...(field === 'message' ? { message: secret }
        : { metadata: { ...item.issue.metadata, reason: secret } }) });
      const before = snapshot(item.store), fake = readings(), plan = prepare(item);
      await expect(plan.read()).rejects.toBeInstanceOf(JudgmentInputError);
      expect(fake.requests).toHaveLength(0); await unchanged(item.store, before);
    });
  }

  test('provider replacement during admission prevents later equivalence requests', async () => {
    const fake = readings(), replacement = fakePort(() => noulAnswer(0.99));
    installJudgmentPort({ ...fake.port, async ask(request) {
      const response = await fake.port.ask(request);
      if ('gapSubject' in request.questions) installJudgmentPort(replacement.port);
      return response;
    } });
    const meaning = { query, subjects: [], sources: [] };
    const plan = prepareAnswerGapReadings({ question: meaning, needsSubject: true,
      candidates: [{ reference: 'gap-1', title: query, ...meaning }] },
    { deadlineAt: Date.now() + 1_000, assertCurrent() {} });
    await expect(plan.read()).rejects.toMatchObject({ reason: 'stale' });
    expect(fake.requests).toHaveLength(1); expect(fake.requests[0]?.questions).toHaveProperty('gapSubject');
    expect(replacement.requests).toHaveLength(0);
  });

  test('unscoped default-space no-match stays read-only without a judgment request', async () => {
    const item = await fixture();
    await gap(item.store, 'unused-default-gap', { title: 'Authorization: Bearer synthetic-unused', metadata: { knowledgeSpaceId: 'default' } });
    const before = snapshot(item.store), fake = readings();
    const plan = prepareAnswerGapUniverse(item.store, 'default', 'What can you tell me?')
      .prepare({ spaceId: 'default', noMatch: true });
    expect(await (await plan.read()).persist(reason)).toBeNull();
    expect(fake.requests).toHaveLength(0); await unchanged(item.store, before);
  });

  test('foreign-space protected gaps are neither projected nor reused', async () => {
    const item = await fixture();
    await gap(item.store, 'foreign-gap', { title: 'Authorization: Bearer synthetic-foreign',
      metadata: { knowledgeSpaceId: 'homeassistant:other-installation' } });
    const foreign = structuredClone(item.store.getNode('foreign-gap')), fake = readings();
    const result = await (await prepare(item).read()).persist(reason);
    expect(result?.id).toBe(item.existing.id);
    expect(JSON.stringify(fake.requests)).not.toContain('synthetic-foreign');
    expect(item.store.getNode('foreign-gap')).toEqual(foreign);
  });

  test('unrelated foreign oversized source content does not enter the selected universe', async () => {
    const item = await fixture();
    const foreign = await item.store.upsertSource({ id: 'foreign-source', connectorId: 'fixture', sourceType: 'manual', status: 'indexed',
      title: 'Other installation', summary: 'x'.repeat(1_000_001), metadata: { knowledgeSpaceId: 'homeassistant:foreign' } });
    Object.defineProperty(foreign.metadata, 'unrelated', { get() { throw new Error('Foreign content must stay outside the pass'); } });
    Object.defineProperty(foreign.metadata, 'namespace', { get() { throw new Error('Unused scope fallback must stay unread'); } });
    const fake = readings();
    const result = await (await prepare(item).read()).persist(reason);
    expect(result?.id).toBe(item.existing.id); expect(fake.requests.length).toBeGreaterThan(0);
    const none = await prepareAnswerGapUniverse(item.store, 'default', query).prepare({ spaceId: 'default', noMatch: true }).read();
    expect(await none.persist(reason)).toBeNull();
  });

  test('a deadline covers the interval between reading and persistence', async () => {
    const item = await fixture(), before = snapshot(item.store); readings();
    const prepared = await prepare(item, { timeoutMs: 50 }).read();
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    await expect(prepared.persist(reason)).rejects.toMatchObject({ reason: 'budget' });
    await unchanged(item.store, before);
  });

  for (const mode of ['uncertain', 'unavailable', 'aborted', 'budget'] as const) {
    test(`${mode} reader cannot produce a late write, including when cancellation is ignored`, async () => {
      const item = await fixture(), before = snapshot(item.store), controller = new AbortController();
      const fake = readings(mode === 'uncertain' ? 0.5 : 0.99);
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      if (mode !== 'uncertain') installJudgmentPort({ ...fake.port, async ask(request) {
        if ('sameQuestion' in request.questions) {
          if (mode === 'unavailable') throw new Error('Synthetic unavailable gap reader');
          entered.resolve(); await release.promise;
        }
        return fake.port.ask(request);
      } });
      const plan = prepare(item, { signal: controller.signal, ...(mode === 'budget' ? { timeoutMs: 50 } : {}) });
      const pending = plan.read().then((prepared) => prepared.persist(reason));
      const outcome = pending.catch((error: unknown) => error);
      try {
        if (mode === 'aborted' || mode === 'budget') {
          await entered.promise;
          if (mode === 'aborted') controller.abort();
        }
        expect(await outcome).toMatchObject({ reason: mode });
      } finally { release.resolve(); }
      // Let the ignored-cancellation provider return through every queued continuation.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await unchanged(item.store, before);
    });
  }
});
