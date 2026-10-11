import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { ToolRegistry, ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { executionVerification } from '@goodvibes-jev/engine/sdk/platform/gate';
import type { CommandContext } from '../../input/command-registry.ts';
import type { AgentExecutionRecord } from '../../runtime/execution-ledger.ts';
import { agentOrchestrationSummary, describeAgentOrchestrationAgent } from '../../tools/agent-harness-agent-orchestration.ts';
import { executionPostureSummary, describeHarnessExecutionRoute } from '../../tools/agent-harness-execution-posture.ts';
import { executionHistorySummary, describeExecutionHistoryItem } from '../../tools/agent-harness-execution-history.ts';
import { delegationPostureSummary, describeHarnessDelegationRoute } from '../../tools/agent-harness-delegation-posture.ts';
import { documentOpsSummary, describeDocumentOpsLane } from '../../tools/agent-harness-document-ops.ts';
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
function readings(fits: Readonly<Record<string, number>>, verification: Readonly<Record<string, number>> = {}) {
  return fakePort((name, _question, state) => {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Unexpected fixture state.');
    if (name === 'verification' && typeof state.id === 'string') return noulAnswer(verification[state.id] ?? 0.001);
    if (name === 'match' && state.candidate && typeof state.candidate === 'object' && !Array.isArray(state.candidate) && typeof state.candidate.name === 'string') return noulAnswer(fits[state.candidate.name] ?? 0.001);
    throw new Error(`Unexpected fixture reading: ${name}`);
  });
}
const options = () => ({ sourceOwner: ordinaryResearchOwner() });
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
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

describe('owned canonical route and record selectors', () => {
  for (const entry of cases) {
    test(`${entry.kind} ranks the complete candidate set before display limits`, async () => {
      const f = fixture(), fake = readings({ [entry.chosen]: 0.999 }); installJudgmentPort(fake.port);
      const all = await entry.summary(f, {});
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
    test(`${entry.kind} preserves exact IDs and literal lists when a reader is unavailable`, async () => {
      const f = fixture();
      await expect(entry.summary(f, { query: 'mail' }, options())).rejects.toBeInstanceOf(JudgmentPortMissingError);
      expect((await entry.summary(f, {})).total).toBeGreaterThan(0);
      expect((await entry.detail(f, { [entry.id]: entry.chosen })).status).toBe('found');
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
    expect((await agentOrchestrationSummary(f.context, f.registry, {}, { retainCurrent: guard => { guards.push(guard); } })).returned).toBe(2);
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
