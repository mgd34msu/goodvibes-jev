import { extractionValueFixtureFor, extractionValueFixtureReading, type ExtractionValueFixtures } from './_helpers/knowledge-extraction-value-readings.js';
import { captureStrictJudgmentJson } from '../sdk/src/platform/gate/judgment-result.js';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { prepareKnowledgeExtractionValueReading, KnowledgeExtractionValueHeldError, type KnowledgeExtractionValueInput } from '../sdk/src/platform/knowledge/semantic/extraction-value/reader.js';
import { knowledgeExtractionValue } from '../sdk/src/platform/knowledge/semantic/extraction-value/battery.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeSemanticService } from '../sdk/src/platform/knowledge/semantic/service.js';
import { enrichKnowledgeSource } from '../sdk/src/platform/knowledge/semantic/enrichment.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';

let previous: JudgmentPort | undefined;
const roots: string[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function input(text = 'AC-7 mass: 12 kg.') {
  return { source: { title: 'AC-7', sourceType: 'manual', status: 'indexed', summary: '', description: '',
    uri: 'manual://ac-7', trust: 'untrusted reference material', claimedProvenance: { reason: '', domain: '' } },
    extraction: { format: 'text', excerpt: text, sections: ['Overview'] }, text } satisfies KnowledgeExtractionValueInput;
}
function readings(probability = 0.99, expected: KnowledgeExtractionValueInput = input()) {
  const fixtures: ExtractionValueFixtures = [[captureStrictJudgmentJson(expected), probability]];
  const fake = fakePort((name, question, state) => {
    const value = extractionValueFixtureReading(name, question, state, fixtures);
    if (value === undefined) throw new Error('Unscripted extraction-value question');
    return noulAnswer(value);
  });
  installJudgmentPort(fake.port); return fake;
}
const current = () => {};

describe('concrete semantic extraction value', () => {
  test.each([
    ['AC-7 mass: 12 kg.', 0.99, true],
    ['AC-7の重量は12kg。', 0.99, true],
    ['AC-7 cannot charge over USB.', 0.99, true],
    ['Welcome to the publisher portal. Browse the product documentation and contact the publisher for information. No product fact is stated here.', 0.01, false],
    ['', 0.01, false],
  ] as const)('source value uses the authored reading for %s', async (text, probability, expected) => {
    const original = input(text), fake = readings(probability, original);
    const plan = prepareKnowledgeExtractionValueReading(original, { assertCurrent: current });
    expect(await plan.read()).toBe(expected); plan.assertCurrent();
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.state).toEqual(original);
    expect(await plan.read()).toBe(expected);
    expect(fake.requests).toHaveLength(1);
  });

  test('complete late facts and contradictions survive transport without truncation', async () => {
    const original = input('Navigation.\n'.repeat(500) + 'AC-7 runs at 24 V DC. The earlier 12 V label is incorrect.');
    const fake = readings(0.99, original);
    expect(await prepareKnowledgeExtractionValueReading(original, { assertCurrent: current }).read()).toBe(true);
    expect(fake.requests[0]?.state).toEqual(original);
  });

  test('uncertain and absent ports hold rather than selecting a fallback', async () => {
    readings(0.5);
    await expect(prepareKnowledgeExtractionValueReading(input(), { assertCurrent: current }).read()).rejects.toMatchObject({ reason: 'uncertain' });
    installJudgmentPort(undefined);
    await expect(prepareKnowledgeExtractionValueReading(input(), { assertCurrent: current }).read()).rejects.toMatchObject({ reason: 'unconfigured' });
  });

  test('protected late input fields are refused before the first request', () => {
    const fake = readings(), original = input();
    Object.assign(original.source, { password: 'synthetic-protected' });
    expect(() => prepareKnowledgeExtractionValueReading(original, { assertCurrent: current })).toThrow(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });

  test('accessors, hidden fields and sparse arrays are refused without executing getters', () => {
    const fake = readings(); let calls = 0;
    const accessor = input(); Object.defineProperty(accessor.source, 'title', { get() { calls++; return 'AC-7'; }, enumerable: true });
    const hidden = input(); Object.defineProperty(hidden.extraction, 'late', { value: 'late content', enumerable: false });
    const sparse = input(); delete sparse.extraction.sections[0];
    for (const original of [accessor, hidden, sparse]) expect(() => prepareKnowledgeExtractionValueReading(original, { assertCurrent: current })).toThrow(KnowledgeExtractionValueHeldError);
    expect(calls).toBe(0); expect(fake.requests).toHaveLength(0);
  });

  test('large complete input reaches the reader without sampling while privacy admission still applies', async () => {
    const original = input('a'.repeat(160_001));
    const fake = readings(.99, original);
    await prepareKnowledgeExtractionValueReading(original, { assertCurrent: current }).read();
    expect(fake.requests).toHaveLength(1);
    expect(JSON.stringify(fake.requests[0]!.state)).toContain(original.text);
    const protectedInput = input('a'.repeat(160_001)); Object.assign(protectedInput.source, { password: 'synthetic-protected' });
    expect(() => prepareKnowledgeExtractionValueReading(protectedInput, { assertCurrent: current })).toThrow(JudgmentInputError);
    expect(fake.requests).toHaveLength(1);
  });

  test.each(['source', 'text', 'extraction', 'options', 'port'] as const)('%s mutation during the request cannot be adopted', async mutation => {
    const original = input(), options = { assertCurrent: current }, fake = readings();
    installJudgmentPort({ ...fake.port, async ask(request) {
      const result = await fake.port.ask(request);
      if (mutation === 'source') original.source.title = 'Replacement device';
      if (mutation === 'text') original.text = 'Replacement content';
      if (mutation === 'extraction') original.extraction.sections.push('Replacement content');
      if (mutation === 'options') options.assertCurrent = () => {};
      if (mutation === 'port') installJudgmentPort(fake.port);
      return result;
    } });
    await expect(prepareKnowledgeExtractionValueReading(original, options).read()).rejects.toMatchObject({ reason: 'stale' });
  });

  test('an asynchronous caller callback cannot confer currentness', async () => {
    const fake = readings();
    await expect(prepareKnowledgeExtractionValueReading(input(), { assertCurrent: async () => {} }).read()).rejects.toMatchObject({ reason: 'stale' });
    expect(fake.requests).toHaveLength(0);
  });

  test('a caller-options accessor is rejected before it can run', () => {
    const fake = readings(); let calls = 0;
    const options = { assertCurrent: current };
    Object.defineProperty(options, 'assertCurrent', { get() { calls++; return current; }, enumerable: true });
    expect(() => prepareKnowledgeExtractionValueReading(input(), options)).toThrow(KnowledgeExtractionValueHeldError);
    expect(calls).toBe(0); expect(fake.requests).toHaveLength(0);
  });

  test('a settled reading retains its original port and source through later consumption', async () => {
    const original = input(), fake = readings();
    const plan = prepareKnowledgeExtractionValueReading(original, { assertCurrent: current });
    expect(await plan.read()).toBe(true);
    installJudgmentPort({ ...fake.port });
    expect(plan.assertCurrent).toThrow(KnowledgeExtractionValueHeldError);
    installJudgmentPort(fake.port);
    expect(plan.assertCurrent).toThrow(KnowledgeExtractionValueHeldError);
  });

  test('cancellation interrupts an ignored signal and consumes late settlement', async () => {
    const fake = readings(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), controller = new AbortController();
    installJudgmentPort({ ...fake.port, async ask(request) { started.resolve(); await release.promise; return fake.port.ask(request); } });
    const result = prepareKnowledgeExtractionValueReading(input(), { assertCurrent: current, signal: controller.signal }).read();
    const outcome = result.catch((error: unknown) => error);
    try {
      await started.promise; controller.abort();
      expect(await outcome).toMatchObject({ reason: 'aborted' });
    } finally { release.resolve(); await outcome; }
  });

  test('a native timeout interrupts an ignored signal without extending the original limit', async () => {
    const fake = readings(), release = Promise.withResolvers<void>();
    installJudgmentPort({ ...fake.port, async ask(request) { await release.promise; return fake.port.ask(request); } });
    const outcome = prepareKnowledgeExtractionValueReading(input(), { assertCurrent: current, timeoutMs: 10 }).read().catch((error: unknown) => error);
    try { expect(await outcome).toMatchObject({ reason: 'budget' }); }
    finally { release.resolve(); await outcome; }
  });

  test('malformed response probabilities and unknown protected metadata cannot become yes', async () => {
    const fake = readings();
    installJudgmentPort({ ...fake.port, async ask(request) {
      const result = await fake.port.ask(request);
      return Object.assign(result, { answers: { extractionValue: { type: 'noul', noul: 2 } } });
    } });
    await expect(prepareKnowledgeExtractionValueReading(input(), { assertCurrent: current }).read()).rejects.toMatchObject({ reason: 'malformed' });
    installJudgmentPort({ ...fake.port, async ask(request) { return Object.assign(await fake.port.ask(request), { password: 'synthetic-protected' }); } });
    await expect(prepareKnowledgeExtractionValueReading(input(), { assertCurrent: current }).read()).rejects.toBeInstanceOf(JudgmentInputError);
  });
});

async function fixture(text: string) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-extraction-value-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const source = await store.upsertSource({ id: 'short-source', connectorId: 'fixture', sourceType: 'manual', title: 'AC-7', status: 'indexed' });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'fixture', format: 'text', excerpt: text });
  return { store, source, extraction };
}
function callerReadings(item: Awaited<ReturnType<typeof fixture>>, probability: number) {
  const fixtures = [extractionValueFixtureFor(item.source, item.extraction, probability)];
  const fake = fakePort((name, question, state) => {
    const value = extractionValueFixtureReading(name, question, state, fixtures);
    if (value !== undefined) return noulAnswer(value);
    if (name === 'included') return noulAnswer(0.99);
    throw new Error(`Unscripted extraction caller question: ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}


describe('exact extraction-value fixture admission', () => {
  const question = knowledgeExtractionValue.items.extractionValue.question;
  test('unlisted requests fail while independently authored negative observations remain no', () => {
    const original = input();
    expect(() => extractionValueFixtureReading('extractionValue', question, original)).toThrow('Unscripted complete extraction-value fixture input');
    const fixtures: ExtractionValueFixtures = [[captureStrictJudgmentJson(original), 0.01]];
    expect(extractionValueFixtureReading('extractionValue', question, original, fixtures)).toBe(0.01);
  });
  test.each(['source-summary', 'source-description', 'source-uri', 'source-type', 'source-status', 'source-trust', 'source-provenance',
    'extraction-format', 'extraction-title', 'extraction-summary', 'extraction-excerpt', 'extraction-sections', 'text', 'extra-field'] as const)(
    'changed %s cannot match an otherwise identical title and semantic text', change => {
      const original = input(), fixtures: ExtractionValueFixtures = [[captureStrictJudgmentJson(original), 0.99]];
      if (change === 'source-summary') original.source.summary = 'Different summary';
      if (change === 'source-description') original.source.description = 'Different description';
      if (change === 'source-uri') original.source.uri = 'manual://different-source';
      if (change === 'source-type') Object.assign(original.source, { sourceType: 'document' });
      if (change === 'source-status') Object.assign(original.source, { status: 'stale' });
      if (change === 'source-trust') original.source.trust = 'Different trust claim';
      if (change === 'source-provenance') original.source.claimedProvenance.domain = 'different.example';
      if (change === 'extraction-format') Object.assign(original.extraction, { format: 'html' });
      if (change === 'extraction-title') Object.assign(original.extraction, { title: 'Different extraction title' });
      if (change === 'extraction-summary') Object.assign(original.extraction, { summary: 'Different extraction summary' });
      if (change === 'extraction-excerpt') original.extraction.excerpt = 'Different excerpt';
      if (change === 'extraction-sections') original.extraction.sections.push('Different section');
      if (change === 'text') original.text = 'Different full text';
      if (change === 'extra-field') Object.assign(original, { extra: undefined });
      expect(() => extractionValueFixtureReading('extractionValue', question, original, fixtures)).toThrow('Unscripted complete extraction-value fixture input');
    });
  test('canonical item and complete question schema must both match', () => {
    const original = input(), fixtures: ExtractionValueFixtures = [[captureStrictJudgmentJson(original), 0.99]];
    expect(() => extractionValueFixtureReading('otherPurpose', question, original, fixtures)).toThrow('Unscripted extraction-value fixture purpose');
    expect(() => extractionValueFixtureReading('extractionValue', { ...question, instructions: 'Replacement instructions' }, original, fixtures)).toThrow('Unscripted extraction-value fixture purpose');
    expect(() => extractionValueFixtureReading('extractionValue', Object.assign({ ...question }, { extra: 'Unregistered schema field' }), original, fixtures)).toThrow('Unscripted extraction-value fixture purpose');
    expect(extractionValueFixtureReading('otherPurpose', { ...question, instructions: 'Other registered purpose' }, original, fixtures)).toBeUndefined();
  });
  test('native fixture registration detaches complete source and extraction evidence', async () => {
    const item = await fixture('Mass: 12 kg.');
    const authored = extractionValueFixtureFor(item.source, item.extraction, 0.99);
    const original = structuredClone(authored[0]);
    Object.assign(item.source, { summary: 'Changed after registration' });
    Object.assign(item.extraction, { sections: [...item.extraction.sections, 'Changed after registration'] });
    expect(Object.isFrozen(authored[0].source)).toBe(true);
    expect(Object.isFrozen(authored[0].extraction.sections)).toBe(true);
    expect(extractionValueFixtureReading('extractionValue', question, original, [authored])).toBe(0.99);
    const replacement = extractionValueFixtureFor(item.source, item.extraction, 0.99);
    expect(() => extractionValueFixtureReading('extractionValue', question, replacement[0], [authored])).toThrow('Unscripted complete extraction-value fixture input');
  });
});

describe('original enrichment and reindex extraction-value callers', () => {
  test('direct enrichment reaches the actual generation call for a short concrete source', async () => {
    const item = await fixture('Mass: 12 kg.'), fake = callerReadings(item, 0.99); let calls = 0;
    const sentinel = new Error('Synthetic generation reached');
    await expect(enrichKnowledgeSource({ store: item.store, llm: { async completeJson() { calls++; throw sentinel; }, async completeText() { return null; } } }, item.source, { force: true })).rejects.toBe(sentinel);
    expect(calls).toBe(1); expect(fake.requests.filter(request => 'extractionValue' in request.questions)).toHaveLength(1);
    expect(item.store.getSemanticEnrichmentState(item.source.id)).toBeNull(); expect(item.store.listNodes()).toHaveLength(0);
  });

  test('long source with a settled no makes no generation call and records an honest skip', async () => {
    const item = await fixture('Welcome to the documentation portal. Browse the documentation pages and contact the publisher for information.'), fake = callerReadings(item, 0.01); let calls = 0;
    const result = await enrichKnowledgeSource({ store: item.store, llm: { async completeJson() { calls++; return null; }, async completeText() { return null; } } }, item.source, { force: true });
    expect(result.skipped).toBe(true); expect(result.reason).toContain('no concrete fact'); expect(calls).toBe(0);
    expect(fake.requests.filter(request => 'extractionValue' in request.questions)).toHaveLength(1);
    expect(item.store.listNodes()).toHaveLength(0);
  });

  test('unsettled extraction value leaves every native store record unchanged', async () => {
    const item = await fixture('Mass: 12 kg.'); callerReadings(item, 0.5); let calls = 0;
    const before = JSON.stringify({ sources: item.store.listSources(), nodes: item.store.listNodes(), edges: item.store.listEdges(), extraction: item.store.getExtractionBySourceId(item.source.id) });
    await expect(enrichKnowledgeSource({ store: item.store, llm: { async completeJson() { calls++; return null; }, async completeText() { return null; } } }, item.source, { force: true })).rejects.toMatchObject({ reason: 'uncertain' });
    expect(calls).toBe(0); expect(item.store.getSemanticEnrichmentState(item.source.id)).toBeNull();
    expect(JSON.stringify({ sources: item.store.listSources(), nodes: item.store.listNodes(), edges: item.store.listEdges(), extraction: item.store.getExtractionBySourceId(item.source.id) })).toBe(before);
  });

  test.each(['source', 'extraction', 'stop'] as const)('native %s change during value reading prevents generation and publication', async mutation => {
    const item = await fixture('Mass: 12 kg.'), fake = callerReadings(item, 0.99); let calls = 0, stopped = false;
    installJudgmentPort({ ...fake.port, async ask(request) {
      const result = await fake.port.ask(request);
      if ('extractionValue' in request.questions) {
        if (mutation === 'source') await item.store.upsertSource({ ...item.source, title: 'Changed source' });
        if (mutation === 'extraction') await item.store.upsertExtraction({ sourceId: item.source.id, extractorId: 'fixture', format: 'text', excerpt: 'Corrected source text.' });
        if (mutation === 'stop') stopped = true;
      }
      return result;
    } });
    await expect(enrichKnowledgeSource({ store: item.store, llm: { async completeJson() { calls++; return null; }, async completeText() { return null; } } }, item.source,
      { force: true, shouldStop: () => stopped })).rejects.toBeInstanceOf(KnowledgeExtractionValueHeldError);
    expect(calls).toBe(0); expect(item.store.getSemanticEnrichmentState(item.source.id)).toBeNull(); expect(item.store.listNodes()).toHaveLength(0);
  });

  test('the original service reindex gate reaches generation for the short concrete source', async () => {
    const item = await fixture('Mass: 12 kg.'); callerReadings(item, 0.99); let calls = 0;
    const service = new KnowledgeSemanticService(item.store, { maxLlmSourcesPerReindex: 1, scheduleSeam() {},
      llm: { async completeJson() { calls++; throw new Error('Synthetic generation reached'); }, async completeText() { return null; } } });
    const selfImprove = spyOn(service, 'selfImprove').mockResolvedValue({ scannedGaps: 0, candidateGaps: 0, processedGaps: 0, createdGaps: 0,
      repairableGaps: 0, suppressedGaps: 0, skippedGaps: 0, searched: 0, ingestedSources: 0, linkedRepairs: 0, blockedGaps: 0, closedGaps: 0,
      queuedTasks: 0, requestedLimit: 0, effectiveLimit: 0, truncated: false, budgetExhausted: false, taskIds: [], ingestedSourceIds: [], acceptedSourceIds: [], promotedFactCount: 0, errors: [] });
    try {
      const result = await service.reindex({ sourceIds: [item.source.id], force: true });
      expect(calls).toBe(1); expect(result.failed).toBe(1); expect(result.errors[0]?.error).toBe('Synthetic generation reached');
    } finally { selfImprove.mockRestore(); }
  });
});
