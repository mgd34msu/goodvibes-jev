import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { ArtifactRecord } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { modelReasonTheme, routingRegistry } from '@goodvibes-jev/engine/sdk/platform/routing';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { formatComparisonSynthesis } from '../../tools/agent-model-compare-judgment.ts';
import { readComparisonReasonThemes } from '../../tools/agent-model-compare-themes.ts';
import { createComparisonOperation } from '../../tools/agent-model-compare-operation.ts';
import type { AgentModelCompareArtifactStore, LoadedComparisonJudgment } from '../../tools/agent-model-compare-types.ts';
import { cleanupResearchScreeningFixtures, exactSensitiveSpans, ordinaryResearchOwner, researchScreeningFixture } from '../helpers/research-screening.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => { installJudgmentPort(previous); await cleanupResearchScreeningFixtures(); });
function fixture() {
  const judgment: LoadedComparisonJudgment = { artifact: { artifactId: 'judgment-a', mimeType: 'application/json', sizeBytes: 1 },
    judgmentId: 'synthetic-judgment', comparisonId: 'synthetic-comparison', winnerBlindId: 'B', sourceArtifactId: 'comparison-a',
    reasons: 'The losing response claimed clear and fast; I did not prefer those qualities.', notes: '', revealIncludedInJudgment: false };
  const contents: Record<string, unknown> = {
    'judgment-a': { schema: 'goodvibes.agent.model_compare_judgment.v1', judgmentId: judgment.judgmentId, comparisonId: judgment.comparisonId,
      winnerBlindId: 'B', sourceArtifactId: 'comparison-a', reasons: judgment.reasons, notes: '', originalUnknown: 'complete judgment metadata' },
    'comparison-a': { schema: 'goodvibes.agent.model_compare.v1', comparisonId: judgment.comparisonId,
      prompt: 'Full original prompt, including its tail.', systemPrompt: 'Original system prompt.', rubric: 'Original rubric.',
      candidates: [{ blindId: 'A', status: 'completed', content: 'Actual losing response.' },
        { blindId: 'B', status: 'completed', content: 'Actual winning response, including its tail.', usage: { inputTokens: 7, outputTokens: 11 } }],
      sourceArtifact: { artifactId: 'source-a' }, originalUnknown: 'complete comparison metadata' },
    'source-a': 'Full original source document, including its tail.',
  };
  const bytes = (id: string) => Buffer.from(typeof contents[id] === 'string' ? contents[id] as string : JSON.stringify(contents[id]));
  const records = Object.fromEntries(Object.keys(contents).map(id => [id, { id, kind: 'data', mimeType: id === 'source-a' ? 'text/plain' : 'application/json',
    sizeBytes: bytes(id).byteLength, sha256: createHash('sha256').update(bytes(id)).digest('hex'), createdAt: 0, acquisitionMode: 'inline-data', fetchMode: 'not-applicable',
    metadata: { provenance: 'owned synthetic artifact', unknownField: 'complete provenance metadata' },
    contentPath: '/synthetic/transport/' + id, metadataPath: '/synthetic/transport/' + id + '.json' } satisfies ArtifactRecord]));
  const store: AgentModelCompareArtifactStore = { create: async () => { throw new Error('No writes in theme reader'); },
    get: id => records[id], list: () => Object.values(records),
    async readContent(id) {
      const record = records[id]; if (!record) throw new Error('Unknown synthetic artifact');
      return { record, buffer: Buffer.from(typeof contents[id] === 'string' ? contents[id] as string : JSON.stringify(contents[id])) };
    } };
  const report = { request: { mode: 'synthesis', includeReasons: true, unrecognizedOriginal: 'complete request metadata' },
    limit: 20, includeReasons: true, filters: {} };
  return { judgment, contents, records, store, report };
}
function suspended() {
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { start, release, started, gate };
}

test('actual registered six-question reader preserves full originals, provenance and recorded action', async () => {
  const f = fixture(), fake = fakePort(name => noulAnswer(name === 'faithfulness' ? 0.999 : 0.001));
  using log = new SqliteDecisionLog(':memory:');
  installJudgmentPort(withDecisionLog(fake.port, log));
  const reading = await readComparisonReasonThemes(f.judgment, f.store, f.report, { sourceOwner: ordinaryResearchOwner() });
  expect(reading.status).toBe('settled');
  if (reading.status !== 'settled') throw new Error('Synthetic registered theme read was held');
  // Deliberately counter to legacy keywords: canonical readings alone determine the themes.
  expect(reading.themes).toEqual(['faithfulness']);
  expect(reading.provenance).toMatchObject({ battery: modelReasonTheme.name, version: 1, model: 'jev-1.13.0' });
  expect(typeof reading.provenance.decisionId).toBe('string');
  expect(fake.requests).toHaveLength(1);
  expect(Object.keys(fake.requests[0]!.questions)).toEqual(['actionable', 'clarity', 'faithfulness', 'context', 'safety', 'efficiency']);
  const state = JSON.stringify(fake.requests[0]!.state);
  for (const text of ['Full original prompt, including its tail.', 'Original system prompt.', 'Actual winning response, including its tail.',
    'Full original source document, including its tail.', 'complete judgment metadata', 'complete comparison metadata',
    'complete provenance metadata', 'complete request metadata']) expect(state).toContain(text);
  expect(state).not.toContain('/synthetic/transport/');
  const entries = log.query(); expect(entries).toHaveLength(1);
  expect(JSON.stringify(entries[0])).toContain('classified preference themes: faithfulness');
});

test('unsettled readings remain unresolved rather than uncategorized or keyword classified', async () => {
  const f = fixture(), fake = fakePort(() => noulAnswer(0.5));
  using log = new SqliteDecisionLog(':memory:'); installJudgmentPort(withDecisionLog(fake.port, log));
  const report = await formatComparisonSynthesis({ artifactStore: f.store, judgments: [f.judgment], request: f.report.request,
    limit: 20, includeReasons: true, filters: {}, storeAvailable: true, readingOptions: { sourceOwner: ordinaryResearchOwner() } });
  expect(report).toContain('Unresolved preference signal: 1 judgment');
  expect(report).not.toContain('Uncategorized preference signal');
  expect(report).not.toContain('Clear/scannable communication:');
  expect(report).toContain('No selected model was changed.');
  expect(JSON.stringify(log.query())).toContain('held preference theme classification');
});

test('only six settled negative readings produce the existing uncategorized bucket', async () => {
  const f = fixture(), fake = fakePort(() => noulAnswer(0.001)); installJudgmentPort(fake.port);
  const report = await formatComparisonSynthesis({ artifactStore: f.store, judgments: [f.judgment], limit: 20,
    includeReasons: false, filters: {}, storeAvailable: true, readingOptions: { sourceOwner: ordinaryResearchOwner() } });
  expect(report).toContain('Uncategorized preference signal: 1 judgment');
  expect(report).not.toContain('Unresolved preference signal');
});

test('missing source ownership makes zero theme requests', async () => {
  const f = fixture(), fake = fakePort(() => noulAnswer(0.999)); installJudgmentPort(fake.port);
  expect(await readComparisonReasonThemes(f.judgment, f.store, f.report, {})).toEqual({ status: 'held' });
  expect(fake.requests).toHaveLength(0);
});

test('card-shaped numeric artifact metadata remains held before thematic dispatch', async () => {
  const f = fixture(), fake = fakePort(() => noulAnswer(0.999)); installJudgmentPort(fake.port);
  // Synthetic epoch-shaped data that also satisfies the canonical card-number screen.
  Object.defineProperty(f.records['judgment-a']!, 'createdAt', { value: 1791691300001, enumerable: true });
  expect(await readComparisonReasonThemes(f.judgment, f.store, f.report, { sourceOwner: ordinaryResearchOwner() })).toEqual({ status: 'held' });
  expect(fake.requests).toHaveLength(0);
});

test('artifact method descriptor admission does not execute an accessor', async () => {
  const f = fixture(), fake = fakePort(() => noulAnswer(0.999)); let accessorCalls = 0;
  installJudgmentPort(fake.port);
  Object.defineProperty(f.store, 'readContent', { enumerable: true, get() { accessorCalls++; throw new Error('Synthetic borrowed getter'); } });
  expect(await readComparisonReasonThemes(f.judgment, f.store, f.report, { sourceOwner: ordinaryResearchOwner() })).toEqual({ status: 'held' });
  expect(accessorCalls).toBe(0); expect(fake.requests).toHaveLength(0);
});

for (const location of ['comparison', 'judgment', 'provenance', 'request', 'source'] as const) {
  test(`sensitive original ${location} content cannot enter thematic dispatch`, async () => {
    const f = fixture(), secret = 'synthetic-sensitive-marker';
    if (location === 'comparison') (f.contents['comparison-a'] as Record<string, unknown>).unknownSecret = secret;
    if (location === 'judgment') (f.contents['judgment-a'] as Record<string, unknown>).unknownSecret = secret;
    if (location === 'provenance') Object.defineProperty(f.records['comparison-a']!.metadata, 'unknownSecret', { value: secret, enumerable: true });
    if (location === 'request') f.report.request.unrecognizedOriginal = secret;
    if (location === 'source') f.contents['source-a'] = secret;
    const privacy = researchScreeningFixture({ spans: exactSensitiveSpans([secret]) });
    const fake = fakePort(() => noulAnswer(0.999)); installJudgmentPort(fake.port);
    expect(await readComparisonReasonThemes(f.judgment, f.store, f.report, { sourceOwner: privacy.owner })).toEqual({ status: 'held' });
    expect(fake.requests).toHaveLength(0);
    expect(JSON.stringify(privacy.calls)).toContain(secret);
  });
}

test('wrong comparison association holds before dispatch', async () => {
  const f = fixture(), fake = fakePort(() => noulAnswer(0.999)); installJudgmentPort(fake.port);
  (f.contents['comparison-a'] as Record<string, unknown>).comparisonId = 'different-comparison';
  expect(await readComparisonReasonThemes(f.judgment, f.store, f.report, { sourceOwner: ordinaryResearchOwner() })).toEqual({ status: 'held' });
  expect(fake.requests).toHaveLength(0);
});

test('cancelled privacy screening makes zero thematic requests', async () => {
  const f = fixture(), pending = suspended(), controller = new AbortController();
  const privacy = researchScreeningFixture({ beforeProposal: async () => { pending.start(); await pending.gate; } });
  const fake = fakePort(() => noulAnswer(0.999)); installJudgmentPort(fake.port);
  const reading = readComparisonReasonThemes(f.judgment, f.store, f.report, { sourceOwner: privacy.owner, signal: controller.signal });
  const outcome = reading.then(value => ({ value }), error => ({ error: error as unknown }));
  await pending.started; controller.abort(); pending.release();
  expect(await outcome).toHaveProperty('error');
  expect(fake.requests).toHaveLength(0);
});

test('source-owner freshness guard survives asynchronous privacy acquisition', async () => {
  const f = fixture(), pending = suspended(); let current = true;
  const privacy = researchScreeningFixture({ beforeProposal: async () => { pending.start(); await pending.gate; } });
  const fake = fakePort(() => noulAnswer(0.999)); installJudgmentPort(fake.port);
  const reading = readComparisonReasonThemes(f.judgment, f.store, f.report, { sourceOwner: privacy.owner,
    assertCurrent: () => { if (!current) throw new Error('Synthetic source revision expired'); } });
  const outcome = reading.then(value => ({ value }), error => ({ error: error as unknown }));
  await pending.started; current = false; pending.release();
  const result = await outcome;
  expect('error' in result && result.error instanceof Error ? result.error.message : null).toBe('Synthetic source revision expired');
  expect(fake.requests).toHaveLength(0);
});

test('actual comparison operation rejects changed source provenance during screening', async () => {
  const f = fixture(), pending = suspended();
  const operation = createComparisonOperation({ artifactStore: f.store, modelCatalog: { listModels: () => [] },
    providerRegistry: { getForModel: () => { throw new Error('No provider acquisition'); } } }, { mode: 'synthesis' });
  const privacy = researchScreeningFixture({ beforeProposal: async () => { pending.start(); await pending.gate; } });
  const fake = fakePort(() => noulAnswer(0.999)); installJudgmentPort(fake.port);
  const reading = readComparisonReasonThemes(f.judgment, operation.deps.artifactStore, f.report,
    { sourceOwner: privacy.owner, assertCurrent: operation.assertCurrent });
  const outcome = reading.then(value => ({ value }), error => ({ error: error as unknown }));
  await pending.started;
  Object.defineProperty(f.records['source-a']!.metadata, 'newProvenance', { value: 'Changed while screening', enumerable: true });
  pending.release();
  const result = await outcome;
  expect('error' in result && result.error instanceof Error ? result.error.message : null).toBe('Comparison source artifact changed during this operation.');
  expect(fake.requests).toHaveLength(0);
});

test('actual comparison operation refuses content not matching its source hash', async () => {
  const f = fixture(), operation = createComparisonOperation({ artifactStore: f.store, modelCatalog: { listModels: () => [] },
    providerRegistry: { getForModel: () => { throw new Error('No provider acquisition'); } } }, { mode: 'synthesis' });
  f.contents['source-a'] = 'Synthetic tampered body';
  const fake = fakePort(() => noulAnswer(0.999)); installJudgmentPort(fake.port);
  expect(await readComparisonReasonThemes(f.judgment, operation.deps.artifactStore, f.report,
    { sourceOwner: ordinaryResearchOwner(), assertCurrent: operation.assertCurrent })).toEqual({ status: 'held' });
  expect(fake.requests).toHaveLength(0);
});

test('replacing the installed port while an answer is pending cannot publish themes', async () => {
  const f = fixture(), pending = suspended(), fake = fakePort(() => noulAnswer(0.999));
  const delayed: JudgmentPort = { ...fake.port, async ask(request) { pending.start(); await pending.gate; return fake.port.ask(request); } };
  installJudgmentPort(delayed);
  const reading = readComparisonReasonThemes(f.judgment, f.store, f.report, { sourceOwner: ordinaryResearchOwner() });
  await pending.started; installJudgmentPort(fakePort(() => noulAnswer(0.001)).port); pending.release();
  expect(await reading).toEqual({ status: 'held' });
});

test('complete provider response admission refuses private unknown fields before classification', async () => {
  const f = fixture(), fake = fakePort(() => noulAnswer(0.999));
  const borrowed: JudgmentPort = { ...fake.port, async ask(request) {
    return { ...await fake.port.ask(request), unrecognizedOriginal: { apiKey: 'synthetic-response-private-marker' } };
  } };
  installJudgmentPort(borrowed);
  expect(await readComparisonReasonThemes(f.judgment, f.store, f.report, { sourceOwner: ordinaryResearchOwner() })).toEqual({ status: 'held' });
  expect(fake.requests).toHaveLength(1);
});

test('complete response descriptor capture does not execute an accessor', async () => {
  const f = fixture(), fake = fakePort(() => noulAnswer(0.999)); let accessorCalls = 0;
  const borrowed: JudgmentPort = { ...fake.port, async ask(request) {
    const response = await fake.port.ask(request);
    Object.defineProperty(response, 'unrecognizedOriginal', { enumerable: true, get() { accessorCalls++; return 'synthetic'; } });
    return response;
  } };
  installJudgmentPort(borrowed);
  expect(await readComparisonReasonThemes(f.judgment, f.store, f.report, { sourceOwner: ordinaryResearchOwner() })).toEqual({ status: 'held' });
  expect(accessorCalls).toBe(0);
});

test('an uncalibrated observed model cannot classify preference themes', async () => {
  const f = fixture(), fake = fakePort(() => noulAnswer(0.999));
  const borrowed: JudgmentPort = { ...fake.port, async ask(request) { return { ...await fake.port.ask(request), model: 'jev-9.99.0' }; } };
  installJudgmentPort(borrowed);
  expect(await readComparisonReasonThemes(f.judgment, f.store, f.report, { sourceOwner: ordinaryResearchOwner() })).toEqual({ status: 'held' });
});

test('mutating the registered definition while an answer is pending holds the read', async () => {
  const f = fixture(), pending = suspended(), fake = fakePort(() => noulAnswer(0.999));
  const delayed: JudgmentPort = { ...fake.port, async ask(request) { pending.start(); await pending.gate; return fake.port.ask(request); } };
  installJudgmentPort(delayed);
  const reading = readComparisonReasonThemes(f.judgment, f.store, f.report, { sourceOwner: ordinaryResearchOwner() });
  await pending.started;
  const descriptor = Object.getOwnPropertyDescriptor(modelReasonTheme, 'version')!;
  try { Object.defineProperty(modelReasonTheme, 'version', { ...descriptor, value: 2 }); pending.release();
    expect(await reading).toEqual({ status: 'held' });
  } finally { Object.defineProperty(modelReasonTheme, 'version', descriptor); }
  expect(routingRegistry.get(modelReasonTheme.name)).toBe(modelReasonTheme);
});
