/** Offline regression of the exact permission composition used by bootstrap. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { executeToolCalls, type ToolExecutionDeps } from '@goodvibes-jev/engine/sdk/platform/core';
import { TurnHookOwner } from '@goodvibes-jev/engine/sdk/platform/hooks';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { PermissionManager, PermissionCheckResult, PermissionExecutionOptions } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { JudgmentError, SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { composeAgentPermissionManager } from '../../runtime/bootstrap-core.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { installPermissionManagerSafetyGuard } from '../../runtime/tool-permission-safety.ts';
import { installPermissionManagerSafetyGuard as sharedGuard } from '@goodvibes-jev/engine/sdk/platform/gate/policy';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const runtimes: RuntimeServices[] = [];
const logs: SqliteDecisionLog[] = [];
let previous = installJudgmentPort(undefined);
afterEach(async () => {
  for (const services of runtimes.splice(0)) {
    await services.processManager.close();
    services.dispose();
  }
  for (const log of logs.splice(0)) log[Symbol.dispose]();
  installJudgmentPort(previous);
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function runtime() {
  previous = installJudgmentPort(undefined);
  const root = makeProjectTempDir('agent-shared-permission-');
  const workspace = join(root, 'workspace');
  const homeDir = join(root, 'home');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  const services = createRuntimeServices({
    modelDiscovery: 'skip', workingDir: workspace, homeDirectory: homeDir,
    configManager: new ConfigManager({ surfaceRoot: 'agent', workingDir: workspace, homeDir, configDir: join(homeDir, 'config') }),
    runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), getConversationTitle: () => 'offline permission fixture',
  });
  runtimes.push(services);
  services.configManager.set('permissions.mode', 'allow-all');
  installJudgmentPort(undefined); // Never use the graph's production provider.
  return services;
}
function pipeline(services: RuntimeServices, signal?: AbortSignal) {
  const executed: unknown[] = [];
  const registry = new ToolRegistry();
  for (const name of ['read', 'fetch']) registry.register({
    definition: { name, description: 'Nonexecuting fixture', parameters: { type: 'object', additionalProperties: true } },
    execute: async (args) => { executed.push(args); return { success: true, output: 'fixture' }; },
  });
  const deps: ToolExecutionDeps = {
    autonomousSource: () => ({ goal: 'Read the synthetic fixture through the Agent permission pipeline', criteria: ['Execute only the requested fixture action'] }),
    toolRegistry: registry, permissionManager: composeAgentPermissionManager(services),
    turnSignal: signal, runtimeBus: null, hookDispatcher: null, sessionId: 'fixture',
    emitterContext: () => { throw new Error('No event emitter in fixture'); },
  };
  return { executed, run: (name: string, args: Record<string, unknown> = {}) => executeToolCalls(deps, 'fixture-turn', [{ id: 'fixture-call', name, arguments: args }]) };
}
const allowed: PermissionCheckResult = {
  approved: true, persisted: false, sourceLayer: 'config_policy', reasonCode: 'config_allow',
  analysis: { classification: 'generic', riskLevel: 'low', summary: 'typed fixture', reasons: [] },
};

/** Replace only external judgment I/O; real preparation, constraints and admission remain live. */
function record(port: JudgmentPort) {
  const log = new SqliteDecisionLog(':memory:'); logs.push(log);
  installJudgmentPort(withDecisionLog(port, log));
  return log;
}
function approvalReadings() {
  return fakePort((name, question) => {
    if (name === 'disposition') return choiceAnswer(question, 'act', 0.99);
    if (name === 'kind') return choiceAnswer(question, 'read', 0.99);
    if (name === 'family') return choiceAnswer(question, 'generic', 0.99);
    if (['secrets', 'mutates', 'outward', 'irreversible', 'beyondProject', 'weakensSecurity', 'obfuscated', 'catastrophic', 'cardDetails'].includes(name)) return noulAnswer(0.001);
    throw new Error(`Unscripted question: ${name}`);
  });
}

describe('Agent adopts the shared permission gate without alternate authority', () => {
  test('the compatibility path is the exact shared implementation and bootstrap uses its composition', () => {
    expect(installPermissionManagerSafetyGuard).toBe(sharedGuard);
    const source = readFileSync(new URL('../../runtime/bootstrap-core.ts', import.meta.url), 'utf8');
    expect(source).toContain('const permissionManager = composeAgentPermissionManager(services)');
    expect(source).not.toContain("from './tool-permission-safety.ts'");
  });

  for (const tool of ['read', 'fetch']) {
    for (const failure of ['unavailable', 'throwing'] as const) test(`${tool}: ${failure} authoritative check never admits a fake action`, async () => {
      const services = runtime();
      const error = failure === 'unavailable' ? new JudgmentError('unavailable', 'fixture unavailable') : new Error('fixture manager failed');
      const log = record({ model: 'jev-1.13.0', ask: async () => { throw error; } });
      const gate = pipeline(services);
      await expect(gate.run(tool)).rejects.toMatchObject({ kind: 'unavailable' });
      expect(log.query({}).every(entry => entry.status === 'failed')).toBe(true);
      expect(log.query({}).length).toBeGreaterThan(0);
      expect(gate.executed).toHaveLength(0);
    });
  }

  test('missing judgment in the real graph manager never approves a read', async () => {
    const services = runtime();
    const gate = pipeline(services);
    await expect(gate.run('read', { path: 'fixture.txt' })).rejects.toThrow();
    expect(gate.executed).toHaveLength(0);
  });

  for (const method of ['check', 'checkDetailed'] as const) {
    test(`${method}: full execution options, attribution, and immutable arguments reach the authoritative check`, async () => {
      const args = Object.freeze({ nested: Object.freeze({ path: 'fixture.txt' }) });
      const attribution = { kind: 'background-agent', agentId: 'fixture', template: 'reader' } as const;
      const controller = new AbortController();
      const hookOwner = new TurnHookOwner('fixture', 'turn', controller.signal);
      const options: PermissionExecutionOptions & { fixtureOption: string } = { signal: controller.signal, hookOwner, fixtureOption: 'preserved' };
      let received: unknown[] = [];
      const manager: Pick<PermissionManager, 'check' | 'checkDetailed' | 'getCategory'> = {
        async check(...input) { received = input; return true; },
        async checkDetailed(...input) { received = input; return allowed; },
        getCategory: () => 'read',
      };
      sharedGuard(manager);
      const result = await manager[method]('read', args, attribution, options);
      expect(received[1]).toBe(args);
      expect(received[2]).toBe(attribution);
      expect(received[3]).toEqual(options);
      expect(result).toBe(method === 'check' ? true : allowed);
      await hookOwner.closeAndDrain();
    });
  }

  for (const method of ['check', 'checkDetailed'] as const) {
    for (const failure of ['unavailable', 'throwing'] as const) test(`${method}: the retained guard propagates the exact ${failure} authority failure`, async () => {
      const error = failure === 'unavailable' ? new JudgmentError('unavailable', 'fixture unavailable') : new Error('fixture manager failed');
      const manager: Pick<PermissionManager, 'check' | 'checkDetailed' | 'getCategory'> = {
        check: async () => { throw error; },
        checkDetailed: async () => { throw error; },
        getCategory: () => 'read',
      };
      sharedGuard(manager);
      await expect(manager[method]('read', {})).rejects.toBe(error);
    });
  }

  test('revocation reported by the authority while awaiting is never fallback-approved', async () => {
    const services = runtime();
    const entered = deferred();
    const release = deferred();
    const answers = approvalReadings();
    record({ model: answers.port.model, async ask(request) {
      if ('disposition' in request.questions) { entered.resolve(); await release.promise; }
      return answers.port.ask(request);
    } });
    const gate = pipeline(services);
    const outcome = gate.run('read').catch((error: unknown) => error);
    await entered.promise;
    services.configManager.set('permissions.mode', 'plan');
    release.resolve();
    expect(await outcome).toMatchObject({ message: 'Autonomous admission authority, source or scope changed' });
    expect(gate.executed).toHaveLength(0);
  });

  test('cancellation releases a non-cooperative pending check and discards its late approval', async () => {
    const services = runtime();
    const entered = deferred();
    const release = deferred();
    const answers = approvalReadings();
    const log = record({ model: answers.port.model, async ask(request) {
      if ('disposition' in request.questions) { entered.resolve(); await release.promise; }
      return answers.port.ask(request);
    } });
    const controller = new AbortController();
    const gate = pipeline(services, controller.signal);
    const outcome = gate.run('fetch').catch((error: unknown) => error);
    await entered.promise; controller.abort('private reason');
    try {
      expect(await Promise.race([outcome, Bun.sleep(1_000).then(() => 'pending after cancellation')])).toMatchObject({ name: 'JudgmentError', kind: 'aborted' });
      expect(gate.executed).toHaveLength(0);
    } finally { release.resolve(); await outcome; }
    await Bun.sleep(0);
    expect(gate.executed).toHaveLength(0);
    expect(log.query({ site: 'engine.gate.autonomous-tool' })).toMatchObject([{ status: 'failed' }]);
  });

  test('failed real judgment retains failure provenance without a fabricated permission decision', async () => {
    const services = runtime();
    const log = new SqliteDecisionLog(':memory:'); logs.push(log);
    installJudgmentPort(withDecisionLog({
      model: 'jev-1.13.0',
      ask: async () => { throw new JudgmentError('unavailable', 'fixture unavailable'); },
    }, log));
    const gate = pipeline(services);
    await expect(gate.run('read', { path: 'fixture.txt' })).rejects.toMatchObject({ kind: 'unavailable' });
    expect(gate.executed).toHaveLength(0);
    const entries = log.query({});
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.status === 'failed')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('config_allow');
    expect(JSON.stringify(entries)).not.toContain('tool-permission-safety');
  });

  test('real typed Jev approval executes only the fake action and retains decision-log provenance', async () => {
    const services = runtime();
    const answers = approvalReadings();
    const log = record(answers.port);
    const gate = pipeline(services);
    const args = Object.freeze({ path: 'fixture.txt' });
    expect((await gate.run('read', args))[0]?.success).toBe(true);
    expect(gate.executed).toEqual([args]);
    expect(answers.requests.find(request => request.context?.site === 'engine.gate.autonomous-tool')?.state).toMatchObject({ input: { source: { goal: 'Read the synthetic fixture through the Agent permission pipeline', criteria: ['Execute only the requested fixture action'] } } });
    const entries = log.query({});
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).toContain('engine.gate');
    expect(JSON.stringify(entries)).not.toContain('permission-manager-exception');
    expect(JSON.stringify(entries)).not.toContain('tool-permission-safety');
  });
});
