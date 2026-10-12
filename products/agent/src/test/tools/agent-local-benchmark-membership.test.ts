import { afterAll, afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ArtifactStore, type ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { localBenchmarkPrompt, localBenchmarkPromptPolicy, routingRegistry } from '@goodvibes-jev/engine/sdk/platform/routing';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { localBenchmarkRouteLatencyMapFor, localModelBenchmarkHistory, localModelBenchmarkHistoryFrom,
  readLocalModelBenchmarkHistory, readLocalModelBenchmarkSnapshot, type BenchmarkArtifactContext } from '../../tools/agent-harness-local-model-benchmarks.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner, researchScreeningFixture } from '../helpers/research-screening.ts';

let previous: ReturnType<typeof installJudgmentPort>;
const directories: string[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => {
  installJudgmentPort(previous);
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
afterAll(cleanupResearchScreeningFixtures);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jev-local-benchmark-membership-')); directories.push(directory);
  const store = new ArtifactStore({ rootDir: directory });
  const context: BenchmarkArtifactContext = { platform: { artifactStore: store } };
  return { context, store };
}
async function comparison(store: ArtifactStore, prompt: string, metadata: Record<string, unknown> = {}): Promise<ArtifactDescriptor> {
  return store.create({ kind: 'data', mimeType: 'application/json', filename: 'comparison.json',
    text: JSON.stringify({ schema: 'goodvibes.agent.model_compare.v1', prompt, candidates: [
      { blindId: 'A', status: 'completed', content: 'The actual complete synthetic candidate response.' },
    ] }), metadata: { purpose: 'agent-model-compare', promptPreview: prompt.slice(0, 160), completedCandidates: 1,
      candidateLatencyEvidence: [{ registryKey: 'synthetic:route', latencyMs: 127, status: 'completed' }], ...metadata } });
}
async function judgment(store: ArtifactStore, notes: string, metadata: Record<string, unknown> = {}): Promise<ArtifactDescriptor> {
  return store.create({ kind: 'data', mimeType: 'application/json', filename: 'judgment.json',
    text: JSON.stringify({ schema: 'goodvibes.agent.model_compare_judgment.v1', reasons: notes, notes }),
    metadata: { purpose: 'agent-model-compare-judgment', promptPreview: notes.slice(0, 160), ...metadata } });
}
function deferred() {
  let resolve: () => void = () => { throw new Error('Deferred initialization did not finish'); };
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('registered canonical battery owns the membership decision and original synthetic fixtures', () => {
  expect(() => localBenchmarkPromptPolicy.assertCurrent()).not.toThrow();
  expect(routingRegistry.get(localBenchmarkPrompt.name)).toBe(localBenchmarkPrompt);
  expect(localBenchmarkPrompt.model).toBe('jev-1.13.0');
  expect(Object.keys(localBenchmarkPrompt.items)).toEqual(['member']);
  expect(localBenchmarkPrompt.fixtures.some(fixture => fixture.expect.member === 'yes')).toBe(true);
  expect(localBenchmarkPrompt.fixtures.some(fixture => fixture.expect.member === 'no')).toBe(true);
});

test('startup credits exact typed native kind and exact source linkage without a port or text fallback', async () => {
  const f = await fixture();
  const native = await comparison(f.store, 'The native producer declares this artifact.', { benchmarkKind: 'local-model-route' });
  await comparison(f.store, 'local model benchmark: misleading preview only');
  const linked = await judgment(f.store, 'Native linked review.', { sourceArtifactId: native.id });
  await judgment(f.store, 'local model benchmark: unlinked title only', { sourceArtifactId: 'missing-source' });
  const result = localModelBenchmarkHistory(f.context, true);
  expect(result.evidence).toMatchObject({ comparisonCount: 1, completedCandidateCount: 1, hiddenJudgmentCount: 1 });
  expect(result.artifacts).toMatchObject([{ artifactId: native.id }]);
  expect(result.judgments).toMatchObject([{ artifactId: linked.id }]);
  expect(result.evidence.winnerStacks).toEqual([]);
});

test('explicit unmarked membership reads the entire native body and undisplayed metadata before evidence credit', async () => {
  const f = await fixture();
  const prompt = 'Background context. '.repeat(20) + 'Evaluate the on-device endpoint against our hosted baseline for the same task and record latency before selecting a route.';
  const artifact = await comparison(f.store, prompt, { undisplayed: { note: 'Retained complete synthetic provenance.' } });
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  const snapshot = await readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: ordinaryResearchOwner() });
  expect(snapshot.comparisons.map(artifact => artifact.id)).toEqual([artifact.id]);
  expect(snapshot.membership).toMatchObject([{ artifactId: artifact.id, outcome: 'act', verdict: 'yes' }]);
  expect(fake.requests).toHaveLength(1);
  const source = JSON.stringify(fake.requests[0]!.state);
  expect(source).toContain(JSON.stringify(prompt).slice(1, -1));
  expect(source).toContain('Retained complete synthetic provenance.');
  expect(source).toContain('actual complete synthetic candidate response');
  expect(localBenchmarkRouteLatencyMapFor(snapshot).get('synthetic:route')?.latencyMs).toBe(127);
  expect(localModelBenchmarkHistoryFrom(snapshot, false).evidence.comparisonCount).toBe(1);
});

test.each([
  ['settled no', 0.01, 'act', 'no'], ['uncertain', 0.55, 'hold', 'unknown'],
  ['below the original acting band', 0.7, 'hold', 'unknown'],
] as const)('misleading preview earns no credit on %s', async (_name, probability, outcome, verdict) => {
  const f = await fixture();
  await comparison(f.store, 'Do not run a local model benchmark. This hosted-only comparison is about translation.');
  const fake = fakePort(() => noulAnswer(probability)); installJudgmentPort(fake.port);
  const result = await readLocalModelBenchmarkHistory(f.context, true, { sourceOwner: ordinaryResearchOwner() });
  expect(result.evidence).toMatchObject({ comparisonCount: 0, completedCandidateCount: 0, status: 'unmeasured', routeLatencies: [] });
  expect(result.membership).toMatchObject([{ outcome, verdict }]);
  expect(fake.requests).toHaveLength(1);
});

test('orphan judgments receive their own complete-source reading and never inherit model identity as membership', async () => {
  const f = await fixture();
  const artifact = await judgment(f.store, 'This saved review evaluates the on-device endpoint against our hosted baseline for practical waiting time.');
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  const result = await readLocalModelBenchmarkHistory(f.context, true, { sourceOwner: ordinaryResearchOwner() });
  expect(result.evidence).toMatchObject({ comparisonCount: 0, hiddenJudgmentCount: 1 });
  expect(result.judgments).toMatchObject([{ artifactId: artifact.id }]);
  expect(fake.requests).toHaveLength(1);
  expect(JSON.stringify(fake.requests[0]!.state)).toContain('practical waiting time');
});

test('exact source-id links require no second membership inference', async () => {
  const f = await fixture();
  const source = await comparison(f.store, 'Compare this machine’s inference endpoint with a hosted baseline on the repository task.');
  const linked = await judgment(f.store, 'A linked review with no lexical marker.', { sourceArtifactId: source.id });
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  const snapshot = await readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: ordinaryResearchOwner() });
  expect(snapshot.judgments.map(artifact => artifact.id)).toEqual([linked.id]);
  expect(fake.requests).toHaveLength(1);
  expect(snapshot.membership.map(reading => reading.artifactId)).toEqual([source.id]);
});

test('a text marker with no complete native body holds before a request or evidence credit', async () => {
  const f = await fixture(); const artifact = await comparison(f.store, 'local model benchmark');
  const context: BenchmarkArtifactContext = { platform: { artifactStore: { list: () => [artifact] } } };
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  const result = await readLocalModelBenchmarkHistory(context, true, { sourceOwner: ordinaryResearchOwner() });
  expect(result.evidence.comparisonCount).toBe(0);
  expect(result.membership).toMatchObject([{ outcome: 'hold', verdict: 'unknown', reason: 'complete-artifact-source-unavailable' }]);
  expect(fake.requests).toHaveLength(0);
});

test('no protected owner holds only unmarked sources; explicit native history remains available', async () => {
  const f = await fixture();
  await comparison(f.store, 'local model benchmark: unmarked');
  const native = await comparison(f.store, 'Declared by the native producer.', { benchmarkKind: 'local-model-route' });
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  const snapshot = await readLocalModelBenchmarkSnapshot(f.context, {});
  expect(snapshot.comparisons.map(artifact => artifact.id)).toEqual([native.id]);
  expect(snapshot.membership).toMatchObject([{ outcome: 'hold', reason: 'protected-source-owner-unavailable' }]);
  expect(fake.requests).toHaveLength(0);
});

test('privacy uncertainty refuses the complete artifact before canonical port acquisition', async () => {
  const f = await fixture(); await comparison(f.store, 'Evaluate the laptop endpoint against the hosted baseline.');
  const screening = researchScreeningFixture({ complete: 0.55 });
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  await expect(readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: screening.owner })).rejects.toThrow();
  expect(fake.requests).toHaveLength(0);
});

test.each(['artifact', 'content', 'definition', 'store-method', 'port', 'authority', 'signal'] as const)('pending membership cannot publish after %s retirement', async retirement => {
  const f = await fixture(); const artifact = await comparison(f.store, 'Compare the on-device endpoint with the hosted baseline.');
  const entered = deferred(), release = deferred(); const controller = new AbortController(); let revoked = false;
  let content: Awaited<ReturnType<ArtifactStore['readContent']>> | undefined;
  const originalReadContent = f.store.readContent;
  f.store.readContent = async id => { content = await originalReadContent.call(f.store, id); return content; };
  const question = localBenchmarkPrompt.items.member.question;
  const originalField = Object.getOwnPropertyDescriptor(question, 'retiredFixtureOnly');
  const fake = fakePort(() => noulAnswer(0.99));
  const nativeTails: Promise<unknown>[] = [];
  installJudgmentPort({ ...fake.port, ask: request => {
    const tail = (async () => { entered.resolve(); await release.promise; return fake.port.ask(request); })();
    nativeTails.push(tail); return tail;
  } });
  const pending = readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: ordinaryResearchOwner(), signal: controller.signal,
    assertCurrent: () => { if (revoked) throw new Error('Synthetic native authority retired'); } });
  const observed = pending.then(() => ({ accepted: true }), () => ({ accepted: false }));
  try {
    await Promise.race([entered.promise, observed.then(() => { throw new Error('Membership settled before the retained request began'); })]);
    if (retirement === 'artifact') f.store.delete(artifact.id);
    if (retirement === 'content') { if (!content) throw new Error('Native body was not acquired'); content.buffer[0] = 0; }
    if (retirement === 'definition') Object.defineProperty(question, 'retiredFixtureOnly', { value: true, configurable: true, enumerable: true });
    if (retirement === 'store-method') f.store.list = () => [];
    if (retirement === 'port') installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    if (retirement === 'authority') revoked = true;
    if (retirement === 'signal') controller.abort(new Error('Synthetic caller cancellation'));
    release.resolve();
    expect(await observed).toEqual({ accepted: false });
  } finally {
    release.resolve(); await observed; await Promise.allSettled(nativeTails);
    if (originalField) Object.defineProperty(question, 'retiredFixtureOnly', originalField); else Reflect.deleteProperty(question, 'retiredFixtureOnly');
  }
});

test('complete native content mismatch refuses before hosted membership inference', async () => {
  const f = await fixture(); const artifact = await comparison(f.store, 'Evaluate the on-device endpoint.');
  const original = f.store.readContent;
  f.store.readContent = async id => { const result = await original.call(f.store, id); result.buffer[0] = 0; return result; };
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  await expect(readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: ordinaryResearchOwner() })).rejects.toThrow();
  expect(fake.requests).toHaveLength(0);
  expect(f.store.get(artifact.id)).not.toBeNull();
});

test('malformed canonical answer cannot credit a saved artifact', async () => {
  const f = await fixture(); await comparison(f.store, 'Evaluate our laptop route against the baseline.');
  const fake = fakePort(() => ({ type: 'noul', noul: 2 })); installJudgmentPort(fake.port);
  await expect(readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: ordinaryResearchOwner() })).rejects.toThrow();
});


test('retained native publication guards survive completed private receipt release', async () => {
  const f = await fixture(); const artifact = await comparison(f.store, 'Compare the locally served endpoint with our baseline.');
  const guards: (() => void)[] = [];
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  const snapshot = await readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: ordinaryResearchOwner(), retainCurrent: guard => { guards.push(guard); } });
  expect(snapshot.comparisons).toHaveLength(1);
  expect(() => { for (const guard of guards) guard(); }).not.toThrow();
  f.store.delete(artifact.id);
  expect(() => { for (const guard of guards) guard(); }).toThrow();
});

test('native links remain deterministic beyond the displayed history slice', async () => {
  const f = await fixture(); const source = await comparison(f.store, 'Declared native benchmark.', { benchmarkKind: 'local-model-route' });
  for (let index = 0; index < 4; index++) await comparison(f.store, `Declared native benchmark ${index}.`, { benchmarkKind: 'local-model-route' });
  const linked = await judgment(f.store, 'Review of the original native benchmark.', { sourceArtifactId: source.id });
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  const snapshot = await readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: ordinaryResearchOwner() });
  expect(snapshot.comparisons).toHaveLength(5);
  const display = localModelBenchmarkHistoryFrom(snapshot, false);
  expect(display.artifacts).toHaveLength(3);
  expect(display.judgments).toMatchObject([{ artifactId: linked.id }]);
  expect(fake.requests).toHaveLength(0);
});


test('hidden metadata accessor is refused without invoking it or acquiring the port', async () => {
  const f = await fixture(); const artifact = await comparison(f.store, 'Evaluate the local endpoint.'); let calls = 0;
  Object.defineProperty(artifact.metadata, 'hiddenProvenance', { configurable: true, get() { calls++; return 'unsafe source'; } });
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  await expect(readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: ordinaryResearchOwner() })).rejects.toThrow();
  expect(calls).toBe(0); expect(fake.requests).toHaveLength(0);
});


test.each(['pending', 'non-void', 'borrowed-thenable'] as const)('non-synchronous %s caller restriction refuses before native acquisition or membership dispatch', async kind => {
  const f = await fixture(); await comparison(f.store, 'Evaluate this machine’s inference route.');
  let listCalls = 0, thenReads = 0, callerCalls = 0;
  const nativeList = f.store.list;
  f.store.list = limit => { listCalls++; return nativeList.call(f.store, limit); };
  let rejectOwner: (reason: unknown) => void = () => { throw new Error('Pending owner initialization did not finish'); };
  const ownerTail = new Promise<void>((_resolve, reject) => { rejectOwner = reject; });
  const observedTail = ownerTail.then(() => ({ refused: false }), () => ({ refused: true }));
  const borrowed = Object.defineProperty({}, 'then', { get() { thenReads++; throw new Error('Borrowed then accessor must stay local'); } });
  const callerCurrent = () => { callerCalls++; return kind === 'pending' ? ownerTail : kind === 'non-void' ? true : borrowed; };
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  const pending = readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: ordinaryResearchOwner(), assertCurrent: callerCurrent });
  const observed = pending.then(() => ({ accepted: true }), () => ({ accepted: false }));
  try {
    expect(await observed).toEqual({ accepted: false });
    expect(callerCalls).toBe(1); expect(listCalls).toBe(0); expect(fake.requests).toHaveLength(0); expect(thenReads).toBe(0);
  } finally {
    rejectOwner(new Error('Synthetic late owner refusal')); await observedTail; await observed;
  }
});

test('native generated artifact clocks keep their exact instants while the raw history retains its epochs', async () => {
  const timestamp = 1_791_684_509_006;
  setSystemTime(new Date(timestamp));
  try {
    const f = await fixture();
    const artifact = await f.store.create({ kind: 'data', mimeType: 'application/json', filename: 'native-clock-comparison.json', retentionMs: 60_000,
      text: JSON.stringify({ schema: 'goodvibes.agent.model_compare.v1', prompt: 'Evaluate the workstation endpoint on the same task before selecting a route.', candidates: [] }),
      metadata: { purpose: 'agent-model-compare' } });
    const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    const snapshot = await readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: ordinaryResearchOwner() });
    expect(snapshot.comparisons).toMatchObject([{ id: artifact.id, createdAt: timestamp, expiresAt: timestamp + 60_000 }]);
    expect(fake.requests).toHaveLength(1);
    const source = JSON.stringify(fake.requests[0]!.state);
    expect(source).toContain(new Date(timestamp).toISOString()); expect(source).toContain(new Date(timestamp + 60_000).toISOString());
    expect(source).not.toContain(String(timestamp)); expect(source).not.toContain(String(timestamp + 60_000));
  } finally { setSystemTime(); }
});

test.each(['metadata', 'body'] as const)('the same numeric clock in borrowed %s remains subject to privacy refusal', async location => {
  const f = await fixture(); const timestamp = 1_791_684_509_006;
  await comparison(f.store, location === 'body' ? `Evaluate this endpoint. Borrowed number: ${timestamp}.` : 'Evaluate this endpoint.',
    location === 'metadata' ? { copiedClock: timestamp } : {});
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  await expect(readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: ordinaryResearchOwner() })).rejects.toThrow();
  expect(fake.requests).toHaveLength(0);
});

test('native list array accessors refuse before normalization without executing borrowed code', async () => {
  const f = await fixture(); const artifact = await comparison(f.store, 'Evaluate the local inference route.'); let calls = 0;
  const artifacts = [artifact];
  Object.defineProperty(artifacts, 'map', { configurable: true, get() { calls++; throw new Error('Borrowed array operation must not execute'); } });
  f.store.list = () => artifacts;
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  await expect(readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: ordinaryResearchOwner() })).rejects.toThrow();
  expect(calls).toBe(0); expect(fake.requests).toHaveLength(0);
});


type PolicyRetirement = 'published-items' | 'original-band' | 'run';
function policyControl() {
  const originalItems = localBenchmarkPrompt.items, originalRun = localBenchmarkPrompt.run;
  const yesBand = originalItems.member.band.yes;
  const itemsDescriptor = Object.getOwnPropertyDescriptor(localBenchmarkPrompt, 'items');
  const runDescriptor = Object.getOwnPropertyDescriptor(localBenchmarkPrompt, 'run');
  const actAtDescriptor = Object.getOwnPropertyDescriptor(yesBand, 'actAt');
  if (!itemsDescriptor || !runDescriptor || !actAtDescriptor) throw new Error('Native policy control descriptors are absent');
  return {
    retire(kind: PolicyRetirement) {
      if (kind === 'published-items') Object.defineProperty(localBenchmarkPrompt, 'items', { ...itemsDescriptor, value: structuredClone(originalItems) });
      if (kind === 'original-band') Object.defineProperty(yesBand, 'actAt', { ...actAtDescriptor, value: 0.65 });
      if (kind === 'run') Object.defineProperty(localBenchmarkPrompt, 'run', { ...runDescriptor,
        value: (...args: Parameters<typeof originalRun>) => originalRun(...args) });
    },
    restore() {
      Object.defineProperty(localBenchmarkPrompt, 'items', itemsDescriptor);
      Object.defineProperty(localBenchmarkPrompt, 'run', runDescriptor);
      Object.defineProperty(yesBand, 'actAt', actAtDescriptor);
    },
  };
}

test.each(['published-items', 'original-band', 'run'] as const)('pre-entry %s replacement refuses before native source acquisition or evidence credit', async retirement => {
  const f = await fixture(); await comparison(f.store, 'Evaluate this workstation endpoint on the same repository task.');
  let listCalls = 0, bodyCalls = 0;
  const nativeList = f.store.list, nativeRead = f.store.readContent;
  f.store.list = limit => { listCalls++; return nativeList.call(f.store, limit); };
  f.store.readContent = id => { bodyCalls++; return nativeRead.call(f.store, id); };
  const fake = fakePort(() => noulAnswer(0.7)); installJudgmentPort(fake.port);
  const control = policyControl();
  try {
    control.retire(retirement);
    await expect(readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: ordinaryResearchOwner() })).rejects.toThrow();
    expect(listCalls).toBe(0); expect(bodyCalls).toBe(0); expect(fake.requests).toHaveLength(0);
  } finally { control.restore(); }
  expect(() => localBenchmarkPromptPolicy.assertCurrent()).not.toThrow();
});

test.each(['published-items', 'original-band', 'run'] as const)('pending %s replacement cannot publish the actual membership response', async retirement => {
  const f = await fixture(); await comparison(f.store, 'Evaluate this workstation endpoint against our baseline.');
  const entered = deferred(), release = deferred(), control = policyControl();
  const fake = fakePort(() => noulAnswer(0.7)), nativeTails: Promise<unknown>[] = [];
  installJudgmentPort({ ...fake.port, ask: request => {
    const tail = (async () => { const response = await fake.port.ask(request); entered.resolve(); await release.promise; return response; })();
    nativeTails.push(tail); return tail;
  } });
  const pending = readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: ordinaryResearchOwner() });
  const observed = pending.then(() => ({ accepted: true }), () => ({ accepted: false }));
  try {
    await Promise.race([entered.promise, observed.then(() => { throw new Error('Membership settled before the retained response began'); })]);
    expect(fake.requests).toHaveLength(1);
    control.retire(retirement); release.resolve();
    expect(await observed).toEqual({ accepted: false });
  } finally {
    release.resolve();
    try { await observed; await Promise.allSettled(nativeTails); } finally { control.restore(); }
  }
  expect(() => localBenchmarkPromptPolicy.assertCurrent()).not.toThrow();
});

test('completed membership keeps construction-owned policy restrictions in retained publication guards', async () => {
  const f = await fixture(); await comparison(f.store, 'Evaluate this workstation endpoint against our baseline.');
  const guards: (() => void)[] = [], control = policyControl();
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  const snapshot = await readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: ordinaryResearchOwner(), retainCurrent: guard => { guards.push(guard); } });
  expect(snapshot.membership).toMatchObject([{ outcome: 'act', verdict: 'yes' }]);
  expect(() => { for (const guard of guards) guard(); }).not.toThrow();
  try {
    control.retire('original-band');
    expect(() => { for (const guard of guards) guard(); }).toThrow();
  } finally { control.restore(); }
  expect(() => { for (const guard of guards) guard(); }).not.toThrow();
});


test.each(['store', 'registry', 'store-owner', 'store-list', 'store-read', 'registry-get'] as const)('retained %s callback cannot retire the original policy or owner after its boundary check', async source => {
  const f = await fixture(); const artifact = await comparison(f.store, 'Evaluate this workstation endpoint against our baseline.');
  const control = policyControl(), guards: (() => void)[] = [];
  const nativeList = f.store.list, nativeRead = f.store.readContent, nativeGet = routingRegistry.get;
  const originalGetDescriptor = Object.getOwnPropertyDescriptor(routingRegistry, 'get');
  const originalReadDescriptor = Object.getOwnPropertyDescriptor(f.store, 'readContent');
  const originalStoreDescriptor = Object.getOwnPropertyDescriptor(f.context.platform, 'artifactStore');
  if (!originalStoreDescriptor) throw new Error('Native store control descriptor is absent');
  let armed = false, mutations = 0;
  const retireOwner = () => {
    mutations++;
    if (source === 'store' || source === 'registry') control.retire('original-band');
    if (source === 'store-owner') Object.defineProperty(f.context.platform, 'artifactStore', { ...originalStoreDescriptor, value: { list: () => [] } });
    if (source === 'store-list') f.store.list = limit => nativeList.call(f.store, limit);
    if (source === 'store-read') f.store.readContent = id => nativeRead.call(f.store, id);
    if (source === 'registry-get') routingRegistry.get = name => nativeGet.call(routingRegistry, name);
  };
  const ownedList: typeof nativeList = limit => {
    const artifacts = nativeList.call(f.store, limit);
    if (armed && source !== 'registry' && source !== 'registry-get') retireOwner();
    return artifacts;
  };
  const ownedGet: typeof nativeGet = name => {
    const decision = nativeGet.call(routingRegistry, name);
    if (armed && (source === 'registry' || source === 'registry-get')) retireOwner();
    return decision;
  };
  f.store.list = ownedList; routingRegistry.get = ownedGet;
  const restoreOwner = () => {
    control.restore();
    Object.defineProperty(f.context.platform, 'artifactStore', originalStoreDescriptor);
    f.store.list = ownedList; routingRegistry.get = ownedGet;
    if (originalReadDescriptor) Object.defineProperty(f.store, 'readContent', originalReadDescriptor);
    else Reflect.deleteProperty(f.store, 'readContent');
  };
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  try {
    const snapshot = await readLocalModelBenchmarkSnapshot(f.context, { sourceOwner: ordinaryResearchOwner(), retainCurrent: guard => { guards.push(guard); } });
    expect(snapshot.comparisons.map(artifact => artifact.id)).toEqual([artifact.id]);
    expect(snapshot.membership).toMatchObject([{ outcome: 'act', verdict: 'yes' }]);
    expect(fake.requests).toHaveLength(1); expect(guards.length).toBeGreaterThan(0);
    expect(() => { for (const guard of guards) guard(); }).not.toThrow();
    const unchangedArtifacts = nativeList.call(f.store, 100);
    armed = true;
    expect(() => { for (const guard of guards) guard(); }).toThrow();
    expect(mutations).toBe(1);
    expect(nativeList.call(f.store, 100)).toEqual(unchangedArtifacts);
    armed = false; restoreOwner();
    expect(() => { for (const guard of guards) guard(); }).not.toThrow();
  } finally {
    armed = false; restoreOwner();
    if (originalGetDescriptor) Object.defineProperty(routingRegistry, 'get', originalGetDescriptor);
    else Reflect.deleteProperty(routingRegistry, 'get');
  }
});
