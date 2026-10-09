import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, hashState, type EntryType, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.ts';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import type { ExternalPermissionHost } from '../sdk/src/platform/permissions/external-request.ts';

let log: SqliteDecisionLog;
let restore: ReturnType<typeof installJudgmentPort>;
let selected = 'act';
let factSelection = 'revise_0';
let beforeRead: ((request: { context?: { site?: string } | undefined }) => Promise<void>) | undefined;
let host: ExternalPermissionHost;
let invalidations: Set<() => void>;
let humans: number;
let states: EntryType[] = [];
let uncertainQuestion: string | undefined;
let pathValue = false;
let hostValue = false;
let outward = true;
let uncertainty = false;
let hook: (() => void | Promise<void>) | undefined;
beforeEach(() => {
  states = []; uncertainQuestion = undefined; pathValue = false; hostValue = false; outward = true; uncertainty = false; hook = undefined; selected = 'act'; factSelection = 'revise_0'; beforeRead = undefined; humans = 0; invalidations = new Set();
  forgetGateReadings(); log = new SqliteDecisionLog(':memory:');
  const gate = () => gateReadingsPort([['', { outward, capability: 'write_fs', names_path: uncertainty ? 'uncertain' : pathValue, names_host: hostValue }]]);
  const semantic = fakePort((_name, question, state) => choiceAnswer(question, (state as { input?: { request?: unknown } }).input?.request ? factSelection : selected, 0.99));
  const port: JudgmentPort = withDecisionLog({ model: 'synthetic', async ask(request) {
    request.beforeAttempt?.(); await beforeRead?.(request); request.signal?.throwIfAborted(); request.beforeAttempt?.();
    if ('disposition' in request.questions) { states.push(request.state); return semantic.port.ask(request); }
    if (uncertainQuestion && uncertainQuestion in request.questions) return fakePort((name, question) => {
      if (question.type === 'noul') return noulAnswer(name === uncertainQuestion ? 0.5 : name === 'mutates' || (name === 'outward' && outward) ? 0.97 : 0.03);
      return choiceAnswer(question, name === 'family' ? 'generic' : name === 'capability' ? 'write_fs' : 'other', name === uncertainQuestion ? 0.5 : 0.99);
    }).port.ask(request);
    return gate().port.ask(request);
  } }, log);
  restore = installJudgmentPort(port);
  const config: PermissionConfigReader = {
    isAutoApproveEnabled: () => false, getWorkingDirectory: () => '/synthetic/project',
    getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
    getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory: '/synthetic/project' }),
  } as PermissionConfigReader;
  host = { port, permissionManager: new PermissionManager(async () => { humans++; throw new Error('No human'); }, config, new PolicyRuntimeState()),
    signal: new AbortController().signal, config: { onDidInvalidate(listener) { invalidations.add(listener); return () => { invalidations.delete(listener); }; } } };
});
afterEach(() => { installJudgmentPort(restore); log[Symbol.dispose](); forgetGateReadings(); });


import { McpRegistry } from '../sdk/src/platform/mcp/registry.ts';
import { McpClient } from '../sdk/src/platform/mcp/client.ts';
import { McpPermissionManager } from '../sdk/src/platform/runtime/mcp/permissions.ts';
import { withExternalOperationSource } from '../sdk/src/platform/permissions/external-operation-scope.ts';
import { createRuntimeMcpApi } from '../sdk/src/platform/runtime/runtime-mcp-api.ts';
import { createMcpAutonomousElicitationHandler } from '../sdk/src/platform/mcp/elicitation-autonomous.ts';
import { parseElicitationParams } from '../sdk/src/platform/mcp/elicitation.ts';
const operation = () => ({ sourceOf: () => ({ goal: 'Perform the requested write using supplied name Alice', criteria: [] }), inputFacts: [{ name: 'Alice' }], assertCurrent() {} });
function fixture(mrtr = false) {
  const handler = createMcpAutonomousElicitationHandler(host);
  const client = new McpClient({ name: 'synthetic', command: '/synthetic/server' }, {
    onElicitation: input => handler(parseElicitationParams(input.serverName, input.params, input.id), input.context),
  });
  const access = client as unknown as { proc: unknown; negotiated: unknown; schemaCache: Map<string, unknown>; _dispatchLine(line: string): void; renewConnection(): void };
  access.negotiated = { era: 'modern', version: '2026-07-28', transport: 'stdio' };
  access.schemaCache.set('write', { name: 'write', description: 'synthetic', inputSchema: { type: 'object' } });
  const wire: Record<string, unknown>[] = [];
  access.proc = { exitCode: null, stdin: { write(line: string) {
    const message = JSON.parse(line) as Record<string, unknown>; wire.push(message);
    const params = message.params as Record<string, unknown>;
    const result = mrtr && !params.inputResponses ? { resultType: 'input_required', inputRequests: { form: { method: 'elicitation/create', params: { message: 'name', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } } } } : { done: true, received: params };
    queueMicrotask(() => access._dispatchLine(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })));
  } } };
  const registry = new McpRegistry({ hookDispatcher: { fire: async event => { if (event.phase === 'Pre') await hook?.(); return { ok: true }; } }, sandboxSessions: {} as never });
  registry.setPermissionHost(host);
  const internal = registry as unknown as { clients: Map<string, McpClient>; permissions: McpPermissionManager };
  internal.clients.set('synthetic', client); internal.permissions.registerServer('synthetic');
  const api = createRuntimeMcpApi(registry);
  return { registry, internal, client, access, wire, api, call: (args = { name: 'Alice' }, signal?: AbortSignal) => withExternalOperationSource(operation(), () => api.callTool!('mcp:synthetic:write', args, { signal })) };
}
test('default coherent high-risk ask uses canonical act through the real facade and registry', async () => {
  const f = fixture(); const permission = await f.internal.permissions.evaluateToolCall('synthetic', 'write', {});
  expect(permission.verdict).toBe('ask'); expect(permission.causes).toEqual(['risk-policy']);
  expect(await f.call()).toMatchObject({ done: true }); expect(f.wire).toHaveLength(1); expect(humans).toBe(0); expect(invalidations.size).toBe(0);
});
test('constrained coherent medium uses admission; high stays denied', async () => {
  const f = fixture(); f.registry.setServerTrustMode('synthetic', 'constrained');
  await expect(f.call()).rejects.toThrow('denied'); expect(f.wire).toHaveLength(0);
  outward = false; await f.call(); expect(f.wire).toHaveLength(1);
});
for (const outcome of ['reject', 'defer']) test(`canonical ${outcome} cannot dispatch`, async () => {
  selected = outcome; const f = fixture(); await expect(f.call()).rejects.toThrow(); expect(f.wire).toHaveLength(0); expect(humans).toBe(0); expect(invalidations.size).toBe(0);
});
test('missing original source or recorded host refuses risk-policy ask', async () => {
  const f = fixture(); await expect(f.api.callTool!('mcp:synthetic:write', {})).rejects.toThrow(); expect(f.wire).toHaveLength(0);
  f.registry.setPermissionHost({ ...host, port: { model: host.port.model, ask: host.port.ask.bind(host.port) } });
  await expect(f.call()).rejects.toThrow('recorded'); expect(f.wire).toHaveLength(0);
});
test('uncertain scoped values cannot qualify as confident risk-policy', async () => {
  const f = fixture(); uncertainty = true; outward = false;
  f.internal.permissions.registerServer('synthetic', 'standard', { allowedPaths: ['/synthetic'] });
  const permission = await f.internal.permissions.evaluateToolCall('synthetic', 'write', { path: '/synthetic/file' });
  expect(permission.causes).toContain('uncertain-reading'); await expect(f.call({ name: '/synthetic/file' })).rejects.toThrow(); expect(f.wire).toHaveLength(0);
});
for (const invalidation of ['abort', 'policy', 'config', 'reconnect', 'mutable-policy']) test(`${invalidation} in the prehook prevents the admitted write`, async () => {
  const f = fixture(); const controller = new AbortController();
  hook = () => {
    if (invalidation === 'abort') controller.abort();
    if (invalidation === 'policy') { f.registry.setServerTrustMode('synthetic', 'blocked'); f.registry.setServerTrustMode('synthetic', 'ask-on-risk'); }
    if (invalidation === 'config') for (const invalidate of invalidations) invalidate();
    if (invalidation === 'reconnect') f.access.renewConnection();
    if (invalidation === 'mutable-policy') f.internal.permissions.getServerPermissions('synthetic')!.profile.allowedHosts.push('changed.invalid');
  };
  const failure = await f.call(undefined, controller.signal).catch(error => error); expect(failure).toBeInstanceOf(Error); expect(f.wire).toHaveLength(0); expect(invalidations.size).toBe(0);
});
test('logical tool admission is claimed once across MRTR; each response is separately admitted', async () => {
  const f = fixture(true); await f.call(); expect(f.wire).toHaveLength(2);
  expect((f.wire[1]!.params as Record<string, unknown>).inputResponses).toEqual({ form: { action: 'accept', content: { name: 'Alice' } } });
  expect(invalidations.size).toBe(0); expect(humans).toBe(0);
});
test('caller mutation during admission cannot change exact wire arguments', async () => {
  const f = fixture(); const args = { name: 'Alice' }; beforeRead = async () => { args.name = 'Mallory'; };
  await f.call(args); expect((f.wire[0]!.params as Record<string, unknown>).arguments).toEqual({ name: 'Alice' });
});

import { captureExternalRequestEvidence, readExternalRequestEvidence } from '../sdk/src/platform/permissions/external-request-evidence.ts';
test('canonical recorded state includes actual destination and immutable policy meaning', async () => {
  const f = fixture(); await f.call();
  const stateText = JSON.stringify(states);
  expect(stateText).toContain('/synthetic/server'); expect(stateText).toContain('ask-on-risk');
  expect(stateText).toContain('externalRequest'); expect(stateText).toContain('Alice');
  expect(log.query().some(entry => entry.stateHash === hashState(states[0]!))).toBe(true);
});
test('external evidence is detached, opaque and screened before judgment', () => {
  const input = { destination: 'synthetic', policy: { mode: 'constrained' } };
  const token = captureExternalRequestEvidence(input); input.policy.mode = 'allow-all';
  expect(readExternalRequestEvidence(token)).toEqual({ destination: 'synthetic', policy: { mode: 'constrained' } });
  expect(() => readExternalRequestEvidence({ destination: 'forged' })).toThrow();
  let getters = 0; const bad = Object.defineProperty({}, 'destination', { get() { getters++; return 'synthetic'; }, enumerable: true });
  expect(() => captureExternalRequestEvidence(bad)).toThrow(); expect(getters).toBe(0);
  expect(() => captureExternalRequestEvidence({ destination: 'synthetic', cardNumber: '4111111111111111' })).toThrow();
});
for (const question of ['capability', 'family', 'outward', 'cardDetails']) test(`${question} uncertainty never reaches autonomous disposition or wire`, async () => {
  uncertainQuestion = question; const f = fixture(); await expect(f.call()).rejects.toThrow();
  expect(states).toHaveLength(0); expect(f.wire).toHaveLength(0);
});
for (const mode of ['blocked', 'role', 'capability', 'path', 'host']) test(`${mode} restriction never reaches autonomous disposition`, async () => {
  const f = fixture();
  if (mode === 'blocked') f.registry.setServerTrustMode('synthetic', 'blocked');
  if (mode === 'role') f.registry.setServerRole('synthetic', 'docs');
  if (mode === 'capability') f.internal.permissions.registerServer('synthetic', 'standard', { allowedCapabilities: ['read_fs'] });
  if (mode === 'path') { pathValue = true; f.internal.permissions.registerServer('synthetic', 'standard', { allowedPaths: ['/elsewhere'] }); }
  if (mode === 'host') { hostValue = true; f.internal.permissions.registerServer('synthetic', 'standard', { allowedHosts: ['allowed.invalid'] }); }
  await expect(f.call({ name: '/synthetic/file' })).rejects.toThrow(); expect(states).toHaveLength(0); expect(f.wire).toHaveLength(0);
});
test('source replacement during the first reading cannot adopt a new goal', async () => {
  const f = fixture(); let goal = 'Original goal'; beforeRead = async () => { goal = 'Replacement goal'; };
  await expect(withExternalOperationSource({ sourceOf: () => ({ goal, criteria: [] }), assertCurrent() {} }, () => f.api.callTool!('mcp:synthetic:write', {}))).rejects.toThrow();
  expect(f.wire).toHaveLength(0); expect(states).toHaveLength(0);
});
test('endpoint mutation after admission is refused at the actual write guard', async () => {
  const f = fixture(); hook = () => { (f.client as unknown as { config: { command: string } }).config.command = '/different/server'; };
  await expect(f.call()).rejects.toThrow(); expect(f.wire).toHaveLength(0);
});
for (const change of ['cancel', 'reconnect', 'quarantine']) test(`${change} during delayed schema loading prevents tools/call`, async () => {
  const f = fixture(); f.access.schemaCache.clear(); const controller = new AbortController();
  f.client.getToolSchema = async () => {
    if (change === 'cancel') controller.abort();
    if (change === 'reconnect') f.access.renewConnection();
    if (change === 'quarantine') f.registry.quarantineSchema('synthetic', 'operator_flagged');
    return null;
  };
  await expect(f.call(undefined, controller.signal)).rejects.toThrow(); expect(f.wire).toHaveLength(0); expect(invalidations.size).toBe(0);
});
test('revocation after first MRTR dispatch prevents the continuation write', async () => {
  const f = fixture(true); beforeRead = async request => { if (f.wire.length && request.context?.site === 'engine.gate') f.registry.setServerTrustMode('synthetic', 'blocked'); };
  await expect(f.call()).rejects.toThrow(); expect(f.wire).toHaveLength(1);
});
test('unavailable recorded reader and a late answer after cancellation dispatch nothing', async () => {
  const f = fixture(); const controller = new AbortController();
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  beforeRead = async () => { entered(); await wait; };
  const pending = f.call(undefined, controller.signal).catch(error => error);
  await started; controller.abort(); release(); expect(await pending).toBeInstanceOf(Error);
  expect(f.wire).toHaveLength(0); expect(humans).toBe(0);
  beforeRead = async () => { throw new Error('Synthetic unavailable provider'); };
  await expect(f.call()).rejects.toThrow(); expect(f.wire).toHaveLength(0);
});
test('actual facade preserves absent call support and forwards schema with the registry receiver', async () => {
  const absent = createRuntimeMcpApi({} as never); expect(absent.callTool).toBeUndefined(); expect(absent.getToolSchema).toBeUndefined();
  const schemaOnly = { marker: 'owned', getToolSchema() { expect(this.marker).toBe('owned'); return Promise.resolve(null); } };
  const api = createRuntimeMcpApi(schemaOnly as never); expect(api.callTool).toBeUndefined(); expect(await api.getToolSchema!('mcp:synthetic:write')).toBeNull();
});
