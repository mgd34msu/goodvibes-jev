import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { ToolRegistry, assertCurrentToolExecution } from '@goodvibes-jev/engine/sdk/platform/tools';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { createAgentHarnessTool, registerAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { createAgentHostTool, registerAgentHostTool } from '../../tools/agent-host-tool.ts';
import { createAgentWorkspaceTool, registerAgentWorkspaceTool } from '../../tools/agent-workspace-tool.ts';
import { searchHarnessModelTools } from '../../tools/agent-harness-model-tool-catalog.ts';
import { rankHarnessCatalog } from '../../tools/agent-harness-catalog-ranking.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures, researchScreeningFixture, exactSensitiveSpans } from '../helpers/research-screening.ts';

type ToolExecuteOptions = NonNullable<Parameters<Tool['execute']>[1]>;

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function readings(fits: Readonly<Record<string, number>>) {
  return fakePort((name, question, state) => {
    if (name === 'match') return noulAnswer(fits[(state as unknown as { candidate: { name: string } }).candidate.name] ?? 0.01);
    if (question.type === 'choice') return choiceAnswer(question, name === 'disposition' ? 'act' : name === 'kind' ? 'read' : name === 'hazard' ? 'none' : 'generic', 0.999);
    return noulAnswer(0.001);
  });
}

function fixture(owner = ordinaryResearchOwner(), registry = new ToolRegistry()) {
  bindAgentResearchSourceOwner(registry, owner);
  const commands = new CommandRegistry();
  const executed: string[] = [];
  commands.register({ name: 'search_inbox', description: 'email inbox search', handler: () => { executed.push('search_inbox'); } });
  commands.register({ name: 'opaque_operation', description: 'An unrelated operation selected by recorded judgment.', handler: () => { executed.push('opaque_operation'); } });
  for (const name of ['search_inbox', 'opaque_operation']) registry.register({ definition: {
    name, description: name === 'search_inbox' ? 'email inbox search' : 'A recorded alternative', parameters: { type: 'object', properties: {} },
  }, execute: async () => ({ success: true }) });
  const context = { extensions: {}, clients: {}, workspace: {}, platform: { config: {} }, ops: {}, session: { runtime: { sessionId: 'catalog-session' } } } as unknown as CommandContext;
  const deps = { commandRegistry: commands, toolRegistry: registry, commandContext: context };
  return { registry, commands, context, executed, harness: createAgentHarnessTool(deps), host: createAgentHostTool(deps), workspace: createAgentWorkspaceTool(deps) };
}
const body = (result: { output?: unknown }) => JSON.parse(String(result.output));

function suspended() {
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { start, release, started, gate };
}

describe('P11 actual catalog consumers', () => {
  test('tool and slash catalogs preserve counter-lexical ranking and explicit bounds', async () => {
    const f = fixture(); const fake = readings({ opaque_operation: 0.98, search_inbox: 0.85 }); installJudgmentPort(fake.port);
    for (const [tool, args, field, id] of [
      [f.harness, { mode: 'tools', query: 'search inbox', limit: 1 }, 'tools', 'name'],
      [f.workspace, { action: 'commands', query: 'search inbox', limit: 1 }, 'commands', 'name'],
    ] as const) {
      const output = body(await tool.execute(args));
      expect(output[field]).toHaveLength(1); expect(output[field][0][id]).toBe('opaque_operation');
      expect(output[field][0].judgment.reading.verdict).toBe('yes'); expect(output.queryMatch).toBeUndefined();
    }
    expect(fake.requests.every(request => request.context?.battery === 'engine.tools.registry-rank')).toBe(true);
    expect(f.executed).toEqual([]);
  });

  test('mode and actual host method discovery use the canonical winner, including beyond the former full-source cap', async () => {
    const f = fixture(); const fake = readings({ background_processes: 0.98, 'services.status': 0.98 }); installJudgmentPort(fake.port);
    const modes = body(await f.harness.execute({ mode: 'modes', query: 'email inbox calendar', limit: 1 }));
    expect(modes.modes[0].id).toBe('background_processes');
    const methods = body(await f.host.execute({ action: 'methods', query: 'email inbox calendar', limit: 1 }));
    expect(methods.methods[0].id).toBe('services.status');
    expect(methods.total).toBeGreaterThan(400);
    expect(fake.requests.filter(request => request.context?.site === 'agent.harness.operator-methods').length).toBe(methods.total);
  });

  test('one uncertain detail remains ambiguous and no negative result guesses a lexical fallback', async () => {
    const f = fixture();
    for (const probability of [0.5, 0.01]) {
      installJudgmentPort(readings({ search_inbox: probability }).port);
      const result = await f.workspace.execute({ action: 'run_command', query: 'search inbox', confirm: true, explicitUserRequest: 'Run the selected command' });
      expect(result.success).toBe(false); expect(f.executed).toEqual([]);
      const tools = body(await f.harness.execute({ mode: 'tools', query: 'search inbox' }));
      expect(tools.tools).toHaveLength(probability === 0.5 ? 1 : 0);
    }
  });

  test('a sole yes discovers a command but only a separately named invocation executes', async () => {
    const f = fixture(); installJudgmentPort(readings({ opaque_operation: 0.99 }).port);
    const result = await f.workspace.execute({ action: 'run_command', query: 'search inbox', confirm: true, explicitUserRequest: 'Run the selected command' });
    expect(body(result)).toMatchObject({ status: 'selection_required', reason: 'exact_command_identity_required', candidates: [{ commandName: 'opaque_operation' }] });
    expect(f.executed).toEqual([]);
    const exact = await f.workspace.execute({ action: 'run_command', commandName: 'opaque_operation', confirm: true, explicitUserRequest: 'Run opaque_operation' });
    expect(exact.success).toBe(true); expect(f.executed).toEqual(['opaque_operation']);
  });

  test('explicit identities and no-query catalogs stay deterministic without an owner or judgment', async () => {
    const f = fixture(); const unbound = new ToolRegistry();
    const harness = createAgentHarnessTool({ commandRegistry: f.commands, commandContext: f.context, toolRegistry: unbound });
    expect(body(await harness.execute({ mode: 'commands' })).commands).toHaveLength(2);
    expect(body(await harness.execute({ mode: 'command', commandName: 'OPAQUE_OPERATION' })).name).toBe('opaque_operation');
    expect((await harness.execute({ mode: 'command', commandName: 'opaque' })).success).toBe(false);
  });

  test('missing or failing hosted readers remain failures at actual callers', async () => {
    const f = fixture();
    await expect(f.workspace.execute({ action: 'commands', query: 'search inbox' })).rejects.toBeInstanceOf(JudgmentPortMissingError);
    installJudgmentPort({ model: 'fixture', ask: async () => { throw new Error('synthetic reader unavailable'); } });
    await expect(f.harness.execute({ mode: 'tools', query: 'search inbox' })).rejects.toThrow('synthetic reader unavailable');
  });

  test.each(['harness', 'host', 'workspace'] as const)('%s protects full original nonprojected invocation fields before any hosted reader', async kind => {
    const sensitive = 'synthetic-private-contact';
    const screening = researchScreeningFixture({ spans: exactSensitiveSpans([sensitive]) });
    const f = fixture(screening.owner); const fake = readings({ opaque_operation: 0.99 }); installJudgmentPort(fake.port);
    const args = kind === 'harness' ? { mode: 'tools', query: 'search inbox', privateNote: sensitive }
      : { action: kind === 'host' ? 'methods' : 'commands', query: 'search inbox', privateNote: sensitive };
    await expect(f[kind].execute(args)).rejects.toThrow();
    expect(JSON.stringify(screening.calls)).toContain(sensitive); expect(fake.requests).toHaveLength(0);
    const before = screening.calls.length;
    await expect(f[kind].execute({ ...args, privateNote: 'Authorization: Bearer synthetic-credential' })).rejects.toThrow();
    expect(screening.calls).toHaveLength(before); expect(fake.requests).toHaveLength(0);
  });

  test('redacted full schema source holds output instead of returning private fields beyond the 600-character ranking projection', async () => {
    const sensitive = 'synthetic-private-schema';
    const screening = researchScreeningFixture({ spans: exactSensitiveSpans([sensitive]) });
    const f = fixture(screening.owner);
    f.registry.register({ definition: { name: 'private_schema', description: 'x'.repeat(700), parameters: { type: 'object', properties: { note: { type: 'string', description: sensitive } } } }, execute: async () => ({ success: true }) });
    const fake = readings({ private_schema: 0.99 }); installJudgmentPort(fake.port);
    await expect(f.harness.execute({ mode: 'tools', query: 'search inbox', includeParameters: true })).rejects.toThrow();
    expect(JSON.stringify(screening.calls)).toContain(sensitive); expect(fake.requests).toHaveLength(0);
  });

  test.each(['cancel', 'session', 'owner', 'tool-registration', 'command-registration'] as const)('awaited catalog reading rejects %s loss before result/effect', async change => {
    const f = fixture(); const wait = suspended(); const controller = new AbortController();
    const fake = readings({ opaque_operation: 0.99 }); const signals: unknown[] = [];
    installJudgmentPort({ ...fake.port, ask: async request => { signals.push(request.signal); wait.start(); await wait.gate; return fake.port.ask(request); } });
    const pending = f.workspace.execute({ action: 'run_command', query: 'search inbox', confirm: true, explicitUserRequest: 'Run it' }, { signal: controller.signal });
    await wait.started;
    if (change === 'cancel') controller.abort(new Error('catalog cancelled'));
    if (change === 'session') f.context.session!.runtime.sessionId = 'different';
    if (change === 'owner') bindAgentResearchSourceOwner(f.registry, researchScreeningFixture().owner);
    if (change === 'tool-registration') f.registry.register({ definition: { name: 'workspace', description: 'replacement', parameters: { type: 'object' } }, execute: async () => ({ success: true }) });
    if (change === 'command-registration') f.commands.unregister('opaque_operation');
    wait.release(); await expect(pending).rejects.toThrow();
    expect(signals.every(signal => signal === controller.signal)).toBe(true); expect(f.executed).toEqual([]);
  });

  test.each(['agent_harness', 'host', 'workspace'] as const)('%s registered ingress preserves registration guards across the real rewritten caller', async name => {
    const f = fixture();
    if (name === 'agent_harness') registerAgentHarnessTool(f.registry, f.commands, f.context);
    if (name === 'host') registerAgentHostTool(f.registry, f.commands, f.context);
    if (name === 'workspace') registerAgentWorkspaceTool(f.registry, f.commands, f.context);
    const wait = suspended(); const fake = readings({ opaque_operation: 0.99, 'services.status': 0.99 });
    installJudgmentPort({ ...fake.port, ask: async request => {
      if (request.context?.battery === 'engine.tools.registry-rank') { wait.start(); await wait.gate; }
      return fake.port.ask(request);
    } });
    const args = name === 'agent_harness' ? { mode: 'tools', query: 'search inbox' } : { action: name === 'host' ? 'methods' : 'commands', query: 'search inbox' };
    const pending = f.registry.execute('registered-catalog', name, args);
    await wait.started; f.registry.unregister(name); wait.release();
    await expect(pending).rejects.toThrow(); expect(f.executed).toEqual([]);
  });

  test('malformed catalog objects reject before description access, local screening, or hosted port lookup', async () => {
    const screening = researchScreeningFixture(); let touched = 0;
    for (const entry of [
      { id: 'one', get description() { touched++; return 'private'; } },
      new Proxy({ id: 'one', description: 'private' }, { ownKeys() { touched++; return []; } }),
    ]) await expect(rankHarnessCatalog([entry], 'query', value => value, 'agent.harness.tools', { sourceOwner: screening.owner })).rejects.toThrow();
    expect(touched).toBe(0); expect(screening.calls).toHaveLength(0);
  });
});

for (const name of ['host', 'workspace'] as const) test(`${name} retains authentic original admission through rewritten args and fences policy revocation`, async () => {
  let revoked = false;
  const reader = {
    getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: revoked, directory: '/synthetic/catalog' }),
    isAutoApproveEnabled: () => revoked, getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }), getWorkingDirectory: () => '/synthetic/catalog',
  } as PermissionConfigReader;
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const f = fixture(ordinaryResearchOwner(), new ToolRegistry(manager));
  if (name === 'host') registerAgentHostTool(f.registry, f.commands, f.context);
  else registerAgentWorkspaceTool(f.registry, f.commands, f.context);
  const tool = f.registry.list().find(tool => tool.definition.name === name)!;
  const execute = tool.execute;
  let originalOptions: ToolExecuteOptions | undefined;
  let originalArgs: Record<string, unknown> | undefined;
  tool.execute = async (args, options) => {
    originalOptions = options; originalArgs = args;
    expect(assertCurrentToolExecution(args, options)).toBe(true);
    return execute(args, options);
  };
  const fake = readings({ opaque_operation: 0.99, 'services.status': 0.99 });
  const wait = suspended();
  using log = new SqliteDecisionLog(':memory:');
  installJudgmentPort(withDecisionLog({ ...fake.port, ask: async request => {
    if (request.context?.battery === 'engine.tools.registry-rank') {
      expect(assertCurrentToolExecution(originalArgs!, originalOptions)).toBe(true);
      wait.start(); await wait.gate;
    }
    return fake.port.ask(request);
  } }, log));
  const args = { action: name === 'host' ? 'methods' : 'commands', query: 'search inbox' };
  const call = await f.registry.prepareCall('authentic-catalog', name, args);
  const admission = await manager.admitAutonomous(call.callId, name, call.args, {
    sourceOf: () => ({ goal: 'Inspect the synthetic catalog', criteria: ['Read only synthetic data'] }),
    schemaRevision: call.schemaRevision, preparedCall: { registry: f.registry, call },
  });
  expect(admission.result.approved).toBe(true);
  const pending = f.registry.executePrepared(call, admission);
  await wait.started; revoked = true; wait.release();
  await expect(pending).rejects.toThrow(); expect(f.executed).toEqual([]);
});

for (const changed of ['cancel', 'session', 'source-owner'] as const) test(`full original screening fences ${changed} before any catalog port access`, async () => {
  const wait = suspended();
  const screening = researchScreeningFixture({ beforeProposal: async () => { wait.start(); await wait.gate; } });
  const f = fixture(screening.owner); const fake = readings({ opaque_operation: 0.99 }); installJudgmentPort(fake.port);
  const controller = new AbortController();
  const pending = f.workspace.execute({ action: 'commands', query: 'search inbox' }, { signal: controller.signal });
  await wait.started;
  if (changed === 'cancel') controller.abort();
  if (changed === 'session') f.context.session!.runtime.sessionId = 'replaced';
  if (changed === 'source-owner') bindAgentResearchSourceOwner(f.registry, researchScreeningFixture().owner);
  wait.release(); await expect(pending).rejects.toThrow(); expect(fake.requests).toHaveLength(0);
});

test('malformed hosted judgment never becomes a lexical selection or command effect', async () => {
  const f = fixture();
  installJudgmentPort({ model: 'fixture', ask: async () => ({ answers: {} }) as never });
  await expect(f.workspace.execute({ action: 'run_command', query: 'search inbox', confirm: true, explicitUserRequest: 'Run it' })).rejects.toThrow();
  expect(f.executed).toEqual([]);
});

for (const kind of ['harness', 'host', 'workspace'] as const) test(`${kind} rejects inherited catalog routing without reading getters or contacting either service`, async () => {
  const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings({ opaque_operation: 0.99 }); installJudgmentPort(fake.port);
  let touched = 0;
  const inherited = { get query() { touched++; return 'search inbox'; } };
  const routing = kind === 'harness' ? { mode: 'tools' } : { action: kind === 'host' ? 'methods' : 'commands' };
  const args = Object.assign(Object.create(inherited), routing, { privateNote: 'Authorization: Bearer synthetic-credential' });
  await expect(f[kind].execute(args)).rejects.toThrow();
  expect(touched).toBe(0); expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
});

test('exact command resolution fences same-object handler replacement across its async boundary', async () => {
  const f = fixture(); let replaced = 0;
  const command = f.commands.get('opaque_operation')!;
  const pending = f.workspace.execute({ action: 'run_command', commandName: command.name, confirm: true, explicitUserRequest: 'Run opaque_operation' });
  command.handler = () => { replaced++; };
  await expect(pending).rejects.toThrow(); expect(replaced).toBe(0); expect(f.executed).toEqual([]);
});

test('a cancelled command cannot dispatch a nested effect through the adapter-owned context', async () => {
  const f = fixture(); const wait = suspended(); const controller = new AbortController();
  f.commands.register({ name: 'parent', description: 'Synthetic parent', handler: async (_args, context) => {
    wait.start(); await wait.gate; await context.executeCommand!('opaque_operation', []);
  } });
  const pending = f.workspace.execute({ action: 'run_command', commandName: 'parent', confirm: true, explicitUserRequest: 'Run parent' }, { signal: controller.signal });
  await wait.started; controller.abort(); wait.release();
  await expect(pending).rejects.toThrow(); expect(f.executed).toEqual([]);
});

test.each(['commands', 'tools'] as const)('actual %s detail rejects replaced catalog getters before invoking them', async mode => {
  const screening = researchScreeningFixture(); const f = fixture(screening.owner); let accessed = 0;
  if (mode === 'commands') Object.defineProperty(f.commands.get('opaque_operation')!, 'name', { get() { accessed++; return 'opaque_operation'; } });
  else Object.defineProperty(f.registry.list()[0]!, 'definition', { get() { accessed++; return {}; } });
  const fake = readings({ opaque_operation: 0.99 }); installJudgmentPort(fake.port);
  await expect(f.harness.execute({ mode: mode === 'commands' ? 'command' : 'tool', query: 'search inbox' })).rejects.toThrow();
  expect(accessed).toBe(0); expect(fake.requests).toHaveLength(0);
});

test.each(['default', 'enum'] as const)('full declared credential schema %s is refused before local projection and hosted ranking', async field => {
  const screening = researchScreeningFixture(); const f = fixture(screening.owner); const fake = readings({ private_schema: 0.99 }); installJudgmentPort(fake.port);
  // A replaced definition simulates dynamic catalog metadata after registration;
  // ordinary registration itself correctly refuses this unsafe source.
  const tool = f.registry.list()[0]!;
  Object.defineProperty(tool.definition, 'parameters', { value: { type: 'object', properties: {
    password: { type: 'string', [field]: field === 'default' ? 'synthetic-inline-secret' : ['synthetic-inline-secret'] },
  } } });
  await expect(searchHarnessModelTools(f.registry, { query: 'search inbox', includeParameters: true }, { sourceOwner: screening.owner })).rejects.toThrow();
  expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
});

test('real large host catalog keeps canonical eight-request backpressure and cancels before queued pairs dispatch', async () => {
  let screeningActive = 0, maxScreeningActive = 0;
  const screening = researchScreeningFixture({ beforeProposal: async () => {
    screeningActive++; maxScreeningActive = Math.max(maxScreeningActive, screeningActive);
    await Promise.resolve(); screeningActive--;
  } });
  const f = fixture(screening.owner); const controller = new AbortController(); const wait = suspended();
  let active = 0, maxActive = 0, dispatched = 0;
  const fake = readings({ 'services.status': 0.99 });
  installJudgmentPort({ ...fake.port, ask: async request => {
    active++; dispatched++; maxActive = Math.max(maxActive, active);
    if (dispatched === 8) wait.start();
    try { await wait.gate; return await fake.port.ask(request); } finally { active--; }
  } });
  const pending = f.host.execute({ action: 'methods', query: 'search inbox', limit: 1 }, { signal: controller.signal });
  await wait.started;
  expect(dispatched).toBe(8); expect(maxActive).toBe(8); expect(maxScreeningActive).toBe(1);
  expect(screening.calls.filter(call => call.path === '/v1/chat/completions').length).toBeGreaterThanOrEqual(59);
  controller.abort(); wait.release(); await expect(pending).rejects.toThrow();
  expect(dispatched).toBe(8); expect(active).toBe(0);
});

test('aggregate structural capture is bounded across many individually small private DTOs', async () => {
  const screening = researchScreeningFixture(); const fake = readings({}); installJudgmentPort(fake.port);
  const entries = Array.from({ length: 500 }, (_, index) => ({ id: `entry-${index}`, description: 'ordinary', metadata: Array.from({ length: 300 }, () => null) }));
  await expect(rankHarnessCatalog(entries, 'query', ({ id, description }) => ({ id, description }), 'agent.harness.tools', { sourceOwner: screening.owner })).rejects.toThrow();
  expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
});

test('aggregate sparse-array allocation is bounded before private DTO copies', async () => {
  const screening = researchScreeningFixture(); const fake = readings({}); installJudgmentPort(fake.port);
  const entries = Array.from({ length: 6 }, (_, index) => ({ id: `entry-${index}`, description: 'ordinary', metadata: new Array(20_000) }));
  await expect(rankHarnessCatalog(entries, 'query', ({ id, description }) => ({ id, description }), 'agent.harness.tools', { sourceOwner: screening.owner })).rejects.toThrow();
  expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
});
