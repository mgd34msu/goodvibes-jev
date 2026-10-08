/**
 * Actual Agent composition acceptance for the bounded read/goodvibes_settings
 * adoption. These expose the ca12 read gaps; only the judgment I/O is
 * synthetic; registration, policies, preparation, admission and backends are
 * production code. All reads and writes are confined to each scratch runtime.
 * Preferred settings/agent_harness and live semantic calibration are separate.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { executeToolCalls, type ToolExecutionDeps } from '@goodvibes-jev/engine/sdk/platform/core';
import type { ToolResult } from '@goodvibes-jev/engine/sdk/platform/types';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ReadTool } from '@goodvibes-jev/engine/sdk/platform/tools';
import { CodeIntelligence } from '@goodvibes-jev/engine/sdk/platform/intelligence';
import { withTurnSurface } from '@goodvibes-jev/engine/sdk/platform/security';
import { PolicyRuntimeState, RuntimeEventBus } from '@/runtime/index.ts';
import { PermissionManager, createPermissionConfigReader, UserPermissionRuleStore } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { composeAgentToolRegistry } from '../../runtime/agent-tool-registry.ts';
import { explainAgentToolPolicyInvocation } from '../../tools/agent-tool-policy-guard.ts';
import { composeAgentPermissionManager } from '../../runtime/bootstrap-core.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type Request = JudgmentRequest<Questions>;
let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
let requests: Request[];
let selected: 'act' | 'reject' | 'defer_0';
let reportsMutation: boolean;
let secrets: 'no' | 'yes' | 'uncertain';
let platform: 'no' | 'yes' | 'uncertain';
let platformRequested: 'no' | 'yes' | 'uncertain';
let beforeAnswer: ((request: Request) => void | Promise<void>) | undefined;
let readBodies: number;
let restoreRead: (() => void) | undefined;
const runtimes: RuntimeServices[] = [];
const restoreOthers: (() => void)[] = [];
const secretTargets = new Set<string>();
const platformTargets = new Set<string>();

beforeEach(() => {
  requests = []; selected = 'act'; reportsMutation = true; secrets = 'no'; platform = 'no'; platformRequested = 'no'; beforeAnswer = undefined; readBodies = 0;
  secretTargets.clear(); platformTargets.clear();
  log = new SqliteDecisionLog(':memory:');
  const originalRead = ReadTool.prototype.execute;
  const readSpy = spyOn(ReadTool.prototype, 'execute').mockImplementation(function (this: ReadTool, args, options) {
    readBodies++;
    return originalRead.call(this, args, options);
  });
  restoreRead = () => readSpy.mockRestore();
  previous = installJudgmentPort(recordedPort());
});

afterEach(async () => {
  try {
    for (const runtime of runtimes.splice(0).reverse()) {
      try { await runtime.processManager.close(); } finally { runtime.dispose(); }
    }
  } finally {
    restoreRead?.(); restoreRead = undefined;
    for (const restore of restoreOthers.splice(0)) restore();
    installJudgmentPort(previous); log[Symbol.dispose]();
  }
});

function recordedPort(): JudgmentPort {
  const scripted = fakePort((name, question, state) => {
    const subject = state as { path?: string; arguments?: { path?: string } };
    const path = subject.path ?? subject.arguments?.path ?? '';
    if (name === 'disposition' && question.type === 'choice') {
      const choice = selected === 'act' && !Object.hasOwn(question.criteria, 'act') ? 'reject' : selected;
      return choiceAnswer(question, choice, 0.999);
    }
    if (name === 'hazard') return choiceAnswer(question, 'approval-gate', 0.999);
    if (name === 'family' || name === 'capability') return choiceAnswer(question, 'generic', 0.999);
    if (name === 'kind') return choiceAnswer(question, 'read', 0.999);
    if (name === 'secrets') return noulAnswer(secretTargets.has(path) || secrets === 'yes' ? 0.999 : secrets === 'uncertain' ? 0.5 : 0.001);
    if (name === 'platform_source') return noulAnswer(platformTargets.has(path) || platform === 'yes' ? 0.999 : platform === 'uncertain' ? 0.5 : 0.001);
    if (name === 'platform_requested') return noulAnswer(platformRequested === 'yes' ? 0.999 : platformRequested === 'uncertain' ? 0.5 : 0.001);
    if (question.type === 'noul') return noulAnswer(name === 'mutates' && reportsMutation ? 0.999 : 0.001);
    throw new Error(`Unscripted Agent read/settings fixture question: ${name}`);
  });
  const observed: JudgmentPort = {
    model: scripted.port.model,
    async ask(request) {
      request.signal?.throwIfAborted(); request.beforeAttempt?.();
      requests.push(request as Request);
      await beforeAnswer?.(request as Request);
      return scripted.port.ask(request);
    },
  };
  return withDecisionLog(observed, log);
}

function fixture() {
  const root = makeProjectTempDir('agent-read-settings-admission');
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const configDir = join(home, '.goodvibes', 'agent');
  mkdirSync(workspace, { recursive: true }); mkdirSync(configDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: workspace, timeout: 30_000 });
  const runtime = createRuntimeServices({
    modelDiscovery: 'skip', runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(),
    configManager: new ConfigManager({ surfaceRoot: 'agent', workingDir: workspace, homeDir: home, configDir }),
    workingDir: workspace, homeDirectory: home, getConversationTitle: () => 'read/settings acceptance',
  });
  runtimes.push(runtime);
  // Runtime construction owns the production installation; replace only its I/O.
  installJudgmentPort(recordedPort());
  runtime.configManager.set('permissions.mode', 'prompt');
  runtime.configManager.set('display.theme', 'vaporwave');
  let prompts = 0;
  runtime.permissionPromptRef.requestPermission = async () => { prompts++; throw new Error('No human semantic permission callback is allowed'); };
  const source = { goal: 'Read the scratch fixtures and apply the exact scratch setting requested by this test', criteria: ['Do not touch any real file, account or setting'] };
  const sourceOf = () => source;
  const registry = composeAgentToolRegistry({ services: runtime, configManager: runtime.configManager,
    homeDirectory: home, resolveSessionId: () => 'adoption-session', getLastUserMessage: () => source.goal }).toolRegistry;
  const manager = composeAgentPermissionManager(runtime);
  const deps: ToolExecutionDeps = { toolRegistry: registry, permissionManager: manager, autonomousSource: sourceOf,
    hookDispatcher: null, runtimeBus: null, sessionId: 'adoption-session',
    emitterContext: () => { throw new Error('No runtime emitter is used by this fixture'); } };
  let sequence = 0;
  const run = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const result = (await executeToolCalls(deps, `turn-${++sequence}`, [{ id: `call-${sequence}`, name, arguments: args }]))[0];
    if (!result) throw new Error('Composed execution returned no result');
    return result;
  };
  const write = (path: string, body = 'SYNTHETIC ORDINARY FILE') => writeFileSync(join(workspace, path), body);
  const prepare = async (id: string, name: string, args: Record<string, unknown>) => {
    await manager.prepareAutonomousOwner();
    const owner = manager.autonomousPreparation(id, sourceOf);
    return registry.prepareCall(id, name, args, { port: owner.port, assertCurrent: owner.assertCurrent });
  };
  return { runtime, registry, manager, deps, run, write, workspace, source, sourceOf, prepare, prompts: () => prompts };
}

const read = (path: string) => ({ files: [{ path }] });
const setting = (value = 'nord') => ({ mode: 'set', key: 'display.theme', value, confirm: true });

test('immediate first Agent turn awaits owner readiness and reads once with a recorded act', async () => {
  const f = fixture(); f.write('ordinary.txt'); reportsMutation = false;
  const result = await f.run('read', read('ordinary.txt'));
  expect(result.success).toBe(true); expect(result.output).toContain('SYNTHETIC ORDINARY FILE');
  expect(result.autonomousDecision?.outcome).toBe('act'); expect(readBodies).toBe(1); expect(f.prompts()).toBe(0);
});

test('recorded act reads a harmless hidden fixture without the obsolete name veto', async () => {
  const f = fixture(); f.write('.ordinary-note'); reportsMutation = false;
  const result = await f.run('read', read('.ordinary-note'));
  expect(result.autonomousDecision?.outcome).toBe('act');
  expect(result.success).toBe(true); expect(result.output).toContain('SYNTHETIC ORDINARY FILE'); expect(readBodies).toBe(1);
});

test('read evidence identifies each path before the common admission', async () => {
  const f = fixture(); f.write('one.txt'); f.write('two.txt'); reportsMutation = false;
  const result = await f.run('read', { files: [{ path: 'one.txt' }, { path: 'two.txt' }] });
  expect(result.success).toBe(true);
  const admissionIndex = requests.findIndex(request => 'disposition' in request.questions);
  const pathReads = requests.slice(0, admissionIndex).filter(request => 'secrets' in request.questions);
  for (const path of ['one.txt', 'two.txt']) {
    const other = path === 'one.txt' ? 'two.txt' : 'one.txt';
    expect(pathReads.some(request => JSON.stringify(request.state).includes(path) && !JSON.stringify(request.state).includes(other))).toBe(true);
  }
});

test.each(['reject', 'defer_0'] as const)('control: authoritative %s yields zero read bodies', async outcome => {
  const f = fixture(); f.write('ordinary.txt'); selected = outcome;
  const readResult = await f.run('read', read('ordinary.txt'));
  expect(readResult.success).toBe(false);
  expect(readBodies).toBe(0); expect(f.prompts()).toBe(0);
});

test('target contract: unadmitted direct Agent read cannot reach the backend', async () => {
  const f = fixture(); f.write('ordinary.txt');
  const result = await f.registry.execute('direct-read', 'read', read('ordinary.txt'));
  expect(result.success).toBe(false); expect(readBodies).toBe(0);
});

test('target contract: a genuine admission for another prepared read cannot authorize this read', async () => {
  const f = fixture(); f.write('one.txt'); f.write('two.txt'); reportsMutation = false;
  const first = await f.prepare('first', 'read', read('one.txt'));
  const second = await f.prepare('second', 'read', read('two.txt'));
  const admitted = await f.manager.admitAutonomous('first', first.name, first.args, { sourceOf: f.sourceOf,
    schemaRevision: first.schemaRevision, preparationDecisionIds: first.judgmentDecisionIds,
    assertPrepared: () => f.registry.assertPrepared(first), preparedCall: { registry: f.registry, call: first } });
  expect(admitted.result.approved).toBe(true);
  await f.registry.executePrepared(second, admitted).catch(() => undefined);
  expect(readBodies).toBe(0);
});

test('authority change-and-restore during the final hook invalidates the old admission', async () => {
  const f = fixture(); f.write('ordinary.txt'); reportsMutation = false;
  f.deps.hookDispatcher = { fire: async () => {
    f.runtime.configManager.set('permissions.mode', 'plan');
    f.runtime.configManager.set('permissions.mode', 'prompt');
    return { ok: true, decision: 'allow' };
  } };
  const result = await f.run('read', read('ordinary.txt'));
  expect(result.success).toBe(false); expect(readBodies).toBe(0);
});

test('control: genuine prepared execution is one-shot', async () => {
  const f = fixture(); f.write('ordinary.txt'); reportsMutation = false;
  const prepared = await f.prepare('once', 'read', read('ordinary.txt'));
  const admitted = await f.manager.admitAutonomous('once', prepared.name, prepared.args, { sourceOf: f.sourceOf,
    schemaRevision: prepared.schemaRevision, preparationDecisionIds: prepared.judgmentDecisionIds,
    assertPrepared: () => f.registry.assertPrepared(prepared), preparedCall: { registry: f.registry, call: prepared } });
  expect((await f.registry.executePrepared(prepared, admitted)).success).toBe(true);
  await expect(f.registry.executePrepared(prepared, admitted)).rejects.toBeDefined();
  expect(readBodies).toBe(1);
});

test('control: declared read batch limit still prevents backend execution', async () => {
  const f = fixture(); reportsMutation = false;
  await f.run('read', { files: Array.from({ length: 11 }, (_, index) => ({ path: `ordinary-${index}.txt` })) }).catch(() => undefined);
  expect(readBodies).toBe(0); expect(f.prompts()).toBe(0);
});

test.each(['yes', 'uncertain'] as const)('a %s secrets observation cannot act beyond the declared non-secret read surface', async evidence => {
  const f = fixture(); f.write('ordinary-report.txt', 'SYNTHETIC CLASSIFICATION FIXTURE'); reportsMutation = false; secrets = evidence;
  const result = await f.run('read', read('ordinary-report.txt'));
  expect(result.success).toBe(false); expect(readBodies).toBe(0); expect(result.output).toBeUndefined(); expect(f.prompts()).toBe(0);
});

test('recorded act can read ordinary notes in a platform-looking directory without a second intent guess', async () => {
  const f = fixture(); reportsMutation = false;
  mkdirSync(join(f.workspace, 'goodvibes-notes'));
  f.write('goodvibes-notes/travel.txt', 'SYNTHETIC TRAVEL NOTES');
  f.source.goal = 'Read my synthetic travel notes';
  const result = await f.run('read', read('goodvibes-notes/travel.txt'));
  expect(result.autonomousDecision?.outcome).toBe('act');
  expect(result.success).toBe(true); expect(result.output).toContain('SYNTHETIC TRAVEL NOTES'); expect(readBodies).toBe(1);
});

test('platform source requested in the original host goal is admitted once', async () => {
  const f = fixture(); f.write('source.ts', 'export const fixture = true;'); reportsMutation = false;
  platform = 'yes'; platformRequested = 'yes'; f.source.goal = 'Investigate the implementation failure in the assistant source';
  const result = await f.run('read', read('source.ts'));
  expect(result.success).toBe(true); expect(readBodies).toBe(1); expect(f.prompts()).toBe(0);
  const scopes = requests.filter(request => 'platform_requested' in request.questions);
  expect(scopes).toHaveLength(1); expect(JSON.stringify(scopes[0]?.state)).toContain(f.source.goal);
  expect(requests.at(-1)?.questions).toHaveProperty('disposition');
});

test.each(['no', 'uncertain'] as const)('platform source with %s requested-scope evidence cannot act', async request => {
  const f = fixture(); f.write('source.ts'); reportsMutation = false; platform = 'yes'; platformRequested = request;
  f.source.goal = 'Log into my email account';
  const result = await f.run('read', read('source.ts'));
  expect(result.success).toBe(false); expect(readBodies).toBe(0); expect(f.prompts()).toBe(0);
});

test('uncertain platform identity cannot expand unrelated task scope', async () => {
  const f = fixture(); f.write('source.ts'); reportsMutation = false; platform = 'uncertain';
  const result = await f.run('read', read('source.ts'));
  expect(result.success).toBe(false); expect(readBodies).toBe(0);
});

test.each(['revoke', 'cancel', 'replace-file'] as const)('read %s after an extraction await withholds its output', async change => {
  const f = fixture(); f.write('source.ts', 'export const PRIVATE_FIXTURE = true;'); reportsMutation = false;
  const abort = new AbortController(); f.deps.turnSignal = abort.signal; let reached = false;
  const extraction = spyOn(CodeIntelligence.prototype, 'getOutline').mockImplementation(async () => {
    reached = true; await Promise.resolve();
    if (change === 'revoke') f.runtime.configManager.set('permissions.mode', 'plan');
    else if (change === 'cancel') abort.abort();
    else f.write('source.ts', 'export const REPLACED_FIXTURE = true;');
    return [];
  });
  restoreOthers.push(() => extraction.mockRestore());
  const result = await f.run('read', { files: [{ path: 'source.ts', extract: 'outline' }] }).catch(() => undefined);
  expect(reached).toBe(true); expect(result?.success ?? false).toBe(false);
  expect(JSON.stringify(result ?? {})).not.toContain('PRIVATE_FIXTURE'); expect(f.prompts()).toBe(0);
});

test('a first turn cancelled while the actual rule owner initializes performs no judgment or read', async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const pending: Promise<void>[] = [];
  const originalInit = UserPermissionRuleStore.prototype.init;
  const init = spyOn(UserPermissionRuleStore.prototype, 'init').mockImplementation(function (this: UserPermissionRuleStore) {
    const operation = waiting.then(() => originalInit.call(this)); pending.push(operation); return operation;
  });
  restoreOthers.push(() => init.mockRestore());
  const f = fixture(); f.write('ordinary.txt'); reportsMutation = false;
  const abort = new AbortController(); f.deps.turnSignal = abort.signal;
  const operation = f.run('read', read('ordinary.txt')).catch(() => undefined);
  try {
    await Promise.resolve();
    expect(requests).toHaveLength(0); expect(readBodies).toBe(0);
    abort.abort(); await operation;
    expect(requests).toHaveLength(0); expect(readBodies).toBe(0); expect(f.prompts()).toBe(0);
  } finally {
    release(); await Promise.all(pending);
  }
});

test.each(['arguments', 'source'] as const)('protected %s are held before any read evidence leaves the process', async location => {
  const f = fixture(); f.write('ordinary.txt'); reportsMutation = false;
  if (location === 'source') f.source.goal = 'Read this using password=synthetic-private';
  const args = location === 'arguments' ? read('password=synthetic-private') : read('ordinary.txt');
  await f.run('read', args).catch(() => undefined);
  expect(requests).toHaveLength(0); expect(readBodies).toBe(0); expect(f.prompts()).toBe(0);
});

test('changed original source while path evidence is pending cannot execute', async () => {
  const f = fixture(); f.write('ordinary.txt'); reportsMutation = false;
  beforeAnswer = request => {
    if ('platform_source' in request.questions) f.source.goal = 'A different current task';
  };
  await f.run('read', read('ordinary.txt')).catch(() => undefined);
  expect(readBodies).toBe(0); expect(f.prompts()).toBe(0);
});

test.each(['secret', 'platform'] as const)('an innocent in-root alias cannot hide its canonical %s subject', async kind => {
  const f = fixture(); reportsMutation = false;
  const target = kind === 'secret' ? '.env' : 'platform-implementation.ts';
  f.write(target, 'SYNTHETIC TARGET ONLY');
  symlinkSync(target, join(f.workspace, 'innocent-alias.txt'));
  (kind === 'secret' ? secretTargets : platformTargets).add(join(f.workspace, target));
  const result = await f.run('read', read('innocent-alias.txt'));
  expect(result.success).toBe(false); expect(readBodies).toBe(0); expect(result.output).toBeUndefined();
  expect(requests.some(request => JSON.stringify(request.state).includes(join(f.workspace, target)))).toBe(true);
});

test('a requested platform read through an alias records the actual target and can act', async () => {
  const f = fixture(); reportsMutation = false; platformRequested = 'yes';
  f.write('platform-implementation.ts', 'SYNTHETIC PLATFORM SOURCE');
  symlinkSync('platform-implementation.ts', join(f.workspace, 'alias.txt'));
  platformTargets.add(join(f.workspace, 'platform-implementation.ts'));
  f.source.goal = 'Read the platform implementation reached by alias.txt';
  const result = await f.run('read', read('alias.txt'));
  expect(result.success).toBe(true); expect(readBodies).toBe(1);
  expect(requests.some(request => JSON.stringify(request.state).includes(join(f.workspace, 'platform-implementation.ts')))).toBe(true);
});

test('an alias outside the admitted project is refused before semantic evidence or bytes', async () => {
  const f = fixture(); reportsMutation = false;
  const outside = join(f.workspace, '..', 'outside-fixture.txt');
  writeFileSync(outside, 'SYNTHETIC OUTSIDE PROJECT'); symlinkSync(outside, join(f.workspace, 'alias.txt'));
  await f.run('read', read('alias.txt')).catch(() => undefined);
  expect(readBodies).toBe(0); expect(requests).toHaveLength(0);
});

test('the actual Agent registry rejects a different genuine manager for the same prepared handle', async () => {
  const f = fixture(); reportsMutation = false; f.write('ordinary.txt');
  const prepared = await f.prepare('wrong-owner', 'read', read('ordinary.txt'));
  const foreign = new PermissionManager(undefined, createPermissionConfigReader(f.runtime.configManager), new PolicyRuntimeState());
  const admission = await foreign.admitAutonomous('wrong-owner', prepared.name, prepared.args, {
    sourceOf: f.sourceOf, schemaRevision: prepared.schemaRevision,
    preparationDecisionIds: prepared.judgmentDecisionIds,
    assertPrepared: () => f.registry.assertPrepared(prepared), preparedCall: { registry: f.registry, call: prepared },
  });
  expect(admission.result.autonomousDecision?.outcome).toBe('act');
  await expect(f.registry.executePrepared(prepared, admission)).rejects.toThrow();
  expect(readBodies).toBe(0); expect(f.prompts()).toBe(0);
});

test('read explanation states pending admission and checks only mechanical shape', () => {
  const valid = explainAgentToolPolicyInvocation('read', read('ordinary.txt'));
  expect(valid.status).toBe('allowed'); expect(valid.reason).toContain('requires a current bound admission');
  expect(valid.reason).toContain('no execution authority');
  expect(explainAgentToolPolicyInvocation('read', { files: Array.from({ length: 11 }, () => ({ path: 'ordinary.txt' })) }).status).toBe('denied');
  expect(requests).toHaveLength(0); expect(readBodies).toBe(0);
});
