import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createProtectedSourceOwner } from '../sdk/src/platform/security/source-screening/owner.js';
import { createFramedResearchReferenceProjector, resolveFramedResearchReference } from '../sdk/src/platform/security/source-screening/framed-references.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import type { Tool, ToolCall, ToolExecuteOptions } from '../sdk/src/platform/types/tools.js';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.js';
import type { AutonomousToolChoices, AutonomousToolRevision } from '../sdk/src/platform/permissions/autonomous.js';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import { RuntimeEventBus, type ToolEvent } from '../sdk/src/platform/runtime/events/index.js';
import { executeToolCalls, type ToolExecutionDeps } from '../sdk/src/platform/core/orchestrator-tool-runtime.js';
import { handleToolResponseOutcome, type ContractSessionTurn } from '../sdk/src/platform/core/orchestrator-turn-helpers.js';
import { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import type { ContractTurnRecord } from '../sdk/src/platform/contract/evidence.js';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.js';

// Synthetic originals never leave this process. The only HTTP destination is
// our owned role fixture; the admitted executor deliberately performs no fetch.
const BENIGN = 'HTTPS://EXAMPLE.TEST:443/document%2fid?%69d=VALUE_ONE&id=VALUE_TWO&q=ordinary+words#ANCHOR_ONE';
const UNSAFE = 'https://other.example.test/PRIVATE_PATH?%61uth=CREDENTIAL_VALUE#ANCHOR_TWO';
const LAST = 'https://third.example.test/final%2fpage?id=VALUE_THREE#ANCHOR_THREE';
const LABELS = [{ id: 'S1', url: '[source reference S1]' }, { id: 'S2', urlOmitted: true }, { id: 'S3', url: '[source reference S3]' }];
const refs = (...urls: string[]) => urls.map((url, index) => ({ id: `S${index + 1}`, url }));
const input = () => ({ references: refs(BENIGN, UNSAFE, LAST) });
const cleanups: Array<() => Promise<void>> = [];
let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
let requests: JudgmentRequest<Questions>[];
let select: () => string;
let onRequest: ((request: JudgmentRequest<Questions>) => void) | undefined;

beforeEach(() => {
  forgetGateReadings(); log = new SqliteDecisionLog(':memory:'); requests = []; select = () => 'act'; onRequest = undefined;
  const gate = gateReadingsPort();
  const semantic = fakePort((name, question) => question.type === 'noul' ? noulAnswer(0.99) : choiceAnswer(question,
    name === 'boolean_value' ? 'true' : name === 'pick' ? 'spare' : select(), 0.99));
  const port: JudgmentPort = { model: gate.port.model, async ask(request) {
    request.signal?.throwIfAborted(); request.beforeAttempt?.();
    requests.push(request as JudgmentRequest<Questions>); onRequest?.(request as JudgmentRequest<Questions>);
    return 'disposition' in request.questions || 'boolean_value' in request.questions || 'pick' in request.questions
      ? semantic.port.ask(request) : gate.port.ask(request);
  } };
  previous = installJudgmentPort(withDecisionLog(port, log));
});
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings();
});

function latch() { return Promise.withResolvers<void>(); }
function roleAnswer(value: number) {
  return Response.json({ model: 'jev-1.13.0', answers: { credential: { type: 'noul', noul: value } }, usage: { input_tokens: 5, output_tokens: 1 } });
}
function fixture(options: {
  judge?: (body: Record<string, unknown>, count: number) => Response | Promise<Response>;
  requireQuery?: boolean;
  beforeRelease?: () => Promise<void>;
  onAuthority?: () => void;
  onBody?: (args: Record<string, unknown>, opts: ToolExecuteOptions | undefined) => void | Promise<void>;
} = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    const path = new URL(request.url).pathname; calls.push({ path, body });
    if (path !== '/v1/systemone') return new Response('Unexpected proposal route', { status: 400 });
    return options.judge ? options.judge(body, calls.length)
      : roleAnswer((body.state as { parameter: string }).parameter === 'auth' ? 1 : 0);
  } });
  const lifetime = new AbortController(); let current = true;
  const owner = createProtectedSourceOwner({
    authority: { ownerId: 'framed-reference-fixture', revision: '1', retention: 'ephemeral-no-log', signal: lifetime.signal,
      assertCurrent() { if (!current) throw new Error('Synthetic revoked authority'); options.onAuthority?.(); } },
    proposal: { endpoint: `http://127.0.0.1:${server.port}`, model: 'unused-local-proposal-fixture' },
    judgment: { endpoint: `http://127.0.0.1:${server.port}`, model: 'jev-1.13.0' }, timeoutMs: 1_000,
  });
  const released: object[] = [];
  const release = owner.release.bind(owner);
  owner.release = async handle => { await release(handle); await options.beforeRelease?.(); released.push(handle); };
  cleanups.push(async () => { await owner.close(); await server.stop(true); });
  const registry = new ToolRegistry();
  const executed: Array<{ args: Record<string, unknown>; opts: ToolExecuteOptions | undefined; references: unknown[] }> = [];
  const tool: Tool = { definition: { name: 'framed_reference_reader', description: 'Intercepted bounded reference reader', parameters: {
    type: 'object', properties: {
      references: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, url: { type: 'string' }, urlOmitted: { type: 'boolean' } }, required: ['id'], additionalProperties: false } },
      query: { type: 'string' }, enabled: { type: 'boolean' },
    }, required: ['references', ...(options.requireQuery ? ['query'] : [])], additionalProperties: false,
  } }, async execute(args, opts) {
    await options.onBody?.(args, opts);
    const references = (args.references as Array<{ id: string }>).map(cell => resolveFramedResearchReference(opts?.inputProjectionContext, args, cell.id));
    executed.push({ args, opts, references }); return { success: true, output: 'intercepted reference read' };
  } };
  registry.register(tool, { inputProjection: createFramedResearchReferenceProjector(owner) });
  const source = { goal: 'Read the synthetic references', criteria: ['Preserve exact source identity and positions'] };
  const revisions: AutonomousToolRevision[] = [];
  const choices: AutonomousToolChoices = { revisions };
  const config = { getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory: '/synthetic/framed-references' }),
    getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }), getWorkingDirectory: () => '/synthetic/framed-references',
    isAutoApproveEnabled: () => false } as PermissionConfigReader;
  const manager = new PermissionManager(undefined, config, new PolicyRuntimeState(), null, null, null, { autonomousChoices: () => choices });
  const events: ToolEvent[] = []; const bus = new RuntimeEventBus();
  const stop = bus.onDomain('tools', event => { events.push(event.payload); }); cleanups.push(async () => { stop(); });
  const deps: ToolExecutionDeps = { autonomousSource: () => source, toolRegistry: registry, permissionManager: manager,
    hookDispatcher: null, runtimeBus: bus, sessionId: 'framed-fixture',
    emitterContext: () => ({ sessionId: 'framed-fixture', traceId: 'synthetic', source: 'orchestrator' }) };
  return { owner, registry, tool, source, choices, revisions, manager, deps, calls, events, executed, lifetime, released, revoke: () => { current = false; } };
}
type Fixture = ReturnType<typeof fixture>;
function run(f: Fixture, args: Record<string, unknown> = input(), id = 'framed-call') {
  return executeToolCalls(f.deps, 'framed-turn', [{ id, name: f.tool.definition.name, arguments: args }]);
}
function expectNoOriginal(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const hidden of ['EXAMPLE.TEST', 'example.test', 'document%2fid', 'PRIVATE_PATH', 'final%2fpage', 'VALUE_ONE', 'VALUE_TWO',
    'VALUE_THREE', 'CREDENTIAL_VALUE', 'ordinary+words', 'ANCHOR_ONE', 'ANCHOR_TWO', 'ANCHOR_THREE']) expect(serialized).not.toContain(hidden);
}
function expectDrained(f: Fixture) {
  // The real owner's full capacity is available only after all previous
  // handles have been retired, not merely after a cancellation race settles.
  const handles = Array.from({ length: 128 }, (_, index) => f.owner.captureResearchReference(`https://capacity.test/${index}`));
  return Promise.all(handles.map(handle => f.owner.release(handle)));
}

test('real Jev role HTTP, admission, event and executor preserve positions without disclosing any URL bytes', async () => {
  const f = fixture();
  const [result] = await run(f);
  expect(result).toMatchObject({ success: true, autonomousDecision: { outcome: 'act' } });
  expect(f.calls.map(call => call.path)).toEqual(['/v1/systemone', '/v1/systemone', '/v1/systemone']);
  expect(f.calls.map(call => call.body.state)).toEqual([{ parameter: 'id' }, { parameter: 'q' }, { parameter: 'auth' }]);
  expectNoOriginal(f.calls); expectNoOriginal(requests); expectNoOriginal(log.query({})); expectNoOriginal(f.events);
  expect(f.executed).toHaveLength(1);
  expect(f.executed[0]!.args.references).toEqual(LABELS);
  expect(f.executed[0]!.references).toEqual([{ status: 'preserved', url: BENIGN }, { status: 'omitted' }, { status: 'preserved', url: LAST }]);
  expect(f.events.find(event => event.type === 'TOOL_RECEIVED')).toMatchObject({ args: { references: LABELS } });
  expect(requests.some(request => 'disposition' in request.questions)).toBe(true);
  for (const id of result!.autonomousDecision!.judgmentDecisionIds) expect(log.get(id)?.status).toBe('answered');
  expect(f.released).toHaveLength(3); await expectDrained(f);
  await expect(run(f)).rejects.toBeDefined(); expect(f.executed).toHaveLength(1);
});

test('missing string and boolean repair operate on projected references before real admission', async () => {
  const f = fixture({ requireQuery: true });
  const [result] = await run(f, { ...input(), spare: 'ordinary research topic', enabled: 'enabled' });
  expect(result?.success).toBe(true);
  expect(f.executed[0]!.args).toEqual({ references: LABELS, query: 'ordinary research topic', enabled: true });
  expect(requests.some(request => 'pick' in request.questions)).toBe(true);
  expect(requests.some(request => 'boolean_value' in request.questions)).toBe(true);
  expect(JSON.stringify(requests)).toContain('[source reference S1]');
  expectNoOriginal(requests); expectNoOriginal(log.query({})); expectNoOriginal(f.events);
});

test.each([false, true])('all offered references are screened before admission; selected revision = %s', async selected => {
  const f = fixture(); let admissions = 0;
  f.revisions.push({ ref: { id: 'alternative', revision: 'host-v1', kind: 'revise-action' },
    toolName: f.tool.definition.name, args: { ...input(), enabled: 'enabled' } });
  select = () => ++admissions === 1 && selected ? 'revise_0' : 'act';
  onRequest = () => { expect(f.calls.map(call => call.body.state)).toEqual([{ parameter: 'id' }, { parameter: 'q' }, { parameter: 'auth' }]); };
  const [result] = await run(f, { references: refs('https://initial.test/no-query') });
  expect(result?.success).toBe(true); expect(f.calls).toHaveLength(3);
  expect(requests.filter(request => 'disposition' in request.questions)).toHaveLength(selected ? 2 : 1);
  expect(requests.filter(request => 'boolean_value' in request.questions)).toHaveLength(selected ? 1 : 0);
  expect(f.executed[0]!.args).toEqual(selected ? { references: LABELS, enabled: true } : { references: [{ id: 'S1', url: '[source reference S1]' }] });
  expect(f.executed[0]!.references).toEqual(selected
    ? [{ status: 'preserved', url: BENIGN }, { status: 'omitted' }, { status: 'preserved', url: LAST }]
    : [{ status: 'preserved', url: 'https://initial.test/no-query' }]);
  const repairIds = log.query({}).filter(record => JSON.stringify(record.questions).includes('boolean_value')).map(record => record.id);
  if (selected) { expect(repairIds).toHaveLength(1); expect(result!.autonomousDecision!.judgmentDecisionIds).toContain(repairIds[0]!); }
  expectNoOriginal(requests); expectNoOriginal(log.query({})); expectNoOriginal(f.events);
  expect(f.released).toHaveLength(4); await expectDrained(f);
});

test.each([false, true])('foreground first persistence and contract reports are projected, with unselected alternative = %s', async alternative => {
  const f = fixture(); const conversation = new ConversationManager();
  if (alternative) f.revisions.push({ ref: { id: 'alternative', revision: 'host-v1', kind: 'revise-action' }, toolName: f.tool.definition.name, args: input() });
  const args = alternative ? { references: refs('https://initial.test/no-query') } : input();
  const expected = alternative ? [{ id: 'S1', url: '[source reference S1]' }] : LABELS;
  const persisted: unknown[] = [], pending: ToolCall[][] = [], reports: ContractTurnRecord[] = [];
  const add = conversation.addAssistantMessage.bind(conversation);
  conversation.addAssistantMessage = (content, opts) => { persisted.push(opts?.toolCalls); expectNoOriginal(opts); add(content, opts); };
  const contractSession: ContractSessionTurn = {
    record: { id: 'synthetic-contract-turn' } as ContractSessionTurn['record'], turn: 0,
    hooks: { onTurnEnd: (_record, round) => { reports.push(round); expectNoOriginal(round); }, sessionTurn: () => null,
      takeSessionNudge: () => null, holdCompletion: async () => ({ kind: 'release' }) },
  };
  const result = await handleToolResponseOutcome({
    toolRegistry: f.registry, conversation, contractSession,
    agentManager: { list: () => [], spawn: () => { throw new Error('Unexpected agent spawn'); } }, planManager: null,
    configManager: { get: () => undefined } as unknown as Pick<ConfigManager, 'get'>,
    providerRegistry: { getCurrentModel: () => ({ id: 'fixture', provider: 'fixture', registryKey: 'fixture:fixture', displayName: 'fixture',
      description: 'fixture', capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false }, contextWindow: 128_000, selectable: true }) },
    runtimeBus: null, emitterContext: f.deps.emitterContext, turnId: 'framed-turn',
    response: { content: '', toolCalls: [{ id: 'framed-call', name: f.tool.definition.name, arguments: args }], usage: undefined } as never,
    userText: '', executeToolCalls: (turnId, calls) => executeToolCalls(f.deps, turnId, calls),
    setPendingToolCalls: calls => { pending.push(calls); expectNoOriginal(calls); }, messageQueueLength: 0, requestRender: () => {}, sessionId: 'framed-fixture',
  });
  expect(result.results[0]?.success).toBe(true);
  expect(persisted).toEqual([[{ id: 'framed-call', name: f.tool.definition.name, arguments: { references: expected } }]]);
  expect(pending).toHaveLength(2); expect(reports).toHaveLength(1);
  expect(reports[0]!.toolCalls[0]!.arguments.references).toEqual(expected);
  expectNoOriginal(conversation.getMessageSnapshot()); expectNoOriginal(requests); expectNoOriginal(log.query({}));
  expect(f.calls).toHaveLength(3); expect(f.released).toHaveLength(alternative ? 4 : 3);
});

test('only the exact final frozen args and real execution context resolve; release invalidates retained access', async () => {
  const entered = latch(), finish = latch(); let foreignContext: object | undefined;
  const other = fixture({ onBody: async (_args, opts) => { foreignContext = opts?.inputProjectionContext; entered.resolve(); await finish.promise; } });
  const pending = run(other, { references: refs('https://foreign.test/source') }, 'foreign-call'); await entered.promise;
  const f = fixture({ onBody: (args, opts) => {
    if (!opts?.inputProjectionContext) return;
    const context = opts.inputProjectionContext;
    expect(Object.isFrozen(args)).toBe(true); expect(Object.isFrozen(args.references)).toBe(true);
    expect(Object.isFrozen(context)).toBe(true); expect(Reflect.ownKeys(context)).toEqual([]);
    expect(() => resolveFramedResearchReference(undefined, args, 'S1')).toThrow('unavailable');
    expect(() => resolveFramedResearchReference(Object.freeze({}), args, 'S1')).toThrow('unavailable');
    expect(() => resolveFramedResearchReference(foreignContext, args, 'S1')).toThrow('unavailable');
    expect(() => resolveFramedResearchReference(context, { ...args }, 'S1')).toThrow('unavailable');
    expect(() => resolveFramedResearchReference(context, { ...args, references: [{ id: 'S1', url: '[source reference S3]' }] }, 'S1')).toThrow('unavailable');
    expect(() => resolveFramedResearchReference(context, args, 'S4')).toThrow('unavailable');
    expect(resolveFramedResearchReference(context, args, 'S1')).toEqual({ status: 'preserved', url: BENIGN });
  } });
  try {
    const projected = await f.registry.projectCall('framed-call', f.tool.definition.name, input());
    const prepared = await f.registry.prepareCall('framed-call', f.tool.definition.name, projected.args);
    await expect(f.tool.execute(prepared.args)).rejects.toThrow('unavailable');
    expect((await run(f, projected.args))[0]?.success).toBe(true);
    const context = f.executed[0]!.opts?.inputProjectionContext;
    expect(() => resolveFramedResearchReference(context, f.executed[0]!.args, 'S1')).toThrow('unavailable');
  } finally { finish.resolve(); await pending; }
});

test('real framed owner refuses changed protected cells at the repaired-binding boundary', async () => {
  const f = fixture();
  const projection = await createFramedResearchReferenceProjector(f.owner).project({
    callId: 'framed-call', name: f.tool.definition.name, args: input(), assertCurrent() {},
  });
  expect(projection.status).toBe('projected'); if (projection.status !== 'projected') return;
  try {
    for (const changed of [LABELS.slice(1), [...LABELS].reverse(), [{ id: 'S1', url: '[source reference S2]' }, ...LABELS.slice(1)],
      [LABELS[0], { id: 'S2', url: UNSAFE }, LABELS[2]]]) {
      expect(() => projection.assertRepairedArgs!({ ...projection.args, references: changed })).toThrow('unavailable');
    }
    const safe = Object.freeze({ ...projection.args, enabled: true }); projection.assertRepairedArgs!(safe);
    // Binding validation alone does not mint an active admitted-body lease.
    expect(() => resolveFramedResearchReference(projection.executionContext, safe, 'S3')).toThrow('stale');
  } finally { await projection.release!(); }
});

test.each(['prepare', 'execute'] as const)('later %s cancellation retires reference access while the admitted body is still running', async stage => {
  const entered = latch(), finish = latch(); const later = new AbortController();
  let execution: { args: Record<string, unknown>; context: object | undefined; signal: AbortSignal | undefined } | undefined;
  const f = fixture({ onBody: async (args, opts) => {
    execution = { args, context: opts?.inputProjectionContext, signal: opts?.signal };
    expect(resolveFramedResearchReference(execution.context, args, 'S1')).toEqual({ status: 'preserved', url: BENIGN });
    entered.resolve(); await finish.promise;
  } });
  const projected = await f.registry.projectCall('later-signal', f.tool.definition.name, input());
  const prepared = await f.registry.prepareCall('later-signal', f.tool.definition.name, projected.args, stage === 'prepare' ? { signal: later.signal } : undefined);
  const running = f.registry.executePrepared(prepared, () => {}, stage === 'execute' ? { signal: later.signal } : undefined);
  void running.catch(() => {});
  try {
    await entered.promise; later.abort();
    expect(execution!.signal?.aborted).toBe(true);
    expect(() => resolveFramedResearchReference(execution!.context, execution!.args, 'S1')).toThrow('cancelled');
    expect(f.released).toHaveLength(0);
    finish.resolve(); await expect(running).rejects.toBeDefined();
    expect(f.released).toHaveLength(3); expect(f.executed).toHaveLength(0);
  } finally { finish.resolve(); await running.catch(() => {}); await f.registry.releaseProjected(projected); }
});

test('source-authority callback cannot cancel the execution lease and still release an original reference', async () => {
  const later = new AbortController(); let armed = false;
  const f = fixture({ onAuthority: () => { if (armed) later.abort(); }, onBody: (args, opts) => {
    armed = true;
    expect(() => resolveFramedResearchReference(opts?.inputProjectionContext, args, 'S1')).toThrow('cancelled');
    expect(opts?.signal?.aborted).toBe(true);
  } });
  const projected = await f.registry.projectCall('reentrant-lease', f.tool.definition.name, input());
  const prepared = await f.registry.prepareCall('reentrant-lease', f.tool.definition.name, projected.args);
  await expect(f.registry.executePrepared(prepared, () => {}, { signal: later.signal })).rejects.toBeDefined();
  expect(f.executed).toHaveLength(0); expect(f.released).toHaveLength(3);
});

test.each(['raw floor', 'decoded floor', 'frame gap', 'extra cell field'] as const)('complete reference batch preflight rejects %s before any local request', async kind => {
  const f = fixture(); const args = input();
  if (kind === 'raw floor') args.references[2]!.url = 'https://example.test/?password=synthetic-value';
  if (kind === 'decoded floor') args.references[2]!.url = 'https://example.test/?password%3Dsynthetic-value=ordinary';
  if (kind === 'frame gap') args.references[2]!.id = 'S4';
  if (kind === 'extra cell field') Object.assign(args.references[2]!, { title: 'unframed' });
  await expect(run(f, args)).rejects.toBeDefined();
  expect(f.calls).toHaveLength(0); expect(requests).toHaveLength(0); expect(f.executed).toHaveLength(0); expect(f.events).toHaveLength(0);
  await expectDrained(f);
});

test('an unsettled real role holds every reference and cannot enter repair, admission or events', async () => {
  const f = fixture({ judge: () => roleAnswer(0.5), requireQuery: true });
  for (const id of ['held-call', 'held-again']) {
    await expect(run(f, { ...input(), enabled: 'enabled', spare: 'ordinary topic' }, id)).rejects.toMatchObject({ problem: 'held' });
  }
  expect(f.calls).toHaveLength(1); expect(requests).toHaveLength(0); expect(f.events).toHaveLength(0); expect(f.executed).toHaveLength(0);
  expect(f.released).toHaveLength(6); expectNoOriginal(f.calls); await expectDrained(f);
});

test('successful reference projection does not bypass the ordinary schema', async () => {
  const f = fixture();
  await expect(run(f, { ...input(), query: { invalid: true } })).rejects.toThrow('schema');
  expect(f.calls).toHaveLength(3); expect(requests).toHaveLength(0); expect(f.events).toHaveLength(0); expect(f.executed).toHaveLength(0);
  expect(f.released).toHaveLength(3); await expectDrained(f);
});

test('borrowed reference mutation cannot replace captured originals while the local role request is pending', async () => {
  const started = latch(), resume = latch();
  const f = fixture({ judge: async body => { started.resolve(); await resume.promise; return roleAnswer((body.state as { parameter: string }).parameter === 'auth' ? 1 : 0); } });
  const args = input(); const pending = run(f, args); await started.promise;
  args.references[0]!.url = 'https://changed.test/?id=CHANGED_VALUE'; args.references.reverse(); resume.resolve();
  expect((await pending)[0]?.success).toBe(true);
  expect(f.executed[0]!.references).toEqual([{ status: 'preserved', url: BENIGN }, { status: 'omitted' }, { status: 'preserved', url: LAST }]);
  expectNoOriginal(f.calls); expectNoOriginal(requests);
});

test.each(['source', 'caller', 'owner', 'authority'] as const)('pending real role request loses %s authority without publication or a body', async kind => {
  const started = latch(), resume = latch();
  const f = fixture({ judge: async () => { started.resolve(); await resume.promise; return roleAnswer(0); } });
  const controller = new AbortController(); f.deps.turnSignal = controller.signal;
  const pending = run(f); const outcome = pending.then(() => 'resolved', () => 'rejected'); await started.promise;
  if (kind === 'source') f.source.criteria[0] = 'Changed source criterion';
  if (kind === 'caller') controller.abort();
  if (kind === 'owner') f.lifetime.abort();
  if (kind === 'authority') f.revoke();
  resume.resolve(); expect(await outcome).toBe('rejected');
  expect(f.calls).toHaveLength(1); expectNoOriginal(f.calls); expect(requests).toHaveLength(0);
  expect(f.executed).toHaveLength(0); expect(f.events).toHaveLength(0); expect(f.released).toHaveLength(3);
  if (kind === 'source' || kind === 'caller') await expectDrained(f);
});

test.each(['source', 'caller'] as const)('canonical local-role retry rechecks %s before a second transmission', async kind => {
  const controller = new AbortController();
  const f = fixture({ judge: () => {
    if (kind === 'source') f.source.criteria[0] = 'Changed source criterion';
    else controller.abort();
    return new Response('Synthetic local retryable failure', { status: 503 });
  } });
  f.deps.turnSignal = controller.signal;
  await expect(run(f)).rejects.toBeDefined();
  expect(f.calls).toHaveLength(1); expect(requests).toHaveLength(0); expect(f.events).toHaveLength(0); expect(f.executed).toHaveLength(0);
  expect(f.released).toHaveLength(3); expectNoOriginal(f.calls); await expectDrained(f);
});

test('all release callers await the real owner cleanup, and released prepared input cannot execute', async () => {
  const cleanup = latch(); const entered = latch();
  const f = fixture({ beforeRelease: async () => { entered.resolve(); await cleanup.promise; } });
  const projected = await f.registry.projectCall('framed-call', f.tool.definition.name, input());
  const prepared = await f.registry.prepareCall('framed-call', f.tool.definition.name, projected.args);
  let firstSettled = false, secondSettled = false;
  const first = f.registry.releaseProjected(projected); const second = f.registry.releaseProjected(projected);
  void first.then(() => { firstSettled = true; }); void second.then(() => { secondSettled = true; }); await entered.promise;
  expect(firstSettled).toBe(false); expect(secondSettled).toBe(false); expect(f.released).toHaveLength(0);
  const execution = f.registry.executePrepared(prepared, () => {}).then(() => 'resolved', () => 'rejected');
  cleanup.resolve(); await Promise.all([first, second]); expect(firstSettled).toBe(true); expect(secondSettled).toBe(true);
  expect(await execution).toBe('rejected'); expect(f.released).toHaveLength(3);
  expect(f.executed).toHaveLength(0); await expectDrained(f);
});
