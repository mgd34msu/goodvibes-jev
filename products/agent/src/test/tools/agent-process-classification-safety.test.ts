import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { afterAll, afterEach, beforeEach, describe, spyOn, expect, test } from 'bun:test';
import { gateJudgmentRegistry } from '@goodvibes-jev/engine/sdk/platform/gate';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolRegistry, ProcessManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { runBackgroundProcessAction } from '../../tools/agent-harness-background-processes.ts';
import { createAgentHarnessTool, registerAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { processClassificationOptions } from '../../tools/agent-harness-process-launch.ts';
import { resolveBackgroundProcessClass } from '../../tools/agent-harness-process-timeout-policy.ts';
import { createAgentProcessTool, createAgentTerminalTool, registerAgentTerminalProcessTools } from '../../tools/agent-terminal-process-tools.ts';
import { ordinaryResearchOwner, researchScreeningFixture, cleanupResearchScreeningFixtures, exactSensitiveSpans } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);
const configRoots: string[] = [];
function fixturePlatform() {
  const root = makeProjectTempDir('harness-config-owner');
  configRoots.push(root);
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: join(root, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: root,
    homeDir: root,
  });
  return { config: configManager.getAll(), configManager };
}
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => {
  installJudgmentPort(previous);
  for (const root of configRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const start = { command: 'env firefox', processAction: 'start', confirm: true, explicitUserRequest: 'Open the browser.', timeoutMs: 120_000 };
function fixture(owner = ordinaryResearchOwner()) {
  const calls: unknown[][] = [];
  const manager = { async spawn(...args: unknown[]) { calls.push(args); return { process_id: 'fixture-process', pid: 123 }; } } as unknown as ProcessManager;
  const context = { platform: fixturePlatform(), workspace: { processManager: manager }, session: { runtime: { sessionId: 'original' } }, extensions: {}, clients: {} } as CommandContext;
  const registry = new ToolRegistry(); bindAgentResearchSourceOwner(registry, owner);
  return { context, registry, calls, manager, options: (signal?: AbortSignal) => processClassificationOptions(context, registry, signal) };
}
function reading(p = 0.99) { const fake = fakePort(() => noulAnswer(p)); installJudgmentPort(fake.port); return fake; }
function latch() {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = new Promise<void>(resolve => { started = resolve; });
  return { release, started, gate, first };
}

describe('protected process lifetime classification', () => {
  test('all three real callers await the same protected reading before spawn', async () => {
    for (const name of ['terminal', 'process', 'agent_harness'] as const) {
      const f = fixture(); const fake = reading(); const pending = latch();
      installJudgmentPort({ ...fake.port, async ask(request) { pending.started(); await pending.gate; return fake.port.ask(request); } });
      const tool = name === 'terminal' ? createAgentTerminalTool(f.context, f.registry)
        : name === 'process' ? createAgentProcessTool(f.context, f.registry)
        : createAgentHarnessTool({ commandContext: f.context, commandRegistry: new CommandRegistry(), toolRegistry: f.registry });
      const result = tool.execute({ ...start, background: true, action: 'start', mode: 'run_background_process' });
      await pending.first; expect(f.calls).toEqual([]); pending.release();
      const value = await result;
      expect(value.success).toBe(true);
      expect(JSON.parse(value.output!)).toMatchObject({ status: 'started', processClass: 'long_lived', killOnTimeout: false });
      expect(f.calls).toEqual([['env firefox', undefined, undefined, { timeout_ms: 120_000, sigterm_grace_ms: 5000, kill_on_timeout: false, signal: undefined, assertCurrent: expect.any(Function) }]]);
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]?.context?.battery).toBe('agent.tools.long-lived-process');
    }
  });

  test('ordinary reading preserves timeout termination and explicit kill overrides', async () => {
    const f = fixture(); reading(0.01);
    await runBackgroundProcessAction(f.context, { ...start, command: 'grep -r firefox /etc' }, f.options());
    expect(f.calls[0]?.[3]).toMatchObject({ kill_on_timeout: true });
    reading(0.99);
    await runBackgroundProcessAction(f.context, { ...start, killOnTimeout: true }, f.options());
    expect(f.calls[1]?.[3]).toMatchObject({ kill_on_timeout: true });
  });

  test('explicit classes launch without a classification owner or hosted reading', async () => {
    const f = fixture();
    for (const processClass of ['command', 'long_lived']) {
      const result = await runBackgroundProcessAction(f.context, { ...start, processClass });
      expect(result.processClass).toBe(processClass);
    }
    expect(f.calls).toHaveLength(2);
  });

  test('complete command is screened, and only its projection reaches the hosted port and logs', async () => {
    const privateText = 'synthetic-private-contact';
    const local = researchScreeningFixture({ spans: exactSensitiveSpans([privateText]) });
    const f = fixture(local.owner); const fake = fakePort(() => noulAnswer(0.99));
    const log = new SqliteDecisionLog(':memory:'); installJudgmentPort(withDecisionLog(fake.port, log));
    const command = 'env firefox ' + 'x'.repeat(1200) + privateText;
    try {
      await runBackgroundProcessAction(f.context, { ...start, command }, f.options());
      expect(JSON.stringify(local.calls)).toContain(command);
      expect(JSON.stringify(fake.requests)).not.toContain(privateText);
      expect(JSON.stringify(fake.requests)).toContain('[redacted]');
      expect(JSON.stringify(log.query())).not.toContain(privateText);
      expect(log.query()).toHaveLength(1);
      expect(f.calls[0]?.[0]).toBe(command);
    } finally { log[Symbol.dispose](); }
  });

  test('literal credentials anywhere in the command are held before either service', async () => {
    const local = researchScreeningFixture(); const f = fixture(local.owner); const fake = reading();
    await expect(runBackgroundProcessAction(f.context, { ...start, command: 'env firefox ' + 'x'.repeat(1200) + ' Authorization: Bearer synthetic-credential' }, f.options())).rejects.toThrow();
    expect(local.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });

  test('missing owner, unsettled screening, missing port, malformed answer and uncertain answer never spawn', async () => {
    const noOwner = fixture(); const fake = reading();
    await expect(runBackgroundProcessAction(noOwner.context, start)).rejects.toThrow();
    expect(fake.requests).toHaveLength(0); expect(noOwner.calls).toHaveLength(0);
    const local = researchScreeningFixture({ complete: 0.5 }); const held = fixture(local.owner);
    await expect(runBackgroundProcessAction(held.context, start, held.options())).rejects.toThrow();
    expect(fake.requests).toHaveLength(0); expect(held.calls).toHaveLength(0);
    for (const response of ['missing', 'malformed', 'uncertain', 'failure']) {
      const f = fixture();
      installJudgmentPort(response === 'missing' ? undefined : response === 'failure'
        ? { model: 'jev-1.13.0', ask: async () => { throw new Error('synthetic unavailable'); } }
        : fakePort(() => response === 'malformed' ? { type: 'noul', noul: 'yes' } : noulAnswer(0.5)).port);
      await expect(runBackgroundProcessAction(f.context, start, f.options())).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    }
  });

  test('cancellation during local screening never contacts the classifier', async () => {
    const pending = latch(); const local = researchScreeningFixture({ beforeProposal: async () => { pending.started(); await pending.gate; } });
    const f = fixture(local.owner); const fake = reading(); const controller = new AbortController();
    const result = runBackgroundProcessAction(f.context, start, f.options(controller.signal));
    await pending.first; controller.abort(); pending.release();
    await expect(result).rejects.toThrow(); expect(fake.requests).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });

  for (const change of ['abort', 'owner-revoked', 'owner-replaced', 'port-replaced', 'ask-replaced', 'session', 'manager'] as const) {
    test(`a pending reading cannot spawn after ${change}`, async () => {
      const local = researchScreeningFixture(); const f = fixture(local.owner); const fake = reading();
      const pending = latch(), controller = new AbortController();
      const port: typeof fake.port = { ...fake.port, async ask(request) { pending.started(); await pending.gate; return fake.port.ask(request); } };
      installJudgmentPort(port);
      const result = runBackgroundProcessAction(f.context, start, f.options(controller.signal));
      await pending.first;
      if (change === 'abort') controller.abort();
      if (change === 'owner-revoked') local.lifetime.abort();
      if (change === 'owner-replaced') bindAgentResearchSourceOwner(f.registry, ordinaryResearchOwner());
      if (change === 'port-replaced') installJudgmentPort(fake.port);
      if (change === 'ask-replaced') port.ask = fake.port.ask;
      if (change === 'session') (f.context.session.runtime as { sessionId: string }).sessionId = 'new';
      if (change === 'manager') (f.context.workspace as { processManager?: ProcessManager }).processManager = fixture().manager;
      pending.release(); await expect(result).rejects.toThrow(); expect(f.calls).toHaveLength(0);
    });
  }

  test('retry and log guards remain current while awaiting a port result', async () => {
    for (const fence of ['beforeAttempt', 'assertLogCurrent'] as const) {
      const f = fixture(); const fake = reading(); let checked = false;
      installJudgmentPort({ ...fake.port, async ask(request) {
        expect(typeof request[fence]).toBe('function');
        request[fence]!();
        (f.context.session.runtime as { sessionId: string }).sessionId = 'new';
        expect(() => request[fence]!()).toThrow(); checked = true;
        return fake.port.ask(request);
      } });
      await expect(runBackgroundProcessAction(f.context, start, f.options())).rejects.toThrow();
      expect(checked).toBe(true); expect(f.calls).toHaveLength(0);
    }
  });

  test('a cancelled response cannot be persisted by the decision log', async () => {
    const f = fixture(), pending = latch(), controller = new AbortController(); const fake = reading();
    const log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog({ ...fake.port, async ask(request) { pending.started(); await pending.gate; return fake.port.ask(request); } }, log));
    try {
      const result = runBackgroundProcessAction(f.context, start, f.options(controller.signal));
      await pending.first; controller.abort(); pending.release();
      await expect(result).rejects.toThrow(); expect(log.query()).toHaveLength(0); expect(f.calls).toHaveLength(0);
    } finally { log[Symbol.dispose](); }
  });

  test('snapshot isolates command, timeout and kill overrides from mid-reading mutation', async () => {
    const f = fixture(), pending = latch(); const fake = reading();
    installJudgmentPort({ ...fake.port, async ask(request) { pending.started(); await pending.gate; return fake.port.ask(request); } });
    const args = { ...start, killOnTimeout: false };
    const result = runBackgroundProcessAction(f.context, args, f.options());
    await pending.first; args.command = 'different command'; args.killOnTimeout = true; args.timeoutMs = 1000; pending.release(); await result;
    expect(f.calls).toEqual([['env firefox', undefined, undefined, { timeout_ms: 120_000, sigterm_grace_ms: 5000, kill_on_timeout: false, signal: undefined, assertCurrent: expect.any(Function) }]]);
  });

  test('accessors are not evaluated by the classification source capture', async () => {
    const fake = reading(); let accessed = 0;
    await expect(resolveBackgroundProcessClass({ get processClass() { accessed++; return 'command'; } }, 'firefox', { sourceOwner: ordinaryResearchOwner() })).rejects.toThrow();
    expect(accessed).toBe(0); expect(fake.requests).toHaveLength(0);
  });

  for (const name of ['terminal', 'process', 'agent_harness'] as const) {
    test(`${name} registered ingress protects commands before generic readers and repair`, async () => {
      const sensitive = 'synthetic-private-contact';
      const local = researchScreeningFixture({ spans: exactSensitiveSpans([sensitive]) });
      const f = fixture(local.owner); const fake = reading();
      if (name === 'agent_harness') registerAgentHarnessTool(f.registry, new CommandRegistry(), f.context);
      else registerAgentTerminalProcessTools(f.registry, f.context);
      const args = { ...start, background: true, mode: 'run_background_process', command: `env firefox ${sensitive}` };
      await expect(f.registry.projectCall('private', name, args)).rejects.toThrow();
      expect(fake.requests).toHaveLength(0); expect(f.calls).toHaveLength(0);
      const projected = await f.registry.projectCall('clear', name, { ...args, command: 'env firefox' });
      f.registry.assertProjected(projected);
      local.lifetime.abort(); expect(() => f.registry.assertProjected(projected)).toThrow();
      await f.registry.releaseProjected(projected);
    });
  }

  test('non-start process and harness status remain usable without a source owner or port', async () => {
    const f = fixture(); const registry = new ToolRegistry();
    registerAgentHarnessTool(registry, new CommandRegistry(), f.context); registerAgentTerminalProcessTools(registry, f.context);
    for (const [name, args] of [['process', { action: 'capabilities' }], ['agent_harness', { mode: 'run_background_process', processAction: 'capabilities' }]] as const) {
      const projected = await registry.projectCall('status', name, args);
      registry.assertProjected(projected); await registry.releaseProjected(projected);
    }
  });
  test('held sources cannot reach the registry or inspect the hosted binding', async () => {
    const getter = spyOn(gateJudgmentRegistry, 'get');
    const fake = fakePort(() => noulAnswer(0.99)); let modelReads = 0;
    Object.defineProperty(fake.port, 'model', { get() { modelReads++; return 'jev-1.13.0'; } });
    installJudgmentPort(fake.port);
    try {
      for (const command of ['env firefox', 'env firefox Authorization: Bearer synthetic-credential']) {
        const local = researchScreeningFixture({ complete: 0.5 });
        await expect(resolveBackgroundProcessClass({}, command, { sourceOwner: local.owner })).rejects.toThrow();
      }
      expect(getter).not.toHaveBeenCalled(); expect(modelReads).toBe(0); expect(fake.requests).toHaveLength(0);
    } finally { getter.mockRestore(); }
  });

  for (const name of ['terminal', 'process', 'agent_harness'] as const) for (const change of ['permission', 'registration'] as const) {
    test(`${name} authentic admission stays current during a pending reading: ${change}`, async () => {
      const f = fixture(), pending = latch(); let revision = 0;
      const config = {
        getAutonomousSnapshot: () => ({ permissions: { mode: revision ? 'allow-all' : 'prompt', tools: {} }, autoApprove: false, directory: '/synthetic/project', incarnation: revision }),
        isAutoApproveEnabled: () => false, getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }), getWorkingDirectory: () => '/synthetic/project',
      } as PermissionConfigReader;
      const manager = new PermissionManager(undefined, config, new PolicyRuntimeState());
      const registry = new ToolRegistry(manager); bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
      if (name === 'agent_harness') registerAgentHarnessTool(registry, new CommandRegistry(), f.context);
      else registerAgentTerminalProcessTools(registry, f.context);
      const fake = fakePort((questionName, question) => question.type === 'noul'
        ? noulAnswer(questionName === 'long_lived' || questionName === 'mutates' ? 0.99 : 0.01)
        : choiceAnswer(question, questionName === 'disposition' ? 'act' : questionName === 'family' || questionName === 'capability' ? 'generic' : questionName === 'hazard' ? 'none' : 'other', 0.99));
      using log = new SqliteDecisionLog(':memory:');
      installJudgmentPort(withDecisionLog({ ...fake.port, async ask(request) {
        if (request.context?.battery === 'agent.tools.long-lived-process') { pending.started(); await pending.gate; }
        return fake.port.ask(request);
      } }, log));
      const args = name === 'terminal' ? { command: start.command, background: true, confirm: true, explicitUserRequest: start.explicitUserRequest }
        : name === 'process' ? { command: start.command, action: 'start', confirm: true, explicitUserRequest: start.explicitUserRequest }
        : { ...start, mode: 'run_background_process' };
      const call = await registry.prepareCall('admitted', name, args);
      const admission = await manager.admitAutonomous('admitted', name, call.args, {
        sourceOf: () => ({ goal: 'Open the synthetic browser', criteria: [] }), schemaRevision: call.schemaRevision, preparedCall: { registry, call },
      });
      const result = registry.executePrepared(call, admission);
      await pending.first;
      if (change === 'permission') revision++;
      else registry.unregister(name);
      pending.release();
      await expect(result).rejects.toThrow(); expect(f.calls).toHaveLength(0);
    });
  }

  for (const change of ['abort', 'session', 'owner-revoked'] as const) {
    test(`the real ProcessManager fences ${change} during environment screening`, async () => {
      const local = researchScreeningFixture(); const f = fixture(local.owner), pending = latch();
      const manager = new ProcessManager(); (f.context.workspace as { processManager?: ProcessManager }).processManager = manager;
      const controller = new AbortController();
      const key = `JEV_PROCESS_LIFETIME_${change.replaceAll('-', '_').toUpperCase()}`;
      const previous = process.env[key]; process.env[key] = 'synthetic';
      const fake = fakePort((name) => noulAnswer(name === 'long_lived' ? 0.99 : 0.01));
      installJudgmentPort({ ...fake.port, async ask(request) {
        if ((request.state as { name?: string }).name === key) { pending.started(); await pending.gate; }
        return fake.port.ask(request);
      } });
      const launches = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('Unexpected synthetic launch'); });
      try {
        const result = runBackgroundProcessAction(f.context, start, f.options(controller.signal));
        const settled = result.then(() => undefined, (error: unknown) => error);
        await pending.first;
        if (change === 'abort') controller.abort(new Error('synthetic cancellation'));
        if (change === 'session') (f.context.session.runtime as { sessionId: string }).sessionId = 'new';
        if (change === 'owner-revoked') local.lifetime.abort();
        pending.release(); expect(await settled).toBeInstanceOf(Error);
        await manager.close(); expect(launches).not.toHaveBeenCalled(); expect(manager.list()).toEqual([]);
      } finally {
        pending.release(); await manager.close(); launches.mockRestore();
        if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
      }
    });
  }

  test('authentic terminal permission revocation during the real environment scrub prevents Bun.spawn', async () => {
    const f = fixture(), pending = latch(); let revision = 0;
    const processManager = new ProcessManager(); (f.context.workspace as { processManager?: ProcessManager }).processManager = processManager;
    const key = 'JEV_PROCESS_LIFETIME_PERMISSION'; const previous = process.env[key]; process.env[key] = 'synthetic';
    const config = {
      getAutonomousSnapshot: () => ({ permissions: { mode: revision ? 'allow-all' : 'prompt', tools: {} }, autoApprove: false, directory: '/synthetic/project', incarnation: revision }),
      isAutoApproveEnabled: () => false, getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }), getWorkingDirectory: () => '/synthetic/project',
    } as PermissionConfigReader;
    const permissions = new PermissionManager(undefined, config, new PolicyRuntimeState());
    const registry = new ToolRegistry(permissions); bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
    registerAgentTerminalProcessTools(registry, f.context);
    const fake = fakePort((name, question) => question.type === 'noul' ? noulAnswer(name === 'long_lived' || name === 'mutates' ? 0.99 : 0.01)
      : choiceAnswer(question, name === 'disposition' ? 'act' : name === 'family' || name === 'capability' ? 'generic' : name === 'hazard' ? 'none' : 'other', 0.99));
    using log = new SqliteDecisionLog(':memory:');
    installJudgmentPort(withDecisionLog({ ...fake.port, async ask(request) {
      if ((request.state as { name?: string }).name === key) { pending.started(); await pending.gate; }
      return fake.port.ask(request);
    } }, log));
    const launches = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('Unexpected synthetic launch'); });
    try {
      const call = await registry.prepareCall('admitted-real', 'terminal', { command: start.command, background: true, confirm: true, explicitUserRequest: start.explicitUserRequest });
      const admission = await permissions.admitAutonomous('admitted-real', 'terminal', call.args, {
        sourceOf: () => ({ goal: 'Open the synthetic browser', criteria: [] }), schemaRevision: call.schemaRevision, preparedCall: { registry, call },
      });
      const result = registry.executePrepared(call, admission); const settled = result.then(() => undefined, (error: unknown) => error);
      await pending.first; revision++; pending.release();
      expect(await settled).toBeInstanceOf(Error); await processManager.close();
      expect(launches).not.toHaveBeenCalled(); expect(processManager.list()).toEqual([]);
    } finally {
      pending.release(); await processManager.close(); launches.mockRestore();
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  });

});
