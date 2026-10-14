import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { createStores } from './_helpers/knowledge-semantic-fixtures.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { createSchema, KNOWLEDGE_SCHEMA_VERSION } from '../sdk/src/platform/knowledge/store-schema.js';
import { repairSourceAuthority } from '../sdk/src/platform/knowledge/semantic/repair-source-authority/battery.js';
import { writeSupportedRepairSubjectLinks } from '../sdk/src/platform/knowledge/semantic/repair-subject-write-plan.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { prepareSourceLinkedRepairProfileFacts, promoteRepairSources, type SourceLinkedRepairProfileFactInput } from '../sdk/src/platform/knowledge/semantic/self-improvement-promotion.js';
import { prepareRepairFactScoring, KnowledgeRepairFactScoringHeldError, type RepairFactScoringInput } from '../sdk/src/platform/knowledge/semantic/repair-fact-scoring/reader.js';
import { prepareRepairProfileRequirement } from '../sdk/src/platform/knowledge/semantic/repair-profile-requirement/reader.js';
import { repairProfileFixtureReading } from './_helpers/repair-profile-fixture-readings.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';

const spaceId = 'scored-repair-space', text = 'AC-7 has four HDMI inputs. AC-7 has two USB ports. AC-7 supports Dolby Vision.';
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function score(question: Question, value: number, confidence = 0.99) { return scoreAnswer(question, value, confidence); }
function scoringInput(reference = 'fact-1'): RepairFactScoringInput {
  return { reference, query: 'How many HDMI inputs does AC-7 have?', subjects: [{ title: 'AC-7', aliases: [], identity: { model: 'AC-7' } }],
    fact: { title: 'HDMI inputs', kind: 'specification', summary: 'AC-7 has four HDMI inputs.', value: 'four HDMI inputs', aliases: [] },
    evidence: [{ source: { sourceType: 'manual', title: 'AC-7 technical reference' }, text }],
    trustEvidence: { source: { sourceType: 'manual', title: 'AC-7 technical reference' }, text } };
}
async function fixture() {
  const { store } = createStores();
  const observed = { id: 'ac-seven', kind: 'ha_device' as const, slug: 'ac-seven', title: 'AC-7', status: 'active' as const,
    metadata: { knowledgeSpaceId: spaceId, model: 'AC-7', entityKind: 'device' } };
  const subject = await upsertObservedKnowledgeNode(store, observed, 'home-assistant-snapshot', observed, () => observed);
  const source = await store.upsertSource({ id: 'ac-seven-reference', connectorId: 'synthetic', sourceType: 'manual', title: 'AC-7 reference', status: 'indexed',
    metadata: { knowledgeSpaceId: spaceId, privateMetadata: 'NEVER_TRANSMIT', sourceDiscovery: { linkedObjectIds: [subject.id] } } });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: text, metadata: { knowledgeSpaceId: spaceId } });
  const input: SourceLinkedRepairProfileFactInput = { store, spaceId, source, extraction, subjects: [subject], authority: 'official-vendor',
    title: 'HDMI inputs', summary: 'AC-7 has four HDMI inputs.', evidence: 'AC-7 has four HDMI inputs.',
    classification: { kind: 'specification', title: 'HDMI inputs', summary: 'AC-7 has four HDMI inputs.', value: 'four HDMI inputs', labels: ['HDMI'], aliases: [] }, extractor: 'synthetic' };
  return { store, subject, source, extraction, input };
}
function graph(store: Awaited<ReturnType<typeof fixture>>['store']) {
  return JSON.stringify({ nodes: store.listNodes(), edges: store.listEdges(), tasks: store.listRefinementTasks() });
}
function publicationReadings(grading: (name: string) => number = name => name === 'factTrust' ? 2 : name === 'sourceSupport' ? 3 : 4) {
  const fake = fakePort((name, question) => {
    if (name === 'factTrust' || name === 'sourceSupport' || name === 'subjectSupport') return score(question, grading(name));
    if (name === 'supported' || name === 'attached' || name === 'serve') return noulAnswer(0.99);
    throw new Error(`Unscripted scored publication question ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}

// Only the exact authored native publisher-role request has this fixture answer.
// These synthetic manual records declare no independently established origin.
function sourceAuthorityFixture(question: Question, state: unknown, query: string, sourceText: string) {
  expect(question).toEqual(repairSourceAuthority.items.authority.question);
  expect(state).toEqual({
    reference: 'source-1', query,
    subjects: [{ title: 'AC-7', kind: 'ha_device', aliases: [], identity: { model: 'AC-7', entityKind: 'device' } }],
    source: { sourceType: 'manual', title: 'AC-7 reference' },
    extraction: { format: 'text', links: [] }, text: sourceText, claimedProvenance: {},
  });
  return choiceAnswer(question, 'secondary', 0.99);
}

async function persistedRelinkFixture(protectedTail: boolean) {
  const item = await fixture(); publicationReadings();
  const fact = await item.store.upsertNode({ id: 'ordinary-hdmi-fact', kind: 'fact', slug: 'ordinary-hdmi-fact', title: 'HDMI inputs',
    summary: 'AC-7 has four HDMI inputs.', status: 'active', sourceId: item.source.id, aliases: [],
    metadata: { knowledgeSpaceId: spaceId, factKind: 'specification', value: 'four HDMI inputs', evidence: 'AC-7 has four HDMI inputs.',
      sourceIds: [item.source.id], subjectIds: [item.subject.id], linkedObjectIds: [item.subject.id] } });
  const observed = { id: 'persisted-relink-gap', kind: 'knowledge_gap' as const, slug: 'persisted-relink-gap', title: 'How many HDMI inputs does AC-7 have?',
    metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [item.subject.id] } };
  const gap = await upsertObservedKnowledgeNode(item.store, observed, 'research-task', observed, () => observed);
  const raw = item.store.getRecordSnapshot('node', fact.id).raw;
  if (!raw || typeof raw.metadata !== 'string') throw new Error('Missing original persisted fact fixture');
  const path = item.store.storagePath; await item.store.close();
  const sqlite = new SQLiteStore(path, { coordinated: true });
  try {
    await sqlite.init(createSchema, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION });
    sqlite.run('UPDATE knowledge_nodes SET metadata = ? WHERE id = ?', [JSON.stringify({ ...JSON.parse(raw.metadata),
      unrecognizedHistoricalTail: protectedTail ? 'Authorization: Bearer synthetic-hidden-material' : 'Safe historical metadata outside the selected scoring fields.' }), fact.id]);
    await sqlite.save();
  } finally { sqlite.close(); }
  const store = new KnowledgeStore({ dbPath: path }); await store.init();
  const currentFact = store.getNode(fact.id), currentGap = store.getNode(gap.id), subject = store.getNode(item.subject.id);
  if (!currentFact || !currentGap || !subject) throw new Error('Historical native fact did not reopen');
  expect<unknown>(currentFact).toBe(store.getNode(fact.id));
  expect(currentFact.metadata.unrecognizedHistoricalTail).toBe(protectedTail ? 'Authorization: Bearer synthetic-hidden-material' : 'Safe historical metadata outside the selected scoring fields.');
  return { store, fact: currentFact, gap: currentGap, subject, sourceId: item.source.id };
}

describe('exact repair scoring and completion judgments', () => {
  test('a protected hidden tail on the actual persisted fact holds before every support/scoring request or write', async () => {
    const item = await persistedRelinkFixture(true);
    try {
      const fake = publicationReadings(), before = graph(item.store);
      await expect(writeSupportedRepairSubjectLinks({ store: item.store, spaceId, gap: item.gap, subjects: [item.subject],
        sourceIds: [item.sourceId], candidate: fact => fact === item.fact })).rejects.toBeInstanceOf(JudgmentInputError);
      expect(fake.requests).toHaveLength(0); expect(graph(item.store)).toBe(before);
      expect(item.store.getNode(item.fact.id)).toBe(item.fact);
    } finally { await item.store.close(); }
  });
  test('an ordinary current persisted fact with safe unrecognized metadata still settles and writes its genuine attachment score', async () => {
    const item = await persistedRelinkFixture(false);
    try {
      const fake = publicationReadings(name => name === 'factTrust' ? 2 : name === 'subjectSupport' ? 2 : 3);
      await writeSupportedRepairSubjectLinks({ store: item.store, spaceId, gap: item.gap, subjects: [item.subject],
        sourceIds: [item.sourceId], candidate: fact => fact === item.fact });
      expect(item.store.listEdges().find(edge => edge.fromId === item.fact.id && edge.toId === item.subject.id && edge.relation === 'describes')?.weight).toBe(0.5);
      expect(fake.requests.filter(request => 'subjectSupport' in request.questions)).toHaveLength(1);
      expect(item.store.getNode(item.fact.id)?.metadata.unrecognizedHistoricalTail).toBe('Safe historical metadata outside the selected scoring fields.');
    } finally { await item.store.close(); }
  });
  test('stored scores and edge weights come from the complete fact readings, independently of the publisher label', async () => {
    const item = await fixture(), fake = publicationReadings(), before = graph(item.store);
    const prepared = await prepareSourceLinkedRepairProfileFacts([item.input]);
    expect(graph(item.store)).toBe(before);
    const calls = fake.requests.length, [fact] = await prepared.write();
    expect(fact?.confidence).toBe(50);
    expect(item.store.listEdges().find(edge => edge.relation === 'supports_fact')?.weight).toBe(0.75);
    expect(item.store.listEdges().find(edge => edge.relation === 'describes')?.weight).toBe(1);
    expect(fake.requests).toHaveLength(calls);
    expect(fake.requests.some(request => 'supported' in request.questions)).toBe(true);
    expect(fake.requests.some(request => 'attached' in request.questions)).toBe(true);
    expect(fake.requests.some(request => 'serve' in request.questions)).toBe(true);
    expect(JSON.stringify(fake.requests)).not.toContain('NEVER_TRANSMIT');
  });
  test('one prepared publication writes multiple exact claims without retiring its original source scoring owner', async () => {
    const item = await fixture(); publicationReadings();
    const second = { ...item.input, title: 'USB ports', summary: 'AC-7 has two USB ports.', evidence: 'AC-7 has two USB ports.',
      classification: { ...item.input.classification, title: 'USB ports', summary: 'AC-7 has two USB ports.', value: 'two USB ports' } };
    const prepared = await prepareSourceLinkedRepairProfileFacts([item.input, second]);
    const written = await prepared.write();
    expect(written.map(fact => fact.title)).toEqual(['HDMI inputs', 'USB ports']);
    expect(written.every(fact => fact.confidence === 50)).toBe(true);
  });
  test('fact trust follows the resolved primary reference while the new support edge keeps its own exact source score', async () => {
    const item = await fixture(); publicationReadings(); await (await prepareSourceLinkedRepairProfileFacts([item.input])).write();
    const source = await item.store.upsertSource({ ...item.source, id: 'new-manufacturer-reference', title: 'New manufacturer reference' });
    const extraction = await item.store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: text, metadata: { knowledgeSpaceId: spaceId } });
    const fake = fakePort((name, question, state) => {
      if (name === 'useful') {
        if (!state || typeof state !== 'object' || !('candidate' in state) || !state.candidate || typeof state.candidate !== 'object'
          || !('title' in state.candidate)) throw new Error('Missing original primary reference');
        return noulAnswer(state.candidate.title === item.source.title ? 0.99 : 0.9);
      }
      if (name === 'authority') return choiceAnswer(question, 'secondary', 0.99);
      if (name === 'factTrust') {
        if (!state || typeof state !== 'object' || !('trustEvidence' in state) || !state.trustEvidence || typeof state.trustEvidence !== 'object'
          || !('source' in state.trustEvidence) || !state.trustEvidence.source || typeof state.trustEvidence.source !== 'object'
          || !('title' in state.trustEvidence.source) || state.trustEvidence.source.title !== item.source.title) throw new Error('Trust borrowed the incoming publisher label');
        return score(question, 4);
      }
      if (name === 'sourceSupport' || name === 'subjectSupport') return score(question, 3);
      if (name === 'supported' || name === 'attached' || name === 'serve') return noulAnswer(0.99);
      throw new Error(`Unscripted primary-bound grading question ${name}`);
    });
    installJudgmentPort(fake.port);
    const [fact] = await (await prepareSourceLinkedRepairProfileFacts([{ ...item.input, source, extraction }])).write();
    expect(fact?.sourceId).toBe(item.source.id); expect(fact?.confidence).toBe(100);
    expect(item.store.listEdges().find(edge => edge.fromId === source.id && edge.relation === 'supports_fact')?.weight).toBe(0.75);
    expect(JSON.stringify(fact?.metadata.factScoring)).toContain(item.source.id);
  });
  test('actual promotion and final relinking persist the new exact subject grade instead of a fixed attachment weight', async () => {
    const item = await fixture(), query = 'How many HDMI inputs does AC-7 have?';
    const observed = { id: 'promoted-scoring-gap', kind: 'knowledge_gap' as const, slug: 'promoted-scoring-gap', title: query,
      metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [item.subject.id] } };
    const gap = await upsertObservedKnowledgeNode(item.store, observed, 'research-task', observed, () => observed);
    const task = await item.store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
    const fake = fakePort((name, question, state) => {
      if (name === 'factTrust' || name === 'sourceSupport' || name === 'subjectSupport') {
        if (!state || typeof state !== 'object' || !('query' in state) || !('fact' in state) || !state.fact || typeof state.fact !== 'object'
          || !('title' in state.fact) || state.fact.title !== 'Input and output ports') throw new Error('Missing complete promoted claim');
        return score(question, name === 'factTrust' ? 2 : name === 'subjectSupport' && state.query === query ? 2 : 3);
      }
      if (name === 'authority') return choiceAnswer(question, 'official-vendor', 0.99);
      const profile = repairProfileFixtureReading(name, state, [['Input and output ports', 'AC-7 has four HDMI inputs.']]);
      if (profile !== undefined) return noulAnswer(profile);
      if (name === 'repairSubjectSelected' || name === 'repairUseful' || name === 'supported' || name === 'attached'
        || name === 'serve' || name === 'repairEvidenceSufficient') return noulAnswer(0.99);
      if (name === 'fullProfileRequired') return noulAnswer(0.01);
      throw new Error(`Unscripted full promotion scoring question ${name}`);
    });
    installJudgmentPort(fake.port);
    const result = await promoteRepairSources({ store: item.store }, spaceId, gap, [item.source.id], task, Date.now() + 30_000);
    expect(result.repairComplete).toBe(true); expect(result.promotedFactCount).toBe(1);
    const facts = item.store.listNodes().filter(node => node.kind === 'fact');
    expect(facts).toHaveLength(1); expect(facts[0]?.confidence).toBe(50);
    expect(item.store.listEdges().find(edge => edge.fromId === facts[0]?.id && edge.toId === item.subject.id && edge.relation === 'describes')?.weight).toBe(0.5);
    expect(item.store.listEdges().find(edge => edge.fromId === item.source.id && edge.relation === 'supports_fact')?.weight).toBe(0.75);
    expect(fake.requests.filter(request => 'subjectSupport' in request.questions)).toHaveLength(2);
    expect(item.store.getRefinementTask(task.id)?.state).toBe('verified');
  });
  test('an uncertain final relink grade cannot replace an earlier independently published edge or verify the repair', async () => {
    const item = await fixture(), query = 'How many HDMI inputs does AC-7 have?';
    const observed = { id: 'held-scoring-gap', kind: 'knowledge_gap' as const, slug: 'held-scoring-gap', title: query,
      metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [item.subject.id] } };
    const gap = await upsertObservedKnowledgeNode(item.store, observed, 'research-task', observed, () => observed);
    const task = await item.store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
    let atHold = '';
    const fake = fakePort((name, question, state) => {
      if (name === 'factTrust' || name === 'sourceSupport' || name === 'subjectSupport') {
        if (!state || typeof state !== 'object' || !('query' in state)) throw new Error('Missing relink scoring query');
        const relinking = state.query === query;
        if (relinking) atHold ||= graph(item.store);
        return score(question, name === 'factTrust' ? 2 : 3, relinking && name === 'subjectSupport' ? 0.5 : 0.99);
      }
      if (name === 'authority') return choiceAnswer(question, 'official-vendor', 0.99);
      const profile = repairProfileFixtureReading(name, state, [['Input and output ports', 'AC-7 has four HDMI inputs.']]);
      if (profile !== undefined) return noulAnswer(profile);
      if (name === 'repairSubjectSelected' || name === 'repairUseful' || name === 'supported' || name === 'attached' || name === 'serve') return noulAnswer(0.99);
      throw new Error(`Unscripted held final scoring question ${name}`);
    });
    installJudgmentPort(fake.port);
    await expect(promoteRepairSources({ store: item.store }, spaceId, gap, [item.source.id], task, Date.now() + 30_000)).rejects.toMatchObject({ reason: 'uncertain' });
    expect(atHold).not.toBe(''); expect(graph(item.store)).toBe(atHold);
    expect(item.store.listNodes().filter(node => node.kind === 'fact')).toHaveLength(1);
    expect(item.store.listEdges().find(edge => edge.relation === 'describes')?.weight).toBe(0.75);
    expect(item.store.getRefinementTask(task.id)?.state).toBe('applying');
  });
  test('metadata adapters cannot overwrite the settled scoring evidence', async () => {
    const item = await fixture(); publicationReadings(); const before = graph(item.store);
    await expect(prepareSourceLinkedRepairProfileFacts([{ ...item.input, metadataBuilder: metadata => ({ ...metadata, knowledgeSpaceId: spaceId,
      factScoring: { trust: 1, sourceSupport: 1, subjectSupport: 1 } }) }])).rejects.toThrow();
    expect(graph(item.store)).toBe(before);
  });
  test('a later uncertain scoring answer prevents every earlier fact publication', async () => {
    const item = await fixture();
    const fake = fakePort((name, question, state) => {
      if (question.type === 'score') return score(question, 4, state && typeof state === 'object' && 'reference' in state && state.reference === 'fact-2' ? 0.5 : 0.99);
      if (name === 'supported' || name === 'attached' || name === 'serve') return noulAnswer(0.99);
      throw new Error(`Unscripted held scoring question ${name}`);
    });
    installJudgmentPort(fake.port); const before = graph(item.store);
    await expect(prepareSourceLinkedRepairProfileFacts([item.input, { ...item.input, title: 'Later HDMI claim' }])).rejects.toBeInstanceOf(KnowledgeRepairFactScoringHeldError);
    expect(graph(item.store)).toBe(before);
  });
  test('a changed original claim after scoring cannot borrow the prepared publication', async () => {
    const item = await fixture(); publicationReadings();
    const input = { ...item.input }, prepared = await prepareSourceLinkedRepairProfileFacts([input]);
    input.title = 'Changed request'; const before = graph(item.store);
    await expect(prepared.write()).rejects.toThrow(); expect(graph(item.store)).toBe(before);
  });
  test('protected material in the last scoring input holds before acquiring the provider', async () => {
    const fake = fakePort((_name, question) => score(question, 4)); installJudgmentPort(fake.port);
    const last = scoringInput('fact-2');
    await expect(prepareRepairFactScoring([scoringInput(), { ...last, fact: { ...last.fact, summary: 'Authorization: Bearer synthetic-protected-value' } }])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test.each(['wrong type', 'missing probability', 'nonfinite', 'invalid sum'] as const)('malformed score %s holds the entire reading', async mode => {
    const fake = fakePort((_name, question) => {
      const answer = score(question, 4);
      if (mode === 'wrong type') return noulAnswer(0.99);
      if (mode === 'missing probability') return { ...answer, probabilities: { '4': 1 } };
      if (mode === 'nonfinite') return { ...answer, score: Number.NaN };
      return { ...answer, probabilities: { '0': 1, '1': 1, '2': 1, '3': 1, '4': 1 } };
    });
    installJudgmentPort(fake.port);
    await expect(prepareRepairFactScoring([scoringInput()])).rejects.toMatchObject({ reason: 'malformed' });
  });
  test('a retired scoring port cannot authorize a retained reading', async () => {
    const fake = fakePort((_name, question) => score(question, 4)); installJudgmentPort(fake.port);
    const prepared = await prepareRepairFactScoring([scoringInput()]);
    installJudgmentPort(fakePort((_name, question) => score(question, 4)).port);
    expect(() => prepared.assertCurrent()).toThrow(KnowledgeRepairFactScoringHeldError);
  });
  test('an asynchronous owner callback holds before any scoring request', async () => {
    const fake = fakePort((_name, question) => score(question, 4)); installJudgmentPort(fake.port);
    await expect(prepareRepairFactScoring([scoringInput()], { assertCurrent: async () => {} })).rejects.toMatchObject({ reason: 'stale' });
    expect(fake.requests).toHaveLength(0);
  });
  test('cancellation retires an ignored-signal late grading result without publishing any fact', async () => {
    const item = await fixture(), fake = publicationReadings(), controller = new AbortController();
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    installJudgmentPort({ ...fake.port, async ask(request) {
      if ('factTrust' in request.questions) { entered.resolve(); await released.promise; }
      return fake.port.ask(request);
    } });
    const before = graph(item.store), pending = prepareSourceLinkedRepairProfileFacts([item.input], { signal: controller.signal });
    const outcome = pending.catch((error: unknown) => error);
    try {
      await entered.promise; controller.abort();
      expect(await outcome).toBeInstanceOf(Error);
      expect(graph(item.store)).toBe(before);
    } finally { released.resolve(); await outcome; }
    expect(graph(item.store)).toBe(before);
  });
  test('scope reading distinguishes complete narrow wording from a broad request without trigger vocabulary', async () => {
    const narrow = 'What is the complete count of HDMI inputs on AC-7?', broad = 'Tell me everything AC-7 can do and how it is equipped.';
    const fake = fakePort((name, _question, state) => {
      if (name !== 'fullProfileRequired' || !state || typeof state !== 'object' || !('query' in state)) throw new Error('Unscripted scope reading');
      if (state.query === narrow) return noulAnswer(0.01);
      if (state.query === broad) return noulAnswer(0.99);
      throw new Error('Unscripted scope query');
    });
    installJudgmentPort(fake.port);
    expect((await prepareRepairProfileRequirement({ query: narrow, subjects: [] })).fullProfileRequired).toBe(false);
    expect((await prepareRepairProfileRequirement({ query: broad, subjects: [] })).fullProfileRequired).toBe(true);
  });
  test('one useful fact completes a narrow full-count request only after the separate exact-gap reading', async () => {
    const item = await fixture(); publicationReadings(); await (await prepareSourceLinkedRepairProfileFacts([item.input])).write();
    const query = 'What is the complete count of HDMI inputs on AC-7?';
    const observed = { id: 'narrow-gap', kind: 'knowledge_gap' as const, slug: 'narrow-gap', title: query,
      metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [item.subject.id] } };
    const gap = await upsertObservedKnowledgeNode(item.store, observed, 'research-task', observed, () => observed);
    const task = await item.store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
    const fake = fakePort((name, _question, state) => {
      if (name === 'authority') return sourceAuthorityFixture(_question, state, query, text);
      if (name === 'factTrust' || name === 'sourceSupport' || name === 'subjectSupport') return score(_question, name === 'factTrust' ? 2 : 3);
      if (name === 'repairSubjectSelected' || name === 'repairUseful' || name === 'supported' || name === 'attached' || name === 'serve') return noulAnswer(0.99);
      if (name === 'wanted') return noulAnswer(0.01);
      if (name === 'fullProfileRequired') return noulAnswer(0.01);
      if (name === 'repairEvidenceSufficient') {
        if (!state || typeof state !== 'object' || !('requestedScope' in state) || !state.requestedScope || typeof state.requestedScope !== 'object'
          || !('fullProfileRequired' in state.requestedScope) || state.requestedScope.fullProfileRequired !== false) throw new Error('Missing narrow native scope');
        return noulAnswer(0.99);
      }
      throw new Error(`Unscripted complete narrow repair question ${name}`);
    });
    installJudgmentPort(fake.port);
    const result = await promoteRepairSources({ store: item.store }, spaceId, gap, [item.source.id], task, Date.now() + 30_000);
    expect(result.repairComplete).toBe(true); expect(result.promotedFactCount).toBe(1);
    expect(item.store.getRefinementTask(task.id)?.state).toBe('verified');
    expect(fake.requests.some(request => 'repairEvidenceSufficient' in request.questions)).toBe(true);
  });
  test('three useful rows do not complete a broad gap when the exact-gap reading identifies missing information', async () => {
    const item = await fixture(); publicationReadings();
    const usb = { ...item.input, title: 'USB ports', summary: 'AC-7 has two USB ports.', evidence: 'AC-7 has two USB ports.',
      classification: { ...item.input.classification, title: 'USB ports', summary: 'AC-7 has two USB ports.', value: 'two USB ports' } };
    const hdr = { ...item.input, title: 'Dolby Vision', summary: 'AC-7 supports Dolby Vision.', evidence: 'AC-7 supports Dolby Vision.',
      classification: { ...item.input.classification, title: 'Dolby Vision', summary: 'AC-7 supports Dolby Vision.', value: 'Dolby Vision' } };
    await (await prepareSourceLinkedRepairProfileFacts([item.input, usb, hdr])).write();
    const observed = { id: 'broad-gap', kind: 'knowledge_gap' as const, slug: 'broad-gap', title: 'What are the full features and specifications of AC-7?',
      metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [item.subject.id] } };
    const gap = await upsertObservedKnowledgeNode(item.store, observed, 'research-task', observed, () => observed);
    const task = await item.store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
    const fake = fakePort((name, question, state) => {
      if (name === 'authority') return sourceAuthorityFixture(question, state, 'What are the full features and specifications of AC-7?', text);
      if (name === 'factTrust' || name === 'sourceSupport' || name === 'subjectSupport') return score(question, name === 'factTrust' ? 2 : 3);
      if (name === 'repairSubjectSelected' || name === 'repairUseful' || name === 'supported' || name === 'attached' || name === 'serve' || name === 'fullProfileRequired') return noulAnswer(0.99);
      if (name === 'wanted' || name === 'repairEvidenceSufficient') return noulAnswer(0.01);
      throw new Error(`Unscripted incomplete broad repair question ${name}`);
    });
    installJudgmentPort(fake.port);
    const result = await promoteRepairSources({ store: item.store }, spaceId, gap, [item.source.id], task, Date.now() + 30_000);
    expect(result.promotedFactCount).toBe(3); expect(result.repairComplete).toBe(false);
    expect(item.store.getRefinementTask(task.id)?.state).toBe('applying');
  });
  test('source-supported alternate subject identity reaches the semantic reader despite unrelated model-shaped words', async () => {
    const item = await fixture(); publicationReadings();
    await item.store.upsertExtraction({ sourceId: item.source.id, extractorId: 'synthetic', format: 'text',
      excerpt: 'The device AC-7 is also named BETA999 in this technical reference. BETA999 has four HDMI inputs.', metadata: { knowledgeSpaceId: spaceId } });
    const fact = await item.store.upsertNode({ id: 'alternate-name-fact', kind: 'fact', slug: 'alternate-name-fact', title: 'BETA999 HDMI inputs',
      summary: 'BETA999 has four HDMI inputs.', status: 'active', sourceId: item.source.id,
      metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', factKind: 'specification', value: 'four HDMI inputs',
        evidence: 'BETA999 has four HDMI inputs.', subject: 'BETA999', sourceIds: [item.source.id] } });
    const observed = { id: 'alias-gap', kind: 'knowledge_gap' as const, slug: 'alias-gap', title: 'How many HDMI inputs does AC-7 have?',
      metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [item.subject.id] } };
    const gap = await upsertObservedKnowledgeNode(item.store, observed, 'research-task', observed, () => observed);
    const task = await item.store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
    const fake = fakePort((name, _question, state) => {
      if (name === 'authority') return sourceAuthorityFixture(_question, state, 'How many HDMI inputs does AC-7 have?',
        'The device AC-7 is also named BETA999 in this technical reference. BETA999 has four HDMI inputs.');
      if (name === 'repairUseful') {
        if (!state || typeof state !== 'object' || !('fact' in state) || !state.fact || typeof state.fact !== 'object'
          || !('title' in state.fact) || state.fact.title !== fact.title) throw new Error('Alternate subject claim was lost');
        return noulAnswer(0.99);
      }
      if (name === 'factTrust' || name === 'sourceSupport' || name === 'subjectSupport') return score(_question, name === 'factTrust' ? 2 : name === 'sourceSupport' ? 3 : 2);
      if (name === 'repairSubjectSelected' || name === 'supported' || name === 'attached' || name === 'serve' || name === 'repairEvidenceSufficient') return noulAnswer(0.99);
      if (name === 'wanted' || name === 'fullProfileRequired') return noulAnswer(0.01);
      throw new Error(`Unscripted alternate subject repair question ${name}`);
    });
    installJudgmentPort(fake.port);
    const result = await promoteRepairSources({ store: item.store }, spaceId, gap, [item.source.id], task, Date.now() + 30_000);
    expect(result.repairComplete).toBe(true); expect(result.promotedFactCount).toBe(1);
    expect(item.store.listEdges().find(edge => edge.fromId === fact.id && edge.toId === item.subject.id && edge.relation === 'describes')?.weight).toBe(0.5);
  });
});
