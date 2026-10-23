import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { SandboxSessionRegistry } from '@goodvibes-jev/engine/sdk/platform/runtime/sandbox';
import { browserDeviceEvidence } from '@goodvibes-jev/engine/sdk/platform/gate';
import { MediaProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/media';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { ToolInputProjectionError, ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { VoiceProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/voice';
import { SqliteDecisionLog, withDecisionLog, noul, type EntryType, type Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { ConversationManager } from '../../core/conversation.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { browserPwaReadModelSnapshot } from '../../tools/agent-harness-browser-pwa-read-models.ts';
import { certifiedDeviceLiveRecords, deviceLiveReadModelSnapshot } from '../../tools/agent-harness-device-live-read-models.ts';
import { browserDeviceCatalogMatches, readBrowserDeviceEvidence, type BrowserDeviceEvidenceInput } from '../../tools/agent-harness-browser-device-readings.ts';
import { describeHarnessPairingRoute, pairingPostureSummary } from '../../tools/agent-harness-pairing-posture.ts';
import { mediaPostureSummary, describeHarnessMediaProvider } from '../../tools/agent-harness-media-posture.ts';
import type { CatalogRankingOptions } from '../../tools/agent-harness-catalog-ranking.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { createTestProviderRegistry } from '../helpers/test-managers.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
afterAll(cleanupResearchScreeningFixtures);
const options = (): CatalogRankingOptions => ({ sourceOwner: ordinaryResearchOwner() });

function fixture(readModels: unknown = {}) {
  const root = makeProjectTempDir('browser-device-media-readings');
  const workingDirectory = join(root, 'workspace'), homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory); mkdirSync(homeDirectory);
  const paths = createShellPathService({ workingDirectory, homeDirectory });
  const config = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT), workingDir: workingDirectory, homeDir: homeDirectory });
  const voice = new VoiceProviderRegistry(), media = new MediaProviderRegistry();
  const context: CommandContext = {
    print: () => {}, renderRequest: () => {}, exit: () => {},
    workspace: { shellPaths: paths }, platform: { config: config.getAll(), configManager: config,
      voiceProviderRegistry: voice, mediaProviderRegistry: media },
    session: { conversationManager: new ConversationManager(() => 80, config), runtime: {
      sessionId: 'browser-device-media-fixture', model: 'fixture', provider: 'fixture', debugMode: false,
      systemPrompt: '', reasoningEffort: 'medium',
    } }, provider: { providerRegistry: createTestProviderRegistry() }, ops: {}, clients: {},
    extensions: { toolRegistry: new ToolRegistry(), mcpRegistry: new McpRegistry({
      hookDispatcher: { fire: async () => { throw new Error('MCP hooks must not run in a metadata fixture.'); } },
      sandboxSessions: new SandboxSessionRegistry(workingDirectory),
    }) },
  };
  // Published records are an external DTO boundary, separate from native services.
  Object.defineProperty(context.platform, 'readModels', { value: readModels, configurable: true, enumerable: true });
  return { context, config, voice, media };
}

interface EvidenceRow { readonly state: BrowserDeviceEvidenceInput; readonly probability: number; }
const rankQuestion = noul(
  'Someone is looking for a skill, agent or tool, described by `query`: either a few search words or a description of a task they need to do. `candidate` is one available skill, agent or tool with its `type`, `name` and `description`. Is this candidate one they are looking for: something that provides, or directly helps with, what the query names?',
  { true: 'The candidate\'s purpose covers what the query asks for: searching for it by these words or picking it for this task would make sense.',
    false: 'The candidate does something else, or only shares a word with the query without serving its purpose.' },
);
function candidateState(state: EntryType) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || !('query' in state) || typeof state.query !== 'string'
    || !('candidate' in state) || !state.candidate || typeof state.candidate !== 'object' || Array.isArray(state.candidate)
    || !('type' in state.candidate) || state.candidate.type !== 'tool'
    || !('name' in state.candidate) || typeof state.candidate.name !== 'string'
    || !('description' in state.candidate) || typeof state.candidate.description !== 'string'
    || !('evidenceJson' in state.candidate) || typeof state.candidate.evidenceJson !== 'string'
    || !isDeepStrictEqual(Object.keys(state), ['query', 'candidate'])
    || !isDeepStrictEqual(Object.keys(state.candidate), ['type', 'name', 'description', 'evidenceJson'])) throw new Error('Unexpected complete catalog request.');
  if (JSON.stringify(JSON.parse(state.candidate.evidenceJson)) !== state.candidate.evidenceJson) throw new Error('Unexpected complete candidate evidence framing.');
  return { query: state.query, name: state.candidate.name, evidence: state.candidate.evidenceJson };
}
function readings(rows: readonly EvidenceRow[], ranks: readonly { readonly query: string; readonly name: string; readonly probability: number }[] = []) {
  return fakePort((name: string, question: Question, state: EntryType) => {
    if (name === 'supported' && isDeepStrictEqual(question, browserDeviceEvidence.items.supported.question)) {
      const row = rows.find(entry => isDeepStrictEqual(JSON.parse(JSON.stringify(state)), JSON.parse(JSON.stringify(entry.state))));
      if (!row) throw new Error('Unexpected complete evidence reading.');
      return noulAnswer(row.probability);
    }
    if (name === 'match' && isDeepStrictEqual(question, rankQuestion)) {
      const candidate = candidateState(state);
      const row = ranks.find(entry => entry.query === candidate.query && entry.name === candidate.name);
      if (!row) throw new Error('Unexpected catalog candidate or original query.');
      return noulAnswer(row.probability);
    }
    throw new Error('Unexpected named question.');
  });
}
function evidenceRecord(id: string, summary: string) {
  return { id, capabilityId: id, summary, schemaStatus: 'certified', schemaVersion: '1',
    publicationGuarantee: 'Synthetic durable permission-scoped record.', publisher: 'synthetic-publisher',
    receiptId: `receipt-${id}`, cursor: 'cursor-one', permissionScope: 'camera', status: 'ready',
    routes: { inspect: 'device action:"capability"', capture: 'device action:"capture"' } };
}
function deferred() {
  let start = () => {}, release = () => {};
  const started = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { start, release, started, gate };
}

describe('complete browser and device evidence', () => {
  test('the actual evidence reader records the native reading and read-only action', async () => {
    const source = { kind: 'mobile-touch', record: { summary: 'Large thumb controls work on a narrow screen.' } } satisfies BrowserDeviceEvidenceInput;
    const fake = readings([{ state: source, probability: .999 }]);
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog(fake.port, log));
    expect(await readBrowserDeviceEvidence(source, options())).toBe(true);
    const entries = log.query({ battery: browserDeviceEvidence.name });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('answered');
    expect(JSON.stringify(entries)).toContain('read-only published capability evidence interpretation');
  });

  test('explicit native browser true and false bypass capability judgments', async () => {
    const routes = [{ id: 'native-yes', categoryId: 'home', mobileReady: true, pwaReady: false },
      { id: 'native-no', categoryId: 'work', mobileReady: 'blocked', pwaReady: 'ready' }];
    const f = fixture({ browserPwa: { categoryRoutes: routes, firstRunReceipts: [{ id: 'receipt', manifestStatus: 'missing' }] } });
    const fake = readings([]); installJudgmentPort(fake.port);
    const snapshot = await browserPwaReadModelSnapshot(f.context, options());
    expect(snapshot.categoryRoutes.map(record => [record.id, record.mobileReady, record.pwaReady])).toEqual([
      ['native-yes', true, false], ['native-no', false, true],
    ]);
    expect(snapshot.firstRunReceipts[0]?.manifestStatus).toBe('missing');
    expect(fake.requests).toHaveLength(0);
  });

  test('absent browser fields read affirmative opaque evidence and negated keyword evidence', async () => {
    const positive = { id: 'opaque', categoryId: 'home', summary: 'Large thumb-operated controls work on narrow screens. The installed web app works without connectivity.' };
    const negative = { id: 'mobile-pwa', categoryId: 'work', summary: 'Mobile, touch, PWA, manifest and offline support are unavailable.' };
    const fake = readings([
      { state: { kind: 'mobile-touch', record: positive }, probability: .999 }, { state: { kind: 'pwa-runtime', record: positive }, probability: .999 },
      { state: { kind: 'mobile-touch', record: negative }, probability: .001 }, { state: { kind: 'pwa-runtime', record: negative }, probability: .001 },
    ]);
    installJudgmentPort(fake.port);
    const snapshot = await browserPwaReadModelSnapshot(fixture({ browserPwa: { categoryRoutes: [positive, negative] } }).context, options());
    expect(snapshot.categoryRoutes.map(record => [record.id, record.mobileReady, record.pwaReady])).toEqual([['opaque', true, true], ['mobile-pwa', false, false]]);
    expect(fake.requests).toHaveLength(4);
  });

  test('unknown browser evidence holds instead of a lexical fallback', async () => {
    const record = { id: 'mobile', summary: 'Mobile readiness has not been resolved.' };
    const fake = readings([{ state: { kind: 'mobile-touch', record }, probability: .5 }]); installJudgmentPort(fake.port);
    let published = 0;
    await expect(browserPwaReadModelSnapshot(fixture({ browserPwa: { categoryRoutes: [record] } }).context, options()).then(result => { published++; return result; })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(published).toBe(0);
  });

  test('certified device selection reads the full original tail and ignores keyword decoys', async () => {
    const positive = evidenceRecord('opaque-optics', 'The paired optical route acquires images.');
    const negative = evidenceRecord('camera-help', 'Camera support is described here. '.repeat(30) + 'The actual route cannot capture anything; it is setup documentation only.');
    Object.defineProperty(negative, 'limitation', { value: 'No image capture permission exists.', enumerable: false });
    const unready = { id: 'camera-legacy', summary: 'Camera words in an uncertified record.' };
    const fake = readings([
      { state: { kind: 'device-capability', record: positive, requestedCapability: 'camera-location-sensors', requestedTerms: ['camera', 'location'] }, probability: .999 },
      { state: { kind: 'device-capability', record: { ...negative, limitation: 'No image capture permission exists.' }, requestedCapability: 'camera-location-sensors', requestedTerms: ['camera', 'location'] }, probability: .001 },
    ]); installJudgmentPort(fake.port);
    const snapshot = await deviceLiveReadModelSnapshot(fixture({ device: { capabilities: [positive, negative, unready] } }).context, options());
    const matched = await certifiedDeviceLiveRecords(snapshot, 'camera-location-sensors', ['camera', 'location'], options());
    expect(matched.map(record => record.id)).toEqual(['opaque-optics']);
    expect(fake.requests).toHaveLength(2);
    expect(JSON.stringify(fake.requests)).toContain('The actual route cannot capture anything');
    expect(JSON.stringify(fake.requests)).toContain('No image capture permission exists.');
  });

  test.each(['copy', 'absent', 'mutated-original'] as const)('device snapshot %s custody refuses before a capability reading', async kind => {
    const record = evidenceRecord('opaque-optics', 'The paired optical route acquires images.');
    const fake = readings([]); installJudgmentPort(fake.port);
    const snapshot = await deviceLiveReadModelSnapshot(fixture({ device: { capabilities: [record] } }).context, options());
    expect(Object.keys(snapshot)).toEqual(['capabilities', 'sourceCounts']);
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.capabilities[0])).toBe(true);
    if (kind === 'mutated-original') record.summary = 'This route cannot acquire an image.';
    const input = kind === 'copy' ? { ...snapshot } : kind === 'absent' ? { capabilities: [], sourceCounts: {} } : snapshot;
    let published = 0;
    await expect(certifiedDeviceLiveRecords(input, 'camera-location-sensors', ['camera'], options()).then(result => { published++; return result; })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(fake.requests).toHaveLength(0); expect(published).toBe(0);
  });

  test.each(['private', 'accessor'] as const)('complete hidden %s evidence refuses before wire or publication', async kind => {
    const record = { summary: 'Thumb controls are available.' };
    let touched = 0, published = 0;
    Object.defineProperty(record, 'undisplayed', kind === 'private' ? { value: '4111111111111111', enumerable: false }
      : { get() { touched++; return 'private getter'; }, enumerable: false });
    const fake = readings([]); installJudgmentPort(fake.port);
    await expect(readBrowserDeviceEvidence({ kind: 'mobile-touch', record }, options()).then(result => { published++; return result; })).rejects.toThrow();
    expect(fake.requests).toHaveLength(0); expect(touched).toBe(0); expect(published).toBe(0);
  });

  test('a response with a private undisplayed field refuses before recording or publication', async () => {
    const source = { kind: 'mobile-touch', record: { summary: 'Thumb controls are available.' } } satisfies BrowserDeviceEvidenceInput;
    const fake = readings([{ state: source, probability: .999 }]);
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog({ ...fake.port, async ask(request) {
      const result = await fake.port.ask(request);
      return { ...result, undisplayed: '4111111111111111' };
    } }, log));
    let published = 0;
    await expect(readBrowserDeviceEvidence(source, options()).then(result => { published++; return result; })).rejects.toThrow();
    expect(published).toBe(0); expect(log.query({ status: 'answered' })).toHaveLength(0);
    expect(JSON.stringify(log.query({}))).not.toContain('4111111111111111');
  });

  test.each(['value', 'promise'] as const)('an original retainer %s return refuses before wire or publication', async kind => {
    const source = { kind: 'mobile-touch', record: { summary: 'Thumb controls are available.' } } satisfies BrowserDeviceEvidenceInput;
    const fake = readings([]); installJudgmentPort(fake.port);
    const retainCurrent = kind === 'promise' ? () => Promise.reject(new Error('private-retainer-tail')) : () => 'private-retainer-tail';
    let published = 0;
    await expect(readBrowserDeviceEvidence(source, { ...options(), retainCurrent }).then(result => { published++; return result; })).rejects.toBeInstanceOf(ToolInputProjectionError);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fake.requests).toHaveLength(0); expect(published).toBe(0);
  });

  test('pending nested battery question replacement refuses the original read', async () => {
    const source = { kind: 'mobile-touch', record: { summary: 'Thumb controls are available.' } } satisfies BrowserDeviceEvidenceInput;
    const fake = readings([{ state: source, probability: .999 }]), wait = deferred();
    installJudgmentPort({ ...fake.port, async ask(request) { const result = await fake.port.ask(request); wait.start(); await wait.gate; return result; } });
    const band = browserDeviceEvidence.items.supported.band.yes, original = Object.getOwnPropertyDescriptor(band, 'actAt');
    if (!original) throw new Error('Original native question band is missing.');
    let published = 0;
    const pending = readBrowserDeviceEvidence(source, options()).then(result => { published++; return result; });
    try {
      await Promise.race([wait.started, pending.then(() => { throw new Error('The original evidence read completed before its native response barrier.'); })]);
      Object.defineProperty(band, 'actAt', { ...original, value: .51 });
      wait.release(); await expect(pending).rejects.toThrow(); expect(published).toBe(0);
    } finally {
      wait.release(); await pending.then(() => {}, () => {});
      Object.defineProperty(band, 'actAt', original);
    }
  });

  test.each(['source', 'cancel', 'owner-method', 'port'] as const)('pending evidence %s replacement cannot publish', async kind => {
    const record = { summary: 'Thumb controls are available.' }, source = { kind: 'mobile-touch', record } satisfies BrowserDeviceEvidenceInput;
    const fake = readings([{ state: source, probability: .999 }]), wait = deferred(), lifetime = new AbortController();
    installJudgmentPort({ ...fake.port, async ask(request) { const result = await fake.port.ask(request); wait.start(); await wait.gate; return result; } });
    const owner = ordinaryResearchOwner(), original = Object.getOwnPropertyDescriptor(owner, 'project');
    let published = 0;
    const pending = readBrowserDeviceEvidence(source, { sourceOwner: owner, signal: lifetime.signal }).then(result => { published++; return result; });
    try {
      await Promise.race([wait.started, pending.then(() => { throw new Error('The original evidence read completed before its native response barrier.'); })]);
      if (kind === 'source') record.summary = 'Thumb controls are unavailable.';
      if (kind === 'cancel') lifetime.abort();
      if (kind === 'owner-method') Object.defineProperty(owner, 'project', { value: () => [], configurable: true });
      if (kind === 'port') installJudgmentPort(fakePort(() => { throw new Error('Replacement port must not read.'); }).port);
      wait.release(); await expect(pending).rejects.toThrow();
      expect(published).toBe(0);
    } finally {
      wait.release(); await pending.then(() => {}, () => {});
      if (original) Object.defineProperty(owner, 'project', original); else Reflect.deleteProperty(owner, 'project');
    }
  });
});

describe('original catalog query semantics', () => {
  test('all candidates are read and an opaque affirmative outranks a literal decoy', async () => {
    const candidates = [{ id: 'camera', summary: 'Only documentation.' }, { id: 'opaque', summary: 'Captures the paired image stream.' }];
    const fake = readings([], [{ query: 'camera', name: 'camera', probability: .001 }, { query: 'camera', name: 'opaque', probability: .999 }]);
    installJudgmentPort(fake.port);
    const matched = await browserDeviceCatalogMatches(candidates, 'camera', entry => ({ id: entry.id, description: entry.summary, evidence: entry }), options(), 'agent.test.device-query');
    expect(matched.map(entry => entry.id)).toEqual(['opaque']); expect(fake.requests).toHaveLength(2);
  });

  test('an unsettled competing candidate holds a sole affirmative detail', async () => {
    const query = 'Help the nearby handset connect';
    const ids = ['qr-pairing', 'manual-token-display', 'pairing-ui', 'connected-host-token-provisioning', 'connected-host-status', 'companion-capabilities', 'device-capability-map', 'channels-readiness'];
    const fake = readings([], ids.map(name => ({ query, name, probability: name === 'qr-pairing' ? .999 : name === 'pairing-ui' ? .5 : .001 })));
    installJudgmentPort(fake.port); let published = 0;
    await expect(describeHarnessPairingRoute(fixture().context, { query }, options()).then(result => { published++; return result; })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(fake.requests).toHaveLength(ids.length); expect(published).toBe(0);
  });

  test('exact pairing and provider ids remain native with no rank or select request', async () => {
    const f = fixture(); f.voice.register({ id: 'opaque', label: 'Synthetic speech provider', capabilities: ['tts'] });
    const fake = readings([]); installJudgmentPort(fake.port);
    const paired = await describeHarnessPairingRoute(f.context, { pairingRouteId: 'QR-PAIRING' }, options());
    const provider = await describeHarnessMediaProvider(f.context, { mediaProviderId: 'voice:opaque' }, options());
    expect(paired.status).toBe('found'); expect(provider.status).toBe('found'); expect(fake.requests).toHaveLength(0);
  });

  test.each(['selected', 'none', 'uncertain'] as const)('actual provider selection respects %s Choice and independent fits', async kind => {
    const f = fixture();
    f.media.register({ id: 'literal', label: 'A camera setup guide', capabilities: ['metadata'] });
    f.media.register({ id: 'opaque', label: 'B optical frame acquisition', capabilities: ['understand'] });
    const query = 'Acquire a frame from the paired optical source';
    const instruction = 'The context contains the complete lookup query and available catalog records. Select the one candidate the query means. Read its complete meaning and evidence, rather than matching shared words. Choose none if no record fits or the query does not distinguish one record. Candidate IDs are local indexes. Selecting a record grants no permission and does not execute any route.';
    const fitInstruction = 'Does this existing candidate actually represent the record requested by the complete query, including its purpose, state, and supplied evidence? A shared word or a suggested action is insufficient.';
    const fake = fakePort((name, question, state) => {
      if (!state || typeof state !== 'object' || Array.isArray(state) || !('context' in state)
        || !isDeepStrictEqual(state.context, { query }) || !('selectionFitInstructions' in state)
        || state.selectionFitInstructions !== fitInstruction || !('candidates' in state) || !Array.isArray(state.candidates)
        || state.candidates.length !== 2) throw new Error('Unexpected complete selection state.');
      const [first, second] = state.candidates;
      if (!first || typeof first !== 'object' || Array.isArray(first) || !('id' in first) || first.id !== '0'
        || !('content' in first) || typeof first.content !== 'string'
        || !second || typeof second !== 'object' || Array.isArray(second) || !('id' in second) || second.id !== '1'
        || !('content' in second) || typeof second.content !== 'string') throw new Error('Unexpected native local candidate indexes.');
      expect(JSON.parse(first.content)).toMatchObject({ id: 'media:literal', record: { provider: { id: 'literal' } } });
      expect(JSON.parse(second.content)).toMatchObject({ id: 'media:opaque', record: { provider: { id: 'opaque' } } });
      if (name === 'pick' && question.type === 'choice' && isDeepStrictEqual(question.instructions, instruction)
        && isDeepStrictEqual(question.criteria, { '0': null, '1': null, none: 'None of the candidates does what is needed.' })) {
        return choiceAnswer(question, kind === 'none' ? 'none' : '1', kind === 'uncertain' ? .5 : .999);
      }
      if (name === 'fits_0' && isDeepStrictEqual(question, noul({ question: 'Apply the complete selectionFitInstructions in state to this exact candidate.', candidate: '`candidates[0]` (id "0")' }))) return noulAnswer(.001);
      if (name === 'fits_1' && isDeepStrictEqual(question, noul({ question: 'Apply the complete selectionFitInstructions in state to this exact candidate.', candidate: '`candidates[1]` (id "1")' }))) return noulAnswer(kind === 'none' ? .001 : .999);
      throw new Error('Unexpected selection question.');
    });
    installJudgmentPort(fake.port); let published = 0;
    const pending = describeHarnessMediaProvider(f.context, { query }, options()).then(result => { published++; return result; });
    if (kind === 'uncertain') { await expect(pending).rejects.toThrow(); expect(published).toBe(0); }
    else { const result = await pending; expect(result.status).toBe(kind === 'none' ? 'missing_lookup' : 'found'); }
    expect(fake.requests).toHaveLength(1); expect(fake.requests[0]?.context?.battery).toBe('engine.tools.registry-select');
  });

  test('a whole-map paraphrase reads the canonical device-map candidate', async () => {
    const f = fixture(), query = 'Show everything the companion can currently do';
    const ids = ['qr-pairing', 'manual-token-display', 'pairing-ui', 'connected-host-token-provisioning', 'connected-host-status', 'companion-capabilities', 'device-capability-map', 'channels-readiness'];
    const fake = readings([], [...ids.map(name => ({ query, name, probability: .001 })),
      { query, name: 'whole-device-map', probability: .999 }]);
    installJudgmentPort(fake.port);
    const result = await pairingPostureSummary(f.context, { query, includeParameters: true }, options());
    expect(result.deviceCapabilities).toHaveLength(8);
    expect(fake.requests.filter(request => request.context?.site === 'agent.pairing.whole-device-map.query')).toHaveLength(1);
    expect(fake.requests.some(request => request.context?.site === 'agent.pairing.capabilities.query')).toBe(false);
  });

  test('actual media provider and workflow queries use independent canonical candidates before limit', async () => {
    const f = fixture();
    f.media.register({ id: 'camera', label: 'Camera documentation only', capabilities: ['metadata'] });
    f.media.register({ id: 'opaque', label: 'Synthetic optical frame provider', capabilities: ['understand'] });
    const query = 'camera';
    const fake = readings([], [
      { query, name: 'media:camera', probability: .001 }, { query, name: 'media:opaque', probability: .999 },
      { query, name: 'push-to-talk', probability: .001 }, { query, name: 'voice-memo-transcription', probability: .001 },
      { query, name: 'spoken-responses', probability: .001 }, { query, name: 'wake-and-speak', probability: .001 },
    ]); installJudgmentPort(fake.port);
    const result = await mediaPostureSummary(f.context, { query, limit: 1 }, options());
    expect(result.providers).toMatchObject([{ id: 'opaque' }]);
    expect(result.voiceWorkflows).toEqual([]); expect(result.total).toBe(2); expect(fake.requests).toHaveLength(6);
    expect(fake.requests.every(request => request.context?.battery === 'engine.tools.registry-rank')).toBe(true);
  });
});
