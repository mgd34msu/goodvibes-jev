/**
 * PARKED SETTINGS ACCEPTANCE: intentionally outside *.test.ts discovery.
 * This executable specification is still red. Settings admission/effect-owner
 * adoption is separate from the approved READ-only slice. Do not count this
 * file as passed or delete these obligations when qualifying the read slice.
 * The original red suite is preserved in commit 5e1e6090.
 */
/**
 * Actual Agent composition acceptance for the bounded read/goodvibes_settings
 * adoption. These are intentionally red on ca12: only the judgment I/O is
 * synthetic; registration, policies, preparation, admission and backends are
 * production code. All reads and writes are confined to each scratch runtime.
 * Preferred settings/agent_harness and live semantic calibration are separate.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
import { RuntimeEventBus } from '@/runtime/index.ts';
import { composeAgentToolRegistry } from '../../runtime/agent-tool-registry.ts';
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

beforeEach(() => {
  requests = []; selected = 'act'; reportsMutation = true; secrets = 'no'; platform = 'no'; platformRequested = 'no'; beforeAnswer = undefined; readBodies = 0;
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
  const scripted = fakePort((name, question) => {
    if (name === 'disposition' && question.type === 'choice') {
      const choice = selected === 'act' && !Object.hasOwn(question.criteria, 'act') ? 'reject' : selected;
      return choiceAnswer(question, choice, 0.999);
    }
    if (name === 'hazard') return choiceAnswer(question, 'approval-gate', 0.999);
    if (name === 'family' || name === 'capability') return choiceAnswer(question, 'generic', 0.999);
    if (name === 'kind') return choiceAnswer(question, 'read', 0.999);
    if (name === 'secrets') return noulAnswer(secrets === 'yes' ? 0.999 : secrets === 'uncertain' ? 0.5 : 0.001);
    if (name === 'platform_source') return noulAnswer(platform === 'yes' ? 0.999 : platform === 'uncertain' ? 0.5 : 0.001);
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
  const prepare = (id: string, name: string, args: Record<string, unknown>) => {
    const owner = manager.autonomousPreparation(id, sourceOf);
    return registry.prepareCall(id, name, args, { port: owner.port, assertCurrent: owner.assertCurrent });
  };
  return { runtime, registry, manager, deps, run, write, workspace, source, sourceOf, prepare, prompts: () => prompts };
}

const read = (path: string) => ({ files: [{ path }] });
const setting = (value = 'nord') => ({ mode: 'set', key: 'display.theme', value, confirm: true });

test('recorded settings act is not vetoed by missing caller-authored request prose', async () => {
  const f = fixture();
  f.source.goal = 'Revoke unattended read capability by setting permissions.tools.read to deny in the scratch config';
  const result = await f.run('goodvibes_settings', { mode: 'set', key: 'permissions.tools.read', value: 'deny', confirm: true });
  expect(result.autonomousDecision?.outcome).toBe('act'); expect(result.success).toBe(true);
  expect(f.runtime.configManager.get('permissions.tools.read')).toBe('deny'); expect(f.prompts()).toBe(0);
  expect(requests.filter(request => 'hazard' in request.questions)).toHaveLength(1);
});

test.each(['reject', 'defer_0'] as const)('control: authoritative %s yields zero read bodies and settings writes', async outcome => {
  const f = fixture(); f.write('ordinary.txt'); selected = outcome;
  const readResult = await f.run('read', read('ordinary.txt'));
  const settingsResult = await f.run('goodvibes_settings', { ...setting(), explicitUserRequest: 'unrelated words' });
  expect(readResult.success).toBe(false); expect(settingsResult.success).toBe(false);
  expect(readBodies).toBe(0); expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave'); expect(f.prompts()).toBe(0);
});

test.each(['set', 'reset'] as const)('known settings %s cannot write in plan mode even when supporting mutation evidence is wrong', async mode => {
  const f = fixture(); f.runtime.configManager.set('permissions.mode', 'plan'); reportsMutation = false;
  const result = await f.run('goodvibes_settings', { ...setting(), mode });
  expect(result.success).toBe(false); expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
});

test('target contract: unadmitted direct Agent settings cannot write', async () => {
  const f = fixture();
  const result = await f.registry.execute('direct-settings', 'goodvibes_settings', setting());
  expect(result.success).toBe(false); expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
});

test('target contract: a forged prepared claim callback cannot authorize an Agent settings write', async () => {
  const f = fixture(); const prepared = await f.prepare('forged', 'goodvibes_settings', setting());
  await f.registry.executePrepared(prepared, () => {}).catch(() => undefined);
  expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
});

test('settings revoke after the backend await prevents persistence', async () => {
  const f = fixture(); let reached = false;
  beforeAnswer = request => {
    if ('credential_material' in request.questions && !reached) {
      reached = true; f.runtime.configManager.set('permissions.mode', 'plan');
    }
  };
  await f.run('goodvibes_settings', setting()).catch(() => undefined);
  expect(reached).toBe(true); expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
});

test('settings cancellation after the backend await prevents persistence', async () => {
  const f = fixture(); const abort = new AbortController(); f.deps.turnSignal = abort.signal; let reached = false;
  beforeAnswer = request => {
    if ('credential_material' in request.questions && !reached) { reached = true; abort.abort(); }
  };
  await f.run('goodvibes_settings', setting()).catch(() => undefined);
  expect(reached).toBe(true); expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
});

test('control: unavailable admission stays effect-free and cancellation does not prompt', async () => {
  const f = fixture(); const abort = new AbortController(); f.deps.turnSignal = abort.signal;
  let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  beforeAnswer = async request => {
    if ('disposition' in request.questions) { started(); await blocked; }
  };
  const operation = f.run('goodvibes_settings', setting()).catch(() => undefined);
  await waiting;
  expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave'); expect(f.prompts()).toBe(0);
  abort.abort(); release(); await operation;
  expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave'); expect(f.prompts()).toBe(0);
});

test('control: goodvibes_settings has no valid read mode or get-side mutation', async () => {
  const f = fixture();
  await f.run('goodvibes_settings', { mode: 'get', key: 'display.theme', confirm: true }).catch(() => undefined);
  expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave'); expect(f.prompts()).toBe(0);
});

test.each(['set', 'reset'] as const)('declared settings %s cannot gain command authority from a false semantic read', async mode => {
  const f = fixture(); reportsMutation = false;
  const result = await withTurnSurface({ surface: 'email' }, () => f.run('goodvibes_settings', { ...setting(), mode }));
  expect(result.success).toBe(false); expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
});
