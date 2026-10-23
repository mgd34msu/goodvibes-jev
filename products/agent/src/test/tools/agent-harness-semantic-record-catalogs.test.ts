import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { types as nodeTypes } from 'node:util';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { ProcessManager, ToolRegistry, ToolInputProjectionError, assertCurrentToolInvocation, type BackgroundProcess } from '@goodvibes-jev/engine/sdk/platform/tools';
import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import { DEFAULT_CONFIG, type PermissionMode } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import type { MemoryRecord } from '@goodvibes-jev/engine/sdk/platform/state';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { createAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import type { WatcherRecord } from '../../runtime/index.ts';
import { createDomainDispatch, createRuntimeStore } from '../../runtime/store/index.ts';
import { createUiReadModels } from '../../runtime/ui-read-models.ts';
import { createWatchersReadModel } from '../helpers/ui-read-models.ts';
import { getTestRuntimeServices, resetTestRuntimeServices } from '../helpers/runtime-services.ts';
import { autonomyQueueCatalogStatus, autonomyQueueSummary, describeAutonomyQueueItem } from '../../tools/agent-harness-autonomy-queue.ts';
import { learningCuratorSummary, describeLearningCandidate } from '../../tools/agent-harness-learning-curator.ts';
import { backgroundProcessSummary, describeBackgroundProcess, runBackgroundProcessAction } from '../../tools/agent-harness-background-processes.ts';
import { captureModelReadingInput } from '../../tools/agent-harness-model-reading-source.ts';
import { watcherReadModelLiveRecords } from '../../tools/agent-harness-autonomy-watcher-read-models.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner, researchScreeningFixture, exactSensitiveSpans } from '../helpers/research-screening.ts';

class CatalogProcessFixture extends ProcessManager {
  readonly records: BackgroundProcess[] = [
    { id: 'lexical-mail', pid: 101, cmd: 'mail', startTime: Date.now(), stdout: [], stderr: [], exitCode: null, done: false, killDeadline: null },
    { id: 'opaque-worker', pid: 102, cmd: 'unrelated-worker', startTime: Date.now(), stdout: [], stderr: [], exitCode: null, done: false, killDeadline: null },
  ];
  override list() { return this.records.map(entry => ({ id: entry.id, pid: entry.pid, cmd: entry.cmd, status: entry.done ? 'completed' : 'running', done: entry.done })); }
  override getStatus(id: string) { return this.records.find(entry => entry.id === id); }
  override getOutput(id: string) { const record = this.getStatus(id); return record ? { stdout: record.stdout.join(''), stderr: record.stderr.join('') } : undefined; }
}

function memory(id: string, summary: string): MemoryRecord {
  return { id, scope: 'project', cls: 'fact', summary, detail: 'A synthetic record used for catalog admission.', tags: [], provenance: [], reviewState: 'fresh', confidence: 92, createdAt: 1, updatedAt: 1 };
}

function fixture() {
  const manager = new CatalogProcessFixture();
  const memories = [memory('lexical-mail', 'mail'), memory('opaque-lesson', 'A different subject')];
  const context = { extensions: {}, clients: { agentKnowledgeApi: { memory: { getAll: () => memories } } }, workspace: { processManager: manager }, platform: { config: {} }, ops: {}, session: { runtime: { sessionId: 'semantic-records' } } } as unknown as CommandContext;
  return { context, manager, memories };
}

function readings(fits: Readonly<Record<string, number>>) {
  return fakePort((name, question, state) => {
    if (name === 'kind' && question.type === 'choice' && Object.hasOwn(question.criteria, 'owner_profile')) {
      return choiceAnswer(question, 'other', 0.999);
    }
    if (['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name)) return noulAnswer(0.001);
    // Script the six independent curator measurements so this suite can test
    // catalog ranking separately from live grading calibration.
    if (question.type === 'score' && ['usefulness', 'freshness', 'source_quality', 'risk', 'priority', 'confidence'].includes(name)) {
      return scoreAnswer(question, name === 'risk' || name === 'confidence' ? 1 : 2, 0.999);
    }
    if (name === 'link' && question.type === 'score') return scoreAnswer(question, 0, 0.999); // These two authored records are distinct.
    if (name === 'same_record' && question.type === 'noul') return noulAnswer(0.001);
    if (name !== 'match') throw new Error(`Unexpected catalog reading ${name}`);
    const candidate = (state as unknown as { candidate: { name: string } }).candidate;
    return noulAnswer(fits[candidate.name] ?? 0.01);
  });
}
const options = () => ({ sourceOwner: ordinaryResearchOwner() });
let watcherRuntime: ReturnType<typeof getTestRuntimeServices> | undefined;

function watcherReadModelFixture(state: WatcherRecord['state'], outputPreview: string) {
  const watcher = {
    id: 'fixture-watcher', kind: 'manual', label: 'Synthetic watcher', state,
    source: { id: 'fixture-source', kind: 'watcher', label: 'Synthetic source', enabled: true,
      createdAt: 1, updatedAt: 1, metadata: {} },
    metadata: { outputPreview },
  } satisfies WatcherRecord;
  const services = getTestRuntimeServices(), dispatch = createDomainDispatch(services.runtimeStore);
  watcherRuntime = services;
  const publish = () => { dispatch.syncWatcher(watcher); };
  publish();
  const readModels = createUiReadModels(services), readModel = readModels.watchers;
  return { watcher, readModel, readModels, publish };
}

function nativeMembershipRequest(raw: unknown) {
  if (!raw || typeof raw !== 'object' || !('query' in raw) || typeof raw.query !== 'string'
    || !('candidate' in raw) || !raw.candidate || typeof raw.candidate !== 'object'
    || !('name' in raw.candidate) || typeof raw.candidate.name !== 'string'
    || !('evidenceJson' in raw.candidate) || typeof raw.candidate.evidenceJson !== 'string')
    throw new Error('Expected complete native membership request');
  return { query: raw.query, id: raw.candidate.name, evidence: raw.candidate.evidenceJson };
}
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => {
  watcherRuntime?.dispose(); watcherRuntime = undefined;
  resetTestRuntimeServices(); installJudgmentPort(previous);
});
afterAll(cleanupResearchScreeningFixtures);

const cases = [
  { kind: 'autonomy', chosen: 'research-runs', field: 'queue', id: 'queueItemId', summary: autonomyQueueSummary, detail: describeAutonomyQueueItem },
  { kind: 'learning', chosen: 'memory:opaque-lesson:needs-review', field: 'candidates', id: 'candidateId', summary: learningCuratorSummary, detail: describeLearningCandidate },
  { kind: 'process', chosen: 'opaque-worker', field: 'processes', id: 'processId', summary: backgroundProcessSummary, detail: describeBackgroundProcess },
] as const;

describe('canonical semantic record catalogs', () => {
  test('autonomy reads all native contracts for every lane and counts only dispatchable named matches', async () => {
    const f = fixture(), native = getOperatorContract().operator.methods;
    const evidence = new Map(native.map(method => [method.id, JSON.stringify(captureModelReadingInput(method))]));
    const available = native.find(method => method.id === 'accounts.snapshot');
    const unavailable = native.find(method => method.id === 'artifacts.content.get');
    if (!available || !unavailable) throw new Error('Missing authored native transport controls');
    expect(available.invokable).toBe(true); expect(unavailable.invokable).toBe(false);
    expect(JSON.stringify(native).length).toBeGreaterThan(1_000_000);
    expect(Math.max(...[...evidence.values()].map(value => value.length))).toBeGreaterThan(40_000);
    const lanes = ['approvals', 'automation', 'schedules', 'tasks'];
    // Every exact native ID is an authored transport control. These choices
    // prove full source mapping and queue composition, not live lane semantics.
    const answers = new Map(lanes.map(lane => [lane, new Map(native.map(method => [method.id,
      method.id === unavailable.id || (lane === 'tasks' && method.id === available.id) ? 0.999 : 0.001]))]));
    const seen = new Map(lanes.map(lane => [lane, new Set<string>()]));
    const guards = new Map<string | (() => void), () => void>();
    let fullEvidence = true, repeated = false, matches = 0, firstRetentionMatches = -1, parentEnteredPrivacy = false;
    const fake = fakePort((name, question, raw) => {
      if (name === 'match') {
        const request = nativeMembershipRequest(raw), answer = answers.get(request.query)?.get(request.id);
        const ids = seen.get(request.query);
        if (answer === undefined || !ids) throw new Error('Unscripted native membership control');
        fullEvidence &&= evidence.get(request.id) === request.evidence;
        repeated ||= ids.has(request.id); ids.add(request.id); matches++;
        return noulAnswer(answer);
      }
      parentEnteredPrivacy ||= guards.size > 0;
      if (name === 'kind' && question.type === 'choice' && Object.hasOwn(question.criteria, 'owner_profile'))
        return choiceAnswer(question, 'other', 0.999);
      if (['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name)) return noulAnswer(0.001);
      throw new Error(`Unexpected native queue question ${name}`);
    });
    installJudgmentPort(fake.port);
    const result = await autonomyQueueSummary(f.context, { includeParameters: true }, {
      ...options(), retainCurrent(guard, key) {
        if (firstRetentionMatches < 0) firstRetentionMatches = matches;
        guards.set(key ?? guard, guard);
      },
      assertCurrent() { for (const guard of guards.values()) guard(); },
    });
    expect(matches).toBe(4 * native.length); expect(fullEvidence).toBe(true); expect(repeated).toBe(false);
    expect(firstRetentionMatches).toBe(matches); expect(parentEnteredPrivacy).toBe(false);
    expect([...seen.values()].every(ids => ids.size === native.length)).toBe(true);
    expect(result.queue).toContainEqual(expect.objectContaining({ queueItemId: 'connected-host-tasks', status: 'ready', count: 1,
      methodIds: [available.id], unavailableMethodIds: [unavailable.id] }));
    for (const id of ['pending-approvals', 'automation-runs', 'connected-schedules', 'autonomous-schedule-requests']) {
      expect(result.queue).toContainEqual(expect.objectContaining({ queueItemId: id, status: 'needs-setup', count: 0,
        methodIds: [], unavailableMethodIds: [unavailable.id] }));
    }
    const requests = fake.requests.length;
    for (const guard of guards.values()) guard();
    expect(fake.requests).toHaveLength(requests);
    expect(Object.isFrozen(native)).toBe(true); expect(Object.isFrozen(available)).toBe(true);
    expect(() => Object.defineProperty(available, 'description', { value: 'Competing write' })).toThrow();
    for (const guard of guards.values()) guard();
    installJudgmentPort(undefined);
    expect(() => { for (const guard of guards.values()) guard(); }).toThrow();
  }, 60_000);

  for (const probability of [0.5, 0.575]) {
    test(`autonomy holds unsettled native membership ${probability} before publishing an empty capability lane`, async () => {
      const evidence = new Map(getOperatorContract().operator.methods.map(method => [method.id, JSON.stringify(captureModelReadingInput(method))]));
      const fake = fakePort((name, question, raw) => {
        if (name !== 'match' || question.type !== 'noul') throw new Error('Unsettled membership reached a later producer');
        const request = nativeMembershipRequest(raw);
        if (request.query !== 'approvals' || evidence.get(request.id) !== request.evidence)
          throw new Error('Unsettled membership omitted its complete native source');
        return noulAnswer(probability);
      });
      installJudgmentPort(fake.port);
      await expect(autonomyQueueSummary(fixture().context, {}, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
      const membership = fake.requests.filter(request => request.context?.battery === 'agent.personal-ops.lane-member');
      expect(membership.length).toBeGreaterThan(0); expect(membership.length).toBeLessThanOrEqual(16);
      expect(membership.every(request => Object.keys(request.questions).join(',') === 'match')).toBe(true);
    });
  }

  test('autonomy cannot read native membership without its protected source owner', async () => {
    const fake = readings({}); installJudgmentPort(fake.port);
    await expect(autonomyQueueSummary(fixture().context, {})).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(fake.requests).toHaveLength(0);
  });

  test('autonomy cancellation after a noncooperating native response holds publication', async () => {
    const controller = new AbortController(), fake = fakePort(() => noulAnswer(0.999));
    installJudgmentPort({ ...fake.port, async ask(request) {
      const response = await fake.port.ask(request); controller.abort(); await Promise.resolve(); return response;
    } });
    await expect(autonomyQueueSummary(fixture().context, {}, { ...options(), signal: controller.signal })).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true); expect(fake.requests.length).toBeLessThanOrEqual(16);
  });

  test('autonomy revocation during native membership retires the original source owner', async () => {
    const screening = researchScreeningFixture(), fake = fakePort(() => { screening.lifetime.abort(); return noulAnswer(0.999); });
    installJudgmentPort(fake.port);
    await expect(autonomyQueueSummary(fixture().context, {}, { sourceOwner: screening.owner })).rejects.toThrow();
    expect(screening.lifetime.signal.aborted).toBe(true); expect(fake.requests.length).toBeLessThanOrEqual(16);
  });

  test('autonomy retains the exact original caller callback while native membership is pending', async () => {
    const current = { ...options(), assertCurrent: () => {} };
    const fake = fakePort(() => { current.assertCurrent = () => {}; return noulAnswer(0.001); });
    installJudgmentPort(fake.port);
    await expect(autonomyQueueSummary(fixture().context, {}, current)).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(fake.requests.length).toBeLessThanOrEqual(16);
  });

  test('autonomy refuses a caller callback that swaps its own binding before source acquisition', async () => {
    const current = { ...options(), assertCurrent: () => {} }, fake = readings({});
    current.assertCurrent = () => { current.assertCurrent = () => {}; };
    installJudgmentPort(fake.port);
    await expect(autonomyQueueSummary(fixture().context, {}, current)).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(fake.requests).toHaveLength(0);
  });

  test('autonomy refuses asynchronous caller callbacks before any native source question', async () => {
    const fake = readings({}); installJudgmentPort(fake.port);
    await expect(autonomyQueueSummary(fixture().context, {}, { ...options(), assertCurrent: async () => {} }))
      .rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(fake.requests).toHaveLength(0);
  });

  test('autonomy retains original owner methods across caller callbacks', async () => {
    const screening = researchScreeningFixture(), fake = readings({}); installJudgmentPort(fake.port);
    await expect(autonomyQueueSummary(fixture().context, {}, { sourceOwner: screening.owner, assertCurrent() {
      Object.defineProperty(screening.owner, 'project', { value: () => [], configurable: true });
    } })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(fake.requests).toHaveLength(0);
  });

  test('watcher startup counts use native facts without reading producer prose', () => {
    const fake = readings({}); installJudgmentPort(fake.port);
    const f = fixture(), baseline = autonomyQueueCatalogStatus(f.context);
    expect(baseline.methodReadiness).toBe('pending');
    expect(Number(baseline.blocked)).toBeGreaterThanOrEqual(4);
    const { watcher, readModel, readModels, publish } = watcherReadModelFixture('running', 'Synthetic watcher output');
    const context: CommandContext = { ...f.context, platform: { ...f.context.platform, readModels } };
    expect(autonomyQueueCatalogStatus(context).active).toBe(Number(baseline.active) + 1);
    watcher.state = 'failed'; publish();
    expect(autonomyQueueCatalogStatus(context).attention).toBe(Number(baseline.attention) + 1);
    Object.defineProperty(watcher, 'state', { value: 'The watcher is currently running according to this prose.',
      writable: true, enumerable: true, configurable: true });
    publish();
    expect(autonomyQueueCatalogStatus(context).active).toBe(baseline.active);
    expect(fake.requests).toHaveLength(0);
  });

  test('literal queue reads await complete watcher privacy and retain producer source through publication', async () => {
    const f = fixture(), { watcher, readModel, readModels, publish } = watcherReadModelFixture('running', 'Complete synthetic watcher output');
    const context: CommandContext = { ...f.context, platform: { ...f.context.platform, readModels } };
    const fake = fakePort((_name, question) => question.type === 'choice' ? choiceAnswer(question, 'other', 0.999) : noulAnswer(0.001));
    installJudgmentPort(fake.port);
    const guards: (() => void)[] = [];
    const result = await autonomyQueueSummary(context, {}, { ...options(), retainCurrent(guard) { guards.push(guard); } });
    expect(result.queue).toContainEqual(expect.objectContaining({ queueItemId: 'automation-runs', status: 'active', liveRecords: expect.any(Array) }));
    expect(fake.requests.length).toBeGreaterThan(0);
    const questions = fake.requests.length;
    for (const guard of guards) guard();
    expect(fake.requests).toHaveLength(questions);
    watcher.metadata.outputPreview = 'A competing native update'; publish();
    expect(() => { for (const guard of guards) guard(); }).toThrow(ToolInputProjectionError);
  });

  test('a watcher changing during whole DTO privacy cannot publish an old literal queue', async () => {
    const f = fixture(), { watcher, readModel, readModels, publish } = watcherReadModelFixture('running', 'Initial synthetic watcher output');
    const context: CommandContext = { ...f.context, platform: { ...f.context.platform, readModels } };
    const fake = fakePort((_name, question) => question.type === 'choice' ? choiceAnswer(question, 'other', 0.999) : noulAnswer(0.001));
    let changed = false;
    installJudgmentPort({ ...fake.port, async ask(request) {
      const answer = await fake.port.ask(request);
      const state = request.state;
      if (state && typeof state === 'object' && !Array.isArray(state) && 'parts' in state && Array.isArray(state.parts)
        && state.parts.some(part => part && typeof part === 'object' && 'text' in part && part.text === 'Initial synthetic watcher output')) {
        watcher.metadata.outputPreview = 'Changed while privacy was pending'; publish();
        changed = true;
      }
      return answer;
    } });
    await expect(autonomyQueueSummary(context, {}, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(changed).toBe(true);
  });

  for (const replacement of ['source', 'getSnapshot', 'getSnapshot-accessor']) {
    test(`native watcher ${replacement} replacement during privacy holds publication without calling the replacement`, async () => {
      const f = fixture(), { readModel, readModels } = watcherReadModelFixture('running', 'Synthetic native watcher output');
      const context: CommandContext = { ...f.context, platform: { ...f.context.platform, readModels } };
      const snapshot = readModel.getSnapshot(), fake = readings({});
      let changed = false, touched = 0, published = 0;
      installJudgmentPort({ ...fake.port, async ask(request) {
        const answer = await fake.port.ask(request);
        if (!changed) {
          changed = true;
          if (replacement === 'source') Object.defineProperty(readModels, 'watchers', { value: createWatchersReadModel(createRuntimeStore()) });
          else if (replacement === 'getSnapshot') Object.defineProperty(readModel, 'getSnapshot', { value() { touched++; return snapshot; } });
          else Object.defineProperty(readModel, 'getSnapshot', { get() { touched++; return () => snapshot; } });
        }
        return answer;
      } });
      await expect(watcherReadModelLiveRecords(context, options()).then(result => { published++; return result; })).rejects.toThrow(ToolInputProjectionError);
      expect(changed).toBe(true); expect(touched).toBe(0); expect(published).toBe(0);
    });
  }

  test('native watcher snapshot accessors hold before reading a getter or asking privacy', async () => {
    const f = fixture(), { readModel, readModels } = watcherReadModelFixture('running', 'Synthetic native watcher output');
    const context: CommandContext = { ...f.context, platform: { ...f.context.platform, readModels } };
    let touched = 0;
    Object.defineProperty(readModel, 'getSnapshot', { get() { touched++; return () => ({}); } });
    const fake = readings({}); installJudgmentPort(fake.port);
    await expect(watcherReadModelLiveRecords(context, options())).rejects.toThrow(ToolInputProjectionError);
    expect(touched).toBe(0); expect(fake.requests).toHaveLength(0);
  });

  test('native watcher unsupported state stays unknown after privacy without a semantic status fallback', async () => {
    const f = fixture(), { watcher, readModel, readModels, publish } = watcherReadModelFixture('running', 'Synthetic native watcher output');
    Object.defineProperty(watcher, 'state', { value: 'The watcher is currently running according to this prose.',
      writable: true, enumerable: true, configurable: true });
    publish();
    const context: CommandContext = { ...f.context, platform: { ...f.context.platform, readModels } };
    const fake = readings({}); installJudgmentPort(fake.port);
    const records = await watcherReadModelLiveRecords(context, options());
    expect(records).toHaveLength(1); expect(records[0]?.status).toBe('unknown');
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests.filter(request => request.context?.battery === 'agent.personal-ops.receipt-status')).toHaveLength(0);
  });

  test('native watcher snapshot protects undisplayed metadata before publishing its actual state and usable preview', async () => {
    const f = fixture(), { watcher, readModel, readModels, publish } = watcherReadModelFixture('running', 'Synthetic native watcher preview');
    Object.defineProperty(watcher.source.metadata, 'undisplayed', { value: 'Synthetic undisplayed native source evidence', enumerable: false });
    publish();
    const context: CommandContext = { ...f.context, platform: { ...f.context.platform, readModels } };
    const fake = readings({}); installJudgmentPort(fake.port);
    const records = await watcherReadModelLiveRecords(context, options());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ label: 'Watcher: Synthetic watcher', status: 'running',
      output: { status: 'preview', preview: 'Synthetic native watcher preview' }, sourceIds: expect.arrayContaining([watcher.id]) });
    expect(JSON.stringify(fake.requests)).not.toContain('Synthetic undisplayed native source evidence');
    expect(JSON.stringify(records)).not.toContain('Synthetic undisplayed native source evidence');
  });

  test('native watcher cancellation after a noncooperating privacy answer prevents publication', async () => {
    const f = fixture(), { readModel, readModels } = watcherReadModelFixture('running', 'Synthetic native watcher output');
    const context: CommandContext = { ...f.context, platform: { ...f.context.platform, readModels } };
    const controller = new AbortController(), fake = readings({});
    let published = 0;
    installJudgmentPort({ ...fake.port, async ask(request) {
      const answer = await fake.port.ask(request); controller.abort(); await Promise.resolve(); return answer;
    } });
    await expect(watcherReadModelLiveRecords(context, { ...options(), signal: controller.signal })
      .then(result => { published++; return result; })).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true); expect(fake.requests.length).toBeGreaterThan(0); expect(published).toBe(0);
  });

  test('native watcher store notifications retain a changed-and-restored snapshot during privacy', async () => {
    const f = fixture(), { watcher, readModel, readModels, publish } = watcherReadModelFixture('running', 'Original native watcher output');
    const context: CommandContext = { ...f.context, platform: { ...f.context.platform, readModels } };
    const fake = readings({}); let changed = false, published = 0;
    installJudgmentPort({ ...fake.port, async ask(request) {
      const answer = await fake.port.ask(request);
      if (!changed) {
        changed = true;
        watcher.metadata.outputPreview = 'Competing native watcher output'; publish();
        watcher.metadata.outputPreview = 'Original native watcher output'; publish();
      }
      return answer;
    } });
    await expect(watcherReadModelLiveRecords(context, options()).then(result => { published++; return result; })).rejects.toThrow(ToolInputProjectionError);
    expect(changed).toBe(true); expect(published).toBe(0);
    expect(readModel.getSnapshot().watchers[0]?.metadata.outputPreview).toBe('Original native watcher output');
  });

  test('native watcher publication retains a real recorded manager admission across permission revocation', async () => {
    const f = fixture(), { readModel, readModels } = watcherReadModelFixture('running', 'Synthetic native watcher output');
    const context: CommandContext = { ...f.context, platform: { ...f.context.platform, readModels } };
    let mode: PermissionMode = 'prompt', entered = false, revoked = false, published = 0;
    const directory = '/synthetic/native-watcher-read';
    const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode, tools: {} });
    const reader: PermissionConfigReader = {
      getAutonomousSnapshot: () => ({ permissions: permissions(), autoApprove: false, directory }),
      getSnapshot: () => ({ permissions: permissions() }), isAutoApproveEnabled: () => false, getWorkingDirectory: () => directory,
    };
    const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState()), registry = new ToolRegistry(manager);
    registry.register({ definition: { name: 'native_watcher_read', description: 'Read the synthetic native watcher fixture.',
      parameters: { type: 'object', properties: {}, additionalProperties: false } }, async execute(args, executionOptions) {
      entered = true;
      expect(assertCurrentToolInvocation(args, executionOptions)).toBe(true);
      const records = await watcherReadModelLiveRecords(context, { ...options(), signal: executionOptions?.signal,
        assertCurrent() { if (!assertCurrentToolInvocation(args, executionOptions)) throw new ToolInputProjectionError('held'); } });
      published++; return { success: true, output: JSON.stringify(records) };
    } });
    const fake = fakePort((name, question) => {
      if (entered && !revoked) { revoked = true; mode = 'plan'; }
      if (question.type === 'noul') return noulAnswer(0.001);
      if (question.type !== 'choice') throw new Error('Unexpected native watcher admission question');
      const label = name === 'kind' && Object.hasOwn(question.criteria, 'owner_profile') ? 'other'
        : name === 'disposition' ? 'act' : name === 'kind' ? 'read' : name === 'hazard' ? 'none'
          : name === 'family' || name === 'capability' ? 'generic' : undefined;
      if (!label || !Object.hasOwn(question.criteria, label)) throw new Error(`Unscripted native watcher admission choice ${name}`);
      return choiceAnswer(question, label, 0.999);
    });
    using log = new SqliteDecisionLog(':memory:'); installJudgmentPort(withDecisionLog(fake.port, log));
    const call = await registry.prepareCall('native-watcher-revocation', 'native_watcher_read', {});
    const admission = await manager.admitAutonomous('native-watcher-revocation', 'native_watcher_read', call.args, {
      sourceOf: () => ({ goal: 'Verify an isolated native watcher read', criteria: ['No external actions or private source uploads'] }),
      schemaRevision: call.schemaRevision, preparedCall: { registry, call },
    });
    expect(admission.result.approved).toBe(true);
    await expect(registry.executePrepared(call, admission)).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(entered).toBe(true); expect(revoked).toBe(true); expect(published).toBe(0);
  });

  for (const entry of cases) {
    test(`${entry.kind} reads every candidate before applying the limit and permits counter-lexical results`, async () => {
      const f = fixture(), fake = readings({ [entry.chosen]: 0.99 }); installJudgmentPort(fake.port);
      let invocation: 'literal' | 'filtered' | 'detail' = 'literal';
      try {
        const all = await entry.summary(f.context, {}, options());
        const expectedTotal = Number(all.total);
        invocation = 'filtered';
        const result = await entry.summary(f.context, { query: 'mail', limit: 1 }, options());
        expect(result[entry.field]).toMatchObject([{ [entry.id]: entry.chosen, judgment: { reading: { verdict: 'yes' } } }]);
        expect(result.total).toBe(expectedTotal);
        const catalogRequests = fake.requests.filter(request => request.context?.battery === 'engine.tools.registry-rank');
        expect(catalogRequests).toHaveLength(expectedTotal);
        expect(new Set(catalogRequests.map(request => (request.state as unknown as { candidate: { name: string } }).candidate.name)).size).toBe(expectedTotal);
        invocation = 'detail';
        const detail = await entry.detail(f.context, { query: 'mail' }, options());
        expect(detail.status).toBe('found');
      } catch (error) {
        if (entry.kind === 'autonomy' && !nodeTypes.isProxy(error) && error instanceof ToolInputProjectionError) {
          const cause: unknown = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
          if (cause && typeof cause === 'object' && !nodeTypes.isProxy(cause)
            && Reflect.ownKeys(cause).length === 2) {
            const code = Object.getOwnPropertyDescriptor(cause, 'code');
            const reason = Object.getOwnPropertyDescriptor(cause, 'reason');
            if (code && Object.hasOwn(code, 'value') && code.value === 'source-screening-held'
              && reason && Object.hasOwn(reason, 'value')) {
              const value: unknown = reason.value;
              switch (value) {
                case 'route-unavailable': case 'protected-input': case 'malformed': case 'unsettled':
                case 'cancelled': case 'stale': case 'capacity': case 'busy':
                  console.error(JSON.stringify({ diagnostic: 'autonomy-native-screening-hold', invocation, reason: value }));
              }
            }
          }
        }
        throw error;
      }
    });

    test(`${entry.kind} keeps one uncertain candidate visible and ambiguous`, async () => {
      const f = fixture(); installJudgmentPort(readings({ [entry.chosen]: 0.5 }).port);
      const result = await entry.summary(f.context, { query: 'mail' }, options());
      expect(result[entry.field]).toMatchObject([{ [entry.id]: entry.chosen, judgment: { reading: { verdict: 'uncertain' } } }]);
      const detail = await entry.detail(f.context, { query: 'mail' }, options());
      expect(detail).toMatchObject({ status: 'ambiguous', candidates: [{ [entry.id]: entry.chosen }] });
    });

    test(`${entry.kind} holds a yes reading whose disposition is still unresolved`, async () => {
      const f = fixture(); installJudgmentPort(readings({ [entry.chosen]: 0.575 }).port);
      const result = await entry.summary(f.context, { query: 'mail' }, options());
      expect(result[entry.field]).toMatchObject([{ [entry.id]: entry.chosen, judgment: { reading: { verdict: 'yes', outcome: 'confirm' } } }]);
      expect(await entry.detail(f.context, { query: 'mail' }, options())).toMatchObject({ status: 'ambiguous', candidates: [{ [entry.id]: entry.chosen }] });
    });

    test(`${entry.kind} refuses unavailable canonical readings and preserves exact-ID selection grammar`, async () => {
      const f = fixture();
      await expect(entry.summary(f.context, { query: 'mail' }, options())).rejects.toBeInstanceOf(JudgmentPortMissingError);
      if (entry.kind === 'autonomy' || entry.kind === 'learning') {
        await expect(entry.summary(f.context, {})).rejects.toBeInstanceOf(ToolInputProjectionError);
        await expect(entry.detail(f.context, { [entry.id]: entry.chosen })).rejects.toBeInstanceOf(ToolInputProjectionError);
        const privacy = readings({});
        installJudgmentPort(privacy.port);
        expect((await entry.summary(f.context, {}, options())).total).toBeGreaterThan(0);
        expect((await entry.detail(f.context, { [entry.id]: entry.chosen }, options())).status).toBe('found');
        expect((await entry.detail(f.context, { [entry.id]: 'unknown-id' }, options())).status).toBe('missing_lookup');
        expect(privacy.requests.some(request => request.context?.battery === 'engine.tools.registry-rank')).toBe(false);
        return;
      }
      expect((await entry.summary(f.context, {})).total).toBeGreaterThan(0);
      expect((await entry.detail(f.context, { [entry.id]: entry.chosen })).status).toBe('found');
      expect((await entry.detail(f.context, { [entry.id]: 'unknown-id' })).status).toBe('missing_lookup');
    });

    test(`${entry.kind} does not fall back to a lexical match after negative readings`, async () => {
      const f = fixture(); installJudgmentPort(readings({}).port);
      const result = await entry.summary(f.context, { query: 'mail' }, options());
      expect(result[entry.field]).toEqual([]);
      expect(result.total).toBeGreaterThan(0);
      if (entry.kind === 'process') expect(result.summary).toMatchObject({ tracked: 2, running: 2 });
      expect((await entry.detail(f.context, { query: 'mail' }, options())).status).toBe('missing_lookup');
    });
  }

  test('the actual harness dispatch retains source guards through final catalog publication', async () => {
    const f = fixture(), registry = new ToolRegistry();
    bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
    const harness = createAgentHarnessTool({ commandContext: f.context, commandRegistry: new CommandRegistry(), toolRegistry: registry });
    for (const [mode, chosen, field, id] of [
      ['autonomy_queue', 'research-runs', 'queue', 'queueItemId'],
      ['learning_curator', 'memory:opaque-lesson:needs-review', 'candidates', 'candidateId'],
      ['background_processes', 'opaque-worker', 'processes', 'processId'],
    ] as const) {
      installJudgmentPort(readings({ [chosen]: 0.99 }).port);
      const result = await harness.execute({ mode, query: 'mail', limit: 1 });
      expect(result.success, result.error).toBe(true);
      const page = JSON.parse(String(result.output));
      expect(page[field]).toMatchObject([{ [id]: chosen }]);
    }
  });

  test('process read actions use the same semantic selection and preserve explicit-ID grammar', async () => {
    const f = fixture(); installJudgmentPort(readings({ 'opaque-worker': 0.99 }).port);
    expect(await runBackgroundProcessAction(f.context, { action: 'status', query: 'mail' }, options())).toMatchObject({ processId: 'opaque-worker' });
    expect(await runBackgroundProcessAction(f.context, { action: 'list', query: 'mail' }, options())).toMatchObject({ processes: [{ processId: 'opaque-worker' }] });
    expect(await describeBackgroundProcess(f.context, { processId: 'opaque' }, options())).toMatchObject({ status: 'missing_lookup' });
  });

  test('a process disappearing while its reading is pending cannot publish its stale detail', async () => {
    const f = fixture(), fake = readings({ 'opaque-worker': 0.99 });
    installJudgmentPort({ ...fake.port, ask: async request => {
      const result = await fake.port.ask(request);
      f.manager.records.splice(1, 1);
      return result;
    } });
    await expect(describeBackgroundProcess(f.context, { query: 'mail' }, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('a changed learning collection invalidates the pending selection', async () => {
    const f = fixture(), fake = readings({ 'memory:opaque-lesson:needs-review': 0.99 });
    installJudgmentPort({ ...fake.port, ask: async request => {
      const result = await fake.port.ask(request);
      f.memories[1]!.reviewState = 'reviewed';
      return result;
    } });
    await expect(describeLearningCandidate(f.context, { query: 'mail' }, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('cancellation after a reading does not publish a selected process', async () => {
    const f = fixture(), fake = readings({ 'opaque-worker': 0.99 }), controller = new AbortController();
    installJudgmentPort({ ...fake.port, ask: async request => { const result = await fake.port.ask(request); controller.abort(); return result; } });
    await expect(backgroundProcessSummary(f.context, { query: 'mail' }, { ...options(), signal: controller.signal })).rejects.toThrow();
  });

  test('literal process lists retain their source snapshot through the publication handoff without readings', async () => {
    const f = fixture(), guards: (() => void)[] = [];
    const result = await backgroundProcessSummary(f.context, {}, { retainCurrent: guard => { guards.push(guard); } });
    expect(result.returned).toBe(2);
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) guard();
    f.manager.records.splice(1, 1);
    expect(() => { for (const guard of guards) guard(); }).toThrow(ToolInputProjectionError);
  });

  test('an exact process detail retains its own record across publication without consulting judgment', async () => {
    const f = fixture(), guards: (() => void)[] = [];
    expect(await describeBackgroundProcess(f.context, { processId: 'opaque-worker' }, { retainCurrent: guard => { guards.push(guard); } })).toMatchObject({ status: 'found' });
    f.manager.records[1]!.done = true;
    expect(() => { for (const guard of guards) guard(); }).toThrow(ToolInputProjectionError);
  });

  test('redacted full process source holds before hosted selection or original-value publication', async () => {
    const f = fixture(), fake = readings({ 'opaque-worker': 0.99 });
    f.manager.records[1]!.cmd = 'synthetic-sensitive-record';
    const screening = researchScreeningFixture({ spans: exactSensitiveSpans(['synthetic-sensitive-record']) });
    installJudgmentPort(fake.port);
    await expect(backgroundProcessSummary(f.context, { query: 'mail' }, { sourceOwner: screening.owner })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(fake.requests).toHaveLength(0);
  });
});
