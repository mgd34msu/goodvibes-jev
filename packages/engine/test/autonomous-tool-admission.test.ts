import { RuntimeEventBus, type ToolEvent } from '../sdk/src/platform/runtime/events/index.ts';
import { decideAutonomousTool as publicSelector } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { decideAutonomousTool } from '../sdk/src/platform/permissions/autonomous.ts';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { withDecisionLog, SqliteDecisionLog, createSystemOnePort, DEFAULT_MODEL, hashState, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.ts';
import { PermissionManager, type GateOptions, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import type { PolicyRule } from '../sdk/src/platform/runtime/permissions/types.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../sdk/src/platform/core/orchestrator-tool-runtime.ts';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import { UserPermissionRuleStore } from '../sdk/src/platform/permissions/user-rule-store.ts';
import { buildDurableRuleForDecision } from '../sdk/src/platform/permissions/approval-rules.ts';
import { InspectTool } from '../sdk/src/platform/tools/inspect/index.ts';
import { UntrustedContentLedger } from '../sdk/src/platform/security/untrusted-content.ts';
import { judgmentInputProblem } from '../sdk/src/platform/gate/judgment-input.ts';
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
function fixture(gate: GateOptions = {}, store: UserPermissionRuleStore | null = null, policyEnabled = false) {
  let directory = '/synthetic/autonomous-gate';
  let mode = 'prompt' as const;
  const config: PermissionConfigReader = { getAutonomousSnapshot: () => ({ permissions: { mode, tools: {} }, autoApprove: false, directory }), isAutoApproveEnabled: () => false, getWorkingDirectory: () => directory,
    getSnapshot: () => ({ permissions: { mode, tools: {} } }) } as PermissionConfigReader;
  const state = new PolicyRuntimeState();
  // No human handler installed. This is the original failing-before acceptance path.
  const manager = new PermissionManager(undefined, config, state, null, { isEnabled: () => policyEnabled }, store, gate);
  const registry = new ToolRegistry(); const executed: Record<string, unknown>[] = [];
  registry.register({ definition: { name: 'exec', description: 'Intercepted tool; never executes a shell', parameters: EXEC_TOOL_SCHEMA },
    execute: async input => { executed.push(input); return { success: true, output: 'intercepted' }; } });
  const deps: ToolExecutionDeps = { autonomousSource: () => ({ goal: 'Carry out the synthetic project change', criteria: ['Preserve fixture identity', 'Execute once'] }), permissionManager: manager, toolRegistry: registry, hookDispatcher: null, runtimeBus: null,
    sessionId: 'autonomous-fixture', emitterContext: () => ({ sessionId: 'autonomous-fixture', traceId: 'synthetic', source: 'orchestrator' }) };
  return { deps, manager, registry, executed, state, config, changeDirectory: () => { directory = '/synthetic/changed'; } };
}
const run = (deps: ToolExecutionDeps, input = args(), id = 'call-1') => executeToolCalls(deps, 'turn-1', [{ id, name: 'exec', arguments: input }]);

test.each(['act', 'reject', 'defer_0'])('Jev %s cannot veto or rewrite a valid tool call', async selected => {
  choice = selected; confidence = 0.1;
  const { deps, executed } = fixture();
  const [result] = await run(deps);
  expect(result?.success).toBe(true);
  expect(result?.autonomousDecision).toBeUndefined();
  expect(executed).toEqual([args()]);
  expect(requests).toHaveLength(0);
  await expect(run(deps)).rejects.toThrow('claimed');
});

test('directory reads, search, edits, shell, settings and nested tools run without a Jev permission service', async () => {
  let judgments = 0;
  installJudgmentPort({ model: DEFAULT_MODEL, async ask() { judgments++; throw new Error('Jev unavailable'); } });
  const { deps, manager, registry } = fixture();
  deps.autonomousSource = () => ({ goal: 'give this project a code review', criteria: [] });
  const tools = ['repo_map', 'read', 'find', 'inspect', 'analyze', 'write', 'edit', 'goodvibes_settings', 'mcp'];
  const executed: string[] = [];
  for (const name of tools) registry.register({ definition: { name, description: 'Test tool', parameters: { type: 'object' } },
    execute: async () => { executed.push(name); return { success: true }; } });
  const results = await executeToolCalls(deps, 'review', tools.map(name => ({ id: name, name, arguments: { path: '.' } })));
  expect(results.every(result => result.success)).toBe(true);
  expect(executed).toEqual(tools);
  expect((await run(deps, { commands: [{ cmd: 'ls -la' }] }, 'list-directory'))[0]?.success).toBe(true);
  for (const path of ['.', 'src', '.github/workflows', 'packages/engine/sdk/src/platform']) expect(await manager.readAccess(path)).toBe('allow');
  expect(await manager.check('exec', { command: 'ls -la' })).toBe(true);
  expect(await manager.passesBoundary('exec', { command: 'ls -la' })).toBe(true);
  expect(judgments).toBe(0);
});

test('owner-configured deny and read-only mode still apply without asking Jev', async () => {
  for (const mode of ['custom', 'plan'] as const) {
    const { deps, config, executed } = fixture();
    config.getAutonomousSnapshot = () => ({ permissions: { mode, tools: { exec: 'deny' } }, autoApprove: false, directory: '/synthetic/autonomous-gate' }) as ReturnType<NonNullable<PermissionConfigReader['getAutonomousSnapshot']>>;
    const [result] = await run(deps);
    expect(result?.success).toBe(false);
    expect(result?.denial?.reason).toBe(mode === 'plan' ? 'plan-mode' : 'config_deny');
    expect(executed).toHaveLength(0);
    expect(requests).toHaveLength(0);
  }
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
  expect(requests.filter(request => request.context?.site === 'engine.gate.autonomous-tool')).toHaveLength(0);
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


test('authority revocation during semantic repair stops its transport before another attempt', async () => {
  const { deps, registry, changeDirectory } = fixture(); registry.unregister('exec'); let body = 0; let fetches = 0;
  registry.register({ definition: { name: 'exec', description: 'boolean fixture', parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] } },
    execute: async () => { body++; return { success: true }; } });
  const transport = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic' }, model: DEFAULT_MODEL, timeoutMs: 1000,
    retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, fetch: async () => { fetches++; changeDirectory(); return new Response('', { status: 503 }); } });
  installJudgmentPort(withDecisionLog(transport, log));
  await expect(executeToolCalls(deps, 'turn-1', [{ id: 'repair-revocation', name: 'exec', arguments: { enabled: 'please enable' } }])).rejects.toMatchObject({ kind: 'rejected' });
  expect(fetches).toBe(1);
  expect(body).toBe(0);
});


test('changed host criteria in the final hook invalidate the bound action', async () => {
  const { deps, executed } = fixture();
  const source = { goal: 'Synthetic goal', criteria: ['original criterion'] }; deps.autonomousSource = () => source;
  deps.hookDispatcher = { fire: async () => { source.criteria.push('new criterion'); return { ok: true, decision: 'allow' }; } };
  const [result] = await run(deps);
  expect(result?.success).toBe(false);
  expect(executed).toHaveLength(0);
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


test('coherent owner frame replaces sequential legacy permission getters on the real path', async () => {
  const { deps, config, executed } = fixture();
  config.getSnapshot = () => { throw new Error('legacy getter must not run'); };
  config.getWorkingDirectory = () => { throw new Error('legacy getter must not run'); };
  config.isAutoApproveEnabled = () => { throw new Error('legacy getter must not run'); };
  expect((await run(deps))[0]?.success).toBe(true); expect(executed).toHaveLength(1);
});


test('registration replacement during repair backoff stops the next transmission', async () => {
  const { deps, registry } = fixture(); registry.unregister('exec'); let fetches = 0; let bodies = 0;
  const definition = { name: 'exec', description: 'boolean fixture', parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] } };
  registry.register({ definition, execute: async () => { bodies++; return { success: true }; } });
  const transport = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic' }, model: DEFAULT_MODEL, timeoutMs: 1000,
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
  const transport = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic' }, model: DEFAULT_MODEL, timeoutMs: 1000,
    retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, fetch: async () => { fetches++; return new Response('', { status: 503 }); } });
  installJudgmentPort(withDecisionLog(transport, log));
  await expect(executeToolCalls(deps, 'turn-1', [{ id: 'repair-callback-replaced', name: 'exec', arguments: { enabled: 'please enable' } }])).rejects.toBeDefined();
  expect(replaced).toBe(true); expect(fetches).toBe(1); expect(bodies).toBe(0);
});


test('an unknown tool returns a recoverable failure without admission and preserves the next real call', async () => {
  const { deps, executed } = fixture();
  const bus = new RuntimeEventBus(); const events: ToolEvent[] = [];
  bus.onDomain('tools', event => events.push(event.payload));
  deps.runtimeBus = bus;
  const [missing, known] = await executeToolCalls(deps, 'turn-1', [
    { id: 'missing-call', name: 'missing_tool', arguments: {} },
    { id: 'known-call', name: 'exec', arguments: args() },
  ]);
  expect(missing).toEqual({ callId: 'missing-call', success: false, error: 'Unknown tool in autonomous preparation' });
  expect(known?.success).toBe(true); expect(executed).toHaveLength(1);
  expect(events.filter(event => 'callId' in event && event.callId === 'missing-call').map(event => event.type)).toEqual(['TOOL_FAILED']);
  expect(requests.filter(request => request.context?.site === 'engine.gate.autonomous-tool')).toHaveLength(0);
});


test('optional schema metadata preserves the existing unversioned input binding', async () => {
  const { deps, manager } = fixture();
  const admission = await manager.admitAutonomous('unversioned-source', 'exec', args(), { sourceOf: deps.autonomousSource! });
  expect(admission.result.approved).toBe(true);
  expect(admission.result.autonomousDecision).toBeUndefined();
  admission.claim();
  expect(() => admission.claim()).toThrow('claimed');
});


test('schema identity is captured once before validation and hashing', async () => {
  const { deps, manager } = fixture();
  let reads = 0;
  const admission = await manager.admitAutonomous('single-read-schema', 'exec', args(), {
    sourceOf: deps.autonomousSource!,
    get schemaRevision() { return ++reads === 1 ? 'original-schema' : 'password=synthetic-private'; },
  });
  expect(reads).toBe(1);
  expect(admission.result.approved).toBe(true);
  expect(admission.result.autonomousDecision).toBeUndefined();
  admission.claim();
  expect(() => admission.claim()).toThrow('claimed');
});
