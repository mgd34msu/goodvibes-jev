import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createSystemOnePort, PINNED_MODEL, SqliteDecisionLog, withDecisionLog,
  type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { HomeGraphService } from '../sdk/src/platform/knowledge/home-graph/service.js';
import { answerHomeGraphQuery } from '../sdk/src/platform/knowledge/home-graph/ask.js';
import { readHomeGraphSearchState } from '../sdk/src/platform/knowledge/home-graph/search.js';
import { KnowledgeSemanticService } from '../sdk/src/platform/knowledge/semantic/service.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../sdk/src/platform/knowledge/types.js';
import type { KnowledgeSemanticAnswerInput } from '../sdk/src/platform/knowledge/semantic/types.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';

const spaceId = 'homeassistant:judgment-fixture';
const query = 'Can the tiny sun beside my pillow fade gently?';
const body = 'The bedside luminaire offers continuous dimming down to one percent.';
const roots: string[] = [], services: HomeGraphService[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => {
  installJudgmentPort(previous);
  for (const service of services.splice(0)) service.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(semantic = false) {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-answer-judgments-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init();
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const semanticService = semantic ? new KnowledgeSemanticService(store, { llm: {
    async completeJson() { throw new Error('No enrichment generation in this fixture'); },
    async completeText() { return body; },
  }, isBackgroundPaused: () => true }) : undefined;
  const service = new HomeGraphService(store, artifactStore, semanticService ? { semanticService } : {}); services.push(service);
  return { store, service, semanticService };
}
async function source(store: KnowledgeStore, id = 'local-booklet', title = 'Bedside booklet', text = body,
  extra: Partial<KnowledgeSourceRecord> = {}) {
  const record = await store.upsertSource({ id, connectorId: 'fixture', sourceType: 'document', title, status: 'indexed',
    ...extra, metadata: { knowledgeSpaceId: spaceId, ...extra.metadata } });
  await store.upsertExtraction({ id: `${id}-extraction`, sourceId: id, extractorId: 'fixture', format: 'text', excerpt: text,
    metadata: { knowledgeSpaceId: String(record.metadata.knowledgeSpaceId) } });
  return record;
}
async function object(store: KnowledgeStore, id = 'local-lamp', title = 'Bedside luminaire', extra: Partial<KnowledgeNodeRecord> = {}) {
  return seedHomeAssistantObservation(store, { id, slug: id, title, kind: 'ha_entity', status: 'active', ...extra,
    metadata: { knowledgeSpaceId: spaceId, ...extra.metadata } });
}
function readings(options: { evidence?: Readonly<Record<string, number>>; objects?: Readonly<Record<string, number>>;
  integrations?: readonly string[]; intent?: number; excerpt?: number; fidelity?: number; complete?: number; match?: number } = {}) {
  const fake = fakePort((name, question, state) => {
    const candidate = (state as { candidate?: { title?: string; text?: string; reference?: string } }).candidate;
    const title = candidate?.title ?? '';
    if (name === 'integrationIntent') return noulAnswer(options.intent ?? 0.01);
    if (name === 'concreteObject') return noulAnswer(0.99);
    if (name === 'integrationObject') return noulAnswer(options.integrations?.includes(title) ? 0.99 : 0.01);
    if (name === 'aligned') return noulAnswer(options.objects?.[title] ?? (title === 'Bedside luminaire' ? 0.99 : 0.01));
    if (name === 'useful') return noulAnswer(options.evidence?.[title] ?? (title === 'Bedside booklet' ? 0.99 : 0.01));
    if (name === 'excerptUseful') return noulAnswer(options.excerpt ?? (candidate?.text === body ? 0.99 : 0.01));
    if (name === 'features') return noulAnswer(0.01);
    if (name === 'readable') return noulAnswer(0.99);
    if (name === 'match') return noulAnswer(options.match ?? 0.99);
    if (name === 'fidelity') return choiceAnswer(question, 'supported', options.fidelity ?? 0.96);
    if (name === 'preferred') return choiceAnswer(question, 'generated', 0.99);
    if (name === 'enough') return noulAnswer(0.99);
    if (name === 'complete') return noulAnswer(options.complete ?? 0.99);
    throw new Error(`Unscripted Home Graph reading: ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
function ask(f: Awaited<ReturnType<typeof fixture>>, input: Partial<KnowledgeSemanticAnswerInput> = {}) {
  return answerHomeGraphQuery({ store: f.store, semanticService: f.semanticService, spaceId,
    query: { query, ...input }, state: readHomeGraphSearchState(f.store, spaceId),
    results: readHomeGraphSearchState(f.store, spaceId).sources.map((source, index) => ({
      kind: 'source' as const, id: source.id, title: source.title ?? '', source,
      score: 1_000 - index, excerpt: f.store.getExtractionBySourceId(source.id)?.excerpt,
    })),
  });
}
function records(store: KnowledgeStore) {
  return JSON.stringify({ nodes: store.listNodes(), edges: store.listEdges(), issues: store.listIssues(), sources: store.listSources() });
}

describe('Home Graph shared answer judgments (authored synthetic evidence)', () => {
  test.each([false, true])('scoped caller defeats former object/type weights with configured service=%s', async semantic => {
    const f = await fixture(semantic); await object(f.store); await source(f.store);
    await object(f.store, 'wrong-television', 'TV television webOS BRAVIA', { kind: 'ha_device' });
    const wrong = await source(f.store, 'wrong-manual', query, 'Unrelated television service instructions.', { sourceType: 'manual' });
    await f.store.upsertEdge({ fromKind: 'source', fromId: wrong.id, toKind: 'node', toId: 'wrong-television', relation: 'has_manual', metadata: { knowledgeSpaceId: spaceId } });
    const fake = readings();
    const result = await ask(f, { limit: 1 });
    expect(result.results.map(row => row.id)).toEqual(['local-booklet']);
    expect(result.results[0]).toMatchObject({ title: 'Bedside booklet' });
    expect(result.results[0]!.score).toBe(semantic ? 0.99 : 999);
    expect(result.answer.linkedObjects.map(row => row.id)).toEqual(['local-lamp']);
    expect(result.answer.text).toContain(body);
    expect(result.answer.confidence).toBe(semantic ? 96 : 0);
    const initial = fake.requests.filter(request => request.context?.site === 'engine.knowledge.answer-evidence-relevance');
    expect(initial).toHaveLength(semantic ? 3 : 2);
    expect(JSON.stringify(initial)).toContain(query);
    expect(JSON.stringify(fake.requests)).toContain('TV television webOS BRAVIA');
    expect(JSON.stringify(initial)).toContain('Bedside booklet');
  });

  test('integration meaning without old keywords and probability-ordered plural objects survive', async () => {
    const f = await fixture(); await source(f.store); await object(f.store);
    await object(f.store, 'bridge', 'Sound bridge', { kind: 'ha_integration' });
    readings({ objects: { 'Sound bridge': 0.995, 'Bedside luminaire': 0.98 }, integrations: ['Sound bridge'], intent: 0.99 });
    const result = await ask(f, { query: 'How can both of these talk to my home controller?' });
    expect(result.answer.linkedObjects.map(row => row.id)).toEqual(['bridge', 'local-lamp']);
  });

  test('settled no stays empty and repeated answers preserve results without gap or review writes', async () => {
    const f = await fixture(); await object(f.store); await source(f.store); const baseline = records(f.store);
    const fake = readings({ evidence: { 'Bedside booklet': 0.01 }, objects: { 'Bedside luminaire': 0.01 } });
    const first = await ask(f), second = await ask(f);
    expect(first).toEqual(second);
    expect(first.results).toEqual([]); expect(first.answer.sources).toEqual([]); expect(first.answer.linkedObjects).toEqual([]);
    expect(first.answer.confidence).toBe(0); expect(first.answer.gaps ?? []).toEqual([]);
    expect(records(f.store)).toBe(baseline);
    expect(fake.requests.some(request => request.context?.site?.includes('answer-gap'))).toBe(false);
  });

  test('literal renderer ignores unrelated protected gap records', async () => {
    const f = await fixture(); await source(f.store);
    await f.store.upsertNode({ id: 'old-gap', kind: 'knowledge_gap', slug: 'old-gap', title: 'Unrelated old gap', status: 'draft',
      metadata: { knowledgeSpaceId: spaceId, semanticKind: 'gap', query: 'Use card 4111111111111111.' } });
    const baseline = records(f.store); const fake = readings();
    const result = await ask(f);
    expect(result.answer.text).toContain(body); expect(result.answer.gaps ?? []).toEqual([]);
    expect(records(f.store)).toBe(baseline);
    expect(fake.requests.some(request => request.context?.site?.includes('answer-gap'))).toBe(false);
  });

  test.each(['uncertain', 'unconfigured', 'unavailable', 'malformed'] as const)('%s holds without old result/confidence fallback', async kind => {
    const f = await fixture(); await object(f.store); await source(f.store); const baseline = records(f.store);
    const fake = readings({ objects: { 'Bedside luminaire': kind === 'uncertain' ? 0.5 : 0.99 } });
    if (kind === 'unconfigured') installJudgmentPort(undefined);
    if (kind === 'unavailable' || kind === 'malformed') installJudgmentPort({ ...fake.port, async ask(request) {
      if ('aligned' in request.questions) {
        if (kind === 'unavailable') throw new Error('Owned synthetic outage');
        const result = await fake.port.ask(request);
        return { ...result, answers: { ...result.answers, aligned: { type: 'noul', noul: 1.5 } } };
      }
      return fake.port.ask(request);
    } });
    await expect(ask(f)).rejects.toMatchObject({
      reason: kind === 'unconfigured' ? 'unavailable' : kind,
    });
    expect(records(f.store)).toBe(baseline);
  });

  test('protected later in-space object is rejected before any port, foreign object is excluded', async () => {
    const f = await fixture(); await source(f.store);
    const bad = await object(f.store, 'private-object', 'Private fixture', { aliases: ['Card 4111111111111111'] });
    const fake = readings();
    await expect(ask(f)).rejects.toMatchObject({ problem: 'card-material' }); expect(fake.requests).toHaveLength(0);
    await f.store.deleteNode(bad.id);
    await object(f.store, 'foreign-object', 'Private foreign fixture', { aliases: ['Card 4111111111111111'], metadata: { knowledgeSpaceId: 'homeassistant:other' } });
    const result = await ask(f);
    expect(result.results.map(row => row.id)).toEqual(['local-booklet']);
    expect(JSON.stringify(fake.requests)).not.toContain('Private foreign fixture');
  });

  test('source mutation during alignment holds before answer delivery and page writes', async () => {
    const f = await fixture(); await object(f.store); const doc = await source(f.store);
    const baseline = JSON.stringify({ nodes: f.store.listNodes(), edges: f.store.listEdges(), issues: f.store.listIssues() });
    const fake = readings(); installJudgmentPort({ ...fake.port, async ask(request) {
      if ('aligned' in request.questions) await f.store.upsertSource({ ...doc, summary: 'Changed while reading.' });
      return fake.port.ask(request);
    } });
    await expect(f.service.ask({ knowledgeSpaceId: spaceId, query })).rejects.toMatchObject({ reason: 'stale' });
    expect(JSON.stringify({ nodes: f.store.listNodes(), edges: f.store.listEdges(), issues: f.store.listIssues() })).toBe(baseline);
  });

  test('ignored-signal deadline aborts shared reads and cannot return late fallback or writes', async () => {
    const f = await fixture(); await object(f.store); await source(f.store); const baseline = records(f.store);
    const fake = readings(); let release: (() => void) | undefined; let signal: AbortSignal | undefined;
    const entered = Promise.withResolvers<void>();
    installJudgmentPort({ ...fake.port, async ask(request) {
      if ('aligned' in request.questions) {
        signal = request.signal; entered.resolve(); await new Promise<void>(resolve => { release = resolve; });
      }
      return fake.port.ask(request);
    } });
    const pending = f.service.ask({ knowledgeSpaceId: spaceId, query, timeoutMs: 100 });
    const held = expect(pending).rejects.toMatchObject({ reason: 'budget' });
    await entered.promise; await held; expect(signal?.aborted).toBe(true);
    release?.(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(records(f.store)).toBe(baseline);
  });

  test('only selected configured-service results reach enrichment when source display is hidden', async () => {
    const f = await fixture(true); await source(f.store); await source(f.store, 'rejected', 'Unrelated booklet', 'Unrelated material.');
    readings(); const semantic = f.semanticService!;
    const pause = spyOn(semantic, 'isBackgroundWorkPaused').mockReturnValue(false);
    const enriched = Promise.withResolvers<readonly KnowledgeSourceRecord[]>();
    const enrich = spyOn(semantic, 'enrichSources').mockImplementation(async sources => { enriched.resolve(sources); return []; });
    try {
      const result = await ask(f, { includeSources: false });
      expect(result.answer.sources).toEqual([]);
      expect(result.results.map(row => row.id)).toEqual(['local-booklet']);
      const selected = await enriched.promise;
      expect(selected.map(row => row.id)).toEqual(['local-booklet']);
    } finally { pause.mockRestore(); enrich.mockRestore(); }
  });

  test('settled empty object context can still return evidence for a generic question', async () => {
    const f = await fixture(); await source(f.store); const fake = readings();
    const result = await ask(f, { query: 'Describe continuous dimming.' });
    expect(result.answer.linkedObjects).toEqual([]);
    expect(result.answer.text).toContain(body);
    const evidence = fake.requests.find(request => request.context?.site === 'engine.knowledge.answer-evidence-relevance');
    expect(evidence?.state).toMatchObject({ query: 'Describe continuous dimming.', subjects: [] });
  });

  test('full original extraction is protected before a safe-looking clipped result can leave', async () => {
    const f = await fixture(); const doc = await source(f.store); await object(f.store);
    await f.store.upsertExtraction({ sourceId: doc.id, extractorId: 'fixture', format: 'text', excerpt: body,
      sections: [`${'Ordinary text. '.repeat(3_000)} Card 4111111111111111.`], metadata: { knowledgeSpaceId: spaceId } });
    const fake = readings();
    await expect(ask(f)).rejects.toMatchObject({ problem: 'card-material' });
    expect(fake.requests).toHaveLength(0);
  });

  test('port replacement during later evidence reading holds the whole scope', async () => {
    const f = await fixture(); await source(f.store); await object(f.store); const baseline = records(f.store);
    const fake = readings(); let restored: JudgmentPort | undefined;
    installJudgmentPort({ ...fake.port, async ask(request) {
      if (request.context?.site === 'engine.knowledge.answer-evidence-relevance') {
        restored = installJudgmentPort(fake.port);
      }
      return fake.port.ask(request);
    } });
    try { await expect(ask(f)).rejects.toMatchObject({ reason: 'stale' }); expect(records(f.store)).toBe(baseline); }
    finally { installJudgmentPort(restored); }
  });

  test('completion order cannot replace retained retrieval ordering or score units', async () => {
    const f = await fixture(); await source(f.store, 'first', 'First booklet'); await source(f.store, 'second', 'Second booklet');
    const fake = readings({ evidence: { 'First booklet': 0.99, 'Second booklet': 0.9 } });
    installJudgmentPort({ ...fake.port, async ask(request) {
      if ((request.state as { candidate?: { title?: string } }).candidate?.title === 'Second booklet') await new Promise(resolve => setTimeout(resolve, 8));
      return fake.port.ask(request);
    } });
    const result = await ask(f);
    expect(result.results.map(row => [row.id, row.score])).toEqual([['second', 1_000], ['first', 999]]);
    expect(result.answer.confidence).toBe(0);
  });

  test('foreign extraction is rejected before full service search or scope can transmit it', async () => {
    const f = await fixture(); const doc = await source(f.store);
    await f.store.upsertExtraction({ sourceId: doc.id, extractorId: 'fixture', format: 'text', excerpt: 'Foreign private evidence.',
      metadata: { knowledgeSpaceId: 'homeassistant:foreign' } });
    const fake = readings();
    await expect(f.service.ask({ knowledgeSpaceId: spaceId, query })).rejects.toMatchObject({ reason: 'malformed' });
    expect(fake.requests).toHaveLength(0);
  });

  test('captured extraction replacement cannot lend fresh provenance to an old search excerpt', async () => {
    const f = await fixture(); const doc = await source(f.store);
    const state = readHomeGraphSearchState(f.store, spaceId);
    const results = [{ kind: 'source' as const, id: doc.id, source: doc, title: doc.title!, score: 200, excerpt: body }];
    await f.store.upsertExtraction({ sourceId: doc.id, extractorId: 'fixture', format: 'text', excerpt: 'New evidence replaces the old claim.', metadata: { knowledgeSpaceId: spaceId } });
    const fake = readings();
    await expect(answerHomeGraphQuery({ store: f.store, spaceId, query: { query }, state, results })).rejects.toMatchObject({ reason: 'stale' });
    expect(fake.requests).toHaveLength(0);
  });

  test.each(['foreign-source', 'foreign-node', 'wrong-id'] as const)('%s cannot become an authorized caller result', async kind => {
    const f = await fixture(); const doc = await source(f.store, 'foreign', 'Foreign private source', body,
      { metadata: { knowledgeSpaceId: 'homeassistant:foreign' } });
    const node = await object(f.store, 'foreign-node', 'Foreign private object', { metadata: { knowledgeSpaceId: 'homeassistant:foreign' } });
    const fake = readings();
    const results = kind === 'foreign-node' ? [{ kind: 'node' as const, id: node.id, node, title: node.title, score: 100 }]
      : [{ kind: 'source' as const, id: kind === 'wrong-id' ? 'another-source' : doc.id, source: doc, title: doc.title!, score: 100 }];
    await expect(answerHomeGraphQuery({ store: f.store, spaceId, query: { query }, state: readHomeGraphSearchState(f.store, spaceId), results }))
      .rejects.toMatchObject({ reason: 'malformed' });
    expect(fake.requests).toHaveLength(0);
  });

  test.each(['draft-node', 'stale-node', 'stale-source', 'generated-source'] as const)('%s outside the captured serving window cannot be injected as a current result', async kind => {
    const f = await fixture();
    const results = kind === 'draft-node' || kind === 'stale-node' ? [{ kind: 'node' as const, id: 'excluded', score: 100, title: 'Excluded claim',
      node: await f.store.upsertNode({ id: 'excluded', slug: 'excluded', kind: 'fact', title: 'Excluded claim', status: kind === 'draft-node' ? 'draft' : 'stale',
        metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact' } }) }]
      : [{ kind: 'source' as const, id: 'excluded', score: 100, title: 'Excluded source', source: await source(f.store, 'excluded', 'Excluded source', body,
        kind === 'stale-source' ? { status: 'stale' } : { metadata: { knowledgeSpaceId: spaceId, generatedProjection: true } }) }];
    const fake = readings();
    await expect(answerHomeGraphQuery({ store: f.store, spaceId, query: { query }, state: readHomeGraphSearchState(f.store, spaceId), results }))
      .rejects.toMatchObject({ reason: 'malformed' });
    expect(fake.requests).toHaveLength(0);
  });

  test('selected same-title/model variant remains distinct in evidence context', async () => {
    const f = await fixture(); await source(f.store);
    await object(f.store, 'european', 'Regional luminaire', { metadata: { knowledgeSpaceId: spaceId,
      model: 'B7', modelNumber: 'B7-EU', brand: 'Fixture', vendor: 'Fixture Europe', variant: { region: 'Europe', voltage: '230 V' } } });
    await object(f.store, 'american', 'Regional luminaire', { metadata: { knowledgeSpaceId: spaceId,
      model: 'B7', modelNumber: 'B7-US', variant: { region: 'North America', voltage: '120 V' } } });
    const fake = readings();
    installJudgmentPort({ ...fake.port, async ask(request) {
      const result = await fake.port.ask(request);
      if ('aligned' in request.questions) {
        const candidate = (request.state as { candidate: { content: { modelNumber?: string } } }).candidate;
        return { ...result, answers: { ...result.answers, aligned: noulAnswer(candidate.content.modelNumber === 'B7-EU' ? 0.99 : 0.01) } };
      }
      return result;
    } });
    const result = await ask(f);
    expect(result.answer.linkedObjects.map(row => row.id)).toEqual(['european']);
    const evidence = fake.requests.find(request => request.context?.site === 'engine.knowledge.answer-evidence-relevance');
    expect(evidence?.state).toMatchObject({ subjects: [{ title: 'Regional luminaire', identity: {
      model: 'B7', modelNumber: 'B7-EU', brand: 'Fixture', vendor: 'Fixture Europe', variant: { region: 'Europe', voltage: '230 V' },
    } }] });
    expect(JSON.stringify(evidence?.state)).not.toContain('B7-US');
  });

  test('owned synthetic transport retains shared retries and recorded decisions', async () => {
    const f = await fixture(); await source(f.store); await object(f.store); const fake = readings();
    using log = new SqliteDecisionLog(':memory:'); let attempts = 0;
    const transport = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture-key' }, model: PINNED_MODEL, timeoutMs: 1_000,
      retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, fetch: async (_url, init) => {
        if (++attempts <= 3) return new Response('', { status: 503 });
        // Owned in-process endpoint source; no genuine provider or credential.
        const request = JSON.parse(String(init?.body)) as JudgmentRequest<Questions>;
        const result = await fake.port.ask(request);
        return Response.json({ model: PINNED_MODEL, answers: result.answers, usage: { input_tokens: 1, output_tokens: 1 } });
      } });
    installJudgmentPort(withDecisionLog(transport, log));
    const result = await ask(f);
    expect(result.answer.text).toContain(body);
    const entries = log.query(); expect(entries).toHaveLength(3);
    expect(entries.every(entry => entry.status === 'answered')).toBe(true);
    expect(entries.some(entry => (entry.lineage?.attempts.length ?? 0) > 1)).toBe(true);
    expect(entries.some(entry => entry.status === 'answered' && entry.notes.some(note => note.kind === 'action'))).toBe(true);
    expect(attempts).toBe(entries.length + 3);
  });
});
