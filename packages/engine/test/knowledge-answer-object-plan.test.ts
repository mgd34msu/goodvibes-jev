import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { createSchema } from '../sdk/src/platform/knowledge/store-schema.js';
import { writeKnowledgeNodeRow } from '../sdk/src/platform/knowledge/store-node-history.js';
import { KnowledgeSemanticService } from '../sdk/src/platform/knowledge/semantic/service.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import type { KnowledgeNodeRecord } from '../sdk/src/platform/knowledge/types.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { prepareAnswerLinkedObjects } from '../sdk/src/platform/knowledge/semantic/answer-object-alignment/prepare.js';
import { answerKnowledgeQuery } from '../sdk/src/platform/knowledge/semantic/answer.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';
const spaceId = 'homeassistant:object-fixture';
const profiles = [{ id: 'fixture', subjectKinds: ['ha_device', 'ha_integration'] }] as const;
const roots: string[] = []; let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-answer-object-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init(); return store;
}
async function object(store: KnowledgeStore, id = 'local-object', title = 'Kitchen speaker', extra: Partial<KnowledgeNodeRecord> = {}) {
  return seedHomeAssistantObservation(store, { id, kind: 'ha_device', slug: id, title, status: 'active',
    summary: 'Wireless audio equipment in the kitchen.', ...extra, metadata: { knowledgeSpaceId: spaceId, ...extra.metadata } });
}
function port(options: { aligned?: number; integrationIntent?: number; initial?: number } = {}) {
  const fake = fakePort((name, question) => {
    if (name === 'integrationIntent') return noulAnswer(options.integrationIntent ?? 0.01);
    if (name === 'integrationObject') return noulAnswer(0.01);
    if (name === 'concreteObject') return noulAnswer(0.99);
    if (name === 'aligned') return noulAnswer(options.aligned ?? 0.99);
    if (name === 'useful') return noulAnswer(options.initial ?? 0.99);
    if (name === 'excerptUseful') return noulAnswer(0.01); // Unselected spans cannot bypass the barrier under test.
    if (name === 'features') return noulAnswer(0.01);
    if (name === 'preferred') return choiceAnswer(question, 'generated', 0.99);
    if (name === 'fidelity') return choiceAnswer(question, 'supported', 0.99);
    if (['match', 'enough', 'complete'].includes(name)) return noulAnswer(0.99);
    throw new Error(`Unscripted object-plan fixture: ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
function prepare(store: KnowledgeStore, linkedObjects?: readonly KnowledgeNodeRecord[], signal?: AbortSignal) {
  return prepareAnswerLinkedObjects(store, spaceId, { query: 'What plays tunes beside the sink?', linkedObjects }, profiles, signal);
}
async function source(store: KnowledgeStore) {
  const record = await store.upsertSource({ id: 'local-source', connectorId: 'synthetic', sourceType: 'manual', title: 'Sound handbook',
    status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
  await store.upsertExtraction({ id: 'local-extraction', sourceId: record.id, extractorId: 'fixture', format: 'text',
    excerpt: 'The kitchen speaker plays music and weighs two kilograms.', metadata: { knowledgeSpaceId: spaceId } });
  return record;
}
function answer(store: KnowledgeStore, linkedObjects?: readonly KnowledgeNodeRecord[], signal?: AbortSignal, generation?: () => void) {
  return answerKnowledgeQuery({ store, objectProfiles: profiles, llm: { async completeJson() { throw new Error('Unused'); },
    async completeText() { generation?.(); return 'The kitchen speaker plays music.'; } } },
  { query: 'What plays tunes beside the sink?', knowledgeSpaceId: spaceId, linkedObjects, signal, autoRepairGaps: false });
}

describe('answer object preparation with real stores', () => {
  test('exact local IDs and caller/fact/graph provenance survive opaque wire references', async () => {
    const store = await fixture(); const node = await object(store, '4111111111111111'); const document = await source(store);
    const fact = await store.upsertNode({ id: 'local-fact', kind: 'fact', slug: 'local-fact', title: 'Sound playback',
      status: 'draft', metadata: { knowledgeSpaceId: spaceId, subjectIds: [node.id] } });
    const edge = await store.upsertEdge({ fromKind: 'source', fromId: document.id, toKind: 'node', toId: node.id,
      relation: 'source_for', metadata: { knowledgeSpaceId: spaceId } });
    const fake = port(); const prepared = prepare(store, [node]);
    const result = await prepared.read([{ kind: 'source', id: document.id, title: document.title!, score: 0, source: document, facts: [] }], [fact]);
    expect(result.linkedObjects[0]).toBe(node);
    expect(result.provenance).toEqual([{ nodeId: node.id, callerContext: true, evidence: [{ kind: 'source', id: document.id }], factIds: [fact.id], edges: [edge] }]);
    const transmitted = JSON.stringify(fake.requests);
    for (const id of [node.id, document.id, fact.id, edge.id]) expect(transmitted).not.toContain(id);
    expect(transmitted).toContain('caller-context'); expect(transmitted).toContain('source_for');
    expect(store.getNode(node.id)).toBe(node); expect(store.listNodes()).toHaveLength(2); expect(store.listIssues()).toEqual([]);
  });
  test('foreign/draft/stale/generated and undeclared extension kinds are excluded before projection', async () => {
    const store = await fixture(); const valid = await object(store);
    await object(store, 'foreign', 'Private foreign object', { summary: 'Authorization: Bearer synthetic', metadata: { knowledgeSpaceId: 'homeassistant:foreign' } });
    const draft = await object(store, 'draft', 'Draft object', { status: 'draft', summary: 'Authorization: Bearer synthetic' });
    const stale = await object(store, 'stale', 'Stale object', { status: 'stale', summary: 'Authorization: Bearer synthetic' });
    await object(store, 'undeclared', 'Undeclared area', { kind: 'ha_area', summary: 'Authorization: Bearer synthetic' });
    const generated = await object(store, 'generated', 'Generated projection', { metadata: { generatedProjection: true }, summary: 'Authorization: Bearer synthetic' });
    const fake = port(); const result = await prepare(store, [draft, stale, generated]).read([], []);
    expect(result.linkedObjects.map((node) => node.id)).toEqual([valid.id]);
    expect(JSON.stringify(fake.requests)).not.toContain('synthetic');
  });
  test('an exact extension declaration adds candidates without semantic kind preference', async () => {
    const store = await fixture(); const node = await object(store, 'custom', 'Visible measurement control', { kind: 'ha_area' });
    const fake = port(); expect((await prepare(store).read([], [])).linkedObjects).toEqual([]); expect(fake.requests).toHaveLength(0);
    const plan = prepareAnswerLinkedObjects(store, spaceId, { query: 'Which control changes the volume?' }, [{ id: 'measurement', subjectKinds: ['ha_area'] }]);
    expect((await plan.read([], [])).linkedObjects.map((row) => row.id)).toEqual([node.id]);
  });
  test('a standalone service uses declared HA object kinds only inside the HA namespace', async () => {
    for (const actualSpace of [spaceId, 'default']) {
      const store = await fixture(); const node = await object(store, 'standalone-speaker', 'Kitchen speaker', { metadata: { knowledgeSpaceId: actualSpace } });
      const semantic = new KnowledgeSemanticService(store); const fake = port({ initial: 0.01 });
      const result = await semantic.answer({ query: 'What plays tunes beside the sink?', knowledgeSpaceId: actualSpace,
        includeLinkedObjects: true, autoRepairGaps: false });
      expect(result.answer.linkedObjects.map((row) => row.id)).toEqual(actualSpace === spaceId ? [node.id] : []);
      expect(fake.requests.filter((request) => 'aligned' in request.questions)).toHaveLength(actualSpace === spaceId ? 1 : 0);
      expect(store.getNode(node.id)?.status).toBe('active');
    }
  });
  test('late aliases/model/subject and hint fields cause zero requests before initial evidence', async () => {
    for (const extra of [{ aliases: ['Authorization: Bearer synthetic'] }, { metadata: { model: 'Authorization: Bearer synthetic' } },
      { metadata: { subject: { password: 'synthetic' } } }, { metadata: { targetHints: [{ model: 'Authorization: Bearer synthetic' }] } }]) {
      const store = await fixture(); await source(store); await object(store); await object(store, 'late-object', 'Other speaker', extra);
      const fake = port(); await expect(answer(store)).rejects.toBeInstanceOf(JudgmentInputError); expect(fake.requests).toHaveLength(0);
      expect(store.listIssues()).toEqual([]);
    }
  });
  test('provenance-only subject preflight protects consumed identity without screening unused structured model metadata', async () => {
    for (const [extra, protectedInput] of [
      [{ aliases: ['Authorization: Bearer synthetic'] }, true],
      [{ metadata: { model: 'Authorization: Bearer synthetic' } }, true],
      [{ metadata: { model: { password: 'unused-synthetic-structure' }, manufacturer: { password: 'unused-synthetic-structure' } } }, false],
    ] as const) {
      const fields: Partial<KnowledgeNodeRecord> = extra;
      const initial = await fixture(); const document = await source(initial);
      const subject = await initial.upsertNode({ id: 'legacy-subject', kind: 'knowledge_entity', slug: 'legacy-subject', title: 'Kitchen speaker',
        status: 'draft', aliases: fields.aliases, metadata: { knowledgeSpaceId: spaceId, semanticKind: 'entity', ...fields.metadata } });
      const fact = await initial.upsertNode({ id: 'legacy-fact', kind: 'fact', slug: 'legacy-fact', title: 'Sound playback', status: 'draft',
        sourceId: document.id, summary: 'The kitchen speaker plays music.', metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', subjectIds: [subject.id] } });
      const sqlite = new SQLiteStore(initial.storagePath); await sqlite.init(createSchema, { schemaVersion: 8 });
      writeKnowledgeNodeRow(sqlite, { ...subject, status: 'active' }); writeKnowledgeNodeRow(sqlite, { ...fact, status: 'active' }); await sqlite.save();
      const store = new KnowledgeStore({ dbPath: initial.storagePath }); await store.init(); const fake = port();
      const result = answerKnowledgeQuery({ store, objectProfiles: profiles }, { query: 'What plays tunes beside the sink?', knowledgeSpaceId: spaceId,
        strictCandidates: true, candidateSourceIds: [document.id] });
      if (protectedInput) { await expect(result).rejects.toBeInstanceOf(JudgmentInputError); expect(fake.requests).toHaveLength(0); }
      else { expect((await result).answer.sources.map((row) => row.id)).toEqual([document.id]);
        expect(JSON.stringify(fake.requests)).not.toContain('unused-synthetic-structure'); }
      expect(store.listIssues()).toEqual([]);
    }
  });
  test('only actual local target records omit bookkeeping IDs; unknown/copy fields retain protection', async () => {
    const store = await fixture(); const target = await object(store, '4111111111111111', 'Bedroom speaker');
    const subject = await object(store, 'hinted', 'Kitchen speaker', { metadata: { targetHints: [{ id: target.id, title: target.title }] } });
    const fake = port(); await prepare(store, [subject]).read([], []); expect(JSON.stringify(fake.requests)).not.toContain(target.id);
    await object(store, 'unknown-hint', 'Unknown target', { metadata: { targetHints: [{ id: '5555555555554444', title: 'Unknown speaker' }] } });
    const next = port(); expect(() => prepare(store)).toThrow(JudgmentInputError); expect(next.requests).toHaveLength(0);
  });
  test('stale caller snapshots cannot inject alternate identity or operator authority', async () => {
    const store = await fixture(); const node = await object(store); const fake = port();
    expect(() => prepare(store, [{ ...node, summary: 'Different identity', metadata: { ...node.metadata, reviewed: true } }])).toThrow();
    expect(fake.requests).toHaveLength(0);
  });
  test('node, operator, graph and new-candidate mutations after awaits hold the selection', async () => {
    for (const mutation of ['node', 'operator', 'graph', 'new-candidate'] as const) {
      const store = await fixture(); const node = await object(store); const fake = port(); let changed = false;
      installJudgmentPort({ ...fake.port, async ask(request) { const response = await fake.port.ask(request);
        if (!changed && 'aligned' in request.questions) {
          changed = true;
          if (mutation === 'node') await object(store, node.id, node.title, { aliases: ['New identity'] });
          if (mutation === 'operator') await store.upsertNode({ ...node, status: 'stale', metadata: { ...node.metadata, reviewState: 'rejected' } });
          if (mutation === 'graph') await store.upsertEdge({ fromKind: 'node', fromId: node.id, toKind: 'node', toId: node.id,
            relation: 'describes', metadata: { knowledgeSpaceId: spaceId } });
          if (mutation === 'new-candidate') await object(store, 'second-speaker', 'Second indistinguishable speaker');
        }
        return response;
      } });
      await expect(prepare(store).read([], [])).rejects.toMatchObject({ reason: 'stale' }); expect(changed).toBe(true);
      expect(store.listIssues()).toEqual([]);
    }
  });
  test('caller question mutation after an await invalidates the prepared selection', async () => {
    const store = await fixture(); await object(store); const input = { query: 'What plays tunes beside the sink?' }; const fake = port();
    const prepared = prepareAnswerLinkedObjects(store, spaceId, input, profiles);
    installJudgmentPort({ ...fake.port, async ask(request) { const response = await fake.port.ask(request); input.query = 'What controls the bedroom lights?'; return response; } });
    await expect(prepared.read([], [])).rejects.toMatchObject({ reason: 'stale' }); expect(store.listIssues()).toEqual([]);
  });
  test('settled empty object selection is not repopulated from caller context in no-evidence path', async () => {
    const store = await fixture(); const node = await object(store); const fake = port({ initial: 0.01, aligned: 0.01 });
    const result = await answer(store, [node]);
    expect(result.answer.linkedObjects).toEqual([]); expect(result.answer.synthesized).toBe(false);
    expect(fake.requests.filter((request) => 'integrationIntent' in request.questions)).toHaveLength(1);
    expect(result.answer.gaps.every((gap) => (gap.metadata.linkedObjectIds as string[]).length === 0)).toBe(true);
  });
  test('both ordinary and no-evidence paths wait for alignment before generation or gap writes', async () => {
    for (const initial of [0.99, 0.01]) {
      const store = await fixture(); const node = await object(store); if (initial === 0.99) await source(store);
      const baseline = JSON.stringify(store.listNodes()); let generated = 0;
      const fake = port({ initial, aligned: 0.6 });
      await expect(answer(store, [node], undefined, () => generated++)).rejects.toMatchObject({ reason: 'uncertain' });
      expect(generated).toBe(0); expect(JSON.stringify(store.listNodes())).toBe(baseline); expect(store.listIssues()).toEqual([]);
      expect(fake.requests.some((request) => 'aligned' in request.questions)).toBe(true);
    }
  });
  test('unavailable and aborted object readings cannot write downstream', async () => {
    for (const abort of [false, true]) {
      const store = await fixture(); const node = await object(store); await source(store); const baseline = JSON.stringify(store.listNodes());
      const controller = new AbortController(); const fake = port(); let generated = 0;
      installJudgmentPort({ ...fake.port, async ask(request) {
        if ('aligned' in request.questions) { if (abort) controller.abort(); throw new Error('Reader unavailable'); }
        return fake.port.ask(request);
      } });
      await expect(answer(store, [node], controller.signal, () => generated++)).rejects.toMatchObject({ reason: abort ? 'aborted' : 'unavailable' });
      expect(generated).toBe(0); expect(JSON.stringify(store.listNodes())).toBe(baseline); expect(store.listIssues()).toEqual([]);
    }
  });
  test('final fact attribution preserves an active exact-space edge and ignores deleted or foreign edges', async () => {
    for (const relationState of ['active', 'deleted', 'foreign-space', 'foreign-subject'] as const) {
      const initial = await fixture(); const node = await object(initial); const document = await source(initial);
      const fact = await initial.upsertNode({ id: 'attribution-fact', kind: 'fact', slug: 'attribution-fact', title: 'Sound playback',
        status: 'draft', sourceId: document.id, summary: 'The kitchen speaker plays music.',
        metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact' } });
      const target = relationState === 'foreign-subject'
        ? await object(initial, 'other-installation-object', 'Bedroom speaker', { metadata: { knowledgeSpaceId: 'homeassistant:other' } }) : node;
      const edge = await initial.upsertEdge({ fromKind: 'node', fromId: fact.id, toKind: 'node', toId: target.id, relation: 'describes',
        metadata: { knowledgeSpaceId: relationState === 'foreign-space' ? 'homeassistant:other' : spaceId, deleted: relationState === 'deleted' } });
      const sqlite = new SQLiteStore(initial.storagePath); await sqlite.init(createSchema, { schemaVersion: 8 });
      writeKnowledgeNodeRow(sqlite, { ...fact, status: 'active' }); await sqlite.save();
      const store = new KnowledgeStore({ dbPath: initial.storagePath }); await store.init(); const fake = port();
      const result = await answer(store, [store.getNode(node.id)!]);
      expect(result.answer.linkedObjects.map((row) => row.id)).toEqual([node.id]);
      expect(result.answer.facts).toHaveLength(1);
      expect(result.answer.facts[0]!.subjectIds ?? []).toEqual(relationState === 'active' ? [node.id] : []);
      expect(store.getNode(fact.id)!.metadata.subjectIds).toBeUndefined();
      expect(store.listEdges().find((row) => row.id === edge.id)?.toId).toBe(target.id);
      const sourceReading = fake.requests.find((request) => 'useful' in request.questions
        && (request.state as { candidate?: { kind?: string } }).candidate?.kind === 'source');
      const projectedFact = (sourceReading?.state as { candidate: { facts: { details: string }[] } }).candidate.facts[0]!;
      const subjects = (JSON.parse(projectedFact.details) as { subjects: { title: string }[] }).subjects;
      expect(subjects.map((subject) => subject.title)).toEqual(relationState === 'active' ? [node.title] : []);
    }
  });
  test('a fact declaring a foreign or unknown subject holds with its original reference intact', async () => {
    for (const unknown of [false, true]) {
      const initial = await fixture(); const document = await source(initial); await object(initial);
      const foreign = unknown ? undefined : await object(initial, 'foreign-subject-reference', 'Bedroom speaker', { metadata: { knowledgeSpaceId: 'homeassistant:other' } });
      const subjectId = foreign?.id ?? 'unknown-subject-reference';
      const fact = await initial.upsertNode({ id: 'declared-subject-fact', kind: 'fact', slug: 'declared-subject-fact', title: 'Sound playback', status: 'draft',
        sourceId: document.id, summary: 'A speaker plays music.', metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', subjectIds: [subjectId] } });
      const sqlite = new SQLiteStore(initial.storagePath); await sqlite.init(createSchema, { schemaVersion: 8 });
      writeKnowledgeNodeRow(sqlite, { ...fact, status: 'active' }); await sqlite.save();
      const store = new KnowledgeStore({ dbPath: initial.storagePath }); await store.init(); const fake = port();
      await expect(answer(store)).rejects.toMatchObject({ reason: 'malformed' });
      expect(fake.requests).toHaveLength(0); expect(store.getNode(fact.id)!.metadata.subjectIds).toEqual([subjectId]);
      expect(store.listIssues()).toEqual([]);
    }
  });
  test('object read-set survives later ranking and final verification awaits', async () => {
    for (const stage of ['match', 'fidelity'] as const) {
      const store = await fixture(); const node = await object(store); await source(store); const fake = port(); let aligned = false, changed = false, generated = 0;
      installJudgmentPort({ ...fake.port, async ask(request) { const response = await fake.port.ask(request);
        if ('aligned' in request.questions) aligned = true;
        if (aligned && !changed && stage in request.questions) { changed = true; await object(store, node.id, node.title, { aliases: ['Changed late'] }); }
        return response;
      } });
      await expect(answer(store, [node], undefined, () => generated++)).rejects.toMatchObject({ reason: 'stale' });
      expect(changed).toBe(true); expect(generated).toBe(stage === 'match' ? 0 : 1); expect(store.listIssues()).toEqual([]);
    }
  });
});
