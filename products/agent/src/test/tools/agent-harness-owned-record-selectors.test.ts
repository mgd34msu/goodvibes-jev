import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { ToolRegistry, ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { registerAccountIdentityRedaction, registerProfileRedactionValues } from '@goodvibes-jev/engine/sdk/platform/utils';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { executionVerification } from '@goodvibes-jev/engine/sdk/platform/gate';
import type { CommandContext } from '../../input/command-registry.ts';
import type { AgentExecutionRecord } from '../../runtime/execution-ledger.ts';
import { agentOrchestrationSummary, describeAgentOrchestrationAgent } from '../../tools/agent-harness-agent-orchestration.ts';
import { executionPostureSummary, describeHarnessExecutionRoute } from '../../tools/agent-harness-execution-posture.ts';
import { executionHistorySummary, describeExecutionHistoryItem } from '../../tools/agent-harness-execution-history.ts';
import { delegationPostureSummary, describeHarnessDelegationRoute } from '../../tools/agent-harness-delegation-posture.ts';
import { documentOpsSummary, describeDocumentOpsLane } from '../../tools/agent-harness-document-ops.ts';
import type { CatalogRankingOptions } from '../../tools/agent-harness-catalog-ranking.ts';
import { createStaticUiReadModel, createStoreBackedUiReadModel } from '../helpers/ui-read-models.ts';
import { createRuntimeStore, createDomainDispatch } from '../../runtime/store/index.ts';
import type { UiReadModel } from '../../runtime/ui-read-models.ts';
import type { RuntimeTask } from '@/runtime/index.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner, researchScreeningFixture, exactSensitiveSpans } from '../helpers/research-screening.ts';

function record(id: string, command: string, status: AgentExecutionRecord['status'] = 'succeeded'): AgentExecutionRecord {
  return { id, callId: id, turnId: 'turn-synthetic', tool: 'exec', routeKind: 'shell', status,
    phase: status === 'running' ? 'TOOL_EXECUTING' : status === 'failed' ? 'TOOL_FAILED' : status === 'cancelled' ? 'TOOL_CANCELLED' : 'TOOL_SUCCEEDED',
    receivedAt: 1000, updatedAt: 2000, argsPreview: '{}', argsKeys: [], commandPreview: command };
}
function fixture() {
  const registry = new ToolRegistry();
  for (const name of ['read', 'edit', 'exec', 'agent']) registry.register({ definition: { name, description: `Synthetic ${name} tool`, parameters: { type: 'object' } }, execute: async () => ({ success: true }) });
  const records = [record('lexical-tests', 'printf "bun test passed"'), record('opaque-proof', 'artifact_probe --synthetic')];
  const agents = [{ id: 'lexical-mail', task: 'mail', status: 'completed', context: 'mail' }, { id: 'opaque-worker', task: 'Another subject', status: 'completed', context: 'Synthetic work' }];
  const manager = { exportState: () => agents };
  const ledger = { getSnapshot: () => ({ records, total: records.length, running: 0, succeeded: records.length, failed: 0, cancelled: 0 }) };
  const context = { extensions: { toolRegistry: registry }, clients: {}, workspace: {}, platform: { config: {} }, ops: { agentManager: manager, executionLedger: ledger }, session: { runtime: { sessionId: 'owned-record-selector' } } } as unknown as CommandContext;
  return { context, registry, records, agents, manager, ledger };
}
const RECORD_INTERPRETATION_BATTERIES = new Set(['agent.runtime.kind', 'agent.runtime.status', 'agent.runtime.schema-status', 'agent.runtime.route-role',
  'agent.remote-publisher.schema-status', 'agent.remote-publisher.outcome-kind']);
const PRIVACY_BATTERIES = new Set(['engine.redaction.field-kind', 'engine.redaction.credential', 'engine.export.credential',
  'engine.redaction.residual-credential', 'engine.redaction.profile-distinctive']);
/** Explicit privacy and publisher interpretations for synthetic local records. No catalog matching answer. */
function recordSupportReadings() {
  const declaredSecrets = new Set(['token', 'password', 'credential', 'apiKey', 'api_key', 'accessToken', 'access_token',
    'refreshToken', 'refresh_token', 'clientSecret', 'client_secret', 'privateKey', 'private_key', 'unlockPassphrase']);
  return fakePort((name, question, state) => {
    // These synthetic native records declare process-output/completed but no
    // schema certification or capture/export operation. Author those readings
    // separately from the catalog match under test.
    if (question.type === 'noul' && (name === 'certified' || name === 'certified_schema')) return noulAnswer(0.001);
    if (question.type === 'choice' && name === 'kind' && Object.hasOwn(question.criteria, 'pty-session')) return choiceAnswer(question, 'process-output', 0.999);
    if (question.type === 'choice' && name === 'status' && Object.hasOwn(question.criteria, 'completed')) return choiceAnswer(question, 'completed', 0.999);
    if (question.type === 'choice' && name === 'role' && Object.hasOwn(question.criteria, 'none')) return choiceAnswer(question, 'none', 0.999);
    if (question.type === 'choice' && name === 'outcome_kind') return choiceAnswer(question, 'other', 0.999);
    if (name === 'kind' && question.type === 'choice' && Object.hasOwn(question.criteria, 'other')
      && state && typeof state === 'object' && !Array.isArray(state) && typeof state.field === 'string') {
      return choiceAnswer(question, declaredSecrets.has(state.field) ? 'secret' : 'other', 0.999);
    }
    if (question.type === 'noul' && ['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name)) {
      const hasDeclaredSpan = (name === 'lineHasCredential' || name === 'spanIsCredential') && state && typeof state === 'object'
        && !Array.isArray(state) && Array.isArray(state.parts) && state.parts.some(part => part && typeof part === 'object'
          && !Array.isArray(part) && part.kind === 'span' && typeof part.field === 'string' && declaredSecrets.has(part.field)
          && (name === 'lineHasCredential' || part.reference === state.target));
      return noulAnswer(hasDeclaredSpan ? 0.999 : 0.001);
    }
    throw new Error(`Semantic matching or unknown privacy contract is unavailable: ${name}`);
  });
}

function readings(fits: Readonly<Record<string, number>>, verification: Readonly<Record<string, number>> = {}) {
  const canonical = fakePort((name, _question, state) => {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Unexpected fixture state.');
    if (name === 'verification' && typeof state.id === 'string') return noulAnswer(verification[state.id] ?? 0.001);
    if (name === 'match' && state.candidate && typeof state.candidate === 'object' && !Array.isArray(state.candidate) && typeof state.candidate.name === 'string') return noulAnswer(fits[state.candidate.name] ?? 0.001);
    throw new Error(`Unexpected fixture reading: ${name}`);
  });
  const privacy = recordSupportReadings();
  const port: JudgmentPort = { ...canonical.port, ask(request) {
    return (PRIVACY_BATTERIES.has(request.context?.battery ?? '') || RECORD_INTERPRETATION_BATTERIES.has(request.context?.battery ?? '')) ? privacy.port.ask(request) : canonical.port.ask(request);
  } };
  return { ...canonical, port, privacyRequests: privacy.requests };
}
const options = () => ({ sourceOwner: ordinaryResearchOwner() });
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previous = installJudgmentPort(undefined);
  registerAccountIdentityRedaction(null); registerProfileRedactionValues(null);
});
afterEach(() => {
  installJudgmentPort(previous);
  registerAccountIdentityRedaction(null); registerProfileRedactionValues(null);
});
afterAll(cleanupResearchScreeningFixtures);

const cases = [
  { kind: 'execution', chosen: 'browser-or-desktop-control', field: 'routes', id: 'executionRouteId',
    summary: (f: ReturnType<typeof fixture>, args: { query?: string; limit?: number }, opts = {}) => executionPostureSummary(f.context, f.registry, args, opts),
    detail: (f: ReturnType<typeof fixture>, args: Record<string, unknown>, opts = {}) => describeHarnessExecutionRoute(f.context, f.registry, args, opts) },
  { kind: 'delegation', chosen: 'hidden-local-fanout-blocked', field: 'routes', id: 'delegationRouteId',
    summary: (f: ReturnType<typeof fixture>, args: { query?: string; limit?: number }, opts = {}) => delegationPostureSummary(f.context, args, opts),
    detail: (f: ReturnType<typeof fixture>, args: Record<string, unknown>, opts = {}) => describeHarnessDelegationRoute(f.context, args, opts) },
  { kind: 'orchestration', chosen: 'opaque-worker', field: 'agents', id: 'agentId',
    summary: (f: ReturnType<typeof fixture>, args: { query?: string; limit?: number }, opts = {}) => agentOrchestrationSummary(f.context, f.registry, args, opts),
    detail: (f: ReturnType<typeof fixture>, args: Record<string, unknown>, opts = {}) => describeAgentOrchestrationAgent(f.context, args, opts) },
  { kind: 'history', chosen: 'opaque-proof', field: 'records', id: 'executionRecordId',
    summary: (f: ReturnType<typeof fixture>, args: { query?: string; limit?: number }, opts = {}) => executionHistorySummary(f.context, args, opts),
    detail: (f: ReturnType<typeof fixture>, args: Record<string, unknown>, opts = {}) => describeExecutionHistoryItem(f.context, args, opts) },
] as const;

const nativeSeams = [
  { kind: 'interactive', chosen: 'browser-or-desktop-control',
    mount(f: ReturnType<typeof fixture>, model: UiReadModel<unknown>) { Object.assign(f.context.platform, { readModels: { execution: { interactiveRuntime: model } } }); },
    run(f: ReturnType<typeof fixture>, opts = {}) { return executionPostureSummary(f.context, f.registry, { query: 'native evidence' }, opts); } },
  { kind: 'remote', chosen: 'opaque-worker',
    mount(f: ReturnType<typeof fixture>, model: UiReadModel<unknown>) { Object.assign(f.context.platform, { readModels: { remoteRuntime: { captureOutcomes: model } } }); },
    run(f: ReturnType<typeof fixture>, opts = {}) { return agentOrchestrationSummary(f.context, f.registry, { query: 'native evidence' }, opts); } },
] as const;

function nativeRecord(summary: string) {
  return { id: 'native-original', runnerId: 'opaque-worker', kind: 'process-output', status: 'completed', summary };
}

describe('owned canonical route and record selectors', () => {
  for (const seam of nativeSeams) {
    test(`${seam.kind} ranks complete private native evidence before presentation clips`, async () => {
      const f = fixture(), fake = readings({ [seam.chosen]: 0.999 }), tail = `${seam.kind}-complete-original-tail`;
      const original = nativeRecord(`${'ordinary '.repeat(100)}${tail}`);
      seam.mount(f, createStaticUiReadModel({ records: [original] })); installJudgmentPort(fake.port);
      const result = await seam.run(f, options());
      expect(fake.requests.filter(request => request.context?.battery === 'engine.tools.registry-rank').length).toBeGreaterThan(0);
      expect(JSON.stringify(fake.requests)).toContain(tail);
      expect(JSON.stringify(result)).not.toContain(tail);
      expect(JSON.stringify(result)).not.toContain('originalSources');
    });
    test(`${seam.kind} holds a private native tail before hosted reading`, async () => {
      const f = fixture(), fake = readings({ [seam.chosen]: 0.999 }), secret = `${seam.kind}-synthetic-private-native-tail`;
      seam.mount(f, createStaticUiReadModel({ records: [nativeRecord(`${'ordinary '.repeat(100)}${secret}`)] }));
      const screening = researchScreeningFixture({ spans: exactSensitiveSpans([secret]) }); installJudgmentPort(fake.port);
      await expect(seam.run(f, { sourceOwner: screening.owner })).rejects.toBeInstanceOf(ToolInputProjectionError);
      expect(fake.requests).toHaveLength(0);
    });
    test(`${seam.kind} refuses a hidden original accessor before projection or hosted reading`, async () => {
      const f = fixture(), fake = readings({ [seam.chosen]: 0.999 }), original = nativeRecord('Complete native original'); let getters = 0;
      Object.defineProperty(original, 'privateEvidence', { get() { getters++; throw new Error('Original accessor must not run'); } });
      seam.mount(f, createStaticUiReadModel({ records: [original] })); installJudgmentPort(fake.port);
      await expect(seam.run(f, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
      expect(getters).toBe(0); expect(fake.requests).toHaveLength(0);
    });
    test(`${seam.kind} rejects an undisplayed native tail edit before logging or publishing`, async () => {
      const f = fixture(), fake = readings({ [seam.chosen]: 0.999 }), original = nativeRecord(`${'ordinary '.repeat(100)}original-tail`);
      seam.mount(f, createStaticUiReadModel({ records: [original] }));
      let start!: () => void, finish!: () => void;
      const started = new Promise<void>(resolve => { start = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
      using log = new SqliteDecisionLog(':memory:');
      installJudgmentPort(withDecisionLog({ ...fake.port, ask: async request => { start(); await gate; return fake.port.ask(request); } }, log));
      const pending = seam.run(f, options()); await started;
      original.summary = `${'ordinary '.repeat(100)}changed-tail`;
      finish(); await expect(pending).rejects.toThrow(ToolInputProjectionError); expect(log.query({})).toHaveLength(0);
    });
    test(`${seam.kind} keeps large originals structured and complete within the existing source budget`, async () => {
      const f = fixture(), fake = readings({ [seam.chosen]: 0.999 }), tail = `${seam.kind}-large-complete-tail`;
      const source = { records: [{ ...nativeRecord('Complete native original'), evidence: Array.from({ length: 100 }, (_, index) => ({ detail: `${'ordinary '.repeat(80)}fragment-${index}${index === 99 ? tail : ''}` })) }] };
      expect(JSON.stringify(source).length).toBeGreaterThan(40_000);
      seam.mount(f, createStaticUiReadModel(source)); installJudgmentPort(fake.port);
      const result = await seam.run(f, options());
      expect(JSON.stringify(fake.requests)).toContain(tail);
      expect(JSON.stringify(result)).not.toContain(tail);
      expect(JSON.stringify(result)).not.toContain('originalSources');
    });
    test(`${seam.kind} retains native notification epochs through ABA without retiring unrelated changes`, async () => {
      const f = fixture(), fake = readings({ [seam.chosen]: 0.999 }), store = createRuntimeStore(), dispatch = createDomainDispatch(store);
      const original: RuntimeTask = { id: 'native-task', kind: 'exec', title: 'Complete native original', status: 'queued', owner: 'native-test', cancellable: true, childTaskIds: [], queuedAt: 4001 };
      dispatch.syncRuntimeTask(original);
      const model = createStoreBackedUiReadModel(store, () => ({ records: [...store.getState().tasks.tasks.values()].map(task => ({ ...nativeRecord(task.title), tasks: [task] })) }));
      seam.mount(f, model); installJudgmentPort(fake.port); const guards: Array<() => void> = [];
      await seam.run(f, { ...options(), retainCurrent: (guard: () => void) => { guards.push(guard); } });
      dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'unrelated-native-domain', task: 'Unrelated domain' });
      expect(() => guards.forEach(guard => guard())).not.toThrow();
      dispatch.syncRuntimeTask({ ...original, title: 'Changed native original' }); dispatch.syncRuntimeTask(original);
      expect(() => guards.forEach(guard => guard())).toThrow(ToolInputProjectionError);
    });
  }
  test('native service holders are guarded separately from consumed remote snapshot DTOs', async () => {
    const f = fixture();
    const source = { records: [{ id: 'native-record', runnerId: 'opaque-worker', status: 'completed', summary: 'Complete native remote evidence' }] };
    const readModel = createStaticUiReadModel(source);
    Object.assign(f.context.platform, { readModels: { remote: createStaticUiReadModel({ acp: {} }), remoteRuntime: { captureOutcomes: readModel } } });
    const guards: Array<() => void> = [];
    installJudgmentPort(recordSupportReadings().port);
    expect((await agentOrchestrationSummary(f.context, f.registry, {}, { ...options(), retainCurrent: guard => { guards.push(guard); } })).total).toBeGreaterThan(0);
    guards.forEach(guard => guard()); const record = source.records[0]; if (!record) throw new Error('Missing actual source record'); record.summary = 'Changed actual hidden native snapshot';
    expect(() => guards.forEach(guard => guard())).toThrow(ToolInputProjectionError);
  });
  test('native workspace maps retain complete private keys and record tails before presentation', async () => {
    const f = fixture(), fake = readings({ 'opaque-worker': 0.999 }), tail = 'complete-native-map-tail';
    const original = { id: 'workspace-original', runnerId: 'opaque-worker', status: 'ready', workspaceId: 'workspace-native', isolationKind: 'worktree', label: `${'ordinary '.repeat(100)}${tail}` };
    Object.assign(f.context.platform, { readModels: { remoteRuntime: { workspaceIsolation: new Map([['native-map-key', original]]) } } });
    installJudgmentPort(fake.port);
    const result = await agentOrchestrationSummary(f.context, f.registry, { query: 'native evidence' }, options());
    expect(JSON.stringify(fake.requests)).toContain(tail); expect(JSON.stringify(fake.requests)).toContain('native-map-key');
    expect(JSON.stringify(result)).not.toContain(tail); expect(JSON.stringify(result)).not.toContain('originalSources');
  });
  test('native workspace map hidden accessors remain uninvoked before any reading', async () => {
    const f = fixture(), fake = readings({ 'opaque-worker': 0.999 }); let getters = 0;
    const original = { id: 'workspace-original', runnerId: 'opaque-worker', status: 'ready', workspaceId: 'workspace-native' };
    Object.defineProperty(original, 'privateEvidence', { get() { getters++; throw new Error('Original map accessor must not run'); } });
    Object.assign(f.context.platform, { readModels: { remoteRuntime: { workspaceIsolation: new Map([['native-map-key', original]]) } } });
    installJudgmentPort(fake.port);
    await expect(agentOrchestrationSummary(f.context, f.registry, { query: 'native evidence' }, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(getters).toBe(0); expect(fake.requests).toHaveLength(0);
  });
  test('native workspace map replacement retires an awaited read before logging or publication', async () => {
    const f = fixture(), fake = readings({ 'opaque-worker': 0.999 });
    const original = { id: 'workspace-original', runnerId: 'opaque-worker', status: 'ready', workspaceId: 'workspace-native', label: `${'ordinary '.repeat(100)}original-tail` };
    const records = new Map([['native-map-key', original]]);
    Object.assign(f.context.platform, { readModels: { remoteRuntime: { workspaceIsolation: records } } });
    let start!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog({ ...fake.port, ask: async request => { start(); await gate; return fake.port.ask(request); } }, log));
    const pending = agentOrchestrationSummary(f.context, f.registry, { query: 'native evidence' }, options()); await started;
    records.set('native-map-key', { ...original, label: `${'ordinary '.repeat(100)}changed-tail` });
    finish(); await expect(pending).rejects.toThrow(ToolInputProjectionError); expect(log.query({})).toHaveLength(0);
  });
  test('native browser service methods are not serialized as interactive record DTOs', async () => {
    const f = fixture();
    Object.assign(f.context.platform, { readModels: { browser: createStaticUiReadModel({ nativeStatus: 'ready' }) } });
    expect((await executionPostureSummary(f.context, f.registry, {})).routes).toBeArray();
  });
  for (const entry of cases) {
    test(`${entry.kind} retains a pure source restriction inside its actual caller readset`, async () => {
      const f = fixture(), fake = readings({ [entry.chosen]: 0.999 }), guards: Array<() => void> = [];
      installJudgmentPort(fake.port);
      const assertCurrent = () => { for (const guard of guards) guard(); };
      const retained = { ...options(), assertCurrent, retainCurrent: (guard: () => void) => { guards.push(guard); } };
      expect((await entry.summary(f, { query: 'mail' }, retained))[entry.field]).toMatchObject([{ [entry.id]: entry.chosen }]);
      expect(() => assertCurrent()).not.toThrow();
      f.context.session.runtime.sessionId = 'changed-original-session';
      expect(() => assertCurrent()).toThrow(ToolInputProjectionError);
    });
    test(`${entry.kind} still checks the active caller after an awaited reading`, async () => {
      const f = fixture(), fake = readings({ [entry.chosen]: 0.999 }), guards: Array<() => void> = [];
      let retired = false, start!: () => void, finish!: () => void;
      const started = new Promise<void>(resolve => { start = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
      using log = new SqliteDecisionLog(':memory:');
      installJudgmentPort(withDecisionLog({ ...fake.port, ask: async request => { start(); await gate; return fake.port.ask(request); } }, log));
      const assertCurrent = () => { if (retired) throw new ToolInputProjectionError('stale'); for (const guard of guards) guard(); };
      const retainCurrent: NonNullable<CatalogRankingOptions['retainCurrent']> = guard => { guards.push(guard); };
      const pending = entry.summary(f, { query: 'mail' }, { ...options(), assertCurrent, retainCurrent });
      await started; retired = true; finish();
      await expect(pending).rejects.toThrow(ToolInputProjectionError); expect(log.query({})).toHaveLength(0);
    });
    test(`${entry.kind} ranks the complete candidate set before display limits`, async () => {
      const f = fixture(), fake = readings({ [entry.chosen]: 0.999 }); installJudgmentPort(fake.port);
      const all = await entry.summary(f, {}, entry.kind === 'orchestration' ? options() : {});
      const result = await entry.summary(f, { query: 'mail', limit: 1 }, options());
      expect(result[entry.field]).toMatchObject([{ [entry.id]: entry.chosen, judgment: { reading: { verdict: 'yes' } } }]);
      expect(result.total).toBe(all.total);
      const ranking = fake.requests.filter(request => request.context?.battery === 'engine.tools.registry-rank');
      expect(ranking).toHaveLength(Number(all.total));
      expect((await entry.detail(f, { query: 'mail' }, options())).status).toBe('found');
    });
    test(`${entry.kind} holds a sole uncertain match and never guesses a lexical fallback`, async () => {
      const f = fixture(); installJudgmentPort(readings({ [entry.chosen]: 0.5 }).port);
      expect(await entry.detail(f, { query: 'mail' }, options())).toMatchObject({ status: 'ambiguous', candidates: [{ [entry.id]: entry.chosen }] });
      installJudgmentPort(readings({}).port);
      expect((await entry.summary(f, { query: 'mail' }, options()))[entry.field]).toEqual([]);
      expect((await entry.detail(f, { query: 'mail' }, options())).status).toBe('missing_lookup');
    });
    test(`${entry.kind} holds either side when the canonical outcome cannot act`, async () => {
      const f = fixture();
      for (const probability of [0.58, 0.42]) {
        installJudgmentPort(readings({ [entry.chosen]: probability }).port);
        expect(await entry.detail(f, { query: 'mail' }, options())).toMatchObject({ status: 'ambiguous', candidates: [{ [entry.id]: entry.chosen, judgment: { reading: { outcome: 'confirm' } } }] });
        expect((await entry.summary(f, { query: 'mail' }, options()))[entry.field]).toMatchObject([{ [entry.id]: entry.chosen, judgment: { reading: { outcome: 'confirm' } } }]);
      }
    });
    test(`${entry.kind} preserves exact IDs and literal lists when semantic matching is unavailable`, async () => {
      const f = fixture();
      await expect(entry.summary(f, { query: 'mail' }, options())).rejects.toBeInstanceOf(JudgmentPortMissingError);
      if (entry.kind === 'orchestration') installJudgmentPort(recordSupportReadings().port);
      const literalOptions = entry.kind === 'orchestration' ? options() : {};
      expect((await entry.summary(f, {}, literalOptions)).total).toBeGreaterThan(0);
      expect((await entry.detail(f, { [entry.id]: entry.chosen }, literalOptions)).status).toBe('found');
      expect((await entry.detail(f, { [entry.id]: 'mail' })).status).toBe('missing_lookup');
    });
  }

  test('Document Ops keeps its literal list synchronous and reads semantic details canonically', async () => {
    const f = fixture(); const all = documentOpsSummary(f.context, {});
    expect(all).not.toBeInstanceOf(Promise); expect(all.returned).toBe(10);
    expect((await describeDocumentOpsLane(f.context, { laneId: 'model_compare' })).status).toBe('found');
    const fake = readings({ model_compare: 0.999 }); installJudgmentPort(fake.port);
    expect(await describeDocumentOpsLane(f.context, { query: 'mail' }, options())).toMatchObject({ status: 'found', lane: { id: 'model_compare', judgment: { reading: { verdict: 'yes' } } } });
    expect(fake.requests).toHaveLength(10);
    installJudgmentPort(readings({ model_compare: 0.5 }).port);
    expect(await describeDocumentOpsLane(f.context, { query: 'mail' }, options())).toMatchObject({ status: 'ambiguous' });
    for (const probability of [0.58, 0.42]) {
      installJudgmentPort(readings({ model_compare: probability }).port);
      expect(await describeDocumentOpsLane(f.context, { query: 'mail' }, options())).toMatchObject({ status: 'ambiguous', candidates: [{ laneId: 'model_compare', judgment: { reading: { outcome: 'confirm' } } }] });
    }
  });
  test('Document Ops retains a pure source restriction inside its actual caller readset', async () => {
    const f = fixture(), guards: Array<() => void> = [];
    const assertCurrent = () => { for (const guard of guards) guard(); };
    expect((await describeDocumentOpsLane(f.context, { laneId: 'model_compare' }, { assertCurrent, retainCurrent: guard => { guards.push(guard); } })).status).toBe('found');
    expect(() => assertCurrent()).not.toThrow();
    Object.assign(f.context.platform, { config: { changedSource: true } });
    expect(() => assertCurrent()).toThrow(ToolInputProjectionError);
  });

  test('a full orchestration candidate beyond the old preview is screened before any hosted reading', async () => {
    const f = fixture(), fake = readings({ 'opaque-worker': 0.999 });
    f.agents[1]!.context = `${'ordinary '.repeat(100)}synthetic-private-record`;
    const screening = researchScreeningFixture({ spans: exactSensitiveSpans(['synthetic-private-record']) });
    installJudgmentPort(fake.port);
    await expect(agentOrchestrationSummary(f.context, f.registry, { query: 'mail' }, { sourceOwner: screening.owner })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(fake.requests).toHaveLength(0);
  });

  test('the canonical reading receives the complete context beyond display previews', async () => {
    const f = fixture(), fake = readings({ 'opaque-worker': 0.999 });
    f.agents[1]!.context = `${'ordinary '.repeat(100)}complete-source-tail`;
    installJudgmentPort(fake.port);
    expect((await describeAgentOrchestrationAgent(f.context, { query: 'mail' }, options())).status).toBe('found');
    expect(JSON.stringify(fake.requests)).toContain('complete-source-tail');
  });

  test('linked work evidence is protected and read in full beyond its card preview', async () => {
    const f = fixture(), fake = readings({ 'opaque-worker': 0.999 }), timestamp = 1791684509006;
    const workItem = { id: 'linked-work', title: 'Synthetic linked work', status: 'done', linked: { agentId: 'opaque-worker' },
      notes: `${'ordinary '.repeat(100)}linked-evidence-tail`, createdAt: timestamp, updatedAt: timestamp, completedAt: timestamp };
    Object.assign(f.context.workspace, { workPlanStore: { listItems: () => [workItem] } });
    installJudgmentPort(fake.port);
    expect((await describeAgentOrchestrationAgent(f.context, { query: 'mail' }, options())).status).toBe('found');
    expect(JSON.stringify(fake.requests)).toContain('linked-evidence-tail');
    expect(JSON.stringify(fake.requests)).not.toContain(String(timestamp));
    const before = fake.requests.length;
    workItem.notes = `${'ordinary '.repeat(100)}synthetic-private-linked-record`;
    const screening = researchScreeningFixture({ spans: exactSensitiveSpans(['synthetic-private-linked-record']) });
    await expect(describeAgentOrchestrationAgent(f.context, { query: 'mail' }, { sourceOwner: screening.owner })).rejects.toThrow(ToolInputProjectionError);
    expect(fake.requests).toHaveLength(before);
  });

  test.each(['record', 'manager', 'cancel', 'session'] as const)('an awaited orchestration reading fences %s loss before logging or publication', async change => {
    const f = fixture(), fake = readings({ 'opaque-worker': 0.999 }), controller = new AbortController();
    let start!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog({ ...fake.port, ask: async request => { start(); await gate; return fake.port.ask(request); } }, log));
    const pending = describeAgentOrchestrationAgent(f.context, { query: 'mail' }, { ...options(), signal: controller.signal });
    await started;
    if (change === 'record') f.agents[1]!.task = 'Retired source';
    if (change === 'manager') f.manager.exportState = () => [...f.agents];
    if (change === 'cancel') controller.abort();
    if (change === 'session') f.context.session.runtime.sessionId = 'retired-session';
    finish(); await expect(pending).rejects.toThrow(); expect(log.query({})).toHaveLength(0);
  });

  test.each(['orchestration', 'history'] as const)('a replaced %s backend accessor is refused without invocation', async kind => {
    const f = fixture(), fake = readings({ 'opaque-worker': 0.999 }, { 'opaque-proof': 0.999 });
    let start!: () => void, finish!: () => void, accessorCalls = 0;
    const started = new Promise<void>(resolve => { start = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog({ ...fake.port, ask: async request => { start(); await gate; return fake.port.ask(request); } }, log));
    const pending = kind === 'orchestration'
      ? describeAgentOrchestrationAgent(f.context, { query: 'mail' }, options())
      : executionHistorySummary(f.context, {}, options());
    await started;
    Object.defineProperty(kind === 'orchestration' ? f.manager : f.ledger, kind === 'orchestration' ? 'exportState' : 'getSnapshot', {
      configurable: true, get() { accessorCalls++; throw new Error('Replacement accessor must not execute.'); },
    });
    finish(); await expect(pending).rejects.toThrow(ToolInputProjectionError);
    expect(accessorCalls).toBe(0); expect(log.query({})).toHaveLength(0);
  });

  test.each(['orchestration', 'execution'] as const)('a replaced nested %s published-source accessor is refused without invocation', async kind => {
    const f = fixture(), fake = readings({ 'opaque-worker': 0.999, 'browser-or-desktop-control': 0.999 });
    const published = { records: [] };
    Object.assign(f.context.platform, { readModels: kind === 'orchestration' ? { remoteRuntime: { captureOutcomes: published } } : { execution: { interactiveRuntime: published } } });
    let start!: () => void, finish!: () => void, accessorCalls = 0;
    const started = new Promise<void>(resolve => { start = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog({ ...fake.port, ask: async request => { start(); await gate; return fake.port.ask(request); } }, log));
    const pending = kind === 'orchestration'
      ? describeAgentOrchestrationAgent(f.context, { query: 'mail' }, options())
      : describeHarnessExecutionRoute(f.context, f.registry, { query: 'mail' }, options());
    await started;
    Object.defineProperty(published, 'records', { configurable: true, get() { accessorCalls++; throw new Error('Replacement accessor must not execute.'); } });
    finish(); await expect(pending).rejects.toThrow(ToolInputProjectionError);
    expect(accessorCalls).toBe(0); expect(log.query({})).toHaveLength(0);
  });

  test('literal route lists retain their read set through publication without a hosted reading', async () => {
    const f = fixture(), guards: (() => void)[] = [];
    expect((await executionPostureSummary(f.context, f.registry, {}, { retainCurrent: guard => { guards.push(guard); } })).returned).toBe(6);
    f.registry.unregister('exec');
    expect(() => { for (const guard of guards) guard(); }).toThrow(ToolInputProjectionError);
  });

  test('orchestration posture retains its tool readiness read set through publication', async () => {
    const f = fixture(), guards: (() => void)[] = [];
    installJudgmentPort(recordSupportReadings().port);
    expect((await agentOrchestrationSummary(f.context, f.registry, {}, { ...options(), retainCurrent: guard => { guards.push(guard); } })).returned).toBe(2);
    f.registry.unregister('agent');
    expect(() => { for (const guard of guards) guard(); }).toThrow(ToolInputProjectionError);
  });

  test('verification role uses its named battery and typed run status, not test words in a result', async () => {
    const f = fixture(), fake = readings({}, { 'opaque-proof': 0.999 }); installJudgmentPort(fake.port);
    const result = await executionHistorySummary(f.context, {}, options());
    expect(result.activityCards).toMatchObject([{ verification: { status: 'passed', evidence: [{ executionRecordId: 'opaque-proof' }] } }]);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.every(request => request.context?.battery === 'engine.gate.execution-verification')).toBe(true);
    f.records[1] = record('opaque-proof', 'artifact_probe --synthetic', 'failed');
    expect((await executionHistorySummary(f.context, {}, options())).activityCards).toMatchObject([{ verification: { status: 'failed' } }]);
  });

  test('uncertain or unavailable verification remains explicitly held', async () => {
    const f = fixture();
    for (const probability of [0.5, 0.8]) {
      installJudgmentPort(readings({}, { 'opaque-proof': probability }).port);
      expect((await executionHistorySummary(f.context, {}, options())).activityCards).toMatchObject([{ verification: { status: 'held', heldExecutionRecordIds: ['opaque-proof'] } }]);
    }
    installJudgmentPort(undefined);
    expect((await describeExecutionHistoryItem(f.context, { executionRecordId: 'opaque-proof' })).status).toBe('found');
    expect((await executionHistorySummary(f.context, {})).activityCards).toMatchObject([{ verification: { status: 'held' } }]);
  });

  test('the typed route alone determines file recovery; a delete-like read name grants none', async () => {
    const f = fixture();
    f.records[0] = { ...record('name-only', ''), tool: 'delete_inbox_preview', routeKind: 'read' };
    f.records[1] = { ...record('opaque-write', ''), tool: 'opaque_operation', routeKind: 'write' };
    Object.assign(f.context.workspace, { fileUndoManager: { undoDepth: () => 1, redoDepth: () => 0, peekUndo: () => null } });
    const read = await describeExecutionHistoryItem(f.context, { executionRecordId: 'name-only' });
    const write = await describeExecutionHistoryItem(f.context, { executionRecordId: 'opaque-write' });
    expect(read).toMatchObject({ status: 'found', record: { tool: 'delete_inbox_preview' } });
    if (read.status === 'found') expect(read.record.recoveryRoute).toBeUndefined();
    expect(write).toMatchObject({ status: 'found', record: { recoveryRoute: 'execution action:"recovery"' } });
  });

  test('a cancelled verification cannot retain a late reading or a success card', async () => {
    const f = fixture(), fake = readings({}, { 'opaque-proof': 0.999 }), controller = new AbortController();
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog({ ...fake.port, ask: async request => { const response = await fake.port.ask(request); controller.abort(); return response; } }, log));
    await expect(executionHistorySummary(f.context, {}, { ...options(), signal: controller.signal })).rejects.toThrow();
    expect(log.query({})).toHaveLength(0);
  });

  test('a replaced verification source owner accessor cannot execute or log a reading', async () => {
    const f = fixture(), fake = readings({}, { 'opaque-proof': 0.999 }), owner = ordinaryResearchOwner();
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'project');
    let accessorCalls = 0;
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog({ ...fake.port, ask: async request => {
      const response = await fake.port.ask(request);
      Object.defineProperty(owner, 'project', { configurable: true, get() { accessorCalls++; throw new Error('Replacement accessor must not execute.'); } });
      return response;
    } }, log));
    try {
      await expect(executionHistorySummary(f.context, {}, { sourceOwner: owner })).rejects.toThrow(ToolInputProjectionError);
      expect(accessorCalls).toBe(0); expect(log.query({})).toHaveLength(0);
    } finally {
      if (descriptor) Object.defineProperty(owner, 'project', descriptor); else Reflect.deleteProperty(owner, 'project');
    }
  });

  test('producer clocks use ISO in protected readings while identical borrowed values remain refused', async () => {
    const f = fixture(), timestamp = 1791684509006;
    f.records[1] = { ...f.records[1]!, receivedAt: timestamp, updatedAt: timestamp, completedAt: timestamp };
    Object.assign(f.agents[1]!, { startedAt: timestamp, completedAt: timestamp });
    const fake = readings({ 'opaque-proof': 0.999, 'opaque-worker': 0.999 }, { 'opaque-proof': 0.999 }); installJudgmentPort(fake.port);
    expect(await describeExecutionHistoryItem(f.context, { query: 'mail' }, options())).toMatchObject({ status: 'found', record: { receivedAt: new Date(timestamp).toISOString() } });
    expect(await describeAgentOrchestrationAgent(f.context, { query: 'mail' }, options())).toMatchObject({ status: 'found', agent: { startedAt: timestamp } });
    expect(JSON.stringify(fake.requests)).not.toContain(String(timestamp));
    const before = fake.requests.length;
    f.records[1] = { ...f.records[1]!, argsPreview: String(timestamp) };
    await expect(describeExecutionHistoryItem(f.context, { query: 'mail' }, options())).rejects.toThrow();
    expect(fake.requests).toHaveLength(before);
  });

  test('artifact expiry clock authority belongs to its store acquisition and cannot move with a record', async () => {
    const f = fixture(), expiresAt = 1791684509006;
    const receipt = { id: 'opaque-receipt', kind: 'data', mimeType: 'application/json', sizeBytes: 2,
      sha256: 'synthetic-native-content-hash', createdAt: 1000, expiresAt,
      acquisitionMode: 'inline-data', fetchMode: 'not-applicable', metadata: {
        purpose: 'connected-host-remote-runner-closeout-receipt', runnerId: 'opaque-worker', summary: 'Complete native receipt',
      } };
    Object.assign(f.context.platform, { artifactStore: { list: () => [receipt] } });
    const fake = readings({ 'opaque-worker': 0.999 }); installJudgmentPort(fake.port);
    expect(await describeAgentOrchestrationAgent(f.context, { query: 'mail' }, options())).toMatchObject({ status: 'found' });
    expect(JSON.stringify(fake.requests)).toContain(new Date(expiresAt).toISOString());
    expect(JSON.stringify(fake.requests)).not.toContain(String(expiresAt));
    const before = fake.requests.length;
    Object.assign(f.context.platform, { artifactStore: undefined });
    Object.assign(f.context.ops, { remoteRuntime: { listContracts: () => [], listPools: () => [], listArtifacts: () => [receipt] } });
    await expect(describeAgentOrchestrationAgent(f.context, { query: 'mail' }, options())).rejects.toThrow();
    expect(fake.requests).toHaveLength(before);
  });

  test('fractional producer clocks cannot silently lose precision before readings', async () => {
    const f = fixture(), fake = readings({ 'opaque-worker': 0.999 }); installJudgmentPort(fake.port);
    Object.assign(f.agents[1]!, { startedAt: 1791684509006.5 });
    await expect(describeAgentOrchestrationAgent(f.context, { query: 'mail' }, options())).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });

  test('orchestration reads every acquired receipt before limiting public artifact cards', async () => {
    const f = fixture();
    const receipts = Array.from({ length: 21 }, (_, index) => ({
      id: `native-receipt-${index}`, kind: 'data', mimeType: 'application/json', sizeBytes: 2,
      sha256: 'synthetic-native-content-hash', createdAt: index + 1,
      metadata: { purpose: 'connected-host-remote-runner-closeout-receipt', runnerId: 'opaque-worker',
        summary: index === 0 ? 'Complete oldest receipt outside the former shortlist' : `Complete native receipt ${index}` },
    }));
    Object.defineProperty(receipts[0]!, 'description', { value: 'Complete hidden native receipt evidence', enumerable: false });
    Object.assign(f.context.platform, { artifactStore: { list: () => receipts } });
    const fake = readings({ 'opaque-worker': 0.999 }); installJudgmentPort(fake.port);
    expect(await describeAgentOrchestrationAgent(f.context, { query: 'mail' }, options())).toMatchObject({ status: 'found' });
    const ranked = fake.requests.filter(request => request.context?.battery === 'engine.tools.registry-rank');
    expect(JSON.stringify(ranked)).toContain('Complete oldest receipt outside the former shortlist');
    expect(JSON.stringify(ranked)).toContain('Complete hidden native receipt evidence');
    const before = fake.requests.length;
    Object.defineProperty(receipts[0]!, 'hidden', { value: '4111111111111111', enumerable: false });
    await expect(describeAgentOrchestrationAgent(f.context, { query: 'mail' }, options())).rejects.toThrow();
    expect(fake.requests).toHaveLength(before);
  });

  test('a changed verification definition cannot log or consume an old response', async () => {
    const f = fixture(), fake = readings({}, { 'opaque-proof': 0.999 });
    const question = executionVerification.items.verification.question;
    const descriptor = Object.getOwnPropertyDescriptor(question, 'instructions');
    if (!descriptor) throw new Error('Missing fixture question instructions.');
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog({ ...fake.port, ask: async request => {
      const result = await fake.port.ask(request);
      Object.defineProperty(question, 'instructions', { ...descriptor, value: 'A different verification contract.' });
      return result;
    } }, log));
    try {
      await expect(executionHistorySummary(f.context, {}, options())).rejects.toThrow();
      expect(log.query({})).toHaveLength(0);
    } finally { Object.defineProperty(question, 'instructions', descriptor); }
  });
});


describe('orchestration literal output preserves complete original refusal parity', () => {
  const branches = ['no-query', 'exact-id'] as const;
  function run(branch: typeof branches[number], f: ReturnType<typeof fixture>, opts: CatalogRankingOptions) {
    return branch === 'no-query' ? agentOrchestrationSummary(f.context, f.registry, { limit: 1 }, opts)
      : describeAgentOrchestrationAgent(f.context, { agentId: 'opaque-worker', includeParameters: false }, opts);
  }
  for (const branch of branches) {
    test(`${branch} refuses nonempty output without its trusted source owner`, async () => {
      const f = fixture(), privacy = recordSupportReadings(); installJudgmentPort(privacy.port);
      await expect(run(branch, f, {})).rejects.toBeInstanceOf(ToolInputProjectionError);
      expect(privacy.requests).toHaveLength(0);
    });

    test(`${branch} privately redacts permitted generic credentials without semantic matching`, async () => {
      const f = fixture(), privacy = recordSupportReadings(), secret = 'ORCHESTRATION_LITERAL_PRIVATE';
      const selected = branch === 'no-query' ? f.agents[0] : f.agents.find(agent => agent.id === 'opaque-worker');
      if (!selected) throw new Error('Original selected agent missing');
      selected.task = `Ordinary task token=${secret}; still visible`;
      const screening = researchScreeningFixture(); installJudgmentPort(privacy.port);
      const result = await run(branch, f, { sourceOwner: screening.owner });
      expect(result).toMatchObject(branch === 'no-query' ? { total: 2 } : { status: 'found' });
      const wire = JSON.stringify({ result, privacy: privacy.requests, screening: screening.calls });
      expect(wire).not.toContain(secret);
      expect(selected.task).toContain(secret);
      expect(privacy.requests.filter(request => request.context?.battery === 'engine.tools.registry-rank')).toHaveLength(0);
      expect(screening.calls.length).toBeGreaterThan(0);
    });

    for (const placement of ['native-workspace-component', 'selected-agent-tail', 'unselected-agent-tail', 'native-remote-tail'] as const) {
      for (const kind of ['card', 'issuer'] as const) {
        test(`${branch} refuses complete ${kind} material in ${placement} before any wire`, async () => {
          const f = fixture(), privacy = recordSupportReadings(), screening = researchScreeningFixture();
          const material = kind === 'card' ? '4111' + '1111'.repeat(3) : 'ghp_' + 'A'.repeat(36);
          const selectedId = branch === 'no-query' ? 'lexical-mail' : 'opaque-worker';
          const selected = f.agents.find(agent => agent.id === selectedId), other = f.agents.find(agent => agent.id !== selectedId);
          if (!selected || !other) throw new Error('Original agents missing');
          if (placement === 'native-workspace-component') {
            const source = { workspaceId: 'literal-native-workspace', runnerId: selected.id, status: 'ready', worktreePath: `/tmp/token=${material}/owned-worktree` };
            Object.assign(f.context.platform, { readModels: { remoteRuntime: { workspaceIsolation: new Map([['native-map-key', source]]) } } });
          } else if (placement === 'native-remote-tail') {
            Object.assign(f.context.platform, { readModels: { remoteRuntime: { captureOutcomes: createStaticUiReadModel({ records: [nativeRecord(`${'ordinary '.repeat(100)}${material}`)] }) } } });
          } else {
            (placement === 'selected-agent-tail' ? selected : other).context = `${'ordinary '.repeat(100)}${material}`;
          }
          installJudgmentPort(privacy.port);
          await expect(run(branch, f, { sourceOwner: screening.owner })).rejects.toBeInstanceOf(ToolInputProjectionError);
          expect(privacy.requests).toHaveLength(0); expect(screening.calls).toHaveLength(0);
          expect(selected.status).toBe('completed'); expect(other.status).toBe('completed');
        });
      }
    }
  }

  for (const kind of ['card', 'issuer'] as const) {
    test(`empty no-query agent output still refuses full original workspace ${kind} before any wire`, async () => {
      const f = fixture(), privacy = recordSupportReadings(), screening = researchScreeningFixture();
      f.agents.length = 0;
      const material = kind === 'card' ? '4111' + '1111'.repeat(3) : 'ghp_' + 'A'.repeat(36);
      const original = { workspaceId: 'empty-native-workspace', runnerId: 'absent-native-agent', status: 'ready', worktreePath: `/tmp/token=${material}/owned-worktree` };
      Object.assign(f.context.platform, { readModels: { remoteRuntime: { workspaceIsolation: new Map([['native-map-key', original]]) } } });
      installJudgmentPort(privacy.port);
      await expect(agentOrchestrationSummary(f.context, f.registry, {}, { sourceOwner: screening.owner })).rejects.toBeInstanceOf(ToolInputProjectionError);
      expect(privacy.requests).toHaveLength(0); expect(screening.calls).toHaveLength(0); expect(f.agents).toHaveLength(0);
      expect(original.worktreePath).toContain(material);
    });
  }
});
