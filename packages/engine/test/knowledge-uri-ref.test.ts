import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort, bindJudgmentPortAuthority } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeConnectorRegistry } from '../sdk/src/platform/knowledge/connectors.js';
import { KnowledgeNodeActivationHeldError } from '../sdk/src/platform/knowledge/activation/types.js';
import { ingestKnowledgeArtifact, ingestKnowledgeUrl } from '../sdk/src/platform/knowledge/ingest-inputs.js';
import { ingestBrowserKnowledge } from '../sdk/src/platform/knowledge/browser-history/ingest.js';
import { compileKnowledgeSource, finalizeKnowledgeIngestedSource } from '../sdk/src/platform/knowledge/ingest-compile.js';
import { prepareKnowledgeExtraction } from '../sdk/src/platform/knowledge/prepared-extraction.js';
import { createKnowledgeIngestUriCanonicalizer, assertKnowledgeIngestUriOperation, type KnowledgeIngestUriCanonicalizer } from '../sdk/src/platform/knowledge/uri-canonicalization/ingest-owner.js';
import { knowledgeUriRef } from '../sdk/src/platform/knowledge/uri-canonicalization/battery.js';
import { registry } from '../sdk/src/platform/knowledge/uri-canonicalization/judgment-registry.js';
import { createKnowledgeUriCanonicalizer, KnowledgeUriCanonicalizationHeldError as Held, KNOWLEDGE_URI_LIMITS as LIMITS } from '../sdk/src/platform/knowledge/uri-canonicalization/reader.js';

let previous: JudgmentPort | undefined;
const roots: string[] = [], stores: KnowledgeStore[] = [], releases: (() => void)[] = [], pending: Promise<unknown>[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  installJudgmentPort(previous);
  await Promise.allSettled(pending.splice(0));
  await Promise.all(stores.splice(0).map(store => store.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const contentOne = 'https://docs.example.test/document?ref=document-one';
const contentTwo = 'https://docs.example.test/document?ref=document-two';
const referral = 'https://shop.example.test/item?ref=affiliate-alice';
function answers(probability: number) { const fake = fakePort(() => noulAnswer(probability)); installJudgmentPort(fake.port); return fake; }
async function held(work: Promise<unknown>, reason: Held['reason']) {
  const error: unknown = await work.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Held);
  if (!(error instanceof Held)) throw new Error('Expected a canonical URI hold');
  expect(error.reason).toBe(reason);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-uri-ref-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store);
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  return { store, artifactStore, connectorRegistry: new KnowledgeConnectorRegistry(), emitIfReady: () => {},
    syncReviewedMemory: async () => {}, lint: async () => [], listConnectors: () => [] };
}
function domainAnswers(refProbability: number) {
  const fake = fakePort(name => noulAnswer(name === 'referral' ? refProbability : name === 'alias' ? 0.01 : 0.99));
  installJudgmentPort(fake.port); return fake;
}

describe('Knowledge concrete ref identity', () => {
  test('registered versioned yes/no reading preserves original confidence floor and contrasted fixture expectations', async () => {
    expect(registry.list().map(battery => battery.name)).toEqual(['engine.knowledge.uri-ref']);
    expect(knowledgeUriRef.version).toBe(1); expect(knowledgeUriRef.accuracyFloor).toBeGreaterThanOrEqual(0.95);
    const fake = fakePort((name, _question, state) => {
      const fixture = knowledgeUriRef.fixtures.find(item => JSON.stringify(item.state) === JSON.stringify(state));
      if (name !== 'referral' || !fixture) throw new Error('Unscripted URI fixture');
      return noulAnswer(fixture.expect.referral === 'yes' ? 0.99 : 0.01);
    });
    const results = await knowledgeUriRef.checkFixtures(fake.port);
    expect(results).toHaveLength(10); expect(results.every(result => result.correct && result.outcome === 'act')).toBe(true);
  });
  test('settled referral ref merges with the clean address; settled page ref preserves distinct content', async () => {
    const yes = answers(0.99), tracking = createKnowledgeUriCanonicalizer();
    expect(await tracking.canonicalize(referral)).toBe('https://shop.example.test/item');
    expect(await tracking.canonicalize('https://shop.example.test/item')).toBe('https://shop.example.test/item');
    expect(yes.requests).toHaveLength(1);
    const no = answers(0.01), content = createKnowledgeUriCanonicalizer();
    expect(await content.canonicalizeAll([contentOne, contentTwo])).toEqual([contentOne, contentTwo]);
    expect(no.requests).toHaveLength(2);
  });
  test('unchanged structural and defined tracking conventions need no judgment port', async () => {
    const reader = createKnowledgeUriCanonicalizer();
    expect(await reader.canonicalize('HTTPS://DOCS.EXAMPLE.TEST:443/path///?z=2&utm_campaign=x&fbclid=y&gclid=z&a=1#section'))
      .toBe('https://docs.example.test/path?a=1&z=2');
    expect(await reader.canonicalize('https://docs.example.test/?Ref=release')).toBe('https://docs.example.test/?Ref=release');
    expect(await reader.canonicalize('not a URI')).toBeNull();
    const nativeReferences = Array.from({ length: 1000 }, (_, index) => `https://docs.example.test/native/${index}`);
    expect(await reader.canonicalizeAll(nativeReferences)).toEqual(nativeReferences);
  });
  test('each repeated ref occurrence is decided separately and content multiplicity survives stable sorting', async () => {
    const uri = 'https://docs.example.test/page?z=last&ref=document-one&ref=affiliate-alice&ref=document-one&a=first';
    const fake = fakePort((_name, _question, state) => noulAnswer(state && typeof state === 'object' && !Array.isArray(state) && state.target && typeof state.target === 'object'
      && !Array.isArray(state.target) && state.target.position === 2 ? 0.99 : 0.01));
    installJudgmentPort(fake.port);
    expect(await createKnowledgeUriCanonicalizer().canonicalize(uri))
      .toBe('https://docs.example.test/page?a=first&ref=document-one&ref=document-one&z=last');
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests.map(request => { const state = request.state; return state && typeof state === 'object' && !Array.isArray(state) ? state.target : undefined; })).toEqual([
      { position: 1, key: 'ref', value: 'document-one' }, { position: 2, key: 'ref', value: 'affiliate-alice' }, { position: 3, key: 'ref', value: 'document-one' },
    ]);
  });
  test('an uncertain, unavailable or unconfigured ref holds and cannot acquire a keep-or-strip fallback', async () => {
    await held(createKnowledgeUriCanonicalizer().canonicalize(contentOne), 'unconfigured');
    answers(0.5); const unknown = createKnowledgeUriCanonicalizer();
    await held(unknown.canonicalize(contentOne), 'uncertain'); expect(() => unknown.assertCurrent()).toThrow(Held);
    const fake = answers(0.01); installJudgmentPort({ ...fake.port, async ask() { throw new Error('Synthetic outage'); } });
    await held(createKnowledgeUriCanonicalizer().canonicalize(contentOne), 'unavailable');
  });
  test('a complete ref-bearing batch and percent-decoded credential fields are screened before earlier safe wires, caps or cache reuse', async () => {
    for (const inputs of [
      [contentOne, 'https://docs.example.test/page?ref=document&password=never-transmit'],
      [contentOne, 'https://docs.example.test/page?ref=password%3Dnever-transmit'],
      [...Array.from({ length: 1001 }, (_, index) => `https://docs.example.test/page?ref=document-${index}`), 'https://docs.example.test/page?ref=document&password=never-transmit'],
    ]) {
      const fake = answers(0.01);
      await expect(createKnowledgeUriCanonicalizer().canonicalizeAll(inputs)).rejects.toBeInstanceOf(JudgmentInputError);
      expect(fake.requests).toHaveLength(0);
    }
    const fake = answers(0.01), reader = createKnowledgeUriCanonicalizer();
    await reader.canonicalize(contentOne);
    await expect(reader.canonicalizeAll([contentOne, 'https://docs.example.test/page?ref=document&password=never-transmit'])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(1);
  });
  test('the complete provider response cannot hide credentials behind a settled probability or an unused field', async () => {
    const fake = answers(0.01);
    installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), extra: { password: 'never-transmit' } }; } });
    await expect(createKnowledgeUriCanonicalizer().canonicalize(contentOne)).rejects.toBeInstanceOf(JudgmentInputError);
  });
  test('input mutation during a pending reading retires the entire batch before cache publication', async () => {
    const fake = answers(0.01), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); releases.push(() => release.resolve());
    installJudgmentPort({ ...fake.port, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } });
    const inputs = [contentOne], reader = createKnowledgeUriCanonicalizer(), work = reader.canonicalizeAll(inputs); pending.push(work);
    await entered.promise; inputs[0] = contentTwo; release.resolve(); await held(work, 'stale');
    expect(() => reader.assertCurrent()).toThrow(Held);
  });
  test('installation ABA, method mutation, removal, source retirement and caller retirement revoke settled identity reuse', async () => {
    for (const mode of ['aba', 'method', 'remove', 'source', 'caller'] as const) {
      const fake = answers(0.01), identity = {}, source = new AbortController(); let current = true;
      bindJudgmentPortAuthority(fake.port, () => ({ identity, signal: source.signal, assertCurrent: () => {} }));
      const reader = createKnowledgeUriCanonicalizer({ assertCurrent() { if (!current) throw new Error('retired'); } });
      await reader.canonicalize(contentOne);
      if (mode === 'aba') { installJudgmentPort({ ...fake.port }); installJudgmentPort(fake.port); }
      if (mode === 'method') Object.assign(fake.port, { ask: fakePort(() => noulAnswer(0.99)).port.ask });
      if (mode === 'remove') installJudgmentPort(undefined);
      if (mode === 'source') source.abort();
      if (mode === 'caller') current = false;
      await held(reader.canonicalize(contentOne), 'stale');
    }
  });
  test('abort and timeout interrupt an owned noncooperative wire, preserve its failed run and drain late settlement', async () => {
    for (const mode of ['abort', 'timeout'] as const) {
      const fake = answers(0.01), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); releases.push(() => release.resolve());
      installJudgmentPort({ ...fake.port, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } });
      const controller = new AbortController(), reader = createKnowledgeUriCanonicalizer({ signal: controller.signal, timeoutMs: mode === 'timeout' ? 10 : 1000 });
      const work = reader.canonicalize(contentOne); pending.push(work); await entered.promise;
      if (mode === 'abort') controller.abort();
      await held(work, mode === 'abort' ? 'aborted' : 'budget');
      release.resolve(); await Promise.resolve(); expect(() => reader.assertCurrent()).toThrow(Held);
    }
  });
  test('a synchronous caller returning a promise or replacing its own option cannot authorize a wire', async () => {
    for (const result of ['promise', 'replace'] as const) {
      const fake = answers(0.01), options = { assertCurrent() {
        if (result === 'promise') return Promise.resolve();
        options.assertCurrent = () => undefined;
        return undefined;
      } };
      expect(() => createKnowledgeUriCanonicalizer(options)).toThrow(Held); expect(fake.requests).toHaveLength(0);
    }
  });
});

describe('native Knowledge ref consumers', () => {
  test('fabricated, copied and method-replaced URI owners fail before any supplied method or persistence', async () => {
    const context = fixture(), fake = domainAnswers(0.01);
    const artifact = await context.artifactStore.createFromStream({ kind: 'document', filename: 'authentic.txt', mimeType: 'text/plain', sourceUri: contentOne, stream: ['Retained reference document.'] });
    await context.store.init();
    const genuine = createKnowledgeIngestUriCanonicalizer(context);
    const generic = createKnowledgeUriCanonicalizer();
    let invoked = 0;
    const fabricated: KnowledgeIngestUriCanonicalizer = {
      signal: new AbortController().signal,
      canonicalize: async () => { invoked++; return 'https://docs.example.test/document'; },
      canonicalizeAll: async () => { invoked++; return []; },
      assertCurrent: () => { invoked++; }, reserveSource: () => { invoked++; }, attachArtifact: () => { invoked++; },
    };
    const copies = [fabricated, { ...genuine }, { ...genuine, canonicalize: fabricated.canonicalize },
      { ...generic, signal: genuine.signal, reserveSource: genuine.reserveSource, attachArtifact: genuine.attachArtifact }];
    const base = { sourceId: 'reserved-source', artifactId: artifact.id, connectorId: 'manual', sourceType: 'document' as const, tags: [], metadata: {} };
    for (const copy of copies) {
      await expect(prepareKnowledgeExtraction(context, base.sourceId, artifact.id, copy)).rejects.toBeInstanceOf(Held);
      await expect(finalizeKnowledgeIngestedSource(context, base, copy)).rejects.toBeInstanceOf(Held);
    }
    expect(invoked).toBe(0); expect(fake.requests).toHaveLength(0); expect(context.store.listSources()).toHaveLength(0);
    expect(context.store.getExtractionBySourceId(base.sourceId)).toBeNull();
  });
  test('genuine but unbound, foreign-context, foreign-source and foreign-artifact operations cannot enter ingest', async () => {
    const context = fixture(), otherContext = fixture(), fake = domainAnswers(0.01);
    const artifact = await context.artifactStore.createFromStream({ kind: 'document', filename: 'bound.txt', mimeType: 'text/plain', sourceUri: contentOne, stream: ['Bound document.'] });
    await context.store.init(); await otherContext.store.init();
    const uris = createKnowledgeIngestUriCanonicalizer(context);
    await expect(prepareKnowledgeExtraction(context, 'source-one', artifact.id, uris)).rejects.toBeInstanceOf(Held);
    uris.reserveSource('source-one'); uris.attachArtifact(artifact.id);
    await expect(prepareKnowledgeExtraction(otherContext, 'source-one', artifact.id, uris)).rejects.toBeInstanceOf(Held);
    await expect(prepareKnowledgeExtraction(context, 'source-two', artifact.id, uris)).rejects.toBeInstanceOf(Held);
    await expect(prepareKnowledgeExtraction(context, 'source-one', 'foreign-artifact', uris)).rejects.toBeInstanceOf(Held);
    expect(() => uris.reserveSource('source-two')).toThrow(Held);
    expect(() => uris.attachArtifact('foreign-artifact')).toThrow(Held);
    expect(fake.requests).toHaveLength(0); expect(context.store.listSources()).toHaveLength(0);
    const token = await prepareKnowledgeExtraction(context, 'source-one', artifact.id, uris);
    expect(token.sourceId).toBe('source-one'); expect(fake.requests.filter(request => request.questions.referral)).toHaveLength(1);
  });
  test('only the same genuine operation can finalize its exact private preparation token once', async () => {
    const context = fixture(), fake = domainAnswers(0.01);
    const artifact = await context.artifactStore.createFromStream({ kind: 'document', filename: 'prepared.txt', mimeType: 'text/plain', sourceUri: contentOne, stream: ['Authentic prepared document.'] });
    await context.store.init();
    const uris = createKnowledgeIngestUriCanonicalizer(context);
    uris.reserveSource('prepared-source'); uris.attachArtifact(artifact.id);
    const token = await prepareKnowledgeExtraction(context, 'prepared-source', artifact.id, uris);
    const foreign = createKnowledgeIngestUriCanonicalizer(context);
    foreign.reserveSource('prepared-source'); foreign.attachArtifact(artifact.id);
    const base = { sourceId: token.sourceId, artifactId: token.artifactId, preparedExtraction: token, connectorId: 'manual', sourceType: 'document' as const, tags: [], metadata: {} };
    const wireCount = fake.requests.length;
    for (const forged of [{ ...token }, Object.freeze({ ...token })]) {
      await expect(finalizeKnowledgeIngestedSource(context, { ...base, preparedExtraction: forged }, uris)).rejects.toBeInstanceOf(Held);
    }
    await expect(finalizeKnowledgeIngestedSource(context, base, foreign)).rejects.toBeInstanceOf(Held);
    expect(fake.requests).toHaveLength(wireCount); expect(context.store.listSources()).toHaveLength(0);
    const result = await finalizeKnowledgeIngestedSource(context, base, uris);
    expect(result.source.canonicalUri).toBe(contentOne); expect(uris.signal.aborted).toBe(true);
    await expect(finalizeKnowledgeIngestedSource(context, base, uris)).rejects.toBeInstanceOf(Held);
    expect(context.store.listSources()).toHaveLength(1);
    expect(context.store.getExtractionBySourceId(token.sourceId)).toEqual(result.extraction);
  });
  test('the authentic operation rechecks native artifact and method ownership at the storage handoff', async () => {
    const context = fixture(); domainAnswers(0.01);
    const artifact = await context.artifactStore.createFromStream({ kind: 'document', filename: 'retained.txt', mimeType: 'text/plain', sourceUri: contentOne, stream: ['Current retained document.'] });
    await context.store.init();
    const uris = createKnowledgeIngestUriCanonicalizer(context);
    uris.reserveSource('retained-source'); uris.attachArtifact(artifact.id);
    const token = await prepareKnowledgeExtraction(context, 'retained-source', artifact.id, uris);
    const originalRecord = context.artifactStore.getRecord(artifact.id);
    if (!originalRecord) throw new Error('Missing fixture artifact record');
    const replacement = spyOn(context.artifactStore, 'getRecord').mockReturnValue({ ...originalRecord, sourceUri: contentTwo });
    try {
      expect(() => assertKnowledgeIngestUriOperation(context, uris, token.sourceId, token.artifactId, token)).toThrow(Held);
      await expect(finalizeKnowledgeIngestedSource(context, { sourceId: token.sourceId, artifactId: token.artifactId, preparedExtraction: token, connectorId: 'manual', sourceType: 'document', tags: [], metadata: {} }, uris)).rejects.toBeInstanceOf(Held);
      expect(context.store.listSources()).toHaveLength(0); expect(context.store.getExtractionBySourceId(token.sourceId)).toBeNull();
    } finally { replacement.mockRestore(); }
    expect(() => uris.assertCurrent()).toThrow(Held);
  });
  test('a second preparation cannot borrow an in-flight genuine source operation', async () => {
    const context = fixture(), fake = domainAnswers(0.01), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    releases.push(() => release.resolve());
    installJudgmentPort({ ...fake.port, async ask(request) { if (request.questions.referral) { entered.resolve(); await release.promise; } return fake.port.ask(request); } });
    const artifact = await context.artifactStore.createFromStream({ kind: 'document', filename: 'in-flight.txt', mimeType: 'text/plain', sourceUri: contentOne, stream: ['Single operation document.'] });
    await context.store.init();
    const uris = createKnowledgeIngestUriCanonicalizer(context);
    uris.reserveSource('in-flight-source'); uris.attachArtifact(artifact.id);
    const work = prepareKnowledgeExtraction(context, 'in-flight-source', artifact.id, uris); pending.push(work);
    await entered.promise;
    await expect(prepareKnowledgeExtraction(context, 'in-flight-source', artifact.id, uris)).rejects.toBeInstanceOf(Held);
    release.resolve(); const token = await work;
    expect(token.sourceId).toBe('in-flight-source'); expect(context.store.listSources()).toHaveLength(0);
    expect(fake.requests.filter(request => request.questions.referral)).toHaveLength(1);
  });
  test('native storage rejects an operation whose artifact authority changes after graph preparation', async () => {
    const context = fixture(); domainAnswers(0.01);
    const artifact = await context.artifactStore.createFromStream({ kind: 'document', filename: 'commit.txt', mimeType: 'text/plain', sourceUri: contentOne, stream: ['Document retained through publication.'] });
    await context.store.init();
    const nativeApply = context.store.applyPreparedIngest.bind(context.store);
    let restoreRecord = () => {}, reachedStorage = false;
    const intercept = spyOn(context.store, 'applyPreparedIngest').mockImplementation((input, prepareGraph, options, onCommitted) =>
      nativeApply(input, async stage => {
        const graph = await prepareGraph(stage); reachedStorage = true;
        const originalRecord = context.artifactStore.getRecord(artifact.id);
        if (!originalRecord) throw new Error('Missing fixture artifact record');
        const changed = spyOn(context.artifactStore, 'getRecord').mockReturnValue({ ...originalRecord, sourceUri: contentTwo });
        restoreRecord = () => changed.mockRestore(); return graph;
      }, options, onCommitted));
    try {
      const uris = createKnowledgeIngestUriCanonicalizer(context);
      uris.reserveSource('commit-source'); uris.attachArtifact(artifact.id);
      const token = await prepareKnowledgeExtraction(context, 'commit-source', artifact.id, uris);
      await expect(finalizeKnowledgeIngestedSource(context, { sourceId: token.sourceId, artifactId: token.artifactId, preparedExtraction: token,
        connectorId: 'manual', sourceType: 'document', tags: [], metadata: {} }, uris)).rejects.toBeInstanceOf(Held);
      expect(reachedStorage).toBe(true); expect(uris.signal.aborted).toBe(true);
      expect(context.store.listSources()).toHaveLength(0); expect(context.store.getExtractionBySourceId(token.sourceId)).toBeNull();
      expect(context.store.listNodes()).toHaveLength(0); expect(context.store.listEdges()).toHaveLength(0);
    } finally { restoreRecord(); intercept.mockRestore(); }
  });
  test('actual artifact ingestion retains two content refs as two sources and still deduplicates a referral ref', async () => {
    const context = fixture(); domainAnswers(0.01);
    const one = await context.artifactStore.createFromStream({ kind: 'document', filename: 'one.txt', mimeType: 'text/plain', sourceUri: contentOne, stream: ['First selected revision.'] });
    const two = await context.artifactStore.createFromStream({ kind: 'document', filename: 'two.txt', mimeType: 'text/plain', sourceUri: contentTwo, stream: ['Second selected revision.'] });
    const first = await ingestKnowledgeArtifact(context, { artifactId: one.id, title: 'First reference' });
    const second = await ingestKnowledgeArtifact(context, { artifactId: two.id, title: 'Second reference' });
    expect(first.source.id).not.toBe(second.source.id); expect(context.store.listSources()).toHaveLength(2);
    expect(first.source.canonicalUri).toBe(contentOne); expect(second.source.canonicalUri).toBe(contentTwo);
    domainAnswers(0.99);
    const track = await context.artifactStore.createFromStream({ kind: 'document', filename: 'track.txt', mimeType: 'text/plain', sourceUri: referral, stream: ['One product document.'] });
    const clean = await context.artifactStore.createFromStream({ kind: 'document', filename: 'clean.txt', mimeType: 'text/plain', sourceUri: 'https://shop.example.test/item', stream: ['One product document.'] });
    const tagged = await ingestKnowledgeArtifact(context, { artifactId: track.id });
    const untagged = await ingestKnowledgeArtifact(context, { artifactId: clean.id });
    expect(tagged.source.id).toBe(untagged.source.id); expect(context.store.listSources()).toHaveLength(3);
  });
  test('URL and artifact-URI routes hold uncertain ref before the actual external fetch or source write', async () => {
    for (const route of ['url', 'artifact'] as const) {
      const context = fixture(); answers(0.5);
      const fetch = spyOn(context.artifactStore, 'create');
      try {
        await expect(route === 'url' ? ingestKnowledgeUrl(context, { url: contentOne }) : ingestKnowledgeArtifact(context, { uri: contentOne }))
          .rejects.toBeInstanceOf(Held);
        expect(fetch).not.toHaveBeenCalled(); expect(context.store.listSources()).toHaveLength(0);
      } finally { fetch.mockRestore(); }
    }
  });
  test('actual compilation attaches each content ref to its own retained source and holds an unsettled link without graph publication', async () => {
    const context = fixture(), store = context.store; domainAnswers(0.01);
    const one = await store.upsertSource({ connectorId: 'manual', sourceType: 'url', canonicalUri: contentOne, status: 'indexed' });
    const two = await store.upsertSource({ connectorId: 'manual', sourceType: 'url', canonicalUri: contentTwo, status: 'indexed' });
    const source = await store.upsertSource({ connectorId: 'manual', sourceType: 'url', canonicalUri: 'https://docs.example.test/index', status: 'indexed' });
    const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', links: [contentOne, contentTwo] });
    await compileKnowledgeSource(context, source, extraction);
    expect(store.listEdges().filter(edge => edge.fromId === source.id && edge.relation === 'links_to_source').map(edge => edge.toId).sort())
      .toEqual([one.id, two.id].sort());
    const before = store.status(), edges = store.listEdges(); answers(0.5);
    await expect(compileKnowledgeSource(context, source, extraction)).rejects.toBeInstanceOf(Held);
    expect(store.status()).toEqual(before); expect(store.listEdges()).toEqual(edges);
  });
  test('native browser aggregation preserves content refs and merges only the authorized defined tracking parameters', async () => {
    const context = fixture(), home = join(roots[roots.length - 1]!, 'synthetic-home'), profile = join(home, '.config', 'chromium', 'Default');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { type: 'folder', name: 'Synthetic references', children: [
      { type: 'url', id: '1', name: 'First selected document', url: contentOne },
      { type: 'url', id: '2', name: 'Second selected document', url: contentTwo },
      { type: 'url', id: '3', name: 'First selected document again', url: `${contentOne}&utm_source=synthetic` },
    ] } } }));
    domainAnswers(0.01);
    const result = await ingestBrowserKnowledge(context, { homeOverride: home, browsers: ['chromium'], sourceKinds: ['bookmark'] });
    expect(result.imported).toBe(2); expect(result.failed).toBe(0);
    expect(context.store.listSources().map(source => source.canonicalUri).sort()).toEqual([contentOne, contentTwo].sort());
  });
  test('the native URL caller signal cancels a pending URI reading before its external fetch and late response cannot publish', async () => {
    const context = fixture(), fake = answers(0.01), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    releases.push(() => release.resolve());
    installJudgmentPort({ ...fake.port, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } });
    const controller = new AbortController(), fetch = spyOn(context.artifactStore, 'create');
    try {
      const work = ingestKnowledgeUrl(context, { url: contentOne, signal: controller.signal }); pending.push(work);
      await entered.promise; controller.abort(); await held(work, 'aborted');
      release.resolve(); await Promise.resolve();
      expect(fetch).not.toHaveBeenCalled(); expect(context.store.listSources()).toHaveLength(0);
    } finally { fetch.mockRestore(); }
  });
  test('native source, extraction and edge writes recheck the original restriction after init and reject asynchronous approval', async () => {
    const context = fixture(), store = context.store;
    await store.init();
    const source = await store.upsertSource({ connectorId: 'manual', sourceType: 'url', canonicalUri: contentOne, status: 'indexed' });
    const before = store.status();
    let calls = 0;
    const revoked = () => { if (++calls > 1) throw new Held('stale'); };
    await expect(store.upsertSource({ ...source, title: 'Must not publish' }, revoked)).rejects.toBeInstanceOf(Held);
    expect(store.getSource(source.id)).toEqual(source);
    await expect(store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text' }, () => Promise.resolve()))
      .rejects.toBeInstanceOf(KnowledgeNodeActivationHeldError);
    await expect(store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'source', toId: source.id, relation: 'links_to_source' }, () => Promise.resolve()))
      .rejects.toBeInstanceOf(KnowledgeNodeActivationHeldError);
    expect(store.status()).toEqual(before);
  });
});
