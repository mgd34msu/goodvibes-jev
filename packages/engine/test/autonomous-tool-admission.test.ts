import { RuntimeEventBus, type ToolEvent } from '../sdk/src/platform/runtime/events/index.ts';
import { decideAutonomousTool as publicSelector } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { decideAutonomousTool } from '../sdk/src/platform/permissions/autonomous.ts';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { withDecisionLog, SqliteDecisionLog, createSystemOnePort, PINNED_MODEL, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.ts';
import { PermissionManager, type GateOptions, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../sdk/src/platform/core/orchestrator-tool-runtime.ts';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import { UserPermissionRuleStore } from '../sdk/src/platform/permissions/user-rule-store.ts';
import { buildDurableRuleForDecision } from '../sdk/src/platform/permissions/approval-rules.ts';
import { InspectTool } from '../sdk/src/platform/tools/inspect/index.ts';
import { UntrustedContentLedger } from '../sdk/src/platform/security/untrusted-content.ts';
import { EXEC_TOOL_SCHEMA } from '../sdk/src/platform/tools/exec/schema.ts';

let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
let requests: JudgmentRequest<Questions>[];
let choice = 'act';
let confidence = 0.97;
let answer: ((request: JudgmentRequest<Questions>) => string) | undefined;
beforeEach(() => {
  forgetGateReadings(); log = new SqliteDecisionLog(':memory:'); requests = []; choice = 'act'; confidence = 0.97; answer = undefined;
  const gate = gateReadingsPort();
  const semantic = fakePort((_name, question, _state) => choiceAnswer(question, choice, confidence));
  const inner: JudgmentPort = { model: gate.port.model, async ask(request) {
    request.signal?.throwIfAborted(); request.beforeAttempt?.(); requests.push(request as JudgmentRequest<Questions>);
    if ('disposition' in request.questions) {
      if (answer) choice = answer(request as JudgmentRequest<Questions>);
      return semantic.port.ask(request);
    }
    return gate.port.ask(request);
  } };
  previous = installJudgmentPort(withDecisionLog(inner, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); });

const args = () => ({ commands: [{ cmd: 'git commit -m autonomous-fixture' }] });
function fixture(gate: GateOptions = {}, store: UserPermissionRuleStore | null = null) {
  let directory = '/synthetic/autonomous-gate';
  let mode = 'prompt' as const;
  const config: PermissionConfigReader = { getAutonomousSnapshot: () => ({ permissions: { mode, tools: {} }, autoApprove: false, directory }), isAutoApproveEnabled: () => false, getWorkingDirectory: () => directory,
    getSnapshot: () => ({ permissions: { mode, tools: {} } }) } as PermissionConfigReader;
  const state = new PolicyRuntimeState();
  // No human handler installed. This is the original failing-before acceptance path.
  const manager = new PermissionManager(undefined, config, state, null, null, store, gate);
  const registry = new ToolRegistry(); const executed: Record<string, unknown>[] = [];
  registry.register({ definition: { name: 'exec', description: 'Intercepted tool; never executes a shell', parameters: EXEC_TOOL_SCHEMA },
    execute: async input => { executed.push(input); return { success: true, output: 'intercepted' }; } });
  const deps: ToolExecutionDeps = { autonomousSource: () => ({ goal: 'Carry out the synthetic project change', criteria: ['Preserve fixture identity', 'Execute once'] }), permissionManager: manager, toolRegistry: registry, hookDispatcher: null, runtimeBus: null,
    sessionId: 'autonomous-fixture', emitterContext: () => ({ sessionId: 'autonomous-fixture', traceId: 'synthetic', source: 'orchestrator' }) };
  return { deps, manager, registry, executed, state, config, changeDirectory: () => { directory = '/synthetic/changed'; } };
}
const run = (deps: ToolExecutionDeps, input = args(), id = 'call-1') => executeToolCalls(deps, 'turn-1', [{ id, name: 'exec', arguments: input }]);

test('real prepared admission executes once with recorded Jev act and no human handler', async () => {
  const { deps, executed } = fixture();
  const [result] = await run(deps);
  expect(result?.success).toBe(true);
  expect(result?.autonomousDecision?.outcome).toBe('act');
  expect(executed).toHaveLength(1);
  expect(Object.isFrozen(executed[0])).toBe(true);
  expect(Object.isFrozen(executed[0]?.commands)).toBe(true);
  const receipt = result!.autonomousDecision!;
  expect(receipt.evidence.length).toBeGreaterThan(0);
  for (const id of receipt.judgmentDecisionIds) expect(log.get(id)?.status).toBe('answered');
  expect(requests.some(request => request.context?.site === 'engine.gate.autonomous-tool')).toBe(true);
  await expect(run(deps)).rejects.toThrow('claimed');
  expect(executed).toHaveLength(1);
});

test.each(['reject', 'defer_0'])('Jev %s yields a typed receipt and zero tool bodies', async selected => {
  choice = selected;
  const { deps, executed } = fixture();
  const [result] = await run(deps);
  expect(result?.success).toBe(false);
  expect(result?.denial?.scope).toBe('jev_decision');
  expect(result?.autonomousDecision?.outcome).toBe(selected === 'reject' ? 'reject' : 'defer');
  expect(executed).toHaveLength(0);
});

test('weak act is resolved by a new recorded non-executing Jev question', async () => {
  confidence = 0.6;
  answer = request => Object.hasOwn(request.questions.disposition?.type === 'choice' ? request.questions.disposition.criteria : {}, 'act') ? 'act' : 'defer_0';
  const { deps, executed } = fixture();
  const [result] = await run(deps);
  expect(result?.autonomousDecision?.outcome).toBe('defer');
  expect(result?.autonomousDecision?.judgmentDecisionIds).toHaveLength(5);
  expect(executed).toHaveLength(0);
});

test('revise chooses a host alternative then freshly prepares and admits its exact arguments', async () => {
  const revised = { commands: [{ cmd: 'git status --revised-fixture' }] };
  const { deps, executed } = fixture({ autonomousChoices: () => ({ revisions: [{
    ref: { id: 'inspect-revision', revision: '1', kind: 'revise-action' }, toolName: 'exec', args: revised,
  }] }) });
  answer = request => JSON.stringify(request.state).includes('git commit') ? 'revise_0' : 'act';
  const [result] = await run(deps);
  expect(result?.autonomousDecision?.outcome).toBe('act');
  expect(executed).toEqual([revised]);
  expect(requests.filter(request => 'disposition' in request.questions)).toHaveLength(2);
  const semanticRecords = log.query({ site: 'engine.gate.autonomous-tool' });
  expect(semanticRecords).toHaveLength(2);
  expect(new Set(semanticRecords.map(record => record.stateHash)).size).toBe(2);
});

test('borrowed argument mutation cannot change the prepared input that reaches the body', async () => {
  const { deps, executed } = fixture(); const original = args();
  deps.hookDispatcher = { fire: async () => { original.commands[0]!.cmd = 'git push --changed'; return { ok: true, decision: 'allow' }; } };
  const [result] = await run(deps, original);
  expect(result?.success).toBe(true);
  expect(executed).toEqual([args()]);
});

test('last reentrant hook revocation invalidates admission before the body', async () => {
  const { deps, executed, changeDirectory } = fixture();
  deps.hookDispatcher = { fire: async () => { changeDirectory(); return { ok: true, decision: 'allow' }; } };
  const [result] = await run(deps);
  expect(result?.success).toBe(false);
  expect(executed).toHaveLength(0);
});

test('last reentrant hook cancellation prevents claim and execution', async () => {
  const { deps, executed } = fixture(); const controller = new AbortController(); deps.turnSignal = controller.signal;
  deps.hookDispatcher = { fire: async () => { controller.abort(); return { ok: true, decision: 'allow' }; } };
  await expect(run(deps)).rejects.toBeDefined();
  expect(executed).toHaveLength(0);
});

test('protected original or revised arguments never reach repair, judgment or body', async () => {
  const { deps, executed } = fixture();
  await expect(run(deps, { ...args(), password: 'synthetic-private' } as ReturnType<typeof args>)).rejects.toMatchObject({ problem: 'credential-material' });
  expect(requests).toHaveLength(0);
  expect(executed).toHaveLength(0);
});

function installTransportFixture(semanticResponse: (attempt: number) => Response | undefined) {
  let attempts = 0;
  const gate = gateReadingsPort();
  const transport = createSystemOnePort({
    endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' },
    model: PINNED_MODEL, timeoutMs: 1000, retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 },
    fetch: async (_url, init) => {
      const wire = JSON.parse(String(init?.body)) as JudgmentRequest<Questions>;
      let response;
      if ('disposition' in wire.questions) {
        response = semanticResponse(++attempts);
        if (response) return response;
        const question = wire.questions.disposition!;
        response = { disposition: choiceAnswer(question, 'act', 0.97) };
      } else response = (await gate.port.ask(wire)).answers;
      return Response.json({ model: PINNED_MODEL, answers: response, usage: { input_tokens: 1, output_tokens: 1 } });
    },
  });
  installJudgmentPort(withDecisionLog(transport, log));
  return () => attempts;
}

test('central transient retry recovers into one recorded semantic act and one body', async () => {
  const attempts = installTransportFixture(attempt => attempt < 4 ? new Response('', { status: 503 }) : undefined);
  const { deps, executed } = fixture();
  const [result] = await run(deps);
  expect(result?.success).toBe(true);
  expect(attempts()).toBe(4);
  expect(executed).toHaveLength(1);
  const records = log.query({ site: 'engine.gate.autonomous-tool' });
  expect(records).toHaveLength(1);
  expect(records[0]?.lineage?.attempts).toHaveLength(4);
  expect(result?.autonomousDecision?.judgmentDecisionIds).toContain(records[0]!.id);
  expect(result?.autonomousDecision?.judgmentDecisionIds).toHaveLength(4);
});

test('live authority revocation during central backoff prevents the next transmission and body', async () => {
  const { deps, executed, changeDirectory } = fixture();
  const attempts = installTransportFixture(() => { changeDirectory(); return new Response('', { status: 503 }); });
  await expect(run(deps)).rejects.toMatchObject({ kind: 'rejected' });
  expect(attempts()).toBe(1);
  expect(executed).toHaveLength(0);
});

test('caller cancellation during central backoff stops waiting without a semantic receipt', async () => {
  const { deps, executed } = fixture(); const controller = new AbortController(); deps.turnSignal = controller.signal;
  const attempts = installTransportFixture(() => { queueMicrotask(() => controller.abort()); return new Response('', { status: 503 }); });
  await expect(run(deps)).rejects.toMatchObject({ kind: 'aborted' });
  expect(attempts()).toBe(1);
  expect(executed).toHaveLength(0);
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toMatchObject([{ status: 'failed' }]);
});

test('defer cannot be retried unchanged into act; a changed input gets a fresh decision', async () => {
  const { deps, executed } = fixture(); choice = 'defer_0';
  const [deferred] = await run(deps);
  choice = 'act';
  await expect(run(deps)).rejects.toThrow('waiting for a new input revision');
  expect(executed).toHaveLength(0);
  const [resumed] = await run(deps, { commands: [{ cmd: 'git status --new-evidence' }] });
  expect(resumed?.success).toBe(true);
  expect(resumed?.autonomousDecision?.binding.inputRevision).not.toBe(deferred?.autonomousDecision?.binding.inputRevision);
  expect(executed).toHaveLength(1);
});

test('unknown semantic choice cannot become an act or receipt', async () => {
  choice = 'unknown-effect';
  const { deps, executed } = fixture();
  await expect(run(deps)).rejects.toMatchObject({ kind: 'invalid-response' });
  expect(executed).toHaveLength(0);
});

test('tool replacement in the final hook invalidates its prepared executor', async () => {
  const { deps, registry, executed } = fixture();
  let replacementCalls = 0;
  deps.hookDispatcher = { fire: async () => {
    registry.unregister('exec');
    registry.register({ definition: { name: 'exec', description: 'replacement', parameters: EXEC_TOOL_SCHEMA }, execute: async () => { replacementCalls++; return { success: true }; } });
    return { ok: true, decision: 'allow' };
  } };
  const [result] = await run(deps);
  expect(result?.success).toBe(false);
  expect(executed).toHaveLength(0);
  expect(replacementCalls).toBe(0);
});

test('deterministic format repair happens before semantic admission and the body sees that exact repair', async () => {
  const { deps, registry } = fixture(); registry.unregister('exec');
  const executed: Record<string, unknown>[] = [];
  registry.register({ definition: { name: 'exec', description: 'numeric fixture', parameters: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } },
    execute: async input => { executed.push(input); return { success: true }; } });
  const [result] = await executeToolCalls(deps, 'turn-1', [{ id: 'repair-call', name: 'exec', arguments: { count: '3' } }]);
  expect(result?.success).toBe(true);
  expect(executed).toEqual([{ count: 3 }]);
  const semantic = requests.find(request => 'disposition' in request.questions);
  expect(JSON.stringify(semantic?.state)).toContain('"count":3');
  expect(JSON.stringify(semantic?.state)).not.toContain('"count":"3"');
});

test('per-call cancellation owns admission backoff and retires its signal without a body', async () => {
  const { deps, executed } = fixture(); const controller = new AbortController(); let closed = 0;
  deps.toolCallSignals = { open: () => controller.signal, close: () => { closed++; } };
  const attempts = installTransportFixture(() => { queueMicrotask(() => controller.abort()); return new Response('', { status: 503 }); });
  const [result] = await run(deps);
  expect(result).toMatchObject({ success: false, cancelled: true });
  expect(attempts()).toBe(1);
  expect(closed).toBe(1);
  expect(executed).toHaveLength(0);
});

test('a registered human handler is never invoked by the migrated real orchestrator', async () => {
  const { deps, executed } = fixture(); let humans = 0;
  deps.permissionManager = new PermissionManager(async () => { humans++; throw new Error('human callback must not run'); }, {
    getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory: '/synthetic/project' }),
    isAutoApproveEnabled: () => false, getWorkingDirectory: () => '/synthetic/project',
    getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
  } as PermissionConfigReader, new PolicyRuntimeState());
  const [result] = await run(deps);
  expect(result?.success).toBe(true);
  expect(humans).toBe(0);
  expect(executed).toHaveLength(1);
});

test('missing recording is an explicit operational failure, never approval', async () => {
  installJudgmentPort(gateReadingsPort().port);
  const { deps, executed } = fixture();
  await expect(run(deps)).rejects.toMatchObject({ kind: 'unrecorded' });
  expect(executed).toHaveLength(0);
});

const exactCommand = 'git add src/README.md';
const exactArgs = (command = exactCommand) => ({ commands: [{ cmd: command }] });
async function exactGrantStore() {
  const store = new UserPermissionRuleStore(':memory:');
  const rule = buildDurableRuleForDecision({ toolName: 'exec', args: exactArgs(), tier: 'exact', effect: 'allow' })!;
  await store.add({ rule, createdAt: 1, tier: 'exact', tool: 'exec' });
  return store;
}
function selectOnlyExactGrantedAction(request: JudgmentRequest<Questions>): string {
  const state = request.state as { input: { evidence: { constraints: { durableEffect: boolean | null } } } };
  return state.input.evidence.constraints.durableEffect === true ? 'act' : 'reject';
}

test.each([
  ['same-class command', 'git push'],
  ['command case', 'GIT add src/README.md'],
  ['target case', 'git add src/readme.md'],
  ['leading whitespace', ' git add src/README.md'],
  ['trailing newline', 'git add src/README.md\n'],
])('actual autonomous executor does not inherit the exact grant for %s', async (_label, different) => {
  const store = await exactGrantStore(); const { deps, executed } = fixture({}, store);
  answer = selectOnlyExactGrantedAction;
  expect((await run(deps, exactArgs(), 'exact-control'))[0]?.success).toBe(true);
  const [result] = await run(deps, exactArgs(different), 'different-command');
  expect(result?.success).toBe(false);
  expect(result?.autonomousDecision?.outcome).toBe('reject');
  expect(result?.denial?.scope).toBe('jev_decision');
  expect(executed).toEqual([exactArgs()]);
  expect(log.query({ site: 'engine.gate.autonomous-tool' })).toHaveLength(2);
});

test('actual autonomous executor observes exact grant revocation in the same live manager', async () => {
  const store = await exactGrantStore(); const { deps, executed } = fixture({}, store); answer = selectOnlyExactGrantedAction;
  expect((await run(deps, exactArgs(), 'before-revoke'))[0]?.success).toBe(true);
  await store.delete(store.rules()[0]!.id);
  const [result] = await run(deps, exactArgs(), 'after-revoke');
  expect(result?.success).toBe(false);
  expect(result?.autonomousDecision?.outcome).toBe('reject');
  expect(executed).toEqual([exactArgs()]);
});

test('durable grant deletion in the last hook invalidates even a previously recorded act', async () => {
  const store = await exactGrantStore(); const { deps, executed } = fixture({}, store); answer = selectOnlyExactGrantedAction;
  deps.hookDispatcher = { fire: async () => { await store.delete(store.rules()[0]!.id); return { ok: true, decision: 'allow' }; } };
  const [result] = await run(deps, exactArgs());
  expect(result?.success).toBe(false);
  expect(executed).toHaveLength(0);
});

test('authority revocation during semantic repair stops its transport before another attempt', async () => {
  const { deps, registry, changeDirectory } = fixture(); registry.unregister('exec'); let body = 0; let fetches = 0;
  registry.register({ definition: { name: 'exec', description: 'boolean fixture', parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] } },
    execute: async () => { body++; return { success: true }; } });
  const transport = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic' }, model: PINNED_MODEL, timeoutMs: 1000,
    retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, fetch: async () => { fetches++; changeDirectory(); return new Response('', { status: 503 }); } });
  installJudgmentPort(withDecisionLog(transport, log));
  await expect(executeToolCalls(deps, 'turn-1', [{ id: 'repair-revocation', name: 'exec', arguments: { enabled: 'please enable' } }])).rejects.toMatchObject({ kind: 'rejected' });
  expect(fetches).toBe(1);
  expect(body).toBe(0);
});

test('full host goal and ordered criteria survive into the recorded question and source binding', async () => {
  const { deps } = fixture();
  const source = { goal: `${'g'.repeat(5000)} original source tail`, criteria: ['second listed first', 'first listed second'] };
  deps.autonomousSource = () => source;
  const [result] = await run(deps);
  expect(result?.success).toBe(true);
  const semantic = requests.find(request => 'disposition' in request.questions);
  expect((semantic?.state as { input: { source: unknown } }).input.source).toEqual(source);
  expect(result?.autonomousDecision?.evidence.some(ref => ref.id === 'source-goal-and-criteria')).toBe(true);
});

test('changed host criteria in the final hook invalidate the bound action', async () => {
  const { deps, executed } = fixture();
  const source = { goal: 'Synthetic goal', criteria: ['original criterion'] }; deps.autonomousSource = () => source;
  deps.hookDispatcher = { fire: async () => { source.criteria.push('new criterion'); return { ok: true, decision: 'allow' }; } };
  const [result] = await run(deps);
  expect(result?.success).toBe(false);
  expect(executed).toHaveLength(0);
});

test('settings observations carry real supporting call lineage into the common decision', async () => {
  const { deps, registry } = fixture(); const executed: Record<string, unknown>[] = [];
  deps.autonomousSource = () => ({ goal: 'Set the synthetic theme', criteria: ['Change only the requested setting'] });
  registry.register({ definition: { name: 'goodvibes_settings', description: 'Synthetic settings action', parameters: { type: 'object', properties: { mode: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' } }, required: ['mode', 'key', 'value'] } },
    execute: async input => { executed.push(input); return { success: true }; } });
  const [result] = await executeToolCalls(deps, 'turn-1', [{ id: 'settings-call', name: 'goodvibes_settings', arguments: { mode: 'set', key: 'ui.theme', value: 'dark' } }]);
  expect(result?.success).toBe(true);
  const observation = log.query({ site: 'engine.gate.settings-write' })[0]!;
  expect(observation.status).toBe('answered');
  expect(result?.autonomousDecision?.judgmentDecisionIds).toContain(observation.id);
  expect(executed).toHaveLength(1);
  const semantic = requests.find(request => 'disposition' in request.questions);
  expect(JSON.stringify(semantic?.state)).toContain('"hazard":"none"');
});

test('missing or malformed host source fails before any judgment or body', async () => {
  const { deps, executed } = fixture(); deps.autonomousSource = undefined;
  await expect(run(deps)).rejects.toThrow('host source');
  expect(requests).toHaveLength(0);
  deps.autonomousSource = () => ({ goal: '', criteria: [] });
  await expect(run(deps)).rejects.toMatchObject({ kind: 'invalid-request' });
  expect(requests).toHaveLength(0);
  expect(executed).toHaveLength(0);
});

test.each(['definition', 'execute'])('accessor-backed %s metadata is rejected without invoking a callback', async field => {
  const { deps, registry, executed } = fixture(); const tool = registry.list()[0]!; let calls = 0;
  const value = tool[field as 'definition'];
  Object.defineProperty(tool, field, { get() { calls++; return value; } });
  await expect(run(deps)).rejects.toThrow('Accessor-backed');
  expect(calls).toBe(0); expect(executed).toHaveLength(0); expect(requests).toHaveLength(0);
});

test('prototype methods remain usable for a real class-based tool without executing it', async () => {
  const registry = new ToolRegistry(); registry.register(new InspectTool());
  const prepared = await registry.prepareCall('class-control', 'inspect', { mode: 'project' });
  expect(prepared.name).toBe('inspect'); expect(prepared.args).toEqual({ mode: 'project' });
  registry.assertPrepared(prepared);
});

test('captured function invocation cannot be replaced through an own call property', async () => {
  const { deps, registry, executed } = fixture(); const tool = registry.list()[0]!; let replacements = 0;
  Object.defineProperty(tool.execute, 'call', { value: async () => { replacements++; return { success: true }; } });
  expect((await run(deps))[0]?.success).toBe(true);
  expect(replacements).toBe(0); expect(executed).toHaveLength(1);
});

test.each(['directory', 'source', 'definition', 'execute'])('the final host callback cannot revoke %s after an earlier stale sample', async field => {
  let revoke = () => {}; let frames = 0;
  const source = { goal: 'Original host source', criteria: ['Keep the original scope'] };
  const { deps, registry, executed, changeDirectory } = fixture({ autonomousChoices: () => {
    const claimRecorded = log.query({ site: 'engine.gate.autonomous-tool' }).some(entry => entry.status === 'answered'
      && entry.notes.some(note => note.kind === 'action' && note.action.startsWith('autonomous:claim:')));
    if (claimRecorded && ++frames === 2) revoke();
    return {};
  } });
  deps.autonomousSource = () => source;
  const tool = registry.list()[0]!; let replacements = 0;
  revoke = field === 'directory' ? changeDirectory : field === 'source' ? () => { source.criteria.push('New owner criterion'); }
    : field === 'definition' ? () => { tool.definition = { ...tool.definition, description: 'new registration metadata' }; }
    : () => { tool.execute = async () => { replacements++; return { success: true }; }; };
  const [result] = await run(deps);
  expect(frames).toBe(2); expect(result?.success).toBe(false);
  expect(executed).toHaveLength(0); expect(replacements).toBe(0);
});

test('a selected host condition can resume after its actual version changes', async () => {
  let revision = 'one';
  const { deps, executed } = fixture({ autonomousChoices: () => ({ resumeConditions: [{ id: 'host-ready', revision }] }) });
  choice = 'defer_1';
  expect((await run(deps))[0]?.autonomousDecision).toMatchObject({ outcome: 'defer', until: { id: 'host-ready', revision: 'one' } });
  choice = 'act';
  await expect(run(deps)).rejects.toThrow('registered condition');
  revision = 'two';
  expect((await run(deps))[0]?.success).toBe(true); expect(executed).toHaveLength(1);
});

test('concurrent unchanged delivery cannot race a deferred decision into act', async () => {
  const { deps, executed } = fixture(); let semanticCalls = 0;
  answer = () => ++semanticCalls === 1 ? 'defer_0' : 'act';
  const settled = await Promise.allSettled([run(deps), run(deps)]);
  expect(settled.some(item => item.status === 'fulfilled' && item.value[0]?.autonomousDecision?.outcome === 'defer')).toBe(true);
  expect(semanticCalls).toBe(1); expect(executed).toHaveLength(0);
});

test('a thrown admitted body retains its recorded act receipt without claiming success', async () => {
  const { deps, registry } = fixture(); registry.list()[0]!.execute = async () => { throw new Error('synthetic body failure'); };
  const [result] = await run(deps);
  expect(result).toMatchObject({ success: false, error: 'synthetic body failure', autonomousDecision: { outcome: 'act' } });
});

test('coherent owner frame replaces sequential legacy permission getters on the real path', async () => {
  const { deps, config, executed } = fixture();
  config.getSnapshot = () => { throw new Error('legacy getter must not run'); };
  config.getWorkingDirectory = () => { throw new Error('legacy getter must not run'); };
  config.isAutoApproveEnabled = () => { throw new Error('legacy getter must not run'); };
  expect((await run(deps))[0]?.success).toBe(true); expect(executed).toHaveLength(1);
});

test('boundary content-derivation call lineage is included in the final receipt', async () => {
  const ledger = new UntrustedContentLedger(); ledger.record({ surface: 'web-page', origin: 'https://source.test', at: '2026-10-03T00:00:00Z', content: 'Ordinary unrelated source content.' });
  const { deps } = fixture({ ledger });
  const gate = gateReadingsPort([['git commit', { outward: true, derives: false }]]);
  const semantic = fakePort((_name, question) => choiceAnswer(question, 'act', 0.97));
  installJudgmentPort(withDecisionLog({ model: gate.port.model, ask(request) {
    request.beforeAttempt?.(); return 'disposition' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } }, log));
  const [result] = await run(deps); expect(result?.success).toBe(true);
  const reads = log.query({ site: 'security.content-taint' }); expect(reads.length).toBeGreaterThan(0);
  for (const read of reads) expect(result?.autonomousDecision?.judgmentDecisionIds).toContain(read.id);
});

test('semantic argument-repair lineage is included in the final receipt', async () => {
  const { deps, registry } = fixture(); registry.unregister('exec');
  registry.register({ definition: { name: 'exec', description: 'boolean fixture', parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] } }, execute: async () => ({ success: true }) });
  const gate = gateReadingsPort(); const semantic = fakePort((name, question) => choiceAnswer(question, name === 'boolean_value' ? 'true' : 'act', 0.97));
  installJudgmentPort(withDecisionLog({ model: gate.port.model, ask(request) {
    request.beforeAttempt?.(); return 'boolean_value' in request.questions || 'disposition' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } }, log));
  const [result] = await executeToolCalls(deps, 'turn-1', [{ id: 'repair-lineage', name: 'exec', arguments: { enabled: 'please enable' } }]);
  expect(result?.success).toBe(true);
  const reads = log.query({ site: 'tools.auto-repair.boolean-value' }); expect(reads).toHaveLength(1);
  expect(result?.autonomousDecision?.judgmentDecisionIds).toContain(reads[0]!.id);
});

test('registration replacement during repair backoff stops the next transmission', async () => {
  const { deps, registry } = fixture(); registry.unregister('exec'); let fetches = 0; let bodies = 0;
  const definition = { name: 'exec', description: 'boolean fixture', parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] } };
  registry.register({ definition, execute: async () => { bodies++; return { success: true }; } });
  const transport = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic' }, model: PINNED_MODEL, timeoutMs: 1000,
    retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, fetch: async () => {
      fetches++; registry.unregister('exec'); registry.register({ definition, execute: async () => { bodies++; return { success: true }; } });
      return new Response('', { status: 503 });
    } });
  installJudgmentPort(withDecisionLog(transport, log));
  await expect(executeToolCalls(deps, 'turn-1', [{ id: 'repair-replaced', name: 'exec', arguments: { enabled: 'please enable' } }])).rejects.toBeDefined();
  expect(fetches).toBe(1); expect(bodies).toBe(0);
});

test('proxy-backed host choices cannot run traps after authority capture', async () => {
  let traps = 0;
  const { deps, executed } = fixture({ autonomousChoices: () => new Proxy({}, { ownKeys() { traps++; return []; } }) });
  await expect(run(deps)).rejects.toMatchObject({ kind: 'invalid-request' });
  expect(traps).toBe(0); expect(executed).toHaveLength(0); expect(requests).toHaveLength(0);
});

test('repair attempt validates registration after every host authority callback', async () => {
  let replace = () => {}; let fetches = 0; let replaced = false; let bodies = 0;
  const { deps, registry } = fixture({ autonomousChoices: () => { if (fetches === 1 && !replaced) { replaced = true; replace(); } return {}; } });
  registry.unregister('exec');
  const definition = { name: 'exec', description: 'boolean fixture', parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] } };
  const execute = async () => { bodies++; return { success: true }; };
  registry.register({ definition, execute });
  replace = () => { registry.unregister('exec'); registry.register({ definition, execute }); };
  const transport = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic' }, model: PINNED_MODEL, timeoutMs: 1000,
    retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, fetch: async () => { fetches++; return new Response('', { status: 503 }); } });
  installJudgmentPort(withDecisionLog(transport, log));
  await expect(executeToolCalls(deps, 'turn-1', [{ id: 'repair-callback-replaced', name: 'exec', arguments: { enabled: 'please enable' } }])).rejects.toBeDefined();
  expect(replaced).toBe(true); expect(fetches).toBe(1); expect(bodies).toBe(0);
});

test('per-call cancellation after body admission retains receipt and partial output', async () => {
  const { deps, registry } = fixture(); const abort = new AbortController();
  deps.toolCallSignals = { open: () => abort.signal, close: () => {} };
  registry.list()[0]!.execute = async () => { abort.abort(); return { success: true, output: 'partial synthetic output' }; };
  const [result] = await run(deps);
  expect(result).toMatchObject({ success: false, cancelled: true, output: 'partial synthetic output', autonomousDecision: { outcome: 'act' } });
});

test('the public permissions entry point exposes the same shared autonomous selector', () => { expect(publicSelector).toBe(decideAutonomousTool); });

test('public selector owns binding, state, evidence and supporting IDs across await', async () => {
  const binding = { sourceId: 'source-1', inputRevision: 'input-1', actionId: 'action-1', actionRevision: 'action-rev-1', authorityId: 'owner-1', authorityRevision: 'owner-rev-1', scopeId: 'scope-1', scopeRevision: 'scope-rev-1' };
  const state = { operation: 'original action' };
  const evidence = [{ id: 'evidence-1', revision: 'evidence-rev-1' }];
  const supportingDecisionIds: string[] = [];
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  const synthetic = fakePort((_name, question) => choiceAnswer(question, 'act', 0.97));
  const port = withDecisionLog({ model: synthetic.port.model, async ask(request) { entered(); await waiting; return synthetic.port.ask(request); } }, log);
  const pending = publicSelector({ port, binding, state, evidence, supportingDecisionIds, choices: {}, allowAct: true, assertCurrent: () => {} });
  await started;
  binding.actionRevision = 'unjudged-action-revision'; state.operation = 'unjudged action'; evidence[0]!.revision = 'unjudged-evidence'; supportingDecisionIds.push('unrecorded-late-id');
  release();
  const result = await pending;
  expect(result.decision.binding.actionRevision).toBe('action-rev-1');
  expect(result.decision.evidence).toEqual([{ id: 'evidence-1', revision: 'evidence-rev-1' }]);
  expect(result.context.judgmentDecisionIds).not.toContain('unrecorded-late-id');
  expect(Object.isFrozen(result.context)).toBe(true);
  expect(Object.isFrozen(result.context.binding)).toBe(true);
  expect(Object.isFrozen(result.context.evidence)).toBe(true);
  expect(JSON.stringify(synthetic.requests[0]!.state)).toContain('original action');
  expect(JSON.stringify(synthetic.requests[0]!.state)).not.toContain('unjudged');
});

test('typed host UUID metadata is structurally captured without raw-content card false positives', async () => {
  // A genuine UUIDv7 shape that the unchanged raw-content scanner sees as PAN-like.
  const id = '01a10407-1f79-7006-8320-47790069cb8a';
  const binding = { sourceId: id, inputRevision: 'input-1', actionId: 'action-1', actionRevision: 'action-rev-1', authorityId: 'owner-1', authorityRevision: 'owner-rev-1', scopeId: 'scope-1', scopeRevision: 'scope-rev-1' };
  const synthetic = fakePort((_name, question) => choiceAnswer(question, 'act', 0.97));
  const result = await publicSelector({ port: withDecisionLog(synthetic.port, log), binding, state: { action: 'synthetic' }, evidence: [{ id: 'known-evidence', revision: id }], choices: {}, allowAct: true, assertCurrent: () => {} });
  expect(result.decision.outcome).toBe('act');
  expect(result.decision.binding.sourceId).toBe(id);
  expect(result.decision.evidence[0]!.revision).toBe(id);
  const before = synthetic.requests.length;
  await expect(publicSelector({ port: withDecisionLog(synthetic.port, log), binding, state: { action: 'synthetic', pan: '4111111111111111' }, evidence: [], choices: {}, allowAct: true, assertCurrent: () => {} })).rejects.toMatchObject({ problem: 'card-material' });
  expect(synthetic.requests.length).toBe(before);
});

test('protocol identity handling does not exempt secrets in raw state, goals, criteria or revisions', async () => {
  const binding = { sourceId: '01a10407-1f79-7006-8320-47790069cb8a', inputRevision: 'input-1', actionId: 'action-1', actionRevision: 'action-rev-1', authorityId: 'owner-1', authorityRevision: 'owner-rev-1', scopeId: 'scope-1', scopeRevision: 'scope-rev-1' };
  const synthetic = fakePort((_name, question) => choiceAnswer(question, 'act', 0.97));
  const port = withDecisionLog(synthetic.port, log);
  const base = { port, binding, evidence: [{ id: 'known-evidence', revision: '1' }], choices: {}, allowAct: true, assertCurrent: () => {} };
  for (const state of [
    { password: 'synthetic-private' },
    { source: { goal: 'API_KEY=synthetic-private', criteria: [] } },
    { source: { goal: 'safe', criteria: ['password=synthetic-private'] } },
    { metadata: { password: 'synthetic-private' } },
    { arguments: { password: 'synthetic-private' } },
  ]) await expect(publicSelector({ ...base, state })).rejects.toMatchObject({ problem: 'credential-material' });
  await expect(publicSelector({ ...base, state: { action: 'safe' }, choices: { revisions: [{ ref: { id: 'revise-1', revision: '1', kind: 'revise-action' }, toolName: 'exec', args: { password: 'synthetic-private' } }] } })).rejects.toMatchObject({ problem: 'credential-material' });
  await expect(publicSelector({ ...base, state: { action: 'safe' }, binding: { ...binding, sourceId: 'password=synthetic-private' } })).rejects.toMatchObject({ problem: 'credential-material' });
  expect(synthetic.requests).toHaveLength(0);
});


test('manager admits a legitimate UUID host condition without weakening raw source inspection', async () => {
  const id = '01a10407-1f79-7006-8320-47790069cb8a';
  const { deps, executed } = fixture({ autonomousChoices: () => ({ resumeConditions: [{ id, revision: id }] }) });
  const [result] = await run(deps);
  expect(result?.success).toBe(true); expect(executed).toHaveLength(1);
  const blocked = fixture({ autonomousChoices: () => ({ resumeConditions: [{ id, revision: id }] }) });
  blocked.deps.autonomousSource = () => ({ goal: 'API_KEY=synthetic-private', criteria: [] });
  const before = requests.length;
  await expect(run(blocked.deps)).rejects.toMatchObject({ problem: 'credential-material' });
  expect(requests.length).toBe(before); expect(blocked.executed).toHaveLength(0);
});


test.each(['act', 'reject', 'defer_0'])('real event projection retains the bound %s receipt', async selected => {
  choice = selected;
  const { deps } = fixture();
  const bus = new RuntimeEventBus(); deps.runtimeBus = bus;
  const events: ToolEvent[] = [];
  const stop = bus.onDomain('tools', event => { events.push(event.payload); });
  try {
    const [result] = await run(deps);
    await Promise.resolve();
    const permissioned = events.find(event => event.type === 'TOOL_PERMISSIONED');
    expect(permissioned?.type).toBe('TOOL_PERMISSIONED');
    if (permissioned?.type !== 'TOOL_PERMISSIONED') throw new Error('missing admission event');
    expect(permissioned.autonomousDecision).toEqual(result?.autonomousDecision);
    const settled = events.find(event => event.type === 'TOOL_SUCCEEDED' || event.type === 'TOOL_FAILED');
    expect(settled).toBeDefined();
    if (settled?.type === 'TOOL_SUCCEEDED' || settled?.type === 'TOOL_FAILED') expect(settled.result?.autonomousDecision).toEqual(result?.autonomousDecision);
  } finally { stop(); }
});
