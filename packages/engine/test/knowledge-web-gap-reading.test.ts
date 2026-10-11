import { KnowledgeExtractionJudgmentHoldError } from '../sdk/src/platform/knowledge/extraction-policy.js';
import { KnowledgeEntityAliasHoldError, readKnowledgeEntityAliases } from '../sdk/src/platform/knowledge/entity-aliases.js';
import { createKnowledgeExtractionOwner } from '../sdk/src/platform/knowledge/extraction-ownership.js';
import { createCompressedPdfBuffer } from './_helpers/homegraph-service-fixtures.js';
import type { MemoryStore } from '../sdk/src/platform/state/index.js';
import { KnowledgeSemanticService } from '../sdk/src/platform/knowledge/semantic/index.js';
import { captureKnowledgeSourceReferences, projectKnowledgeSourceReferences } from '../sdk/src/platform/knowledge/source-structural-references.js';
import { prepareKnowledgeRecordAdmission } from '../sdk/src/platform/knowledge/store-record-snapshot.js';
import { htmlExtractionPort } from './_helpers/html-extraction-readings.js';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createWebKnowledgeGapRepairer, type WebGapRepairOptions } from '../sdk/src/platform/knowledge/semantic/gap-repair.js';
import { KnowledgeWebGapRepairHeldError as Held, type WebGapRepairHoldReason } from '../sdk/src/platform/knowledge/semantic/web-gap-repair/types.js';
import { bindWebGapRepairRequest, assertWebGapRepairResultCurrent } from '../sdk/src/platform/knowledge/semantic/web-gap-repair/ownership.js';
import { registry } from '../sdk/src/platform/knowledge/semantic/web-gap-repair/judgment-registry.js';
import { webGapQuery, webGapRelevance } from '../sdk/src/platform/knowledge/semantic/web-gap-repair/battery.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import type { KnowledgeSemanticGapRepairRequest } from '../sdk/src/platform/knowledge/semantic/types.js';
import type { WebSearchResponse, WebSearchResult } from '../sdk/src/platform/web-search/types.js';
import type { KnowledgeSourceRecord } from '../sdk/src/platform/knowledge/types.js';
import { createStores } from './_helpers/knowledge-semantic-fixtures.js';
import { KnowledgeService } from '../sdk/src/platform/knowledge/service.js';
import { HomeGraphService } from '../sdk/src/platform/knowledge/home-graph/service.js';
import { isKnowledgeSourceQualityFailure } from '../sdk/src/platform/knowledge/source-quality.js';

let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const request = (): KnowledgeSemanticGapRepairRequest => ({ spaceId: 'default', query: '厨房の温度計の電池を交換するには？', gaps: [], linkedObjects: [], sources: [], facts: [] });
const source = (url = 'https://reference.example/one', snippet = 'Hold the recessed switch for ten seconds.'): WebSearchResult => ({ url, rank: 1, title: 'Reference', snippet, type: 'organic', providerId: 'fixture', metadata: {} });
const response = (results = [source(), source('https://independent.example/two')]): WebSearchResponse => ({ providerId: 'fixture', providerLabel: 'Fixture', query: 'query', verbosity: 'snippets', metadata: {}, results });
function readings(input: { relevant?: number; authority?: 'secondary' | 'official-vendor' | 'vendor'; query?: 'none'; confidence?: number; before?: (name: string) => void } = {}) {
  const fake = fakePort((name, question, state) => {
    input.before?.(name);
    if (name === 'pick') {
      const candidates = (state as { candidates: { id: string }[] }).candidates;
      return choiceAnswer(question, input.query ?? candidates[0]!.id, input.confidence ?? 0.99);
    }
    if (name.startsWith('fits_')) return noulAnswer(0.99);
    if (name === 'relevant') return noulAnswer(input.relevant ?? 0.99);
    if (name === 'authority') return choiceAnswer(question, input.authority ?? 'secondary', 0.99);
    if (name === 'alias' || name === 'serve' || name === 'readable') return noulAnswer(0.99);
    throw new Error(`Unexpected fixture question: ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
function fixture(searchResponse = response()) {
  const searched: Parameters<WebGapRepairOptions['searchService']['search']>[0][] = [], ingested: string[] = [];
  const options: WebGapRepairOptions = { searchService: { async search(input) { searched.push(input); return searchResponse; } },
    ingestService: { async ingestUrl(input, owner) { owner?.assertCurrent?.(); ingested.push(input.url); owner?.onCommitted?.(`indexed-${ingested.length}`); return { source: { id: `indexed-${ingested.length}`, status: 'indexed' } }; } } };
  return { options, searched, ingested, repair: createWebKnowledgeGapRepairer(options) };
}
async function held(work: Promise<unknown>, reason: WebGapRepairHoldReason) { const error: unknown = await work.catch(error => error); expect(error).toBeInstanceOf(Held); expect((error as Held).reason).toBe(reason); }
const originalSource = (id = 'original'): KnowledgeSourceRecord => ({ id, connectorId: 'fixture', sourceType: 'manual', title: 'Reference', url: 'https://original.example/manual', tags: [], status: 'indexed', metadata: {}, createdAt: 1, updatedAt: 1 });

describe('actual web gap repair canonical decisions', () => {
  test('registered selection and relevance replace semantic shortcuts', () => {
    expect(registry.list().map(item => item.name)).toEqual(['engine.knowledge.web-gap-query', 'engine.knowledge.web-gap-source-relevance']);
    expect(webGapQuery.version).toBe(1); expect(webGapRelevance.fixtures.length).toBeGreaterThanOrEqual(5);
    expect(isKnowledgeSourceQualityFailure(new Held('uncertain'))).toBe(true);
  });
  test('non-Latin exact query and no-overlap evidence reach search and ingest without guessed trusted hosts', async () => {
    const fake = readings(), f = fixture(); const original = request();
    const result = await f.repair(original);
    expect(f.searched.map(item => item.query)).toEqual([original.query]);
    expect(f.searched[0]?.trustedHosts).toBeUndefined();
    expect(f.ingested).toEqual(['https://reference.example/one', 'https://independent.example/two']);
    expect(result?.evidenceSufficient).toBe(true);
    expect(result?.sourceAssessments?.map(item => item.confidence)).toEqual([99, 99]);
    expect(fake.requests.some(item => item.context?.site === 'engine.knowledge.repair-source-authority')).toBe(true);
    assertWebGapRepairResultCurrent(result);
  });
  test('settled none performs no search, while uncertainty and absence hold with no fallback', async () => {
    const f = fixture(); readings({ query: 'none' });
    expect((await f.repair(request()))?.searched).toBe(false);
    readings({ confidence: 0.5 }); await held(f.repair(request()), 'uncertain');
    installJudgmentPort(undefined); await held(f.repair(request()), 'unconfigured');
    expect(f.searched).toHaveLength(0); expect(f.ingested).toHaveLength(0);
  });
  test('keyword and manufacturer domain matches never override semantic rejection', async () => {
    readings({ relevant: 0.01 }); const f = fixture(response([source('https://acme.example/official', 'AC-7 specifications manufacturer official manual HDMI Bluetooth')]));
    const result = await f.repair({ ...request(), query: 'AC-7 HDMI Bluetooth manual specifications' });
    expect(result?.evidenceSufficient).toBe(false); expect(f.ingested).toHaveLength(0);
    expect(result?.sourceAssessments?.[0]?.rejectionReason).toBe('query-mismatch');
  });
  test('only a settled authority reading permits the one-primary-source policy', async () => {
    for (const authority of ['secondary', 'official-vendor'] as const) {
      readings({ authority }); const f = fixture(response([source('https://acme.example.attacker.test/official')]));
      const result = await f.repair(request());
      expect(result?.evidenceSufficient).toBe(authority === 'official-vendor');
      expect(f.ingested.length).toBe(authority === 'official-vendor' ? 1 : 0);
    }
  });
  test('domain diversity uses actual URL hosts, not provider claimed labels', async () => {
    readings(); const f = fixture(response([{ ...source('https://same.example/one'), domain: 'first.example' }, { ...source('https://same.example/two'), domain: 'second.example' }]));
    expect((await f.repair(request()))?.evidenceSufficient).toBe(false); expect(f.ingested).toHaveLength(0);
  });
  test('explicit confidence and ingestion limits remain caller policy', async () => {
    readings(); const f = fixture(); const repair = createWebKnowledgeGapRepairer({ ...f.options, minConfidence: 100, maxIngest: 0 });
    expect((await repair(request()))?.evidenceSufficient).toBe(false); expect(f.ingested).toHaveLength(0);
  });
  test('pending existing sources require canonical vendor authority, never URL spelling', async () => {
    readings({ authority: 'official-vendor' }); const f = fixture(response([]));
    const result = await f.repair({ ...request(), sources: [{ ...originalSource(), status: 'pending' }] });
    expect(result?.acceptedSourceIds).toEqual(['original']); expect(f.ingested).toHaveLength(0);
  });
});

describe('whole-input admission and operation lifetime', () => {
  test('protected late original metadata precedes candidate budgets and port acquisition', async () => {
    const fake = readings(), f = fixture();
    const sources = Array.from({ length: 51 }, (_, index) => originalSource(`source-${index}`));
    sources.push({ ...originalSource('last'), metadata: { password: 'never-transmit' } });
    await expect(f.repair({ ...request(), sources })).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0); expect(f.searched).toHaveLength(0);
  });
  test('duplicate and nonselected raw search response content receives complete privacy admission', async () => {
    const fake = readings(), raw = response([source(), { ...source(), metadata: { accessToken: 'never-transmit' } }]);
    const f = fixture(raw); await expect(f.repair(request())).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests.filter(item => item.context?.site === webGapRelevance.name)).toHaveLength(0); expect(f.ingested).toHaveLength(0);
  });
  test('accessor originals are rejected without running getters', async () => {
    const fake = readings(), f = fixture(); let reads = 0;
    await expect(f.repair({ ...request(), get query() { reads++; return 'unsafe'; } })).rejects.toBeInstanceOf(Held);
    expect(reads).toBe(0); expect(fake.requests).toHaveLength(0);
  });
  test('original request mutation during search cannot authorize a later ingest', async () => {
    readings(); const original = request(), f = fixture();
    f.options.searchService.search = async () => { Object.assign(original, { query: 'changed' }); return response(); };
    await held(f.repair(original), 'stale'); expect(f.ingested).toHaveLength(0);
  });
  for (const control of ['signal', 'deadlineAt'] as const) test(`late ${control} accessor holds without invoking the getter`, async () => {
    readings(); const original = request(), f = fixture(); let reads = 0;
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<WebSearchResponse>();
    f.options.searchService.search = async () => { entered.resolve(); return release.promise; };
    const running = f.repair(original); await entered.promise;
    Object.defineProperty(original, control, { enumerable: true, get() { reads++; throw new Error('borrowed getter'); } });
    release.resolve(response());
    await expect(running).rejects.toBeInstanceOf(Held);
    expect(reads).toBe(0); expect(f.ingested).toHaveLength(0);
  });
  test('raw response mutation during reading holds, even when projected fields are unchanged', async () => {
    const raw = response(), f = fixture(raw); readings({ before: name => { if (name === 'relevant') raw.metadata.changed = true; } });
    await held(f.repair(request()), 'stale'); expect(f.ingested).toHaveLength(0);
  });
  test('same-port uninstall/reinstall ABA is retired before ingestion', async () => {
    const fake = readings(), f = fixture();
    f.options.searchService.search = async () => { installJudgmentPort(undefined); installJudgmentPort(fake.port); return response(); };
    await held(f.repair(request()), 'stale'); expect(f.ingested).toHaveLength(0);
  });
  test('aborted noncooperative search returns promptly and its late result cannot ingest', async () => {
    readings(); const f = fixture(), parent = new AbortController(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<WebSearchResponse>();
    f.options.searchService.search = async () => { entered.resolve(); return release.promise; };
    const running = f.repair({ ...request(), signal: parent.signal }); await entered.promise; parent.abort();
    await held(running, 'aborted'); release.resolve(response()); await Promise.resolve(); expect(f.ingested).toHaveLength(0);
  });
  test('timeout retires a late ingestion before its publication check', async () => {
    readings(); const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.options.ingestService.ingestUrl = async (_input, ownership) => {
      entered.resolve(); await release.promise; ownership!.assertCurrent!(); f.ingested.push('unsafe'); return { source: { id: 'late', status: 'indexed' } };
    };
    const running = createWebKnowledgeGapRepairer({ ...f.options, ingestTimeoutMs: 5 })(request());
    await entered.promise; await held(running, 'budget'); release.resolve(); await Promise.resolve();
    expect(f.ingested).toHaveLength(0);
  });
  test('store-backed originals use complete raw admission and reject stale source replacements', async () => {
    readings(); const { store } = createStores(); await store.init();
    const source = await store.upsertSource({ connectorId: 'fixture', sourceType: 'url', title: 'Original', sourceUri: 'https://original.example/manual', status: 'indexed' });
    const original = bindWebGapRepairRequest(store, { ...request(), sources: [source] }, () => {}), f = fixture();
    f.options.searchService.search = async () => { await store.upsertSource({ ...source, title: 'New owner content' }); return response(); };
    await held(f.repair(original), 'stale'); expect(f.ingested).toHaveLength(0);
  });
});

for (const route of ['knowledge-service', 'homegraph-service'] as const) describe(`${route} actual URL ownership consumer`, () => {
  test('caller revocation during artifact preparation prevents source and extraction writes', async () => {
    readings(); const { store, artifactStore } = createStores(); await store.init();
    const artifact = await artifactStore.createFromStream({ kind: 'document', filename: 'manual.txt', mimeType: 'text/plain', sourceUri: 'https://example.invalid/manual', stream: ['A complete reference manual.'] });
    let current = true;
    const fetch = spyOn(artifactStore, 'create').mockImplementation(async () => { current = false; return artifact; });
    const owner = { assertCurrent: () => { if (!current) throw new Held('stale'); } };
    const service = route === 'knowledge-service' ? new KnowledgeService(store, artifactStore, undefined, { memoryRegistry: { async add() { throw new Error('Unexpected memory write'); }, getAll: () => [], getStore() { return { init: async () => {} } as unknown as MemoryStore; } } }) : new HomeGraphService(store, artifactStore);
    try {
      await expect(service.ingestUrl({ url: 'https://example.invalid/manual' }, owner)).rejects.toThrow();
      expect(store.listSources()).toHaveLength(0); expect(store.listExtractions()).toHaveLength(0); expect(store.listEdges()).toHaveLength(0);
    } finally { service.dispose(); fetch.mockRestore(); }
  });
});

for (const route of ['knowledge-service', 'homegraph-service'] as const) describe(`${route} guarded atomic publication`, () => {
  for (const revoked of [false, true]) test(revoked ? 'revocation at the atomic boundary leaves no source or extraction' : 'current ownership commits usable evidence once', async () => {
    readings(); const { store, artifactStore } = createStores(); await store.init();
    const artifact = await artifactStore.createFromStream({ kind: 'document', filename: 'manual.txt', mimeType: 'text/plain', sourceUri: 'https://example.invalid/manual', stream: ['A complete reference manual describes maintenance.'] });
    const fetch = spyOn(artifactStore, 'create').mockImplementation(async () => artifact);
    let current = true; const commits: string[] = [];
    const owner = { assertCurrent: () => { if (!current) throw new Held('stale'); }, onCommitted: (id: string) => { commits.push(id); } };
    const apply = store.applyPreparedIngest.bind(store);
    const commit = spyOn(store, 'applyPreparedIngest').mockImplementation(async (...args) => { if (revoked) current = false; return apply(...args); });
    const service = route === 'knowledge-service' ? new KnowledgeService(store, artifactStore, undefined, { memoryRegistry: { async add() { throw new Error('Unexpected memory write'); }, getAll: () => [], getStore() { return { init: async () => {} } as unknown as MemoryStore; } } }) : new HomeGraphService(store, artifactStore);
    try {
      const work = service.ingestUrl({ url: 'https://example.invalid/manual' }, owner);
      if (revoked) {
        await expect(work).rejects.toThrow(); expect(store.listSources()).toHaveLength(0); expect(store.listExtractions()).toHaveLength(0); expect(commits).toEqual([]);
      } else {
        const result = await work; expect(result.source.status).toBe('indexed'); expect(commits).toEqual([result.source.id]);
        expect(store.listSources()).toHaveLength(1); expect(store.listExtractions()).toHaveLength(1);
        if (route === 'homegraph-service') {
          const extraction = store.getExtractionBySourceId(result.source.id)!;
          const proof = captureKnowledgeSourceReferences(store, result.source, extraction);
          expect(projectKnowledgeSourceReferences(result.source, extraction, proof)?.extractionId).toBe('extraction-reference');
          prepareKnowledgeRecordAdmission(store, 'source', result.source, { source: result.source, extraction, proof }).assertCurrent();
          prepareKnowledgeRecordAdmission(store, 'extraction', extraction, { source: result.source, extraction, proof }).assertCurrent();
        }
      }
      expect(commit).toHaveBeenCalledTimes(1);
    } finally { service.dispose(); commit.mockRestore(); fetch.mockRestore(); }
  });
});

describe('complete original source and judgment response admission regressions', () => {
  test('alias retirement preserves a current host extraction hold but never trusts a provider error class', async () => {
    for (const cause of ['owner-extraction', 'provider-extraction', 'owner-other'] as const) {
      let retired = false;
      const base = fakePort(() => noulAnswer(0.99));
      const hostHold = new KnowledgeExtractionJudgmentHoldError();
      installJudgmentPort({ ...base.port, async ask(input) {
        retired = true;
        if (cause === 'provider-extraction') throw new KnowledgeExtractionJudgmentHoldError();
        return base.port.ask(input);
      } });
      const running = readKnowledgeEntityAliases([{ kind: 'project', title: 'Aurora' }], {
        title: 'AR', summary: '', extractionSummary: '', sections: [],
      }, undefined, undefined, () => {
        if (retired && cause === 'owner-extraction') throw hostHold;
        if (retired && cause === 'owner-other') throw new Error('host detail must not escape');
      });
      if (cause === 'owner-extraction') await expect(running).rejects.toBe(hostHold);
      else await expect(running).rejects.toBeInstanceOf(KnowledgeEntityAliasHoldError);
    }
  });

  for (const mode of ['initial-getter', 'late-getter', 'replacement'] as const) test(`original request questions ${mode} never dispatches or invokes a getter`, async () => {
    const base = fakePort(() => noulAnswer(0.99)); installJudgmentPort(base.port);
    const owner = createKnowledgeExtractionOwner(); let reads = 0;
    const input = { state: {}, questions: { relevant: webGapRelevance.items.relevant.question } };
    const getter = () => Object.defineProperty(input, 'questions', { configurable: true, enumerable: true, get() { reads++; throw new Error('borrowed questions'); } });
    if (mode === 'initial-getter') getter();
    const running = owner.port('knowledge.extraction.test').ask(input);
    if (mode === 'late-getter') getter();
    if (mode === 'replacement') Object.assign(input, { questions: { alias: webGapRelevance.items.relevant.question } });
    await expect(running).rejects.toThrow(); expect(reads).toBe(0); expect(base.requests).toHaveLength(0);
  });
  for (const mode of ['getter', 'replacement'] as const) test(`provider retry questions ${mode} cannot diverge from admitted schema`, async () => {
    const base = fakePort(() => noulAnswer(0.99)); let reads = 0, attempts = 0;
    const originalQuestions = { relevant: webGapRelevance.items.relevant.question };
    installJudgmentPort({ ...base.port, async ask(input) {
      expect(input.questions).not.toBe(originalQuestions); expect(Object.isFrozen(input.questions)).toBe(true);
      input.beforeAttempt?.(); attempts++;
      if (mode === 'getter') Object.defineProperty(input, 'questions', { configurable: true, enumerable: true, get() { reads++; throw new Error('borrowed retry schema'); } });
      else Object.assign(input, { questions: { alias: webGapRelevance.items.relevant.question } });
      input.beforeAttempt?.(); attempts++;
      return base.port.ask(input);
    } });
    const owner = createKnowledgeExtractionOwner();
    await expect(owner.port('knowledge.extraction.test').ask({ state: {}, questions: originalQuestions })).rejects.toThrow();
    expect(reads).toBe(0); expect(attempts).toBe(1); expect(base.requests).toHaveLength(0);
  });

  test('canonical long-fraction probabilities and independent confidence survive unchanged', async () => {
    const base = readings(), f = fixture(); let observed = 0;
    installJudgmentPort({ ...base.port, async ask(input) {
      const result = await base.port.ask(input);
      for (const answer of Object.values(result.answers)) {
        if (answer.type === 'choice') {
          // A real supported transport representation, not a rounded fixture.
          expect(Object.values(answer.probabilities)).toContain(1 - 0.99);
          Object.assign(answer, { confidence: 0.98 }); observed++;
        }
      }
      return result;
    } });
    expect((await f.repair(request()))?.evidenceSufficient).toBe(true);
    expect(observed).toBeGreaterThan(0); expect(f.ingested).toHaveLength(2);
  });
  for (const location of ['unknown-envelope', 'unknown-answer', 'unknown-question', 'unknown-option', 'lookalike-envelope'] as const) test(`protocol probability admission does not exempt ${location}`, async () => {
    const base = readings(), f = fixture();
    installJudgmentPort({ ...base.port, async ask(input) {
      const result = await base.port.ask(input);
      const raw = result as unknown as { extra?: unknown; answers: Record<string, Record<string, unknown>> };
      const fraction = 1 - 0.99;
      if (location === 'unknown-envelope') raw.extra = fraction;
      if (location === 'unknown-answer') raw.answers.pick!.extra = fraction;
      if (location === 'unknown-question') raw.answers.unrequested = { type: 'noul', noul: fraction };
      if (location === 'unknown-option') (raw.answers.pick!.probabilities as Record<string, unknown>).unrequested = fraction;
      if (location === 'lookalike-envelope') raw.extra = { answers: { pick: { type: 'noul', noul: fraction } } };
      return result;
    } });
    await expect(f.repair(request())).rejects.toBeInstanceOf(JudgmentInputError);
    expect(f.searched).toHaveLength(0); expect(f.ingested).toHaveLength(0);
  });
  test('requested schema mutation cannot manufacture a protocol exemption', async () => {
    const base = fakePort(() => noulAnswer(0.99)); let reads = 0;
    const questions = { relevant: webGapRelevance.items.relevant.question };
    installJudgmentPort({ ...base.port, async ask(input) {
      const result = await base.port.ask(input);
      Object.defineProperty(questions, 'relevant', { configurable: true, enumerable: true, get() { reads++; throw new Error('borrowed schema'); } });
      return result;
    } });
    const owner = createKnowledgeExtractionOwner();
    await expect(owner.port('knowledge.extraction.test').ask({ state: {}, questions })).rejects.toThrow();
    expect(reads).toBe(0);
  });
  test('known unit noul remains exact, frozen, and detached from provider mutation', async () => {
    const fraction = 1 - 0.99, base = fakePort(() => noulAnswer(fraction)); let original: object | undefined;
    installJudgmentPort({ ...base.port, async ask(input) {
      const result = await base.port.ask(input); original = result.answers.relevant; return result;
    } });
    const owner = createKnowledgeExtractionOwner();
    const result = await owner.port('knowledge.extraction.test').ask({ state: {}, questions: { relevant: webGapRelevance.items.relevant.question } });
    Object.assign(original!, { noul: 0.99 });
    expect(result.answers.relevant.noul).toBe(fraction); expect(Object.isFrozen(result.answers.relevant)).toBe(true);
  });
  test('alias batch records detached decisions after a later response changes the earlier original', async () => {
    const base = fakePort(() => noulAnswer(0.99));
    const originals: object[] = [], recorded: string[] = []; let reads = 0, mutationQueued = false;
    installJudgmentPort({ ...base.port, recorder: {
      recordReadings() {}, recordAction(id) { recorded.push(id); },
    }, async ask(input) {
      if (originals.length === 1) Object.defineProperty(originals[0]!, 'decisionId', { enumerable: true, get() { reads++; throw new Error('borrowed decision'); } });
      const result = { ...await base.port.ask(input), decisionId: `alias-decision-${originals.length}` };
      originals.push(result); return result;
    } });
    const aliases = await readKnowledgeEntityAliases([{ kind: 'project', title: 'Aurora' }], {
      title: 'AR Dawn', summary: '', extractionSummary: '', sections: [],
    }, undefined, undefined, () => {
      // The lower-port await must hand consumers a detached envelope even if
      // the provider changes its original before the battery continuation.
      if (originals.length === 1 && !mutationQueued) {
        mutationQueued = true;
        queueMicrotask(() => Object.defineProperty(originals[0]!, 'decisionId', {
          enumerable: true, configurable: true, get() { reads++; throw new Error('late original'); },
        }));
      }
    });
    expect(aliases).toEqual([['AR', 'Dawn']]); expect(originals).toHaveLength(2);
    expect(recorded).toEqual(['alias-decision-0', 'alias-decision-1']); expect(reads).toBe(0);
  });
  test('extraction owner returns a deeply frozen admitted envelope before consumer continuations', async () => {
    const base = fakePort(() => noulAnswer(0.99)); let original: object | undefined; let reads = 0;
    installJudgmentPort({ ...base.port, async ask(input) {
      const result = { ...await base.port.ask(input), decisionId: 'extraction-decision', extra: { safe: 'retained' } };
      original = result; return result;
    } });
    const owner = createKnowledgeExtractionOwner();
    const result = await owner.port('knowledge.extraction.test').ask({ state: {}, questions: {} });
    Object.defineProperty(original!, 'decisionId', { enumerable: true, get() { reads++; throw new Error('borrowed decision'); } });
    expect(result.decisionId).toBe('extraction-decision'); expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.answers)).toBe(true); owner.assertCurrent(); expect(reads).toBe(0);
  });

  for (const field of ['answers', 'model', 'requestedModel', 'decisionId']) test(`never reads original ${field} getters, including below the reader`, async () => {
    const base = readings(), f = fixture(); let getters = 0;
    installJudgmentPort({ ...base.port, async ask(input) {
      const result = { ...await base.port.ask(input) };
      Object.defineProperty(result, field, { enumerable: true, get() { getters++; throw new Error('Getter executed'); } });
      return result;
    } });
    await expect(f.repair(request())).rejects.toThrow(); expect(getters).toBe(0); expect(f.searched).toHaveLength(0); expect(f.ingested).toHaveLength(0);
  });
  for (const mode of ['protected-extra', 'hidden-extra', 'sparse-extra'] as const) test(`${mode} cannot be omitted from original response admission`, async () => {
    const base = readings(), f = fixture();
    installJudgmentPort({ ...base.port, async ask(input) {
      const result = { ...await base.port.ask(input) };
      if (mode === 'protected-extra') Object.assign(result, { extra: { password: 'never-send' } });
      if (mode === 'hidden-extra') Object.defineProperty(result, 'extra', { value: { password: 'never-send' }, enumerable: false });
      if (mode === 'sparse-extra') Object.assign(result, { extra: new Array(2) });
      return result;
    } });
    await expect(f.repair(request())).rejects.toThrow(); expect(f.searched).toHaveLength(0); expect(f.ingested).toHaveLength(0);
  });
  for (const mode of ['hidden-metadata', 'sparse-tags', 'named-array-extra'] as const) test(`original ${mode} holds before all model or search work`, async () => {
    const fake = readings(), f = fixture(), item = originalSource();
    if (mode === 'hidden-metadata') Object.defineProperty(item.metadata, 'private', { value: { password: 'never-send' }, enumerable: false });
    if (mode === 'sparse-tags') Object.assign(item, { tags: new Array(2) });
    if (mode === 'named-array-extra') Object.assign(item.tags, { extra: 'outside-sequence' });
    await expect(f.repair({ ...request(), sources: [item] })).rejects.toThrow(); expect(fake.requests).toHaveLength(0); expect(f.searched).toHaveLength(0);
  });
});

for (const route of ['knowledge-service', 'homegraph-service'] as const) describe(`${route} extraction preparation ownership`, () => {
  test('revocation after fetch starts no artifact read or extraction request', async () => {
    const fake = htmlExtractionPort(); installJudgmentPort(fake.port);
    const { store, artifactStore } = createStores(); await store.init();
    const artifact = await artifactStore.createFromStream({ kind: 'document', filename: 'manual.html', mimeType: 'text/html', sourceUri: 'https://example.invalid/manual', stream: ['<article><h1>Manual</h1><p>Concrete reference.</p></article>'] });
    let current = true;
    const fetch = spyOn(artifactStore, 'create').mockImplementation(async () => { current = false; return artifact; });
    const read = spyOn(artifactStore, 'readContent');
    const service = route === 'knowledge-service' ? new KnowledgeService(store, artifactStore, undefined, { memoryRegistry: { async add() { throw new Error('unused'); }, getAll: () => [], getStore() { return { init: async () => {} } as unknown as MemoryStore; } } }) : new HomeGraphService(store, artifactStore);
    try {
      await expect(service.ingestUrl({ url: 'https://example.invalid/manual' }, { assertCurrent: () => { if (!current) throw new Held('stale'); } })).rejects.toThrow();
      expect(read).not.toHaveBeenCalled(); expect(fake.requests).toHaveLength(0); expect(store.listSources()).toHaveLength(0);
    } finally { read.mockRestore(); fetch.mockRestore(); service.dispose(); }
  });
  for (const format of ['html', 'pdf'] as const) for (const abort of [false, true]) test(`${format}: ${abort ? 'abort interrupts a delayed extraction provider' : 'owner change prevents the next extraction provider attempt'}`, async () => {
    const fake = htmlExtractionPort(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let current = true, attempts = 0;
    const controller = new AbortController();
    installJudgmentPort({ ...fake.port, async ask(input) { attempts++; entered.resolve(); await release.promise; input.beforeAttempt?.(); return fake.port.ask(input); } });
    const { store, artifactStore } = createStores(); await store.init();
    const artifact = await artifactStore.createFromStream({ kind: 'document', filename: `manual.${format}`, mimeType: format === 'html' ? 'text/html' : 'application/pdf', sourceUri: 'https://example.invalid/manual', stream: [format === 'html' ? Buffer.from('<title>Manual</title><article><h1>Manual</h1><p>Concrete reference.</p></article>') : createCompressedPdfBuffer('Concrete reference manual.')] });
    const fetch = spyOn(artifactStore, 'create').mockImplementation(async () => artifact);
    const service = route === 'knowledge-service' ? new KnowledgeService(store, artifactStore, undefined, { memoryRegistry: { async add() { throw new Error('unused'); }, getAll: () => [], getStore() { return { init: async () => {} } as unknown as MemoryStore; } } }) : new HomeGraphService(store, artifactStore);
    try {
      const work = service.ingestUrl({ url: 'https://example.invalid/manual' }, { signal: controller.signal, assertCurrent: () => { if (!current) throw new Held('stale'); } });
      await entered.promise; const started = attempts; current = false;
      if (abort) { controller.abort(); await expect(work).rejects.toThrow(); release.resolve(); }
      else { release.resolve(); await expect(work).rejects.toThrow(); }
      expect(attempts).toBe(started); expect(fake.requests).toHaveLength(0);
      expect(store.listSources()).toHaveLength(0); expect(store.listExtractions()).toHaveLength(0);
    } finally { release.resolve(); fetch.mockRestore(); service.dispose(); }
  });
});

for (const deferred of [false, true]) test(deferred ? 'explicit repair ownership defers duplicate enrichment' : 'ordinary KnowledgeService URL ingest still invokes enrichment', async () => {
  readings(); const { store, artifactStore } = createStores(); await store.init();
  const artifact = await artifactStore.createFromStream({ kind: 'document', filename: 'manual.txt', mimeType: 'text/plain', sourceUri: 'https://example.invalid/manual', stream: ['A reference about maintenance.'] });
  const fetch = spyOn(artifactStore, 'create').mockImplementation(async () => artifact);
  const semantic = new KnowledgeSemanticService(store);
  const enrich = spyOn(semantic, 'enrichSource').mockImplementation(async () => { throw new Error('Synthetic enrichment observed; no background work requested'); });
  const service = new KnowledgeService(store, artifactStore, undefined, { semanticService: semantic, memoryRegistry: { async add() { throw new Error('unused'); }, getAll: () => [], getStore() { return { init: async () => {} } as unknown as MemoryStore; } } });
  try {
    await service.ingestUrl({ url: 'https://example.invalid/manual' }, deferred ? { assertCurrent: () => {}, deferSemanticEnrichment: true } : undefined);
    expect(enrich).toHaveBeenCalledTimes(deferred ? 0 : 1);
  } finally { enrich.mockRestore(); fetch.mockRestore(); service.dispose(); }
});

test('HomeGraph owned refresh does not mint generated-reference proof for an ordinary existing extraction ID', async () => {
  readings(); const { store, artifactStore } = createStores(); await store.init();
  const { homeGraphSourceId, namespacedCanonicalUri } = await import('../sdk/src/platform/knowledge/home-graph/helpers.js');
  const spaceId = 'homeassistant:default', url = 'https://example.invalid/manual';
  const id = homeGraphSourceId(spaceId, 'url', url);
  await store.upsertSource({ id, connectorId: 'fixture', sourceType: 'url', sourceUri: url, canonicalUri: namespacedCanonicalUri(spaceId, 'source', url), status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
  await store.upsertExtraction({ id: 'ordinary-existing-extraction', sourceId: id, extractorId: 'text', format: 'text', sections: [], links: [], estimatedTokens: 1, structure: {}, metadata: { knowledgeSpaceId: spaceId } });
  const artifact = await artifactStore.createFromStream({ kind: 'document', filename: 'manual.txt', mimeType: 'text/plain', sourceUri: url, stream: ['A reference about maintenance.'] });
  const fetch = spyOn(artifactStore, 'create').mockImplementation(async () => artifact), service = new HomeGraphService(store, artifactStore);
  try {
    const result = await service.ingestUrl({ url }, { assertCurrent: () => {}, deferSemanticEnrichment: true });
    const extraction = store.getExtractionBySourceId(result.source.id)!;
    expect(extraction.id).toBe('ordinary-existing-extraction');
    const proof = captureKnowledgeSourceReferences(store, result.source, extraction);
    expect(projectKnowledgeSourceReferences(result.source, extraction, proof)?.sourceId).toBe('source-reference');
    expect(projectKnowledgeSourceReferences(result.source, extraction, proof)?.extractionId).toBeUndefined();
  } finally { fetch.mockRestore(); service.dispose(); }
});
