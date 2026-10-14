import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext } from '../../input/command-registry.ts';
import { savedProviderEffectReceiptRecords, savedReviewArtifacts } from '../../tools/agent-harness-personal-ops-records.ts';
import { capturePersonalOpsData, capturePersonalOpsSnapshot, assertPersonalOpsDataCurrent, protectPersonalOpsData, protectPersonalOpsResult } from '../../tools/agent-harness-personal-ops-source.ts';
import * as catalogCapture from '../../tools/agent-harness-catalog-ranking.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureOwnedJson } from '@goodvibes-jev/engine/sdk/platform/gate';
import { mcpSchemaReader, mcpToolRecords, mcpToolSchemas } from '../../tools/agent-harness-personal-ops-discovery.ts';
import { readPersonalOpsReceiptStatus, readPersonalOpsTool } from '../../tools/agent-harness-personal-ops-readings.ts';
import { watcherReadModelLiveRecords, watcherReadModelNativeFacts } from '../../tools/agent-harness-autonomy-watcher-read-models.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const context = (platform: Record<string, unknown>, clients: Record<string, unknown> = {}) => ({ platform, clients }) as unknown as CommandContext;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected actual fixture object');
  return Object.fromEntries(Object.entries(value));
}
function privacyFixture() {
  return fakePort((name, question, state) => {
    if (name === 'status' && question.type === 'choice' && Object.hasOwn(question.criteria, 'succeeded'))
      return choiceAnswer(question, 'succeeded', 0.999);
    if (name === 'kind' && question.type === 'choice' && Object.hasOwn(question.criteria, 'owner_profile')) {
      const field = object(state).field;
      if (typeof field !== 'string') throw new Error('Missing field');
      return choiceAnswer(question, field === 'accessToken' || field === 'password' || field === 'token' ? 'secret' : 'other', 0.999);
    }
    if (['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name)) return noulAnswer(0.001);
    throw new Error(`Unexpected producer privacy question ${name}`);
  });
}

describe('Personal Ops actual producer privacy and lifetimes', () => {
  test('provider result projection protects private names while preserving complete original ownership', async () => {
    const fake = privacyFixture(); installJudgmentPort(fake.port);
    const source = { stable: true, 'token=synthetic-private-result-key': 'Associated provider data' }, guards: Array<() => void> = [];
    const result = await protectPersonalOpsResult(source, { retainCurrent: guard => { guards.push(guard); } });
    expect(result).toEqual({ stable: true, 'token=[REDACTED]': '[REDACTED]' });
    expect(JSON.stringify(fake.requests)).not.toContain('synthetic-private-result-key');
    for (const guard of guards) guard(); source.stable = false;
    expect(() => guards.forEach(guard => guard())).toThrow();
  });
  test('a private producer key still cannot be rewritten into a native contract fact', async () => {
    const fake = privacyFixture(); installJudgmentPort(fake.port);
    await expect(protectPersonalOpsData({ 'token=synthetic-private-native-key': 'Native field' })).rejects.toThrow();
    expect(JSON.stringify(fake.requests)).not.toContain('synthetic-private-native-key');
  });
  const nativeReceipt = () => ({ id: 'receipt-1', kind: 'data', mimeType: 'application/json', sizeBytes: 7,
    sha256: 'synthetic-sha', createdAt: 1791684509006, expiresAt: 1791684509006,
    acquisitionMode: 'inline-data', fetchMode: 'not-applicable',
    metadata: { purpose: 'personal-ops-provider-effect-receipt', laneId: 'inbox', status: 'succeeded', publicationGuarantee: 'Committed receipt. password=[REDACTED]' } });
  test('native receipt clocks reach Jev as ISO with complete protected evidence and original ownership', async () => {
    const fake = privacyFixture(); installJudgmentPort(fake.port);
    const artifact = Object.defineProperty(nativeReceipt(), 'hiddenEvidence', { value: 'Complete retained receipt tail', writable: true });
    const guards: Array<() => void> = [];
    const result = await savedProviderEffectReceiptRecords(context({ artifactStore: { list: () => [artifact] } }), 'inbox', { sourceOwner: ordinaryResearchOwner(), retainCurrent: guard => { guards.push(guard); } });
    expect(result[0]?.status).toBe('succeeded');
    const requests = JSON.stringify(fake.requests);
    expect(requests).toContain(new Date(artifact.createdAt).toISOString());
    expect(requests).toContain('Complete retained receipt tail');
    expect(requests).not.toContain('1791684509006');
    for (const guard of guards) guard();
    Object.defineProperty(artifact, 'hiddenEvidence', { value: 'Changed retained receipt tail' });
    expect(() => guards.forEach(guard => guard())).toThrow();
  });
  test('native clock projection cannot admit fractional clocks, nested cards or generic receipt clocks', async () => {
    const fake = privacyFixture(); installJudgmentPort(fake.port);
    await expect(readPersonalOpsReceiptStatus({ createdAt: 1791684509006, status: 'succeeded' }, { sourceOwner: ordinaryResearchOwner() })).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
    const fractional = { ...nativeReceipt(), createdAt: 1791684509006.5 };
    await expect(savedProviderEffectReceiptRecords(context({ artifactStore: { list: () => [fractional] } }), 'inbox')).rejects.toThrow();
    const nested = { ...nativeReceipt(), metadata: { ...nativeReceipt().metadata, createdAt: '4111111111111111' } };
    await expect(savedProviderEffectReceiptRecords(context({ artifactStore: { list: () => [nested] } }), 'inbox')).rejects.toThrow();
    expect(JSON.stringify(fake.requests)).not.toContain('4111111111111111');
  });
  test('receipt source changes during its status reply prevent publication without a caller readset', async () => {
    const artifact = nativeReceipt(), ordinary = privacyFixture();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const port: JudgmentPort = { model: ordinary.port.model, async ask(request) {
      if (Object.values(request.questions).some(question => question.type === 'choice' && Object.hasOwn(question.criteria, 'succeeded'))) { entered.resolve(); await release.promise; }
      return ordinary.port.ask(request);
    } };
    installJudgmentPort(port);
    const work = savedProviderEffectReceiptRecords(context({ artifactStore: { list: () => [artifact] } }), 'inbox', { sourceOwner: ordinaryResearchOwner() });
    await entered.promise; artifact.metadata.status = 'failed'; release.resolve();
    await expect(work).rejects.toThrow();
  });
  test('complete DTO protection preserves native flags and clocks and owns original source after return', async () => {
    const fake = privacyFixture(); installJudgmentPort(fake.port);
    const original = { accessToken: 'synthetic-private-credential', enabled: true, createdAt: 4001, detail: 'Complete synthetic record tail' };
    const guards: Array<() => void> = [];
    const result = await protectPersonalOpsData(original, { retainCurrent: guard => { guards.push(guard); } });
    expect(result).toEqual({ accessToken: '[REDACTED]', enabled: true, createdAt: 4001, detail: 'Complete synthetic record tail' });
    expect(JSON.stringify(fake.requests)).not.toContain('synthetic-private-credential');
    expect(JSON.stringify(fake.requests)).toContain('Complete synthetic record tail');
    for (const guard of guards) guard(); original.detail = 'Changed original producer detail';
    expect(() => guards.forEach(guard => guard())).toThrow();
  });
  test('hidden producer data is protected and remains in the complete source guard', async () => {
    const fake = privacyFixture(); installJudgmentPort(fake.port);
    const original = Object.defineProperty({ enabled: true }, 'accessToken', { value: 'synthetic-hidden-private', enumerable: false, writable: true });
    const guards: Array<() => void> = [];
    expect(await protectPersonalOpsData(original, { retainCurrent: guard => { guards.push(guard); } })).toEqual({ enabled: true, accessToken: '[REDACTED]' });
    expect(JSON.stringify(fake.requests)).not.toContain('synthetic-hidden-private');
    Object.defineProperty(original, 'accessToken', { value: 'changed-hidden-private' });
    expect(() => guards.forEach(guard => guard())).toThrow();
  });
  test('uncertain field roles cannot silently replace a numeric producer fact', async () => {
    const fake = fakePort((name, question) => { if (name !== 'kind') throw new Error(name); return choiceAnswer(question, 'other', 0.2); });
    installJudgmentPort(fake.port);
    await expect(protectPersonalOpsData({ createdAt: 4001 })).rejects.toThrow();
  });
  test('a source edit during a privacy reply holds the whole producer DTO', async () => {
    const original = { enabled: true, description: 'Original synthetic producer' }, ordinary = privacyFixture();
    let edited = false;
    const port: JudgmentPort = { model: ordinary.port.model, async ask(request) { if (!edited) { edited = true; original.enabled = false; } return ordinary.port.ask(request); } };
    installJudgmentPort(port); await expect(protectPersonalOpsData(original)).rejects.toThrow();
  });
  test('watcher startup facts never read private text through semantic transport', () => {
    const fake = fakePort(() => { throw new Error('Startup acquired hosted reader'); }); installJudgmentPort(fake.port);
    const source = context({ readModels: { watchers: { runs: [{ runId: 'run-1', status: 'running', outputChunks: ['password=synthetic-private'] }], sources: [{ sourceId: 'source-1', enabled: false }] } } });
    expect(watcherReadModelNativeFacts(source)).toEqual([{ status: 'running' }, { status: 'blocked' }]); expect(fake.requests).toHaveLength(0);
  });
  test('watcher details protect the whole source before clipping and retain original method identity', async () => {
    const fake = privacyFixture(); installJudgmentPort(fake.port);
    const record = { runId: 'run-1', status: 'running', updatedAt: 4001, outputChunks: ['Synthetic watcher output password=synthetic-private'], cancelRoute: 'watchers cancel run-1' };
    const producer = { getSnapshot: () => ({ records: [record] }) }, guards: Array<() => void> = [];
    const result = await watcherReadModelLiveRecords(context({ readModels: { watchers: { runHistory: producer } } }), { retainCurrent: guard => { guards.push(guard); }, sourceOwner: ordinaryResearchOwner() });
    expect(result[0]?.status).toBe('running'); expect(result[0]?.cancelRoute).toBe('watchers cancel run-1');
    expect(JSON.stringify(result)).not.toContain('synthetic-private'); expect(JSON.stringify(fake.requests)).not.toContain('synthetic-private');
    for (const guard of guards) guard(); producer.getSnapshot = () => ({ records: [record] });
    expect(() => guards.forEach(guard => guard())).toThrow();
  });
  test('borrowed watcher array accessors are refused without evaluating them', () => {
    let reads = 0;
    const runs = Object.defineProperty([], '0', { get() { reads++; return { status: 'running' }; }, enumerable: true });
    expect(() => watcherReadModelNativeFacts(context({ readModels: { watchers: { runs } } }))).toThrow(); expect(reads).toBe(0);
  });
  test('MCP publication rejects an original method replaced during its native reply', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<readonly unknown[]>();
    const api = { listAllTools: () => { entered.resolve(); return release.promise; } };
    const work = mcpToolRecords(context({}, { mcpApi: api })); await entered.promise; api.listAllTools = () => release.promise;
    release.resolve([{ serverName: 'synthetic', toolName: 'opaque', description: 'Synthetic tool' }]); await expect(work).rejects.toThrow();
  });
  test('all schemas are read and complete actual original values remain owned', async () => {
    const raw = { inputSchema: { type: 'object', description: 'Original complete schema' } }, reads: string[] = [], guards: Array<() => void> = [];
    const api = { getToolSchema: async (name: string) => { reads.push(name); return raw; } };
    const tools = Array.from({ length: 61 }, (_, index) => ({ serverName: 'synthetic', toolName: `opaque-${index}`, description: 'No name shortlist' }));
    const schemas = await mcpToolSchemas(context({}, { mcpApi: api }), tools, { retainCurrent: guard => { guards.push(guard); } });
    expect(schemas.size).toBe(61); expect(reads).toHaveLength(61); for (const guard of guards) guard();
    raw.inputSchema.description = 'Changed original schema'; expect(() => guards.forEach(guard => guard())).toThrow();
  });
  test('saved review descriptors do not republish private native storage fields', async () => {
    const fake = privacyFixture(); installJudgmentPort(fake.port);
    const artifact = { id: 'artifact-1', kind: 'data', mimeType: 'application/json', sizeBytes: 7, sha256: 'synthetic-sha', createdAt: 4001,
      acquisitionMode: 'inline-data', fetchMode: 'not-applicable', contentPath: '/private/source-content', metadataPath: '/private/source-metadata',
      accessToken: 'synthetic-private-artifact', metadata: { purpose: 'personal-ops-review-cards', laneId: 'inbox' } };
    const result = await savedReviewArtifacts(context({ artifactStore: { list: () => [artifact] } }), 'inbox');
    expect(result[0]?.id).toBe('artifact-1'); expect(result[0]?.createdAt).toBe(4001);
    expect(Object.hasOwn(result[0]!, 'contentPath')).toBe(false); expect(Object.hasOwn(result[0]!, 'metadataPath')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('synthetic-private-artifact'); expect(JSON.stringify(fake.requests)).not.toContain('synthetic-private-artifact');
  });
  test('borrowed artifact list getters cannot execute before source admission', async () => {
    let reads = 0;
    const store = Object.defineProperty({}, 'list', { get() { reads++; return () => []; }, enumerable: true });
    await expect(savedReviewArtifacts(context({ artifactStore: store }), 'inbox')).rejects.toThrow(); expect(reads).toBe(0);
  });
  test('a cancelled native schema reply cannot publish late source data', async () => {
    const controller = new AbortController(), release = Promise.withResolvers<unknown>();
    const read = mcpSchemaReader(context({}, { mcpApi: { getToolSchema: () => release.promise } }), { signal: controller.signal });
    if (!read) throw new Error('Missing actual schema reader');
    const work = read('mcp:synthetic:opaque'); controller.abort(); release.resolve({ inputSchema: {} }); await expect(work).rejects.toThrow();
  });
  test('cancellation promptly interrupts a non-cooperating canonical provider reply', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const fake = fakePort((name, question) => { if (name !== 'lane') throw new Error(name); return choiceAnswer(question, 'neither', 0.99); });
    const port: JudgmentPort = { model: fake.port.model, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } }; installJudgmentPort(port);
    const controller = new AbortController();
    const work = readPersonalOpsTool({ server: 'synthetic', tool: 'opaque', description: 'Synthetic contract', inputSchema: {} }, { signal: controller.signal, sourceOwner: ordinaryResearchOwner() });
    await entered.promise; controller.abort(); const timeout = setTimeout(() => release.resolve(), 300);
    try { await expect(work).rejects.toThrow(); expect(fake.requests).toHaveLength(0); } finally { clearTimeout(timeout); release.resolve(); }
  });
});

function personalOpsOutcome(read: () => unknown): string {
  try { read(); return 'accepted'; }
  catch (error) {
    if (!(error instanceof ToolInputProjectionError)) throw error;
    return error.problem;
  }
}
function hiddenPersonalOps(value: unknown, enumerable = false): unknown {
  return Object.defineProperty({ visible: 'Native visible value' }, 'hidden', { value, enumerable });
}
const normalizedPairs = [
  { name: 'object insertion order', base: () => ({ first: 1, second: 2 }), current: () => ({ second: 2, first: 1 }), outcome: 'accepted' },
  { name: 'hidden-field enumerability', base: () => hiddenPersonalOps('Complete hidden value'), current: () => hiddenPersonalOps('Complete hidden value', true), outcome: 'accepted' },
  { name: 'changed hidden tail', base: () => hiddenPersonalOps('Complete hidden value'), current: () => hiddenPersonalOps('Changed hidden value'), outcome: 'held' },
  { name: 'hidden dense array index', base: () => Object.defineProperty(['Complete native row'], '0', { enumerable: false }), current: () => ['Complete native row'], outcome: 'accepted' },
  { name: 'alias and duplicate equivalence', base: () => ({ left: { first: 1, second: 2 }, right: { second: 2, first: 1 } }), current: () => { const shared = { second: 2, first: 1 }; return { left: shared, right: shared }; }, outcome: 'accepted' },
  { name: 'undefined versus absence', base: () => ({ field: undefined }), current: () => ({}), outcome: 'held' },
  { name: 'signed zero', base: () => ({ value: -0 }), current: () => ({ value: 0 }), outcome: 'held' },
  { name: 'array order', base: () => ['First native row', 'Second native row'], current: () => ['Second native row', 'First native row'], outcome: 'held' },
];
for (const pair of normalizedPairs) test(`paired Personal Ops equality preserves ${pair.name}`, () => {
  const source = pair.base(), paired = capturePersonalOpsSnapshot(source), generic = capturePersonalOpsData(source), current = pair.current();
  expect(personalOpsOutcome(() => assertPersonalOpsDataCurrent(current, generic))).toBe(pair.outcome);
  expect(personalOpsOutcome(() => paired.assertCurrent(current))).toBe(pair.outcome);
  expect<unknown>(paired.captured).toEqual(generic);
});

test('only completely immutable data can reuse its own Personal Ops observation', () => {
  const source = Object.freeze({ rows: [{ text: 'Original native row' }] });
  const mutable = capturePersonalOpsSnapshot(source);
  const owned = captureOwnedJson(source), immutable = capturePersonalOpsSnapshot(owned);
  expect(() => immutable.assertCurrent(owned)).not.toThrow();
  source.rows[0]!.text = 'Changed native row';
  expect(personalOpsOutcome(() => mutable.assertCurrent(source))).toBe('held');
  expect(personalOpsOutcome(() => immutable.assertCurrent(source))).toBe('held');
  expect(() => immutable.assertCurrent(owned)).not.toThrow();
  const frozen = Object.freeze({ rows: Object.freeze([Object.freeze({ text: 'Original native row' })]) });
  const frozenSnapshot = capturePersonalOpsSnapshot(frozen);
  expect(() => frozenSnapshot.assertCurrent(frozen)).not.toThrow();
  const different = Object.freeze({ rows: Object.freeze([Object.freeze({ text: 'Changed native row' })]) });
  expect(personalOpsOutcome(() => frozenSnapshot.assertCurrent(different))).toBe('held');
  expect(personalOpsOutcome(() => frozenSnapshot.assertCurrent(source))).toBe('held');
  const nested: { left: Readonly<{ text: string }>; right: Readonly<{ text: string }> } = {
    left: Object.freeze({ text: 'Left native row' }), right: Object.freeze({ text: 'Right native row' }),
  };
  const nestedSnapshot = capturePersonalOpsSnapshot(nested);
  expect(() => nestedSnapshot.assertCurrent(nested)).not.toThrow();
  [nested.left, nested.right] = [nested.right, nested.left];
  expect(personalOpsOutcome(() => nestedSnapshot.assertCurrent(nested))).toBe('held');
});

test('paired capture owns only its fresh baseline and leaves the arbitrary-baseline API unchanged', () => {
  const source = { rows: [{ text: 'Original native row' }] }, paired = capturePersonalOpsSnapshot(source);
  expect(Object.isFrozen(source)).toBe(false); expect(Object.isFrozen(source.rows)).toBe(false); expect(Object.isFrozen(source.rows[0])).toBe(false);
  const captured = object(paired.captured), rows = captured.rows;
  if (!Array.isArray(rows)) throw new Error('Missing actual paired array');
  expect(Object.isFrozen(paired.captured)).toBe(true); expect(Object.isFrozen(rows)).toBe(true); expect(Object.isFrozen(rows[0])).toBe(true);
  const row = source.rows[0]; if (!row) throw new Error('Missing actual native row');
  row.text = 'Changed native row'; expect(personalOpsOutcome(() => paired.assertCurrent(source))).toBe('held');
  const arbitrary: unknown = capturePersonalOpsData(['Original baseline']);
  if (!Array.isArray(arbitrary)) throw new Error('Missing original generic array');
  expect(Object.isFrozen(arbitrary)).toBe(false); arbitrary[0] = 'Changed baseline';
  expect(() => assertPersonalOpsDataCurrent(['Changed baseline'], arbitrary)).not.toThrow();
});

for (const kind of ['accessor', 'proxy', 'symbol', 'cycle', 'prototype', 'serializer', 'function', 'nonfinite', 'sparse', 'array-extra', 'array-constructor', 'array-length', 'unique-depth', 'unique-nodes', 'unique-characters', 'unique-slots', 'expanded-nodes', 'expanded-characters'] as const)
  test(`an unequal early field cannot hide a ${kind} invalid tail`, () => {
    let touched = 0, tail: unknown = { text: 'Complete native tail' };
    if (kind === 'accessor') tail = Object.defineProperty({}, 'hidden', { get() { touched++; return 'Unused private value'; } });
    if (kind === 'proxy') tail = new Proxy({}, { ownKeys() { touched++; return []; }, getPrototypeOf() { touched++; return null; } });
    if (kind === 'symbol') tail = Object.defineProperty({}, Symbol('hidden'), { value: 'Private hidden tail' });
    if (kind === 'cycle') { const cycle: { child: unknown } = { child: null }; cycle.child = cycle; tail = cycle; }
    if (kind === 'prototype') tail = Object.create({ inherited: 'Unsupported native source' });
    if (kind === 'serializer') tail = { toJSON() { touched++; return {}; } };
    if (kind === 'function') tail = { value: () => 'Unsupported native value' };
    if (kind === 'nonfinite') tail = Number.NaN;
    if (kind === 'sparse') tail = new Array<unknown>(1);
    if (kind === 'array-extra') tail = Object.defineProperty(['Native row'], 'other', { value: 'Undeclared array value' });
    if (kind === 'array-constructor') tail = Object.defineProperty(['Native row'], 'constructor', { value: Array });
    if (kind === 'array-length') tail = new Array<unknown>(20_001);
    if (kind === 'unique-nodes') tail = Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => [`n${index}`, null]));
    if (kind === 'unique-characters') tail = { text: 'x'.repeat(1_000_001) };
    if (kind === 'unique-depth') { tail = 'Native leaf'; for (let level = 0; level < 65; level++) tail = { child: tail }; }
    if (kind === 'unique-slots') tail = Array.from({ length: 6 }, () => new Array<unknown>(20_000));
    if (kind === 'expanded-nodes') { const shared = { a: 1, b: 2, c: 3, d: 4, e: 5 }; tail = Array.from({ length: 4_000 }, () => shared); }
    if (kind === 'expanded-characters') { const shared = { text: 'x'.repeat(600) }; tail = Array.from({ length: 3_000 }, () => shared); }
    const source = { first: 'Original native value', tail: { text: 'Complete native tail' } }, current = { first: 'Changed native value', tail };
    const generic = capturePersonalOpsData(source), paired = capturePersonalOpsSnapshot(source);
    expect(personalOpsOutcome(() => assertPersonalOpsDataCurrent(current, generic))).toBe('invalid');
    expect(personalOpsOutcome(() => paired.assertCurrent(current))).toBe('invalid'); expect(touched).toBe(0);
  });

const normalizationTampering: readonly { readonly name: string; readonly subject: object; readonly key: PropertyKey }[] = [
  { name: 'reflector', subject: Object, key: 'getOwnPropertyDescriptors' },
  { name: 'immutability proof', subject: Object, key: 'isFrozen' },
  { name: 'native key reflection', subject: Reflect, key: 'ownKeys' },
  { name: 'species', subject: Array, key: Symbol.species },
  { name: 'iterator next', subject: Object.getPrototypeOf([][Symbol.iterator]()), key: 'next' },
  { name: 'array type hook', subject: Array.prototype, key: Symbol.toStringTag },
  { name: 'numeric validation', subject: Number, key: 'isSafeInteger' },
  { name: 'private map size', subject: Map.prototype, key: 'size' },
  ...['value', 'get', 'set', 'enumerable', 'configurable', 'writable'].map(key => ({ name: `inherited descriptor ${key}`, subject: Object.prototype, key })),
];
for (const { name, subject, key } of normalizationTampering) test(`paired capture refuses unsupported initial ${name} operations without invoking their getters`, () => {
  const descriptor = Object.getOwnPropertyDescriptor(subject, key), define = Object.defineProperty, remove = Reflect.deleteProperty;
  let touched = 0, outcome: string | undefined;
  try {
    define(subject, key, { get() { touched++; return undefined; }, configurable: true });
    outcome = personalOpsOutcome(() => capturePersonalOpsSnapshot({ rows: ['Complete native row'] }));
  } finally { if (descriptor) define(subject, key, descriptor); else remove(subject, key); }
  expect(outcome).toBe('invalid'); expect(touched).toBe(0);
});

test('unconsumed static and inherited additions remain supported without executing their getters', () => {
  const source = { rows: ['Complete native row'], detail: 'Complete native tail' }, existing = capturePersonalOpsSnapshot(source);
  const additions = [
    { subject: Object, key: 'pairedUnusedStatic' },
    { subject: Array.prototype, key: 'pairedUnusedMethod' },
    { subject: Object.prototype, key: 'pairedUnusedInherited' },
  ];
  const define = Object.defineProperty, remove = Reflect.deleteProperty;
  let touched = 0, initial: string | undefined, retained: string | undefined, generic: string | undefined;
  for (const { subject, key } of additions) {
    if (Object.getOwnPropertyDescriptor(subject, key)) throw new Error('Fixture addition already exists');
    define(subject, key, { get() { touched++; return 'Unused inherited value'; }, configurable: true });
  }
  try {
    initial = personalOpsOutcome(() => capturePersonalOpsSnapshot(source).assertCurrent(source));
    retained = personalOpsOutcome(() => existing.assertCurrent(source));
    generic = personalOpsOutcome(() => assertPersonalOpsDataCurrent(source, capturePersonalOpsData(source)));
  } finally { for (const { subject, key } of additions) remove(subject, key); }
  expect(initial).toBe('accepted'); expect(retained).toBe('accepted'); expect(generic).toBe('accepted'); expect(touched).toBe(0);
});

test('operation retirement between fallback raw capture and logical normalization holds', () => {
  const source = hiddenPersonalOps('Complete native tail'), paired = capturePersonalOpsSnapshot(source);
  // Equal hidden data with changed enumerability still needs normalization,
  // crossing both phases even when exact native observations can be reused.
  const current = hiddenPersonalOps('Complete native tail', true);
  const capture = catalogCapture.inspectCatalogData, descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'map'), define = Object.defineProperty;
  if (!descriptor) throw new Error('Missing actual native map descriptor');
  let rawCaptures = 0, replacedCalls = 0;
  function captureAndRetire(value: unknown): ReturnType<typeof capture> {
    const observation = capture(value); rawCaptures++;
    define(Array.prototype, 'map', { value() { replacedCalls++; return []; }, configurable: true, writable: true });
    return observation;
  }
  const spy = spyOn(catalogCapture, 'inspectCatalogData').mockImplementation(captureAndRetire);
  let outcome: string | undefined;
  try { outcome = personalOpsOutcome(() => paired.assertCurrent(current)); }
  finally { define(Array.prototype, 'map', descriptor); spy.mockRestore(); }
  expect(outcome).toBe('held'); expect(rawCaptures).toBe(1); expect(replacedCalls).toBe(0);
});

test('a caller mutation between both original source fences holds before privacy dispatch', async () => {
  const fake = privacyFixture(); installJudgmentPort(fake.port);
  const source = { enabled: true, detail: 'Original complete tail' };
  await expect(protectPersonalOpsData(source, { assertCurrent() { source.detail = 'Changed complete tail'; } })).rejects.toThrow();
  expect(fake.requests).toHaveLength(0);
});

test('a native privacy-await cancellation holds while every original field answer stays unchanged', async () => {
  const fake = privacyFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), controller = new AbortController();
  installJudgmentPort({ model: fake.port.model, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } });
  const work = protectPersonalOpsData({ enabled: true, detail: 'Complete cancellation source' }, { signal: controller.signal });
  await entered.promise; controller.abort(); release.resolve(); await expect(work).rejects.toThrow();
  expect(controller.signal.aborted).toBe(true);
});


test('expanded array aliases retain the original absence of a phase-two index-key charge', () => {
  const child = Array.from({ length: 10 }, () => 'x'.repeat(99)), source = Array.from({ length: 1_000 }, () => child);
  const paired = capturePersonalOpsSnapshot(source), generic = capturePersonalOpsData(source);
  expect(personalOpsOutcome(() => assertPersonalOpsDataCurrent(source, generic))).toBe('accepted');
  expect(personalOpsOutcome(() => paired.assertCurrent(source))).toBe('accepted');
  // Equal frozen copies spend more of the unique raw-capture key budget than
  // the original aliases. Immutable descendant reuse must not hide that cost.
  const expanded = source.map(row => Object.freeze([...row]));
  expect(personalOpsOutcome(() => assertPersonalOpsDataCurrent(expanded, generic))).toBe('invalid');
  expect(personalOpsOutcome(() => paired.assertCurrent(expanded))).toBe('invalid');
});

test('a completed raw alias retains its original depth accounting during expanded comparison', () => {
  let child: unknown = { text: 'Complete native leaf' }; for (let level = 0; level < 32; level++) child = { child };
  let later = child; for (let level = 0; level < 32; level++) later = { child: later };
  const source = { first: child, later }, paired = capturePersonalOpsSnapshot(source), generic = capturePersonalOpsData(source);
  expect(personalOpsOutcome(() => assertPersonalOpsDataCurrent(source, generic))).toBe('accepted');
  expect(personalOpsOutcome(() => paired.assertCurrent(source))).toBe('accepted');
});


test('each protected DTO invocation still performs its fresh complete canonical privacy questions', async () => {
  const fake = privacyFixture(); installJudgmentPort(fake.port);
  const source = { enabled: true, detail: 'Complete repeated native source' };
  const first = await protectPersonalOpsData(source), count = fake.requests.length;
  expect(count).toBeGreaterThan(0);
  const originalQuestions = JSON.stringify(fake.requests);
  const second = await protectPersonalOpsData(source);
  expect(fake.requests).toHaveLength(count * 2);
  expect(JSON.stringify(fake.requests.slice(count))).toBe(originalQuestions);
  expect<unknown>(second).toEqual(first); expect(Object.isFrozen(second)).toBe(false);
});
