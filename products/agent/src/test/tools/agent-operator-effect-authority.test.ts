import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createAgentOperatorMethodTool, registerAgentOperatorMethodTool } from '../../tools/agent-operator-method-tool.ts';
import { createAgentOperatorActionTool, registerAgentOperatorActionTool } from '../../tools/agent-operator-action-tool.ts';
import { createOperatorInputProjector } from '../../tools/agent-operator-input-projector.ts';
import { getOperatorActions } from '../../agent/operator-actions.ts';
import { captureOperatorConnection } from '../../agent/operator-connection-owner.ts';
import { createDaemonOperatorInvoke } from '../../agent/daemon-operator-client.ts';
import { executeOperatorMethodWithReceipt } from '../../agent/operator-method-receipt.ts';
import { recordedEffectFixture } from '../helpers/recorded-effect-admission.ts';
import { getSessionUntrustedContentLedger, resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';

let prior: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog;
let readingRequests: unknown[] = [];
const roots: string[] = [], servers: Array<ReturnType<typeof Bun.serve>> = [];
const connectedEnv = process.env.GOODVIBES_CONNECTED_HOST_TOKEN, daemonEnv = process.env.GOODVIBES_DAEMON_TOKEN;
beforeEach(() => {
  resetSessionUntrustedContentLedgerForTests();
  delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN; delete process.env.GOODVIBES_DAEMON_TOKEN;
  log = new SqliteDecisionLog(':memory:');
  const fake = fakePort((name, question) => {
    if (question.type === 'choice') return choiceAnswer(question, name === 'disposition' ? 'act'
      : name === 'kind' ? Object.hasOwn(question.criteria, 'other') ? 'other' : 'read' : 'generic', 0.999);
    if (question.type === 'noul') return noulAnswer(0.001);
    throw new Error(`Unexpected question ${name}`);
  });
  prior = installJudgmentPort(withDecisionLog(fake.port, log));
  readingRequests = fake.requests;
});
afterEach(() => {
  resetSessionUntrustedContentLedgerForTests();
  installJudgmentPort(prior); log[Symbol.dispose]();
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (connectedEnv === undefined) delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN; else process.env.GOODVIBES_CONNECTED_HOST_TOKEN = connectedEnv;
  if (daemonEnv === undefined) delete process.env.GOODVIBES_DAEMON_TOKEN; else process.env.GOODVIBES_DAEMON_TOKEN = daemonEnv;
});

const ACTION = { action: 'automation.jobs.run', jobId: 'fixture-job' };
const METHOD = { methodId: 'services.start', input: {} };
function scene(kind: 'action' | 'method', mode: 'prompt' | 'plan' | 'custom' = 'prompt') {
  const root = mkdtempSync(join(tmpdir(), 'agent-operator-authority-')); roots.push(root);
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  const tokenPath = join(root, '.goodvibes', 'daemon', 'operator-tokens.json');
  const tokenBytes = JSON.stringify({ token: 'fixture-private-operator-token' }); writeFileSync(tokenPath, tokenBytes);
  const requests: Array<{ url: string; auth: string | null; humanRequest: string | null; body: string }> = [];
  let duringRequest: (() => void) | undefined;
  let targets: Array<Record<string, unknown>> = [];
  let targetRevision: string | undefined;
  let nativeMutations = 0;
  let responseBody: unknown = kind === 'method' ? { installed: true, autostart: true, running: true } : { status: 'queued' };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push({ url: request.url, auth: request.headers.get('authorization'),
      humanRequest: request.headers.get('x-goodvibes-explicit-user-request'), body: await request.text() });
    duringRequest?.();
    if (request.method === 'GET' && new URL(request.url).pathname === '/api/automation/schedules') return Response.json({ jobs: targets });
    if (request.method === 'PATCH' && targetRevision !== undefined) {
      const wire = JSON.parse(requests.at(-1)!.body);
      if (wire.expectedMutationRevision !== targetRevision || wire.admission !== 'autonomous') return Response.json({ error: 'Selected target changed' }, { status: 409 });
      nativeMutations++;
    }
    return Response.json(responseBody);
  } }); servers.push(server);
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'agent') });
  config.set('controlPlane.port', server.port!);
  const tool = kind === 'action' ? createAgentOperatorActionTool(paths, config) : createAgentOperatorMethodTool(paths, config);
  let beforeBody: (() => void) | undefined;
  const execute = tool.execute;
  tool.execute = (args, options) => { beforeBody?.(); return execute(args, options); };
  const fixture = recordedEffectFixture(tool, mode, mode === 'custom' ? { write: 'deny' } : {}, root);
  fixture.registry.unregister(tool.definition.name);
  fixture.registry.register(tool, { inputProjection: createOperatorInputProjector(paths, config, kind) });
  return { root, paths, config, tool, fixture, tokenPath, tokenBytes, requests, args: kind === 'action' ? ACTION : METHOD,
    beforeBody(callback: () => void) { beforeBody = callback; },
    response(body: unknown) { responseBody = body; },
    targets(records: Array<Record<string, unknown>>, revision?: string) { targets = records; targetRevision = revision; },
    nativeMutations() { return nativeMutations; },
    duringRequest(callback: () => void) { duringRequest = callback; } };
}

test.each(['action', 'method'] as const)('raw %s confirmation cannot dispatch a loopback effect', async kind => {
  const f = scene(kind);
  const result = await f.tool.execute({ ...f.args, confirm: true, explicitUserRequest: 'A caller supplied claim' });
  expect(result.success).toBe(false); expect(f.requests).toHaveLength(0);
});
test('operator mutation cannot bypass native outward policy with a false outward reading', async () => {
  const f = scene('method');
  getSessionUntrustedContentLedger().record({ surface: 'web-page', origin: 'https://untrusted.example', at: new Date().toISOString() });
  expect(await f.fixture.run(METHOD)).toMatchObject({ success: false }); expect(f.requests).toHaveLength(0);
});
test.each(['before-admission', 'before-body', 'response'] as const)('operator retains its ledger source through %s', async when => {
  const f = scene('method'); let changed = false;
  const change = () => { if (!changed) { changed = true;
    getSessionUntrustedContentLedger().record({ surface: 'web-page', origin: 'https://changed.example', at: new Date().toISOString() });
  } };
  if (when === 'before-admission') f.fixture.beforeAuthorityRead(change);
  else if (when === 'before-body') f.beforeBody(change);
  else f.duringRequest(change);
  if (when === 'before-admission') await expect(f.fixture.run(METHOD)).rejects.toThrow();
  else expect(await f.fixture.run(METHOD)).toMatchObject({ success: false });
  expect(f.requests).toHaveLength(when === 'response' ? 1 : 0);
});
test('generic schedule update retains private native target before admission and injects its own condition', async () => {
  const f = scene('method');
  f.targets([{ id: 'fixture-job', mutationRevision: 'original-target-generation', note: 'fixture-private-operator-token' }], 'original-target-generation');
  expect(await f.fixture.run({ methodId: 'automation.jobs.update', input: { jobId: 'fixture-job', name: 'New name', admission: 'manual' } })).toMatchObject({ success: true });
  expect(f.requests.map(request => new URL(request.url).pathname)).toEqual(['/api/automation/schedules', '/api/automation/jobs/fixture-job']);
  expect(JSON.parse(f.requests[1]!.body)).toEqual({ name: 'New name', admission: 'autonomous', expectedMutationRevision: 'original-target-generation' });
  expect(f.nativeMutations()).toBe(1); expect(JSON.stringify(readingRequests)).not.toContain('fixture-private-operator-token');
});
test('generic schedule update never advances a native parent to a changed target', async () => {
  const f = scene('method'); f.targets([{ id: 'fixture-job', mutationRevision: 'new-generation' }], 'new-generation');
  await expect(f.fixture.run({ methodId: 'automation.jobs.update', input: { jobId: 'fixture-job', expectedMutationRevision: 'old-generation', name: 'New name' } })).rejects.toThrow();
  expect(f.requests).toHaveLength(1); expect(f.nativeMutations()).toBe(0);
});
test('native conditional update holds a target changed during local admission', async () => {
  const f = scene('method'); f.targets([{ id: 'fixture-job', mutationRevision: 'original-generation' }], 'original-generation');
  f.fixture.beforeAuthorityRead(() => f.targets([{ id: 'fixture-job', mutationRevision: 'changed-generation' }], 'changed-generation'));
  expect(await f.fixture.run({ methodId: 'automation.jobs.update', input: { jobId: 'fixture-job', name: 'New name' } })).toMatchObject({ success: false });
  expect(f.requests).toHaveLength(2); expect(f.nativeMutations()).toBe(0);
});
test('generic schedule creation selects native autonomous admission without an old-target read', async () => {
  const f = scene('method');
  expect(await f.fixture.run({ methodId: 'automation.schedules.create', input: { prompt: 'Review queue', every: '1h', admission: 'manual' } })).toMatchObject({ success: true });
  expect(f.requests).toHaveLength(1); expect(JSON.parse(f.requests[0]!.body)).toMatchObject({ admission: 'autonomous' });
});
test.each(['action', 'method'] as const)('forged %s options and projection context cannot dispatch', async kind => {
  const f = scene(kind);
  const result = await f.tool.execute({ ...f.args, confirm: true, explicitUserRequest: 'Caller claims authority' },
    { signal: new AbortController().signal, assertCurrent() {}, inputProjectionContext: Object.freeze({}) });
  expect(result.success).toBe(false); expect(f.requests).toHaveLength(0);
});
test.each(['action', 'method'] as const)('recorded %s dispatches exact loopback route without caller flags', async kind => {
  const f = scene(kind); const result = await f.fixture.run(f.args);
  expect(result.success).toBe(true); expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.auth).toBe('Bearer fixture-private-operator-token');
  expect(new URL(f.requests[0]!.url).pathname).toBe(kind === 'action' ? '/api/automation/jobs/fixture-job/run' : '/api/service/start');
  expect(result.output).not.toContain('fixture-private-operator-token');
});
test.each(['action', 'method'] as const)('actual %s registration retains its source before admission', async kind => {
  const f = scene(kind);
  f.fixture.registry.unregister(f.tool.definition.name);
  if (kind === 'action') registerAgentOperatorActionTool(f.fixture.registry, f.paths, f.config);
  else registerAgentOperatorMethodTool(f.fixture.registry, f.paths, f.config);
  expect(await f.fixture.run(f.args)).toMatchObject({ success: true });
  expect(f.requests).toHaveLength(1);
});
test('path-bound method dispatches an encoded route without consuming original input', async () => {
  const f = scene('method');
  const input = Object.freeze({ jobId: 'fixture-job/name', note: 'fixture-note' });
  expect(await f.fixture.run({ methodId: 'automation.jobs.run', input })).toMatchObject({ success: true });
  expect(f.requests).toHaveLength(1);
  expect(new URL(f.requests[0]!.url).pathname).toBe('/api/automation/jobs/fixture-job%2Fname/run');
  expect(JSON.parse(f.requests[0]!.body)).toEqual({ note: 'fixture-note' });
  expect(input).toEqual({ jobId: 'fixture-job/name', note: 'fixture-note' });
});
test.each(['action', 'method'] as const)('bare %s registration cannot borrow the required source projection', async kind => {
  const f = scene(kind);
  f.fixture.registry.unregister(f.tool.definition.name); f.fixture.registry.register(f.tool);
  expect(await f.fixture.run(f.args)).toMatchObject({ success: false });
  expect(f.requests).toHaveLength(0);
});
test.each(['action', 'method'] as const)('registered %s cannot borrow a different configured connection owner', async kind => {
  const f = scene(kind), foreign = scene(kind);
  f.fixture.registry.unregister(f.tool.definition.name);
  f.fixture.registry.register(f.tool, { inputProjection: createOperatorInputProjector(foreign.paths, foreign.config, kind) });
  expect(await f.fixture.run(f.args)).toMatchObject({ success: false });
  expect(f.requests).toHaveLength(0); expect(foreign.requests).toHaveLength(0);
});
test('native channel wire selects fresh server admission without forging human provenance', async () => {
  const f = scene('method');
  const result = await f.fixture.run({ methodId: 'channels.drafts.save',
    input: { draftId: 'fixture-draft', profileId: 'fixture-profile', text: 'Prepared draft', admission: 'manual' },
    confirm: true, explicitUserRequest: 'Caller supplied request text' });
  expect(result.success).toBe(true); expect(f.requests).toHaveLength(1);
  expect(JSON.parse(f.requests[0]!.body)).toMatchObject({ admission: 'autonomous', draftId: 'fixture-draft', text: 'Prepared draft' });
  expect(f.requests[0]?.humanRequest).toBeNull();
});
test.each([
  ['profile.set', { fieldId: 'preferences.color', value: 'green', surface: 'agent' }, true],
  ['profile.append', { section: 'preferences', text: 'A retained preference', surface: 'agent' }, true],
  ['profile.forget', { fieldId: 'preferences.color' }, false],
  ['profile.undo', { fieldId: 'preferences.color' }, false],
  ['occasions.confirm', { title: 'A date', date: '2030-04-05', kind: 'remember-only', surface: 'agent' }, true],
  ['occasions.plans.confirm', { title: 'A plan', from: '2030-04-05', to: '2030-04-06', surface: 'agent' }, true],
  ['occasions.remove', { occasionId: 'fixture-occasion', confirmed: false }, false],
] as const)('native %s wire selects autonomous admission with truthful provenance', async (methodId, fields, quoted) => {
  const f = scene('method');
  const input = Object.freeze({ ...fields, authority: 'owner-direct', admission: 'manual', ...(quoted ? { said: 'Caller fabricated human words' } : {}) });
  const args = { methodId, input };
  expect(await f.tool.execute(args)).toMatchObject({ success: false }); expect(f.requests).toHaveLength(0);
  expect(await f.fixture.run(args)).toMatchObject({ success: true }); expect(f.requests).toHaveLength(1);
  const wire = JSON.parse(f.requests[0]!.body);
  expect(wire).toEqual({ ...input, authority: 'autonomous', admission: 'autonomous',
    ...(quoted ? { said: '' } : {}), ...(methodId === 'occasions.remove' ? { confirmed: true } : {}) });
  expect(Object.hasOwn(wire, 'said')).toBe(quoted); expect(f.requests[0]?.humanRequest).toBeNull();
  expect(input.authority).toBe('owner-direct'); expect(input.admission).toBe('manual');
});
test.each(['action', 'method'] as const)('outward %s cannot bypass the actual plan restriction', async kind => {
  const f = scene(kind, 'plan');
  const args = kind === 'action' ? ACTION : { methodId: 'automation.jobs.run', input: { jobId: 'fixture-job' } };
  expect(await f.fixture.run(args)).toMatchObject({ success: false }); expect(f.requests).toHaveLength(0);
});
test.each([
  ['occasions.answer', { occasionId: 'fixture-occasion', answer: 'later' }],
  ['occasions.acknowledge', { occasionId: 'fixture-occasion' }],
  ['occasions.interview.answer', { interviewId: 'fixture-interview', stepId: 'fixture-step', text: 'A retained answer' }],
  ['occasions.interview.record', { interviewId: 'fixture-interview', landedOn: 'A retained decision' }],
  ['occasions.conflict.resolve', { occasionId: 'fixture-occasion' }],
  ['occasions.sweep', {}],
] as const)('native %s state wire selects its declared autonomous schema', async (methodId, fields) => {
  const f = scene('method'); const input = Object.freeze({ ...fields, admission: 'manual' });
  expect(await f.tool.execute({ methodId, input })).toMatchObject({ success: false }); expect(f.requests).toHaveLength(0);
  expect(await f.fixture.run({ methodId, input })).toMatchObject({ success: true }); expect(f.requests).toHaveLength(1);
  expect(JSON.parse(f.requests[0]!.body)).toEqual({ ...fields, admission: 'autonomous' });
  expect(f.requests[0]?.humanRequest).toBeNull(); expect(input.admission).toBe('manual');
});
test.each(['action', 'method'] as const)('synthetic read judgment cannot bypass %s structural write floor', async kind => {
  for (const mode of ['plan', 'custom'] as const) {
    const f = scene(kind, mode); const result = await f.fixture.run(f.args);
    expect(result.success).toBe(false); expect(f.requests).toHaveLength(0);
  }
});

test.each(['cancel', 'revoke', 'config-aba', 'token-aba', 'getter', 'method'] as const)('operator final dispatch refuses %s', async change => {
  for (const kind of ['action', 'method'] as const) {
    const f = scene(kind), controller = new AbortController(); let changed = false, getterReads = 0;
    const method = getOperatorContract().operator.methods.find(entry => entry.id === 'services.start');
    const http = method?.http;
    const descriptor = getOperatorActions()['automation.jobs.run'];
    const path = descriptor.pathTemplate;
    const getDescriptor = Object.getOwnPropertyDescriptor(f.config, 'get');
    f.beforeBody(() => f.fixture.beforeAuthorityRead(() => {
      if (changed) return; changed = true;
      if (change === 'cancel') controller.abort();
      else if (change === 'revoke') f.fixture.setMode('plan');
      else if (change === 'config-aba') { const port = f.config.get('controlPlane.port'); f.config.set('controlPlane.port', port + 1); f.config.set('controlPlane.port', port); }
      else if (change === 'token-aba') { writeFileSync(f.tokenPath, JSON.stringify({ token: 'changed-private-token' })); writeFileSync(f.tokenPath, f.tokenBytes); }
      else if (change === 'getter') Object.defineProperty(f.config, 'get', { configurable: true, get() { getterReads++; throw new Error('Accessor must never run'); } });
      else if (kind === 'method' && method) Object.defineProperty(method, 'http', { configurable: true, enumerable: true, value: { ...http, path: '/api/changed-route' } });
      else Object.defineProperty(descriptor, 'pathTemplate', { configurable: true, enumerable: true, value: '/api/changed-route/{jobId}' });
    }));
    try {
      let result: Awaited<ReturnType<typeof f.fixture.run>> | undefined;
      try { result = await f.fixture.run(f.args, controller.signal); } catch { /* The registry may retire the invocation before entering its body. */ }
      expect(result?.success ?? false).toBe(false); expect(f.requests).toHaveLength(0); expect(getterReads).toBe(0);
    } finally {
      if (change === 'getter') { if (getDescriptor) Object.defineProperty(f.config, 'get', getDescriptor); else delete Object(f.config).get; }
      if (change === 'method') { if (method) Object.defineProperty(method, 'http', { configurable: true, enumerable: true, writable: true, value: http }); Object.defineProperty(descriptor, 'pathTemplate', { configurable: true, enumerable: true, writable: true, value: path }); }
    }
  }
});

test.each(['config-aba', 'token-aba', 'method'] as const)('operator source is retained through admission for %s', async change => {
  for (const kind of ['action', 'method'] as const) {
    const f = scene(kind); let changed = false;
    const method = getOperatorContract().operator.methods.find(entry => entry.id === (kind === 'method' ? 'services.start' : ACTION.action));
    if (!method) throw new Error('Fixture requires its selected public method.');
    const originalHttp = Object.getOwnPropertyDescriptor(method, 'http');
    f.fixture.beforeAuthorityRead(() => {
      if (changed) return; changed = true;
      if (change === 'config-aba') { const port = f.config.get('controlPlane.port'); f.config.set('controlPlane.port', port + 1); f.config.set('controlPlane.port', port); }
      else if (change === 'token-aba') { writeFileSync(f.tokenPath, JSON.stringify({ token: 'temporary-token' })); writeFileSync(f.tokenPath, f.tokenBytes); }
      else Object.defineProperty(method, 'http', { configurable: true, enumerable: true, writable: true, value: { ...method?.http, path: '/api/changed-before-admission' } });
    });
    try {
      await expect(f.fixture.run(f.args)).rejects.toThrow(); expect(changed).toBe(true); expect(f.requests).toHaveLength(0);
    } finally { if (change === 'method' && method && originalHttp) Object.defineProperty(method, 'http', originalHttp); }
  }
});

test.each(['action', 'method'] as const)('operator %s rejects a symlinked selected credential', async kind => {
  const f = scene(kind), outside = join(f.root, 'outside-token.json');
  renameSync(f.tokenPath, outside); symlinkSync(outside, f.tokenPath);
  await expect(f.fixture.run(f.args)).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
});
test.each(['action', 'method'] as const)('operator %s cannot certify a response after revocation', async kind => {
  const f = scene(kind); f.duringRequest(() => f.fixture.setMode('plan'));
  let result: Awaited<ReturnType<typeof f.fixture.run>> | undefined;
  try { result = await f.fixture.run(f.args); } catch { /* A currentness failure may be raised by the registry. */ }
  expect(result?.success ?? false).toBe(false); expect(f.requests).toHaveLength(1);
});
test('read-only status and dry-run mutation do not require model effect authority', async () => {
  const f = scene('method', 'plan');
  expect(await f.tool.execute({ methodId: 'services.status' })).toMatchObject({ success: true });
  expect(await f.tool.execute({ methodId: 'services.start', dryRun: true })).toMatchObject({ success: true });
  expect(f.requests).toHaveLength(1);
});
test('registered read-only status and preview publish under plan mode', async () => {
  const f = scene('method', 'plan');
  expect(await f.fixture.run({ methodId: 'services.status' })).toMatchObject({ success: true });
  expect(await f.fixture.run({ methodId: 'services.start', dryRun: true })).toMatchObject({ success: true });
  expect(f.requests).toHaveLength(1);
});

test('shared native transport retains native config and supplied owner through response adoption', async () => {
  for (const change of ['config-aba', 'owner', 'cancel'] as const) {
    const f = scene('method'), controller = new AbortController(); let current = true;
    const assertCurrent = () => { if (!current) throw new Error('Owner retired'); };
    const invoke = createDaemonOperatorInvoke(() => captureOperatorConnection(f.paths, f.config, assertCurrent));
    f.duringRequest(() => {
      if (change === 'owner') current = false;
      else if (change === 'cancel') controller.abort();
      else { const port = f.config.get('controlPlane.port'); f.config.set('controlPlane.port', port + 1); f.config.set('controlPlane.port', port); }
    });
    const result = await invoke('services.status', {}, { signal: controller.signal, assertCurrent });
    expect(result).toMatchObject({ ok: false, kind: 'connected_host_unavailable' });
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('fixture-private-operator-token');
  }
});
test('shared native transport checks exact input and connection callback identity after body await', async () => {
  const f = scene('method');
  const connection = captureOperatorConnection(f.paths, f.config, () => {});
  const input = { fixture: 'original' };
  f.duringRequest(() => { input.fixture = 'changed'; });
  const invoke = createDaemonOperatorInvoke(() => connection);
  expect(await invoke('services.status', input)).toMatchObject({ ok: false, kind: 'connected_host_unavailable' });
  expect(f.requests).toHaveLength(1);
});

test('native parent receives its actual private nested receipt while model output and readings remain protected', async () => {
  const f = scene('method');
  f.response({ installed: true, autostart: true, running: true, note: 'fixture-private-operator-token' });
  let privateBody: unknown;
  const parent: Tool = { definition: { name: 'operator_receipt_parent', description: 'Isolated native receipt fixture.',
    sideEffects: ['state'], parameters: { type: 'object', properties: {}, additionalProperties: false } },
    async execute(_args, options) {
      const receipt = await executeOperatorMethodWithReceipt(owner.registry, 'private-child', 'services.start', {}, options);
      if (receipt.kind === 'received') privateBody = receipt.body;
      return { success: receipt.result.success, output: receipt.result.output, error: receipt.result.error };
    } };
  const owner = recordedEffectFixture(parent, 'prompt', {}, f.root);
  owner.registry.register(f.tool, { inputProjection: createOperatorInputProjector(f.paths, f.config, 'method') });
  const result = await owner.run({});
  expect(result.success).toBe(true);
  expect(privateBody).toMatchObject({ note: 'fixture-private-operator-token' });
  expect(result.output).not.toContain('fixture-private-operator-token');
  expect(JSON.stringify(readingRequests)).not.toContain('fixture-private-operator-token');
  expect(f.requests).toHaveLength(1);
});
test('native receipt scope cannot certify changed input after the actual child request', async () => {
  const f = scene('method'); let privateBody: unknown;
  const input = { fixture: 'original' };
  const parent: Tool = { definition: { name: 'operator_receipt_parent', description: 'Isolated native receipt fixture.',
    sideEffects: ['state'], parameters: { type: 'object', properties: {}, additionalProperties: false } },
    async execute(_args, options) {
      const receipt = await executeOperatorMethodWithReceipt(owner.registry, 'private-child', 'services.start', input, options);
      if (receipt.kind === 'received') privateBody = receipt.body;
      return { success: receipt.result.success };
    } };
  const owner = recordedEffectFixture(parent, 'prompt', {}, f.root);
  owner.registry.register(f.tool, { inputProjection: createOperatorInputProjector(f.paths, f.config, 'method') });
  f.duringRequest(() => { input.fixture = 'changed'; });
  await expect(owner.run({})).rejects.toThrow();
  expect(privateBody).toBeUndefined(); expect(f.requests).toHaveLength(1);
});
