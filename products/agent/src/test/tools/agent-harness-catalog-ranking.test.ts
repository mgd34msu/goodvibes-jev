import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as operatorContracts from '@goodvibes-jev/engine/sdk/contracts';
import { judgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { ToolRegistry, assertCurrentToolExecution } from '@goodvibes-jev/engine/sdk/platform/tools';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { DEFAULT_CONFIG, type GoodVibesConfig } from '@goodvibes-jev/engine/sdk/platform/config';
import { ActivityLogger, fieldKind } from '@goodvibes-jev/engine/sdk/platform/utils';
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
import { captureCatalogSnapshotGuard, prepareHarnessCatalog, rankHarnessCatalog } from '../../tools/agent-harness-catalog-ranking.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../../tools/agent-harness-workspace-actions.ts';
import { contractMethodsForAutonomy, contractMethodsForLane } from '../../tools/agent-harness-personal-ops-discovery.ts';
import { captureModelReadingInput, captureModelReadingSnapshotGuard } from '../../tools/agent-harness-model-reading-source.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures, researchScreeningFixture, exactSensitiveSpans } from '../helpers/research-screening.ts';
import { createRequestCountDiagnostics } from '../helpers/judgment-request-count-diagnostics.ts';

type ToolExecuteOptions = NonNullable<Parameters<Tool['execute']>[1]>;
const requestDiagnostics = createRequestCountDiagnostics('agent-harness-catalog-ranking');
const installJudgmentPort = requestDiagnostics.installPort;

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
const metadataLoggers: ActivityLogger[] = [];
beforeEach(() => { requestDiagnostics.beginFixture(); previous = installJudgmentPort(undefined); });
afterEach(() => {
  for (const logger of metadataLoggers.splice(0)) logger.dispose();
  installJudgmentPort(previous);
  requestDiagnostics.endFixture();
});

function nativeMetadataReading() {
  const logger = new ActivityLogger();
  metadataLoggers.push(logger);
  logger.debug('Synthetic catalog metadata', { battery: 'Synthetic catalog operation' });
}

type ObservedRequest = ReturnType<typeof fakePort>['requests'][number];

/** Only the native reader's complete public field-name request is ancillary. */
function isMetadataPrivacyRequest(request: ObservedRequest): boolean {
  if (request.context?.battery !== fieldKind.name) return false;
  expect(request.model).toBe(fieldKind.model);
  expect(request.context).toEqual({ battery: fieldKind.name, batteryVersion: fieldKind.version,
    pattern: 'battery', site: fieldKind.name });
  expect(request.questions).toEqual({ kind: fieldKind.items.kind.question });
  expect(request.state).toEqual({ field: 'battery' });
  return true;
}

function operationRequests(requests: readonly ObservedRequest[]): ObservedRequest[] {
  return requests.filter(request => !isMetadataPrivacyRequest(request));
}

function readings(fits: Readonly<Record<string, number>>) {
  return requestDiagnostics.track(fakePort((name, question, state) => {
    if (name === 'match') return noulAnswer(fits[(state as unknown as { candidate: { name: string } }).candidate.name] ?? 0.01);
    if (question === fieldKind.items.kind.question) {
      expect(state).toEqual({ field: 'battery' });
      return choiceAnswer(question, 'other', 0.999);
    }
    if (question.type === 'choice') return choiceAnswer(question, name === 'disposition' ? 'act' : name === 'kind' ? 'read' : name === 'hazard' ? 'none' : 'generic', 0.999);
    return noulAnswer(0.001);
  }), 'readings');
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
function admittedFixture() {
  const directory = '/synthetic/admitted-catalog';
  const permissions = { ...DEFAULT_CONFIG.permissions, mode: 'prompt', tools: {} } satisfies GoodVibesConfig['permissions'];
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions, autoApprove: false, directory }),
    getSnapshot: () => ({ permissions }), isAutoApproveEnabled: () => false, getWorkingDirectory: () => directory,
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const f = fixture(ordinaryResearchOwner(), new ToolRegistry(manager));
  registerAgentWorkspaceTool(f.registry, f.commands, f.context);
  let sequence = 0;
  return { ...f, async runWorkspace(args: Record<string, unknown>, signal?: AbortSignal) {
    using log = new SqliteDecisionLog(':memory:');
    const prior = installJudgmentPort(withDecisionLog(judgmentPort('agent.test.catalog-admission'), log));
    try {
      const id = `admitted-catalog-${++sequence}`;
      const call = await f.registry.prepareCall(id, 'workspace', args, { signal });
      const admission = await manager.admitAutonomous(id, 'workspace', call.args, {
        sourceOf: () => ({ goal: 'Verify isolated slash command effects', criteria: ['Only execute registered synthetic command handlers'] }),
        signal, schemaRevision: call.schemaRevision, preparedCall: { registry: f.registry, call },
      });
      expect(admission.result.autonomousDecision?.outcome).toBe('act');
      return await f.registry.executePrepared(call, admission);
    } finally { installJudgmentPort(prior); }
  } };
}
const body = (result: { output?: unknown }) => JSON.parse(String(result.output));

function suspended() {
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { start, release, started, gate };
}

test('native metadata attribution retains unexpected questions and complete private payloads', async () => {
  const fake = readings({}), wait = suspended();
  installJudgmentPort({ ...fake.port, async ask(request) {
    const result = await fake.port.ask(request); wait.start(); return result;
  } });
  nativeMetadataReading(); await wait.started;
  const request = fake.requests[0];
  if (!request) throw new Error('The actual logger did not request field-name privacy.');
  expect(fake.requests).toHaveLength(1);
  expect(operationRequests(fake.requests)).toHaveLength(0);
  expect(() => operationRequests([{ ...request, state: { field: 'battery', unusedPrivatePayload: 'synthetic-private-payload' } }])).toThrow();
  expect(() => operationRequests([{ ...request, questions: { kind: { ...fieldKind.items.kind.question, instructions: 'Unrelated native question' } } }])).toThrow();
  expect(() => operationRequests([{ ...request, state: { field: 'unusedPrivateContext' } }])).toThrow();
  expect(operationRequests([{ ...request, context: { ...request.context, battery: 'unrelated-native-reader' } }])).toHaveLength(1);
});

test.each(['private-extra', 'accessor-extra', 'hidden-extra'] as const)('canonical catalog response admission refuses %s before publishing a match', async kind => {
  let touched = 0, published = 0;
  const fake = readings({ 'ordinary-entry': 0.99 });
  installJudgmentPort({ ...fake.port, ask: async request => {
    const result = await fake.port.ask(request);
    if (kind === 'private-extra') return { ...result, unused: { paymentCard: '4111111111111111' } };
    const borrowed = { ...result };
    Object.defineProperty(borrowed, 'unused', kind === 'accessor-extra'
      ? { enumerable: true, get() { touched++; return 'unused'; } }
      : { enumerable: false, value: 'hidden' });
    return borrowed;
  } });
  await expect(rankHarnessCatalog([{ id: 'ordinary-entry' }], 'ordinary', entry => ({ id: entry.id, description: 'Ordinary read-only entry' }),
    'agent.test.complete-response', { sourceOwner: ordinaryResearchOwner() }).then(result => { published++; return result; })).rejects.toThrow();
  expect(touched).toBe(0); expect(published).toBe(0); expect(fake.requests).toHaveLength(1);
});

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
    const catalogRequests = fake.requests.filter(request => request.context?.site === 'agent.harness.tools' || request.context?.site === 'agent.harness.commands');
    expect(catalogRequests.length).toBeGreaterThan(0);
    expect(catalogRequests.every(request => request.context?.battery === 'engine.tools.registry-rank')).toBe(true);
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
    const f = admittedFixture();
    for (const probability of [0.5, 0.01]) {
      installJudgmentPort(readings({ search_inbox: probability }).port);
      const result = await f.runWorkspace({ action: 'run_command', query: 'search inbox' });
      expect(result.success).toBe(false); expect(f.executed).toEqual([]);
      const tools = body(await f.harness.execute({ mode: 'tools', query: 'search inbox' }));
      expect(tools.tools).toHaveLength(probability === 0.5 ? 1 : 0);
    }
  });

  test('a sole yes discovers a command but only a separately named invocation executes', async () => {
    const f = admittedFixture(); installJudgmentPort(readings({ opaque_operation: 0.99 }).port);
    const result = await f.runWorkspace({ action: 'run_command', query: 'search inbox' });
    expect(body(result)).toMatchObject({ status: 'selection_required', reason: 'exact_command_identity_required', candidates: [{ commandName: 'opaque_operation' }] });
    expect(f.executed).toEqual([]);
    const exact = await f.runWorkspace({ action: 'run_command', commandName: 'opaque_operation' });
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

  test.each(['channel_draft_save', 'channel_draft_send', 'channel_routing_assign', 'channel_routing_remove'])('%s protects complete comms payload before registered repair or admission', async mode => {
    const privateText = 'synthetic-private-comms-payload';
    const screening = researchScreeningFixture({ spans: exactSensitiveSpans([privateText]) });
    const f = fixture(screening.owner); const fake = readings({}); installJudgmentPort(fake.port);
    nativeMetadataReading();
    registerAgentHarnessTool(f.registry, f.commands, f.context);
    await expect(f.registry.prepareCall(`private-comms-${mode}`, 'agent_harness', {
      mode, draftId: 'isolated-draft', channelProfile: 'isolated-profile', routeKey: 'isolated-route',
      body: 'Public draft', unusedPrivateContext: privateText, confirm: true, explicitUserRequest: 'Caller annotation',
    })).rejects.toThrow();
    expect(JSON.stringify(screening.calls)).toContain(privateText);
    expect(operationRequests(fake.requests)).toHaveLength(0);
    expect(JSON.stringify(fake.requests)).not.toContain(privateText); expect(f.executed).toEqual([]);
  });

  test('complete protected description and evidence reach the canonical catalog reader', async () => {
    const description = `${'context '.repeat(100)}the complete description tail`;
    const evidence = { schema: { note: `${'evidence '.repeat(100)}the complete evidence tail` } };
    const fake = readings({ full_context: 0.99 });
    installJudgmentPort(fake.port);
    const result = await rankHarnessCatalog([{ id: 'full_context', description, evidence }], 'find the matching capability', entry => entry,
      'agent.test.complete-catalog-context', { sourceOwner: ordinaryResearchOwner(), requirePreservedSource: true });
    expect(result.matches).toHaveLength(1);
    expect(fake.requests).toHaveLength(1);
    const wire: unknown = fake.requests[0]!.state;
    if (!wire || typeof wire !== 'object' || !('candidate' in wire)
      || !wire.candidate || typeof wire.candidate !== 'object' || !('description' in wire.candidate) || !('evidenceJson' in wire.candidate)) {
      throw new Error('Canonical catalog request lacks its protected candidate context.');
    }
    expect(wire.candidate.description).toBe(description);
    expect(wire.candidate.evidenceJson).toBe(JSON.stringify(evidence));
  });

  test('redacted full schema source holds output instead of returning private fields beyond a display preview', async () => {
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
    const fake = readings({ opaque_operation: 0.99 }); const signals: AbortSignal[] = [];
    installJudgmentPort({ ...fake.port, ask: async request => {
      if (request.context?.battery === 'engine.tools.registry-rank') {
        if (!(request.signal instanceof AbortSignal)) throw new Error('The canonical catalog request needs a live native signal');
        expect(request.signal.aborted).toBe(false);
        signals.push(request.signal); wait.start(); await wait.gate;
      }
      return fake.port.ask(request);
    } });
    const pending = f.workspace.execute({ action: 'run_command', query: 'search inbox', confirm: true, explicitUserRequest: 'Run it' }, { signal: controller.signal });
    await wait.started;
    expect(signals.length).toBeGreaterThan(0);
    if (change === 'cancel') {
      const reason = new Error('catalog cancelled'); controller.abort(reason);
      expect(signals.every(signal => signal.aborted && signal.reason === reason)).toBe(true);
    }
    if (change === 'session') f.context.session!.runtime.sessionId = 'different';
    if (change === 'owner') bindAgentResearchSourceOwner(f.registry, researchScreeningFixture().owner);
    if (change === 'tool-registration') f.registry.register({ definition: { name: 'workspace', description: 'replacement', parameters: { type: 'object' } }, execute: async () => ({ success: true }) });
    if (change === 'command-registration') f.commands.unregister('opaque_operation');
    wait.release(); await expect(pending).rejects.toThrow();
    expect(fake.requests.filter(request => request.context?.battery === 'engine.tools.registry-rank').length).toBeGreaterThan(0);
    expect(f.executed).toEqual([]);
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

test.each(['source', 'owner', 'cancel'] as const)('workspace action publication still holds a pending %s change before its readset joins the caller', async changed => {
  const f = fixture(), ordinary = readings({}), wait = suspended(), controller = new AbortController();
  const category = AGENT_WORKSPACE_CATEGORIES[0], session = f.context.session!.runtime, sessionId = session.sessionId;
  if (!category) throw new Error('Missing native workspace fixture');
  installJudgmentPort({ model: ordinary.port.model, async ask(request) {
    if (request.context?.site === 'agent.workspace.actions') { wait.start(); await wait.gate; }
    return ordinary.port.ask(request);
  } });
  const pending = f.harness.execute({ mode: 'workspace_actions', categoryId: category.id, query: 'Inspect the authored workspace action' }, { signal: controller.signal });
  try {
    await wait.started;
    if (changed === 'source') session.sessionId = 'Changed native workspace session';
    if (changed === 'owner') bindAgentResearchSourceOwner(f.registry, researchScreeningFixture().owner);
    if (changed === 'cancel') controller.abort();
    wait.release(); await expect(pending).rejects.toThrow(); expect(f.executed).toEqual([]);
  } finally { wait.release(); session.sessionId = sessionId; }
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
  const f = admittedFixture(); const wait = suspended(); const controller = new AbortController();
  installJudgmentPort(readings({}).port);
  f.commands.register({ name: 'parent', description: 'Synthetic parent', handler: async (_args, context) => {
    wait.start(); await wait.gate; await context.executeCommand!('opaque_operation', []);
  } });
  const pending = f.runWorkspace({ action: 'run_command', commandName: 'parent' }, controller.signal);
  await wait.started; controller.abort(); wait.release();
  await expect(pending).rejects.toThrow(); expect(f.executed).toEqual([]);
});

test.each(['commands', 'tools'] as const)('actual %s detail rejects replaced catalog getters before invoking them', async mode => {
  const screening = researchScreeningFixture(); const f = fixture(screening.owner); let accessed = 0;
  if (mode === 'commands') Object.defineProperty(f.commands.get('opaque_operation')!, 'name', { get() { accessed++; return 'opaque_operation'; } });
  else Object.defineProperty(f.registry.list()[0]!, 'definition', { get() { accessed++; return {}; } });
  const fake = readings({ opaque_operation: 0.99 }); installJudgmentPort(fake.port);
  nativeMetadataReading();
  await expect(f.harness.execute({ mode: mode === 'commands' ? 'command' : 'tool', query: 'search inbox' })).rejects.toThrow();
  expect(accessed).toBe(0); expect(operationRequests(fake.requests)).toHaveLength(0);
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
    if (isMetadataPrivacyRequest(request)) return fake.port.ask(request);
    expect(request.context?.battery).toBe('engine.tools.registry-rank');
    expect(request.context?.site).toBe('agent.harness.operator-methods');
    active++; dispatched++; maxActive = Math.max(maxActive, active);
    if (dispatched === 8) wait.start();
    try { await wait.gate; return await fake.port.ask(request); } finally { active--; }
  } });
  nativeMetadataReading();
  const pending = f.host.execute({ action: 'methods', query: 'search inbox', limit: 1 }, { signal: controller.signal });
  try {
    await Promise.race([wait.started, pending.then(() => { throw new Error('The real catalog completed before eight rank requests'); })]);
    expect(dispatched).toBe(8); expect(maxActive).toBe(8); expect(maxScreeningActive).toBe(1);
    expect(screening.calls.filter(call => call.path === '/v1/chat/completions').length).toBeGreaterThanOrEqual(59);
    controller.abort(); wait.release(); await expect(pending).rejects.toThrow();
    expect(dispatched).toBe(8); expect(active).toBe(0);
  } finally {
    controller.abort(); wait.release(); await Promise.allSettled([pending]);
  }
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

function structuralCatalog() {
  return [{ id: 'complete-schema', description: 'Complete native method contract', evidence: {
    properties: Object.fromEntries(Array.from({ length: 240 }, (_, index) => [`field-${index}`, {
      type: 'string', description: `${'Complete ordinary schema context. '.repeat(10)} Last property marker ${index}`,
    }])),
  } }];
}

test('oversized structural catalog reaches the canonical reader with every complete native key and value', async () => {
  const entries = structuralCatalog(), screening = researchScreeningFixture(), fake = readings({ 'complete-schema': 0.99 });
  expect(JSON.stringify(entries).length).toBeGreaterThan(40_000);
  installJudgmentPort(fake.port);
  const retained: (() => void)[] = [];
  const ranked = await rankHarnessCatalog(entries, 'Select the complete schema', entry => entry, 'agent.test.structural-catalog', {
    sourceOwner: screening.owner, requirePreservedSource: true, retainCurrent(guard) { retained.push(guard); },
  });
  expect(ranked.matches).toHaveLength(1);
  expect(ranked.matches[0]?.entry).toEqual(entries[0]);
  expect(fake.requests).toHaveLength(1);
  expect(JSON.stringify(fake.requests)).toContain('Last property marker 239');
  const state = fake.requests[0]!.state;
  if (!state || typeof state !== 'object' || Array.isArray(state) || !state.candidate || typeof state.candidate !== 'object'
    || Array.isArray(state.candidate) || typeof state.candidate.evidenceJson !== 'string') throw new Error('Expected complete structural catalog state');
  expect(JSON.parse(state.candidate.evidenceJson)).toEqual(entries[0]!.evidence);
  expect(screening.calls.filter(call => call.path === '/v1/chat/completions').length).toBeGreaterThan(1);
  for (const guard of retained) guard();
  installJudgmentPort(readings({}).port);
  expect(() => { for (const guard of retained) guard(); }).toThrow();
});

test('oversized structural private source stays held before the canonical reader', async () => {
  const sensitive = 'Private complete schema tail', entries = structuralCatalog();
  entries[0]!.evidence.properties['field-239']!.description = sensitive;
  const screening = researchScreeningFixture({ spans: exactSensitiveSpans([sensitive]) }), fake = readings({ 'complete-schema': 0.99 });
  installJudgmentPort(fake.port);
  await expect(rankHarnessCatalog(entries, 'Select the complete schema', entry => entry, 'agent.test.structural-catalog', {
    sourceOwner: screening.owner, requirePreservedSource: true,
  })).rejects.toThrow();
  expect(JSON.stringify(screening.calls)).toContain(sensitive);
  expect(fake.requests).toHaveLength(0);
});

test.each(['cancel', 'source', 'option'] as const)('oversized structural %s change during screening prevents model publication', async change => {
  const entries = structuralCatalog(), controller = new AbortController();
  const expected = JSON.stringify(entries);
  const options = { signal: controller.signal, sourceOwner: ordinaryResearchOwner(), requirePreservedSource: true,
    assertCurrent() { if (JSON.stringify(entries) !== expected) throw new Error('Original native source changed'); } };
  const screening = researchScreeningFixture({ beforeProposal: async () => {
    if (change === 'cancel') controller.abort();
    if (change === 'source') entries[0]!.evidence.properties['field-239']!.description = 'Changed ordinary source';
    if (change === 'option') options.requirePreservedSource = false;
  } });
  options.sourceOwner = screening.owner;
  const fake = readings({ 'complete-schema': 0.99 }); installJudgmentPort(fake.port);
  await expect(rankHarnessCatalog(entries, 'Select the complete schema', entry => entry, 'agent.test.structural-catalog', options)).rejects.toThrow();
  expect(fake.requests).toHaveLength(0);
});

test('oversized structural backend replacement during the reading cannot publish an answer', async () => {
  const entries = structuralCatalog(), fake = readings({ 'complete-schema': 0.99 });
  installJudgmentPort({ ...fake.port, async ask(request) {
    const result = await fake.port.ask(request); installJudgmentPort(readings({}).port); return result;
  } });
  await expect(rankHarnessCatalog(entries, 'Select the complete schema', entry => entry, 'agent.test.structural-catalog', {
    sourceOwner: ordinaryResearchOwner(), requirePreservedSource: true,
  })).rejects.toThrow();
  requestDiagnostics.reportUnexpectedCount(fake, 1, 'oversized structural backend replacement');
  expect(fake.requests).toHaveLength(1);
});

test('structural framing does not split an oversized semantic string or enlarge its privacy budget', async () => {
  const entries = [{ id: 'complete-schema', description: 'x'.repeat(40_001) }], screening = researchScreeningFixture();
  const fake = readings({ 'complete-schema': 0.99 }); installJudgmentPort(fake.port);
  await expect(rankHarnessCatalog(entries, 'Read the complete prose', entry => entry, 'agent.test.structural-catalog', {
    sourceOwner: screening.owner, requirePreservedSource: true,
  })).rejects.toThrow();
  expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
});

function preparedReadings(query: string, entry: { readonly id: string; readonly description: string; readonly evidence?: unknown }, probability = 0.99) {
  return requestDiagnostics.track(fakePort((name, question, state) => {
    if (name !== 'match' || question.type !== 'noul') throw new Error('Unexpected prepared catalog question');
    expect(state).toEqual({ query, candidate: { type: 'tool', name: entry.id, description: entry.description,
      evidenceJson: JSON.stringify(entry.evidence ?? null) } });
    return noulAnswer(probability);
  }), 'preparedReadings');
}

test('prepared catalog preserves complete aliases and tails while every distinct query is screened and read', async () => {
  const alias = { text: `${'Complete ordinary evidence. '.repeat(80)} Complete alias tail` };
  const entry = { id: 'prepared-native', description: `${'Complete ordinary description. '.repeat(40)} Complete description tail`, evidence: { left: alias, right: alias } };
  let described = 0;
  const describeEntry = (value: typeof entry) => { described++; return value; };
  const prepared = prepareHarnessCatalog([entry], describeEntry), screening = researchScreeningFixture();
  expect(Object.isFrozen(prepared)).toBe(true); expect(Object.isFrozen(prepared[0]?.evidence.left)).toBe(true);
  for (const query of ['First complete native lane', 'Second complete native lane']) {
    const fake = preparedReadings(query, entry); installJudgmentPort(fake.port);
    const result = await rankHarnessCatalog(prepared, query, describeEntry, 'agent.test.prepared-complete', {
      sourceOwner: screening.owner, requirePreservedSource: true,
    });
    expect(result.matches[0]?.entry).toEqual(entry);
    requestDiagnostics.reportUnexpectedCount(fake, 1, 'prepared complete query');
    expect(fake.requests).toHaveLength(1);
  }
  expect(described).toBe(1);
  const proposals = screening.calls.filter(call => call.path === '/v1/chat/completions');
  expect(proposals).toHaveLength(2);
  expect(JSON.stringify(proposals[0])).toContain('First complete native lane');
  expect(JSON.stringify(proposals[1])).toContain('Second complete native lane');
  expect(proposals.every(call => JSON.stringify(call).includes('Complete alias tail') && JSON.stringify(call).includes('Complete description tail'))).toBe(true);
});

test('foreign catalog arrays and describers cannot borrow prepared metadata', async () => {
  const entry = { id: 'prepared-native', description: 'Original complete native description' };
  let described = 0;
  const describeEntry = (value: typeof entry) => { described++; return value; };
  const prepared = prepareHarnessCatalog([entry], describeEntry), screening = researchScreeningFixture();
  const fake = preparedReadings('Native foreign-array query', entry); installJudgmentPort(fake.port);
  await rankHarnessCatalog([...prepared], 'Native foreign-array query', describeEntry, 'agent.test.prepared-foreign', { sourceOwner: screening.owner });
  expect(described).toBe(2); expect(fake.requests).toHaveLength(1);
  const before = screening.calls.length;
  await expect(rankHarnessCatalog(prepared, 'Native foreign-callback query', value => ({ ...value, description: 'Authorization: Bearer synthetic-foreign-credential' }),
    'agent.test.prepared-foreign', { sourceOwner: screening.owner })).rejects.toThrow();
  expect(screening.calls).toHaveLength(before); expect(fake.requests).toHaveLength(1);
});

test.each(['array-proxy', 'entry-proxy', 'entry-accessor'] as const)('prepared %s is refused without invoking hostile slots or contacting either reader', async kind => {
  const entry = { id: 'prepared-native', description: 'Ordinary complete description' }, screening = researchScreeningFixture();
  const fake = preparedReadings('Native proxy query', entry); installJudgmentPort(fake.port); let touched = 0;
  const describeEntry = (value: typeof entry) => value;
  const prepared = prepareHarnessCatalog([entry], describeEntry);
  if (kind === 'array-proxy') {
    const borrowed = new Proxy(prepared, { get() { touched++; return undefined; }, ownKeys() { touched++; return []; }, getPrototypeOf() { touched++; return null; } });
    await expect(rankHarnessCatalog(borrowed, 'Native proxy query', describeEntry, 'agent.test.prepared-proxy', { sourceOwner: screening.owner })).rejects.toThrow();
  } else {
    const source = kind === 'entry-proxy' ? new Proxy(entry, { ownKeys() { touched++; return []; } }) : entry;
    if (kind === 'entry-accessor') Object.defineProperty(source, 'description', { get() { touched++; return 'Ordinary complete description'; } });
    expect(() => prepareHarnessCatalog([source], describeEntry)).toThrow();
  }
  expect(touched).toBe(0); expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
});

test('prepared complete private tail is screened anew and cannot reach the canonical reader', async () => {
  const privateTail = 'Synthetic private prepared schema tail';
  const entry = { id: 'prepared-native', description: 'Complete native method', evidence: { note: `${'Ordinary full evidence. '.repeat(100)} ${privateTail}` } };
  const describeEntry = (value: typeof entry) => value, prepared = prepareHarnessCatalog([entry], describeEntry);
  const screening = researchScreeningFixture({ spans: exactSensitiveSpans([privateTail]) }), fake = preparedReadings('Native privacy query', entry);
  installJudgmentPort(fake.port);
  await expect(rankHarnessCatalog(prepared, 'Native privacy query', describeEntry, 'agent.test.prepared-private', {
    sourceOwner: screening.owner, requirePreservedSource: true,
  })).rejects.toThrow();
  expect(JSON.stringify(screening.calls)).toContain(privateTail); expect(fake.requests).toHaveLength(0);
});

test('catalog evidence preserves public redaction tokens while original queries remain action input', async () => {
  const entry = { id: 'masked-receipt', description: 'Complete receipt password=[REDACTED]', evidence: { password: '[REDACTED]' } };
  const describeEntry = (value: typeof entry) => value, screening = researchScreeningFixture();
  const fake = preparedReadings('Find the completed receipt', entry); installJudgmentPort(fake.port);
  const result = await rankHarnessCatalog([entry], 'Find the completed receipt', describeEntry, 'agent.test.masked-evidence', { sourceOwner: screening.owner });
  expect(result.matches[0]?.entry).toEqual(entry); expect(fake.requests).toHaveLength(1);
  const count = screening.calls.length;
  await expect(rankHarnessCatalog([entry], 'password=[REDACTED]', describeEntry, 'agent.test.masked-query', { sourceOwner: screening.owner })).rejects.toThrow();
  expect(screening.calls).toHaveLength(count); expect(fake.requests).toHaveLength(1);
});

test('prepared metadata grants no exemption from the complete original query floor', async () => {
  const entry = { id: 'prepared-native', description: 'Complete native method' }, describeEntry = (value: typeof entry) => value;
  const prepared = prepareHarnessCatalog([entry], describeEntry), screening = researchScreeningFixture(), fake = preparedReadings('Ordinary query', entry);
  installJudgmentPort(fake.port);
  await expect(rankHarnessCatalog(prepared, `Ordinary query ${'x'.repeat(1500)} Authorization: Bearer synthetic-query-credential`, describeEntry,
    'agent.test.prepared-query', { sourceOwner: screening.owner })).rejects.toThrow();
  expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
});

test.each(['source', 'cancel'] as const)('prepared %s loss during actual local screening holds before canonical publication', async change => {
  const entry = { id: 'prepared-native', description: 'Complete native method', evidence: { note: 'Complete original source note' } };
  const original = [entry], assertOriginal = captureModelReadingSnapshotGuard(captureModelReadingInput(original));
  const describeEntry = (value: typeof entry) => value, prepared = prepareHarnessCatalog(original, describeEntry);
  const wait = suspended(), controller = new AbortController();
  const screening = researchScreeningFixture({ beforeProposal: async () => { wait.start(); await wait.gate; } });
  const fake = preparedReadings('Native pending query', entry); installJudgmentPort(fake.port);
  const pending = rankHarnessCatalog(prepared, 'Native pending query', describeEntry, 'agent.test.prepared-pending', {
    sourceOwner: screening.owner, signal: controller.signal, requirePreservedSource: true, assertCurrent() { assertOriginal(original); },
  });
  await wait.started;
  if (change === 'source') entry.evidence.note += ' Authorization: Bearer synthetic-late-source-credential';
  else controller.abort();
  wait.release(); await expect(pending).rejects.toThrow();
  expect(fake.requests).toHaveLength(0); expect(prepared[0]?.evidence.note).toBe('Complete original source note');
  expect(JSON.stringify(screening.calls)).not.toContain('synthetic-late-source-credential');
});

test('prepared metadata never reuses a prior positive reading for uncertain or negative evidence', async () => {
  const entry = { id: 'prepared-native', description: 'Complete native method' }, describeEntry = (value: typeof entry) => value;
  const prepared = prepareHarnessCatalog([entry], describeEntry);
  for (const probability of [0.99, 0.5, 0.01]) {
    const fake = preparedReadings('Same complete query', entry, probability); installJudgmentPort(fake.port);
    const result = await rankHarnessCatalog(prepared, 'Same complete query', describeEntry, 'agent.test.prepared-reading', {
      sourceOwner: ordinaryResearchOwner(), requirePreservedSource: true,
    });
    expect(fake.requests).toHaveLength(1);
    expect(result.judgments[0]?.reading.verdict).toBe(probability === 0.99 ? 'yes' : probability === 0.5 ? 'uncertain' : 'no');
    expect(result.matches).toHaveLength(probability === 0.01 ? 0 : 1);
  }
});

test.each(['normal', 'oversized'] as const)('prepared %s candidate DTOs preserve complete fresh wire and mutable results across model owners', async shape => {
  const entry = shape === 'oversized' ? structuralCatalog()[0]! : {
    id: 'prepared-native', description: 'Complete ordinary native description', evidence: { tail: 'Complete ordinary metadata tail' },
  };
  const describeEntry = (value: typeof entry) => value, prepared = prepareHarnessCatalog([entry], describeEntry);
  for (const [query, probability] of [['First complete query', 0.99], ['Second complete query', 0.01]] as const) {
    const screening = researchScreeningFixture(), fake = preparedReadings(query, entry, probability);
    installJudgmentPort(fake.port);
    const ranked = await rankHarnessCatalog(prepared, query, describeEntry, 'agent.test.prepared-dto', {
      sourceOwner: screening.owner, requirePreservedSource: true,
    });
    expect(fake.requests).toHaveLength(1);
    expect(screening.calls.some(call => call.path === '/v1/chat/completions')).toBe(true);
    expect(ranked.judgments[0]?.id).toBe(entry.id);
    expect(ranked.matches).toHaveLength(probability === 0.99 ? 1 : 0);
    expect(Object.isFrozen(ranked.matches)).toBe(false); expect(Object.isFrozen(ranked.judgments)).toBe(false);
    const judgment = ranked.judgments[0];
    if (!judgment) throw new Error('Expected a fresh complete candidate judgment');
    expect(Object.isFrozen(judgment)).toBe(false);
    expect(Reflect.set(judgment, 'id', 'Caller-local result edit')).toBe(true);
  }
});

test.each(['normal', 'oversized'] as const)('prepared %s DTO reuse still holds a newly private current-owner tail after an earlier successful screen', async shape => {
  const privateTail = 'Synthetic complete current-owner private tail';
  const evidence = shape === 'oversized' ? { ...structuralCatalog()[0]!.evidence, tail: privateTail } : { tail: privateTail };
  const entry = { id: 'prepared-native', description: 'Complete native method contract', evidence };
  const describeEntry = (value: typeof entry) => value, prepared = prepareHarnessCatalog([entry], describeEntry);
  const first = researchScreeningFixture(), firstReading = preparedReadings('First complete query', entry);
  installJudgmentPort(firstReading.port);
  expect((await rankHarnessCatalog(prepared, 'First complete query', describeEntry, 'agent.test.prepared-current-owner', {
    sourceOwner: first.owner, requirePreservedSource: true,
  })).matches).toHaveLength(1);
  expect(firstReading.requests).toHaveLength(1);
  const current = researchScreeningFixture({ spans: exactSensitiveSpans([privateTail]) }), heldReading = preparedReadings('Current complete query', entry);
  installJudgmentPort(heldReading.port);
  await expect(rankHarnessCatalog(prepared, 'Current complete query', describeEntry, 'agent.test.prepared-current-owner', {
    sourceOwner: current.owner, requirePreservedSource: true,
  })).rejects.toThrow();
  expect(JSON.stringify(current.calls)).toContain(privateTail); expect(heldReading.requests).toHaveLength(0);
});

test('prepared metadata with a non-preserved projection sends the current masked DTO rather than its private original', async () => {
  const privateTail = 'Synthetic complete private descriptive tail';
  const entry = { id: 'prepared-native', description: `Ordinary description ${privateTail}`, evidence: { note: privateTail } };
  const describeEntry = (value: typeof entry) => value, prepared = prepareHarnessCatalog([entry], describeEntry);
  const screening = researchScreeningFixture({ spans: exactSensitiveSpans([privateTail]) });
  const fake = preparedReadings('Read the actual protected projection', {
    id: entry.id, description: 'Ordinary description [redacted]', evidence: { note: '[redacted]' },
  });
  installJudgmentPort(fake.port);
  const ranked = await rankHarnessCatalog(prepared, 'Read the actual protected projection', describeEntry, 'agent.test.prepared-masked-dto', {
    sourceOwner: screening.owner,
  });
  expect(ranked.matches).toHaveLength(1); expect(fake.requests).toHaveLength(1);
  expect(JSON.stringify(screening.calls)).toContain(privateTail); expect(JSON.stringify(fake.requests)).not.toContain(privateTail);
});

function completeContractReadings(evidence: ReadonlyMap<string, string>, lanes: readonly string[], chosen: string | undefined) {
  const seen = new Map(lanes.map(lane => [lane, new Set<string>()]));
  const fake = fakePort((name, question, state) => {
    if (name === 'kind' && question.type === 'choice' && Object.hasOwn(question.criteria, 'owner_profile'))
      return choiceAnswer(question, 'other', 0.999);
    if (['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name) && question.type === 'noul')
      return noulAnswer(0.001);
    if (name !== 'match' || question.type !== 'noul' || !state || typeof state !== 'object' || Array.isArray(state)
      || typeof state.query !== 'string' || !state.candidate || typeof state.candidate !== 'object' || Array.isArray(state.candidate)
      || typeof state.candidate.name !== 'string' || typeof state.candidate.evidenceJson !== 'string')
      throw new Error('Unexpected complete contract request');
    const ids = seen.get(state.query), expected = evidence.get(state.candidate.name);
    if (!ids || expected === undefined || state.candidate.evidenceJson !== expected || ids.has(state.candidate.name))
      throw new Error('Unscripted complete contract evidence');
    ids.add(state.candidate.name);
    return noulAnswer(state.candidate.name === chosen ? 0.999 : 0.001);
  });
  return { ...fake, seen };
}

function foreignContractMethod() {
  const original = operatorContracts.OPERATOR_CONTRACT.operator.methods[0];
  if (!original) throw new Error('Missing native fixture template');
  return { ...original, id: 'native.fixture-method', title: 'Synthetic complete method',
    description: 'Complete synthetic native method contract', metadata: { nested: { text: 'Original complete metadata tail' } },
  };
}
function foreignContract(methods: ReturnType<typeof operatorContracts.getOperatorContract>['operator']['methods']) {
  const native = operatorContracts.OPERATOR_CONTRACT;
  return { ...native, operator: { ...native.operator, methods } };
}

test('immutable native contract metadata retains every fresh lane reading across replacement model owners', async () => {
  const native = operatorContracts.OPERATOR_CONTRACT;
  const evidence = new Map(native.operator.methods.map(method => [method.id, JSON.stringify(captureModelReadingInput(method))]));
  const chosen = native.operator.methods.find(method => method.id === 'accounts.snapshot');
  if (!chosen || chosen.invokable !== true) throw new Error('Missing native dispatchable control');
  expect(Object.isFrozen(native)).toBe(true); expect(Object.isFrozen(native.operator)).toBe(true);
  expect(Object.isFrozen(native.operator.methods)).toBe(true);
  const lanes = ['approvals', 'automation', 'schedules', 'tasks'];
  for (const selected of [chosen.id, undefined]) {
    const fake = completeContractReadings(evidence, lanes, selected), screening = researchScreeningFixture();
    installJudgmentPort({ ...fake.port, model: selected ? 'native-owner-first' : 'native-owner-second' });
    const result = await contractMethodsForAutonomy({ sourceOwner: screening.owner });
    for (const lane of lanes) expect(fake.seen.get(lane)?.size).toBe(native.operator.methods.length);
    expect(fake.requests.filter(request => request.context?.battery === 'agent.personal-ops.lane-member'))
      .toHaveLength(native.operator.methods.length * lanes.length);
    expect(screening.calls.filter(call => call.path === '/v1/chat/completions').length).toBeGreaterThan(0);
    expect(result.tasks.available).toEqual(selected ? [chosen.id] : []);
    expect(result.tasks.unavailable).toEqual([]);
  }
});

test('cached native contract metadata still refuses the current caller and cancellation before any reading', async () => {
  const fake = completeContractReadings(new Map(), ['tasks'], undefined), screening = researchScreeningFixture();
  installJudgmentPort(fake.port);
  const controller = new AbortController(); controller.abort();
  await expect(contractMethodsForLane('tasks', { sourceOwner: screening.owner, signal: controller.signal })).rejects.toThrow();
  await expect(contractMethodsForLane('tasks', { sourceOwner: screening.owner,
    assertCurrent() { throw new Error('Native caller retired'); },
  })).rejects.toThrow('Native caller retired');
  expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
});

test.each(['mutable', 'frozen-parent'] as const)('foreign %s contract metadata is recaptured with the complete changed subtree', async kind => {
  const method = foreignContractMethod(), methods = [method], manifest = foreignContract(methods);
  if (kind === 'frozen-parent') { Object.freeze(method); Object.freeze(methods); Object.freeze(manifest.operator); Object.freeze(manifest); }
  const getter = spyOn(operatorContracts, 'getOperatorContract').mockReturnValue(manifest);
  try {
    for (const tail of ['Original complete metadata tail', 'Changed complete metadata tail']) {
      method.metadata.nested.text = tail;
      const evidence = new Map([[method.id, JSON.stringify(captureModelReadingInput(method))]]);
      const fake = completeContractReadings(evidence, ['tasks'], method.id), screening = researchScreeningFixture();
      installJudgmentPort(fake.port);
      const result = await contractMethodsForLane('tasks', { sourceOwner: screening.owner });
      expect(result.available).toEqual([method.id]); expect(fake.seen.get('tasks')?.size).toBe(1);
      expect(JSON.stringify(screening.calls)).toContain(tail);
    }
  } finally { getter.mockRestore(); }
});

for (const kind of ['array-proxy', 'method-proxy', 'method-accessor'] as const)
  test(`foreign ${kind} cannot borrow immutable native metadata or invoke a getter`, async () => {
    const method = foreignContractMethod(); let touched = 0;
    const methods = kind === 'array-proxy' ? new Proxy([method], { get() { touched++; throw new Error('Unexpected proxy read'); } })
      : kind === 'method-proxy' ? [new Proxy(method, { get() { touched++; throw new Error('Unexpected proxy read'); } })] : [method];
    if (kind === 'method-accessor') Object.defineProperty(method.metadata.nested, 'text', { get() { touched++; return 'Hidden getter value'; } });
    const getter = spyOn(operatorContracts, 'getOperatorContract').mockReturnValue(foreignContract(methods));
    const screening = researchScreeningFixture(), fake = completeContractReadings(new Map(), ['tasks'], undefined);
    installJudgmentPort(fake.port);
    try {
      await expect(contractMethodsForLane('tasks', { sourceOwner: screening.owner })).rejects.toThrow();
      expect(touched).toBe(0); expect(screening.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0);
    } finally { getter.mockRestore(); }
  });

test('foreign complete private tail is screened before any native membership publication', async () => {
  const method = foreignContractMethod(), privateTail = 'Private foreign complete metadata tail';
  method.metadata.nested.text = `${'Complete ordinary metadata. '.repeat(80)}${privateTail}`;
  const getter = spyOn(operatorContracts, 'getOperatorContract').mockReturnValue(foreignContract([method]));
  const screening = researchScreeningFixture({ spans: exactSensitiveSpans([privateTail]) });
  const fake = completeContractReadings(new Map([[method.id, JSON.stringify(captureModelReadingInput(method))]]), ['tasks'], method.id);
  installJudgmentPort(fake.port);
  try {
    await expect(contractMethodsForLane('tasks', { sourceOwner: screening.owner })).rejects.toThrow();
    expect(JSON.stringify(screening.calls)).toContain(privateTail); expect(fake.requests).toHaveLength(0);
  } finally { getter.mockRestore(); }
});

test('foreign contract root replacement during actual privacy retires its complete source', async () => {
  const method = foreignContractMethod(), manifest = foreignContract([method]);
  const getter = spyOn(operatorContracts, 'getOperatorContract').mockReturnValue(manifest);
  const replacement = foreignContract(manifest.operator.methods);
  const screening = researchScreeningFixture({ beforeProposal: async () => { getter.mockReturnValue(replacement); } });
  const fake = completeContractReadings(new Map([[method.id, JSON.stringify(captureModelReadingInput(method))]]), ['tasks'], method.id);
  installJudgmentPort(fake.port);
  try {
    await expect(contractMethodsForLane('tasks', { sourceOwner: screening.owner })).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
    expect(operatorContracts.getOperatorContract()).toBe(replacement);
  } finally { getter.mockRestore(); }
});


test.each(['visible', 'hidden'] as const)('frozen catalog roots retain mutable %s descendants after an earlier successful comparison', visibility => {
  const child = { detail: 'original complete evidence' };
  const source = Object.create(null) as { child: typeof child };
  Object.defineProperty(source, 'child', { value: child, enumerable: visibility === 'visible' });
  Object.freeze(source);
  const current = captureCatalogSnapshotGuard(source);
  current(source);
  child.detail = 'changed complete evidence';
  expect(() => current(source)).toThrow();
});

test('an immutable catalog comparison cannot be forged by replacing WeakSet membership', () => {
  const source = Object.freeze({ detail: 'original complete evidence' });
  const changed = Object.freeze({ detail: 'changed complete evidence' });
  const current = captureCatalogSnapshotGuard(source);
  current(source);
  const membership = spyOn(WeakSet.prototype, 'has').mockReturnValue(true);
  try { expect(() => current(changed)).toThrow(); current(source); }
  finally { membership.mockRestore(); }
});
