import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { memoryProviderSelect, routingRegistry } from '@goodvibes-jev/engine/sdk/platform/routing';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { STAKES_BANDS, type JudgmentPort } from '@goodvibes-jev/judgment';
import { externalMemoryLiveProviderRecords, externalMemoryReceiptEvidence } from '../../tools/agent-harness-memory-external-providers.ts';
import { readMemoryPublicText, readMemoryRouteRole, readMemorySchemaCertified, selectMemoryProvider } from '../../tools/agent-harness-memory-provider-readings.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner, exactSensitiveSpans, researchScreeningFixture } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected controlled fixture record');
  return Object.fromEntries(Object.entries(value));
}
const options = () => ({ sourceOwner: ordinaryResearchOwner() });
const privacyNames = new Set(['engine.redaction.field-kind', 'engine.redaction.credential', 'engine.export.credential', 'engine.redaction.residual-credential', 'engine.redaction.profile-distinctive']);
function scripted(settings: {
  readonly role?: 'read' | 'forget' | 'none'; readonly status?: 'available' | 'error' | 'unknown'; readonly bool?: 'true' | 'false' | 'neither'; readonly boolConfidence?: number;
  readonly certified?: boolean; readonly member?: boolean; readonly receipt?: 'succeeded' | 'failed' | 'other';
  readonly credential?: 'missing' | 'configured-secret-ref' | 'unknown'; readonly pick?: '0' | '1' | 'none';
  readonly pickConfidence?: number; readonly fitProbability?: number;
  readonly beforeSemantic?: (request: Parameters<JudgmentPort['ask']>[0]) => void;
} = {}) {
  const roles = fakePort((name, question, state) => {
    const record = object(state), field = record.field;
    if (name === 'role') return choiceAnswer(question, field === 'opaque' ? settings.role ?? 'read' : 'none', 0.999);
    if (name === 'form') return choiceAnswer(question, field !== 'opaque' || settings.role === 'none' ? 'none' : typeof record.value === 'boolean' ? 'flag' : 'route', 0.999);
    throw new Error(`Unscripted memory route fixture ${name}`);
  });
  const status = fakePort((name, question) => { expect(name).toBe('status'); return choiceAnswer(question, settings.status ?? 'available', 0.999); });
  const credential = fakePort((name, question) => { expect(name).toBe('state'); return choiceAnswer(question, settings.credential ?? 'missing', 0.999); });
  const certified = fakePort((name) => { expect(name).toBe('certified'); return noulAnswer(settings.certified ? 0.999 : 0.001); });
  const member = fakePort((name) => { expect(name).toBe('member'); return noulAnswer(settings.member ? 0.999 : 0.001); });
  const bool = fakePort((name, question) => { expect(name).toBe('boolean_value'); return choiceAnswer(question, settings.bool ?? 'false', settings.boolConfidence ?? 0.999); });
  const receipt = fakePort((name, question) => { expect(name).toBe('status'); return choiceAnswer(question, settings.receipt ?? 'failed', 0.999); });
  const select = fakePort((name, question) => name === 'pick' ? choiceAnswer(question, settings.pick ?? 'none', settings.pickConfidence ?? 0.999)
    : noulAnswer(name === `fits_${settings.pick}` ? settings.fitProbability ?? 0.999 : 0.001));
  const spans = fakePort(name => { expect(name).toBe('credential'); return noulAnswer(0.001); });
  const privacy = fakePort((name, question) => name === 'kind' ? choiceAnswer(question, 'other', 0.999) : noulAnswer(0.001));
  const requests: Parameters<JudgmentPort['ask']>[0][] = [];
  const port: JudgmentPort = { model: roles.port.model, ask(request) {
    requests.push(request); const name = request.context?.battery;
    if (name && privacyNames.has(name)) return privacy.port.ask(request);
    settings.beforeSemantic?.(request);
    switch (name) {
      case 'agent.memory.route-role': return roles.port.ask(request);
      case 'agent.memory.live-status': return status.port.ask(request);
      case 'agent.memory.credential-state': return credential.port.ask(request);
      case 'agent.memory.schema-certified': return certified.port.ask(request);
      case 'agent.memory.receipt-member': return member.port.ask(request);
      case 'engine.tools.boolean-value': return bool.port.ask(request);
      case 'agent.personal-ops.receipt-status': return receipt.port.ask(request);
      case 'agent.memory.provider-select': return select.port.ask(request);
      case 'engine.runtime.at-rest-credential': return spans.port.ask(request);
      default: throw new Error(`Unscripted memory provider fixture ${name}`);
    }
  } };
  installJudgmentPort(port); return { port, requests, roles, status, credential, certified, member, bool, receipt, select, spans };
}
function provider() { return { providerId: 'Opaque_A', label: 'Synthetic backend', status: 'ready', configured: 1, reachable: true,
  capabilities: { opaque: false }, routes: { opaque: 'memory_store forget confirmed:true' }, hiddenTail: 'x'.repeat(900) + ' complete-native-provider-tail' }; }
function context(record = provider()) {
  const snapshot = { providers: [record] };
  const source = { snapshot, getSnapshot() { expect(this).toBe(source); return this.snapshot; } };
  return { record, snapshot, source, value: { platform: { readModels: { memory: { externalProviders: source } } } } };
}
function retainedIngress() {
  const guards = new Map<string | symbol, () => void>();
  let calls = 0, depth = 0;
  const assertCurrent = () => {
    calls++; depth++;
    try {
      if (depth !== 1) throw new Error('Retained native guard re-entered caller ingress');
      for (const guard of guards.values()) guard();
    } finally { depth--; }
  };
  return { current: { ...options(), assertCurrent, retainCurrent: (guard: () => void, key?: string) => { guards.set(key ?? Symbol(), guard); } },
    assertCurrent, count: () => calls };
}

function artifact() { return { id: 'artifact-owned', filename: 'receipt.json', createdAt: 1, metadata: {
  purpose: 'opaque cross-session operation result', providerId: 'Opaque_A', operation: 'sync', status: 'ready', receiptId: 'receipt-owned',
  schemaStatus: 'verified', schemaVersion: 'synthetic.receipt.v1', publicationGuarantee: 'Immutable receipt after effect', publisher: 'synthetic-host' } }; }

describe('external memory provider semantics and source lifetime', () => {
  test('actual provider ingestion uses role and status readings rather than key or ready-word authority', async () => {
    const fixture = context(); const script = scripted({ role: 'forget', status: 'error' });
    const records = await externalMemoryLiveProviderRecords(fixture.value, options());
    expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ providerId: 'Opaque_A', status: 'error', configured: true,
      readReady: null, readRoute: null, forgetReady: false, forgetRoute: 'memory_store forget confirmed:true', credentialState: 'missing' });
    expect(script.bool.requests).toHaveLength(0);
    expect(JSON.stringify(script.roles.requests)).toContain('complete-native-provider-tail');
  });

  test('prose boolean flags use the existing registered reader and preserve an explicit refusal', async () => {
    const fixture = context({ ...provider(), configured: 1 });
    Object.defineProperty(fixture.record, 'reachable', { value: 'not actually connected despite the ready label', enumerable: true, writable: true, configurable: true });
    const script = scripted({ bool: 'false' });
    expect((await externalMemoryLiveProviderRecords(fixture.value, options()))[0]?.reachable).toBe(false);
    expect(script.bool.requests).toHaveLength(1);
    expect(script.bool.requests[0]?.context?.battery).toBe('engine.tools.boolean-value');
  });

  test('retained provider guards can be visited by their caller ingress and still retire later mutation', async () => {
    const fixture = context(); scripted(); const ingress = retainedIngress();
    expect((await externalMemoryLiveProviderRecords(fixture.value, ingress.current))[0]?.providerId).toBe('Opaque_A');
    ingress.assertCurrent(); expect(ingress.count()).toBeGreaterThan(1);
    fixture.record.hiddenTail = 'later native provider mutation';
    expect(ingress.assertCurrent).toThrow();
  });

  test('retained artifact guards can be visited by their caller ingress and still detect appended receipts', async () => {
    const records = [artifact()]; scripted({ member: true }); const ingress = retainedIngress();
    const source = { platform: { artifactStore: { list: () => [...records] } } };
    expect((await externalMemoryReceiptEvidence(source, ingress.current))[0]?.artifactId).toBe('artifact-owned');
    ingress.assertCurrent(); expect(ingress.count()).toBeGreaterThan(1);
    records.push({ ...artifact(), id: 'artifact-later' });
    expect(ingress.assertCurrent).toThrow();
  });

  test('external memory native artifact clocks are ISO in every semantic reading and retain their instant', async () => {
    const record = { ...artifact(), createdAt: 1791684509006, expiresAt: 1791684509006 };
    const fake = scripted({ member: true });
    const evidence = await externalMemoryReceiptEvidence({ platform: { artifactStore: { list: () => [record] } } }, options());
    expect(evidence[0]?.createdAt).toBe(new Date(record.createdAt).toISOString());
    const requests = JSON.stringify(fake.requests);
    expect(requests).toContain(new Date(record.createdAt).toISOString());
    expect(requests).not.toContain('1791684509006');
    expect(fake.receipt.requests).toHaveLength(1);
  });

  test('only a missing boolean key can fall through to an affirmative native alias', async () => {
    const absent = context(); Reflect.deleteProperty(absent.record, 'configured');
    Object.defineProperty(absent.record, 'isConfigured', { value: true, enumerable: true });
    scripted(); expect((await externalMemoryLiveProviderRecords(absent.value, options()))[0]?.configured).toBe(true);
    for (const meaning of [{ bool: 'neither', boolConfidence: 0.999 }, { bool: 'true', boolConfidence: 0.2 }] as const) {
      const unresolved = context();
      Object.defineProperty(unresolved.record, 'configured', { value: 'Publisher cannot establish configuration', enumerable: true });
      Object.defineProperty(unresolved.record, 'isConfigured', { value: true, enumerable: true });
      const script = scripted(meaning);
      await expect(externalMemoryLiveProviderRecords(unresolved.value, options())).rejects.toThrow();
      expect(script.bool.requests).toHaveLength(1); expect(script.status.requests).toHaveLength(0);
    }
  });

  test('a held operation readiness field cannot fall through to an affirmative nested alias', async () => {
    const fixture = context();
    Object.defineProperty(fixture.record.routes, 'opaque', { value: { modelRoute: 'memory_store search', ready: 'Readiness remains unestablished', enabled: true }, enumerable: true });
    const script = scripted({ bool: 'neither' });
    await expect(externalMemoryLiveProviderRecords(fixture.value, options())).rejects.toThrow();
    expect(script.bool.requests).toHaveLength(1); expect(script.status.requests).toHaveLength(0);
  });

  test('a held prompt eligibility field cannot fall through to an affirmative prompt policy', async () => {
    const fixture = context();
    Object.defineProperty(fixture.record, 'promptEligible', { value: 'Owner prompt eligibility is not established', enumerable: true });
    Object.defineProperty(fixture.record, 'promptPolicy', { value: { eligible: true }, enumerable: true });
    const script = scripted({ bool: 'neither' });
    await expect(externalMemoryLiveProviderRecords(fixture.value, options())).rejects.toThrow();
    expect(script.bool.requests).toHaveLength(1); expect(script.certified.requests).toHaveLength(0);
  });

  test('an installed throwing backend holds while a mechanically absent backend stays unpublished', async () => {
    expect(await externalMemoryLiveProviderRecords({}, options())).toEqual([]);
    await expect(externalMemoryLiveProviderRecords({ platform: { readModels: { memory: { externalProviders: {
      getSnapshot() { throw new Error('Synthetic host read failure'); },
    } } } } }, options())).rejects.toThrow();
  });

  test('an installed rejecting backend holds instead of becoming an absent publication', async () => {
    await expect(externalMemoryLiveProviderRecords({ platform: { readModels: { memory: { externalProviders: {
      getSnapshot: () => Promise.reject(new Error('Synthetic host rejection')),
    } } } } }, options())).rejects.toThrow();
  });

  test('untyped artifact membership and full receipt outcome are independent registered readings', async () => {
    const record = artifact(); const records = [record];
    const store = { list(limit: number) { expect(this).toBe(store); expect(limit).toBe(100); return [...records]; } };
    const script = scripted({ member: true, receipt: 'failed', certified: false });
    const result = await externalMemoryReceiptEvidence({ platform: { artifactStore: store } }, options());
    expect(result[0]).toMatchObject({ artifactId: 'artifact-owned', providerId: 'Opaque_A', status: 'failed', certification: { schemaStatus: 'legacy' } });
    expect(script.member.requests).toHaveLength(1); expect(script.receipt.requests).toHaveLength(1); expect(script.certified.requests).toHaveLength(1);
    expect(JSON.stringify(script.receipt.requests)).toContain('Immutable receipt after effect');
  });

  test('receipt words alone cannot make an unrelated artifact a provider receipt', async () => {
    const record = artifact(); record.metadata.purpose = 'memory receipt example only';
    const script = scripted({ member: false });
    expect(await externalMemoryReceiptEvidence({ platform: { artifactStore: { list: () => [record] } } }, options())).toEqual([]);
    expect(script.member.requests).toHaveLength(1); expect(script.receipt.requests).toHaveLength(0);
  });

  test('the complete store is checked again when a receipt is appended while a reading is pending', async () => {
    const records = [artifact()]; let changed = false;
    scripted({ member: true, beforeSemantic: () => { if (!changed) { changed = true; records.push({ ...artifact(), id: 'artifact-new' }); } } });
    await expect(externalMemoryReceiptEvidence({ platform: { artifactStore: { list: () => [...records] } } }, options())).rejects.toThrow();
  });

  test('native provider metadata mutation during a response retires the output', async () => {
    const fixture = context(); let changed = false;
    scripted({ beforeSemantic: () => { if (!changed) { changed = true; fixture.record.hiddenTail = 'changed native metadata'; } } });
    await expect(externalMemoryLiveProviderRecords(fixture.value, options())).rejects.toThrow();
  });

  test('replacement snapshot getter is refused without invoking it', async () => {
    const fixture = context(); const original = fixture.source.getSnapshot; let getters = 0;
    scripted({ beforeSemantic: () => { Object.defineProperty(fixture.source, 'getSnapshot', { configurable: true, get() { getters++; return original; } }); } });
    await expect(externalMemoryLiveProviderRecords(fixture.value, options())).rejects.toThrow();
    expect(getters).toBe(0);
  });

  test('replacement service owner retires the same unchanged snapshot', async () => {
    const fixture = context(); let changed = false;
    scripted({ beforeSemantic: () => { if (!changed) { changed = true; fixture.value.platform.readModels.memory.externalProviders = { ...fixture.source }; } } });
    await expect(externalMemoryLiveProviderRecords(fixture.value, options())).rejects.toThrow();
  });

  test('cancellation stops waiting on an unsupported source and observes its later settlement', async () => {
    const controller = new AbortController();
    let resolve: ((value: unknown) => void) | undefined;
    const work = new Promise<unknown>(finish => { resolve = finish; });
    const reading = externalMemoryLiveProviderRecords({ platform: { readModels: { memory: { externalProviders: { getSnapshot: () => work } } } } }, { ...options(), signal: controller.signal });
    try { controller.abort(new Error('synthetic cancellation')); await expect(reading).rejects.toThrow('synthetic cancellation'); }
    finally { resolve?.({ providers: [] }); await work; await reading.catch(() => {}); }
  });

  test('an asynchronous caller-current callback is held before any reading', async () => {
    const script = scripted();
    await expect(externalMemoryLiveProviderRecords(context().value, { ...options(), assertCurrent: async () => {} })).rejects.toThrow();
    expect(script.requests).toHaveLength(0);
  });

  test('held route choices do not become alias fallbacks', async () => {
    const fake = fakePort((_name, question) => choiceAnswer(question, 'read', 0.2)); installJudgmentPort(fake.port);
    await expect(readMemoryRouteRole({ record: { readRoute: 'read provider' }, field: 'readRoute', value: 'read provider' }, options())).rejects.toThrow();
  });

  test('schema words are claims read with complete evidence and cannot certify by themselves', async () => {
    const script = scripted({ certified: false });
    expect(await readMemorySchemaCertified({ schemaStatus: 'certified', detail: 'Actual schema is not verified' }, options())).toBe(false);
    expect(script.certified.requests).toHaveLength(1);
  });

  test('free phrase selection maps opaque ids locally and has no lexical fallback', async () => {
    const providers = [{ id: 'memory-shared', summary: 'Actor queues only, never owner memories' }, { id: 'Opaque_A', summary: 'Cross-session owner memories' }];
    const script = scripted({ pick: '1' });
    expect(await selectMemoryProvider(providers, 'shared owner memory', options())).toBe(providers[1]);
    expect(script.select.requests.every(request => request.context?.battery === 'agent.memory.provider-select')).toBe(true);
    scripted({ pick: 'none' }); expect(await selectMemoryProvider(providers, 'memory-shared', options())).toBeUndefined();
  });

  test('selector preserves original weak bands and refuses pending registered definition replacement', async () => {
    expect(STAKES_BANDS.high.confidence.actAt).toBe(0.85);
    expect(STAKES_BANDS.high.yesNo.yes.actAt).toBe(0.85); expect(STAKES_BANDS.high.yesNo.no.actAt).toBe(0.85);
    const provider = { id: 'opaque', summary: 'Owner memories' }, providers = [provider];
    for (const weak of [{ pickConfidence: 0.8, fitProbability: 0.999 }, { pickConfidence: 0.999, fitProbability: 0.8 }]) {
      const fake = fakePort((name, question) => name === 'pick' ? choiceAnswer(question, '0', weak.pickConfidence) : noulAnswer(weak.fitProbability));
      const result = await memoryProviderSelect.select(fake.port, { query: 'owner memories' }, [{ id: '0', content: provider }]);
      expect(result.chosen).toBe('0'); expect(result.outcome).toBe('confirm');
      expect(weak.pickConfidence < 0.85 ? result.pick.outcome : result.fits['0']?.outcome).toBe('confirm');
      scripted({ pick: '0', ...weak });
      await expect(selectMemoryProvider(providers, 'owner memories', options())).rejects.toThrow();
    }
    scripted({ pick: '0' }); expect(await selectMemoryProvider(providers, 'owner memories', options())).toBe(provider);
    let release: (() => void) | undefined, announce: (() => void) | undefined;
    const responseGate = new Promise<void>(resolve => { release = resolve; });
    const pendingResponse = new Promise<void>(resolve => { announce = resolve; });
    const script = scripted({ pick: '0' });
    const pendingPort: JudgmentPort = { model: script.port.model, async ask(request) {
      const result = await script.port.ask(request);
      if (request.context?.battery === memoryProviderSelect.name) { announce?.(); await responseGate; }
      return result;
    } };
    installJudgmentPort(pendingPort);
    const get = routingRegistry.get, getSlot = Object.getOwnPropertyDescriptor(routingRegistry, 'get');
    const replacement = { ...memoryProviderSelect };
    const selected = selectMemoryProvider(providers, 'owner memories', options());
    try {
      await pendingResponse;
      expect(routingRegistry.get(memoryProviderSelect.name)).toBe(memoryProviderSelect);
      Object.defineProperty(routingRegistry, 'get', { configurable: true, writable: true,
        value: (name: string) => name === memoryProviderSelect.name ? replacement : get.call(routingRegistry, name) });
      expect(routingRegistry.get(memoryProviderSelect.name)).toBe(replacement);
      expect(replacement).not.toBe(memoryProviderSelect);
      expect(replacement.accuracyFloor).toBe(memoryProviderSelect.accuracyFloor);
      release?.(); await expect(selected).rejects.toThrow(); expect(script.select.requests).toHaveLength(1);
    } finally {
      if (getSlot) Object.defineProperty(routingRegistry, 'get', getSlot);
      else Reflect.deleteProperty(routingRegistry, 'get');
      release?.(); await selected.catch(() => {});
    }
    expect(routingRegistry.get(memoryProviderSelect.name)).toBe(memoryProviderSelect);
  });

  test('provider selection checks every candidate including an undisplayed sensitive tail', async () => {
    const secret = 'synthetic-private-hidden-tail'; const privacy = researchScreeningFixture({ spans: exactSensitiveSpans([secret]) });
    const script = scripted({ pick: '0' });
    const providers = [{ id: 'visible', summary: 'Owner memories' }, { id: 'opposing', summary: 'Other backend', tail: secret }];
    await expect(selectMemoryProvider(providers, 'Owner memories', { sourceOwner: privacy.owner })).rejects.toThrow();
    expect(script.select.requests).toHaveLength(0);
  });

  test('held provider selections do not become substring selection', async () => {
    const fake = fakePort((_name, question) => question.type === 'choice' ? choiceAnswer(question, '0', 0.2) : noulAnswer(0.5)); installJudgmentPort(fake.port);
    await expect(selectMemoryProvider([{ id: 'memory', summary: 'memory' }], 'memory', options())).rejects.toThrow();
  });

  test('the original critical credential reader keeps public candidate-shaped prose only on a settled no', async () => {
    const script = scripted();
    expect(await readMemoryPublicText('Read key-rotation-policy-for-tenants before setup.', options())).toBe('Read key-rotation-policy-for-tenants before setup.');
    expect(script.spans.requests).toHaveLength(1);
    const fake = fakePort(() => noulAnswer(0.5)); installJudgmentPort(fake.port);
    expect(await readMemoryPublicText('Read key-rotation-policy-for-tenants before setup.', options())).toContain('[REDACTED_API_KEY]');
  });

  test('retained port and registration identity survive privacy receipt cleanup', async () => {
    const guards: (() => void)[] = []; scripted({ certified: false });
    expect(await readMemorySchemaCertified({ schemaStatus: 'legacy' }, { ...options(), retainCurrent: guard => { guards.push(guard); } })).toBe(false);
    for (const guard of guards) guard();
    installJudgmentPort(fakePort(() => noulAnswer(0.001)).port);
    expect(() => guards.forEach(guard => guard())).toThrow();
    expect(routingRegistry.get('agent.memory.schema-certified')?.name).toBe('agent.memory.schema-certified');
  });
});
