/**
 * The agent tool and AgentManager.spawn hand work to the contract runner
 * (docs/design/contract-runner.md section 10.3): spawn and batch-spawn start a
 * contract unless the work is outside every contract, a contract leaf cannot
 * spawn, a manager spawn that is not outside every contract becomes a
 * contract's owner through startForOwner, and the contracts and
 * contract-history modes read the runner. The workflow tool's `contract`
 * definition starts a contract the same way.
 *
 * Drives the real AgentManager, agent tool, workflow tool and RuntimeEventBus;
 * the runner is a recording fake whose start spawns the owner record exactly as
 * the real runner does (an owner-bound spawn outside every contract).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { withCompletionRepairContext } from '../sdk/src/platform/core/completion-repair-context.js';
import { AgentMessageBus } from '../sdk/src/platform/agents/message-bus.js';
import type { ConfigManager } from '../sdk/src/platform/config/index.js';
import type { ContractRunner, StartedContract } from '../sdk/src/platform/contract/runner.js';
import type { Contract, ContractView, StartContractInput, UnitCheck } from '../sdk/src/platform/contract/types.js';
import { toolResultStartedContract } from '../sdk/src/platform/contract/intake-route.js';
import type { ContractEvent } from '../sdk/src/events/contract.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { AgentManager, createAgentTool, type AgentRecord } from '../sdk/src/platform/tools/agent/index.js';
import { createWorkflowServices, createWorkflowTool } from '../sdk/src/platform/tools/workflow/index.js';
import { makeContract, makeCriterion, makeUnit } from './contract/fixtures.js';
import { makeHarness as realRunnerHarness, oneUnitPlan } from './contract/runner-support.js';
import { AgentOrchestrator } from '../sdk/src/platform/agents/orchestrator.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';
import type { LLMProvider } from '../sdk/src/platform/providers/interface.js';

const PROJECT_ROOT = '/work/agent-tool-contracts';
const SESSION_ID = 'session-7';
let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previousPort = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previousPort); });

function configManager(): Pick<ConfigManager, 'get'> {
  return { get: ((key: string) => (key === 'agents.maxActive' ? 20 : undefined)) as ConfigManager['get'] };
}

interface FakeRunner extends Pick<ContractRunner, 'start' | 'list' | 'get'> {
  readonly starts: StartContractInput[];
  readonly listFilters: Array<Parameters<ContractRunner['list']>[0]>;
}

/** Records every call; start spawns the owner record the way the real runner's spawnOwner does. */
function fakeRunner(manager: AgentManager, contracts: readonly Contract[] = []): FakeRunner {
  const starts: StartContractInput[] = [];
  const listFilters: Array<Parameters<ContractRunner['list']>[0]> = [];
  return {
    starts,
    listFilters,
    start(input: StartContractInput): StartedContract {
      starts.push(input);
      const id = `ctr-${String(starts.length).padStart(8, '0')}`;
      const owner = manager.spawn(
        {
          mode: 'spawn',
          task: input.ask,
          template: 'orchestrator',
          outsideContract: true,
          ...(input.parentAgentId === undefined ? {} : { parentAgentId: input.parentAgentId }),
        },
        { contractId: id, contractRole: 'owner', progress: `Contract ${id}: queued` },
      );
      const contract = makeContract({ id, ask: input.ask, sessionId: input.sessionId, origin: input.origin, ownerAgentId: owner.id, status: 'queued' });
      return { contract, owner };
    },
    list(filter) {
      listFilters.push(filter);
      return [...contracts];
    },
    get(contractId) {
      return contracts.find((contract) => contract.id === contractId) ?? null;
    },
  };
}

function harness(contracts: readonly Contract[] = []) {
  const bus = new RuntimeEventBus();
  const messageBus = new AgentMessageBus();
  const ran: AgentRecord[] = [];
  const manager = new AgentManager({
    archetypeLoader: { loadArchetype: () => null },
    messageBus,
    configManager: configManager(),
    executor: {
      async runAgent(record) {
        record.status = 'running';
        ran.push(record);
      },
    },
  });
  manager.setRuntimeBus(bus);
  const runner = fakeRunner(manager, contracts);
  const tool = createAgentTool({
    manager,
    messageBus,
    configManager: configManager(),
    archetypeLoader: { loadArchetype: () => null },
    contractRunner: runner,
    projectRoot: PROJECT_ROOT,
    resolveSessionId: () => SESSION_ID,
  });
  const guardEvents: Array<Extract<ContractEvent, { type: 'CONTRACT_SPAWN_GUARD_TRIGGERED' }>> = [];
  bus.onDomain('contracts', (envelope) => {
    if (envelope.payload.type === 'CONTRACT_SPAWN_GUARD_TRIGGERED') guardEvents.push(envelope.payload);
  });
  return { bus, manager, runner, tool, ran, guardEvents };
}

/** A unit's sub-agent, spawned the way the phase runner spawns it. */
function spawnUnitAgent(manager: AgentManager): AgentRecord {
  return manager.spawn(
    { mode: 'spawn', task: 'UNIT BRIEF: write the parser', template: 'engineer', outsideContract: true },
    { contractId: 'ctr-0000abcd', contractUnitId: 'u1' },
  );
}

/** What core reads from a tool result (contract/intake-route.ts), given the result the tool returned. */
function startedContract(result: { readonly success: boolean; readonly output?: string | undefined; readonly error?: string | undefined }): boolean {
  return toolResultStartedContract({ callId: 'call-1', success: result.success, ...(result.output === undefined ? {} : { output: result.output }) });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('agent tool spawn', () => {
  test('batch-spawn creates a real contract owner and resolves its OpenAI subscription model', async () => {
    const selected: ModelDefinition = { id: 'gpt-6.1-sol', registryKey: 'openai:gpt-6.1-sol', provider: 'openai-subscriber',
      displayName: 'GPT 6.1 Sol', description: 'fixture', capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
      contextWindow: 128000, selectable: true };
    const h = realRunnerHarness({ plan: oneUnitPlan(1), scripts: {} });
    const subscription: LLMProvider = { name: 'openai-subscriber', models: [selected.id], async chat() { throw new Error('routing test must not call a model'); } };
    const catalog = [{ ...selected, provider: 'openai' }, { ...selected, id: 'gpt-6-sol', registryKey: 'openai:gpt-6-sol', provider: 'openai' }];
    const registry = { listModels: () => catalog, getForModel: (_model: string, provider?: string) => {
      expect(provider).toBe('openai-subscriber'); return subscription;
    } };
    const resolver = new AgentOrchestrator({ messageBus: h.messageBus }) as unknown as {
      resolveProviderForRecord(source: typeof registry, record: AgentRecord, current: ModelDefinition): { provider: LLMProvider; modelId: string };
      resolveFallbackModelRoutes(source: typeof registry, record: AgentRecord, current: ModelDefinition, primary: string): Array<{ provider: LLMProvider; modelId: string; requestedModelId: string }>;
    };
    try {
      const tool = createAgentTool({ manager: h.manager, messageBus: h.messageBus, configManager: configManager(),
        archetypeLoader: { loadArchetype: () => null }, contractRunner: h.runner, projectRoot: h.root,
        resolveSessionId: () => SESSION_ID, getSelectedModel: () => selected });
      const result = await tool.execute({ mode: 'batch-spawn', tasks: [{ task: 'Review the engine' }, { task: 'Review the TUI' }] });
      expect(result.success, result.error).toBe(true);
      const owner = h.manager.list().find(agent => agent.contractRole === 'owner')!;
      expect(owner).toMatchObject({ model: selected.registryKey, provider: 'openai-subscriber' });
      for (const model of [selected.id, selected.registryKey, 'openai-subscriber:gpt-6.1-sol']) {
        expect(resolver.resolveProviderForRecord(registry, { ...owner, model }, selected)).toMatchObject({ provider: subscription, modelId: selected.id });
      }
      expect(resolver.resolveProviderForRecord(registry, { ...owner, provider: undefined }, selected).provider).toBe(subscription);
      expect(resolver.resolveFallbackModelRoutes(registry, { ...owner, fallbackModels: ['openai:gpt-6-sol'] }, selected, selected.registryKey))
        .toEqual([{ provider: subscription, modelId: 'gpt-6-sol', requestedModelId: 'openai:gpt-6-sol' }]);
    } finally {
      for (const contract of h.runner.list()) h.runner.cancel(contract.id, 'routing regression complete');
      await Promise.all(h.runner.list({ includeTerminal: true }).map(contract => h.runner.join(contract.id)));
      h.dispose();
    }
  });

  test('a spawn outside a contract runs the agent directly and starts no contract', async () => {
    const { runner, tool, ran } = harness();

    const result = await tool.execute({ mode: 'spawn', task: 'List the files under src/', template: 'researcher', outsideContract: true });

    expect(result.success).toBe(true);
    expect(runner.starts).toHaveLength(0);
    expect(startedContract(result)).toBe(false);
    const output = JSON.parse(result.output!) as Record<string, unknown>;
    expect(output.contractStarted).toBeUndefined();
    expect(output.status).toBe('spawned');
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ id: output.agentId, reviewMode: 'none', outsideContract: true });
    expect(ran[0]!.contractId).toBeUndefined();
  });

  test('a spawn not outside a contract starts one, with the user\'s words as the ask and the task as the proposed unit', async () => {
    const { manager, runner, tool, ran } = harness();

    const result = await tool.execute({
      mode: 'spawn',
      task: 'Write src/slug.ts exporting slugify()',
      template: 'engineer',
      authoritativeTask: 'add a slugify helper and export it',
    });

    expect(result.success).toBe(true);
    expect(runner.starts).toEqual([{
      ask: 'add a slugify helper and export it',
      sessionId: SESSION_ID,
      origin: 'agent-tool',
      projectRoot: PROJECT_ROOT,
      proposedUnits: [{ task: 'Write src/slug.ts exporting slugify()', template: 'engineer' }],
    }]);
    expect(startedContract(result)).toBe(true);
    const output = JSON.parse(result.output!) as Record<string, unknown>;
    expect(output).toMatchObject({ contractStarted: true, contractId: 'ctr-00000001', status: 'spawned', contractRole: 'owner' });
    const owner = manager.getStatus(output.ownerAgentId as string)!;
    expect(output.agentId).toBe(owner.id);
    expect(owner).toMatchObject({ contractId: 'ctr-00000001', contractRole: 'owner', status: 'running', template: 'orchestrator' });
    // The owner record runs no executor: the contract's units do the work.
    expect(ran).toHaveLength(0);
  });

  test('without the user\'s words the spawn\'s task is the ask', async () => {
    const { runner, tool } = harness();

    await tool.execute({ mode: 'spawn', task: 'Fix the failing date test' });

    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0]).toMatchObject({ ask: 'Fix the failing date test', proposedUnits: [{ task: 'Fix the failing date test' }] });
  });

  test('a failed contract start reports the actual error without admitting an agent', async () => {
    const { manager, runner, tool, ran } = harness();
    let attemptedStarts = 0;
    runner.start = () => { attemptedStarts++; throw new Error('No contract runner is composed in this runtime.'); };

    const result = await tool.execute({ mode: 'spawn', task: 'Fix the failing date test' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('No contract runner is composed in this runtime.');
    expect(attemptedStarts).toBe(1);
    expect(startedContract(result)).toBe(false);
    expect(ran).toHaveLength(0);
    expect(manager.list()).toHaveLength(0);
  });
});

describe('agent tool batch-spawn', () => {
  test('outside-contract tasks spawn directly and the rest become one contract', async () => {
    const { runner, tool, ran } = harness();

    const result = await tool.execute({
      mode: 'batch-spawn',
      cohort: 'release',
      tasks: [
        { task: 'Summarize the CI configuration', template: 'researcher', outsideContract: true },
        { task: 'Add the CSV parser module', template: 'engineer' },
        { task: 'Wire the parser into the convert command' },
      ],
    });

    expect(result.success).toBe(true);
    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0]).toMatchObject({
      ask: '- Add the CSV parser module\n- Wire the parser into the convert command',
      sessionId: SESSION_ID,
      origin: 'agent-tool',
      projectRoot: PROJECT_ROOT,
      proposedUnits: [
        { task: 'Add the CSV parser module', template: 'engineer' },
        { task: 'Wire the parser into the convert command' },
      ],
    });
    expect(startedContract(result)).toBe(true);
    const output = JSON.parse(result.output!) as {
      contractStarted: boolean; contractId: string; ownerAgentId: string; contractTaskCount: number;
      owner: { id: string; contractRole: string };
      agents: Array<{ id: string; task: string }>; count: number; skipped: number; cohort: string;
    };
    expect(output).toMatchObject({ contractStarted: true, contractId: 'ctr-00000001', contractTaskCount: 2, count: 1, skipped: 0, cohort: 'release' });
    expect(output.owner).toMatchObject({ id: output.ownerAgentId, contractRole: 'owner' });
    expect(output.agents.map((agent) => agent.task)).toEqual(['Summarize the CI configuration']);
    expect(ran.map((record) => record.task)).toEqual(['Summarize the CI configuration']);
    expect(ran[0]).toMatchObject({ reviewMode: 'none', cohort: 'release' });
  });

  test('the user\'s words are the batch contract\'s ask when the host attached them', async () => {
    const { runner, tool } = harness();

    await tool.execute({
      mode: 'batch-spawn',
      authoritativeTask: 'build the CSV import end to end',
      tasks: [{ task: 'Add the CSV parser module' }, { task: 'Wire the parser into the convert command' }],
    });

    expect(runner.starts[0]!.ask).toBe('build the CSV import end to end');
  });

  test('a batch entirely outside contracts starts no contract', async () => {
    const { runner, tool, ran } = harness();

    const result = await tool.execute({
      mode: 'batch-spawn',
      outsideContract: true,
      tasks: [
        { task: 'Inspect package manager configuration.', template: 'researcher' },
        { task: 'Inspect CI configuration.', template: 'researcher' },
      ],
    });

    expect(result.success).toBe(true);
    expect(runner.starts).toHaveLength(0);
    expect(startedContract(result)).toBe(false);
    const output = JSON.parse(result.output!) as { count: number; maxAgents: number };
    expect(output.count).toBe(2);
    expect(output.maxAgents).toBeGreaterThanOrEqual(2);
    expect(ran).toHaveLength(2);
    expect(ran.every((record) => record.contractRole === undefined && record.reviewMode === 'none')).toBe(true);
  });

  test('an invalid task refuses the whole batch before anything starts', async () => {
    const { manager, runner, tool } = harness();

    const result = await tool.execute({
      mode: 'batch-spawn',
      tasks: [{ task: 'Add the CSV parser module' }, { task: '   ', outsideContract: true }],
    });

    expect(result.success).toBe(false);
    expect(runner.starts).toHaveLength(0);
    expect(manager.list()).toHaveLength(0);
  });
});

describe('a contract leaf cannot spawn', () => {
  test('the agent tool refuses a unit agent\'s spawn before the runner is called, and emits the guard event', async () => {
    const { manager, runner, tool, guardEvents } = harness();
    const unit = spawnUnitAgent(manager);

    const intoContract = await tool.execute({ mode: 'spawn', task: 'Split the parser work', parentAgentId: unit.id });
    const batch = await tool.execute({ mode: 'batch-spawn', parentAgentId: unit.id, tasks: [{ task: 'a' }, { task: 'b' }] });
    const outside = await tool.execute({ mode: 'spawn', task: 'Look something up', parentAgentId: unit.id, outsideContract: true });

    for (const result of [intoContract, batch, outside]) {
      expect(result.success).toBe(false);
      expect(result.error).toBe('units are leaves; the contract plans sub-work');
    }
    // One task of a batch from a unit is enough to refuse the whole batch before the contract starts.
    const mixed = await tool.execute({ mode: 'batch-spawn', tasks: [{ task: 'a' }, { task: 'b', parentAgentId: unit.id, outsideContract: true }] });
    expect(mixed.success).toBe(false);
    expect(mixed.error).toBe('units are leaves; the contract plans sub-work');

    expect(runner.starts).toHaveLength(0);
    expect(manager.list()).toEqual([unit]);
    await flush();
    expect(guardEvents).toHaveLength(4);
    for (const guardEvent of guardEvents) expect(guardEvent).toMatchObject({
      type: 'CONTRACT_SPAWN_GUARD_TRIGGERED',
      contractId: 'ctr-0000abcd',
      agentId: unit.id,
      depth: 1,
      reason: 'units are leaves; the contract plans sub-work',
    });
  });

  test('AgentManager.spawn refuses a unit agent\'s child the same way', async () => {
    const { manager, guardEvents } = harness();
    const unit = spawnUnitAgent(manager);

    expect(() => manager.spawn({ mode: 'spawn', task: 'helper', parentAgentId: unit.id, outsideContract: true }))
      .toThrow('units are leaves; the contract plans sub-work');
    expect(manager.list()).toEqual([unit]);
    await flush();
    expect(guardEvents).toHaveLength(1);
    expect(guardEvents[0]).toMatchObject({ contractId: 'ctr-0000abcd', agentId: unit.id });
  });

  test('a contract owner may still have children outside the contract', () => {
    const { manager } = harness();
    const owner = manager.spawn(
      { mode: 'spawn', task: 'the ask', template: 'orchestrator', outsideContract: true },
      { contractId: 'ctr-0000beef', contractRole: 'owner', progress: 'Contract ctr-0000beef: queued' },
    );

    const child = manager.spawn({ mode: 'spawn', task: 'side lookup', template: 'researcher', parentAgentId: owner.id, outsideContract: true });

    expect(child.parentAgentId).toBe(owner.id);
    expect(child.contractId).toBeUndefined();
  });
});

describe('AgentManager startForOwner seam', () => {
  test('a spawn not outside every contract becomes the owner of a new contract, and no executor runs', () => {
    const ran: AgentRecord[] = [];
    const owned: AgentRecord[] = [];
    const manager = new AgentManager({
      archetypeLoader: { loadArchetype: () => null },
      messageBus: { registerAgent() {} },
      configManager: configManager(),
      executor: { async runAgent(record) { ran.push(record); } },
    });
    manager.setContractRunner({
      startForOwner(record) {
        owned.push(record);
        record.contractId = 'ctr-00000042';
        record.contractRole = 'owner';
        record.status = 'running';
        return { contract: makeContract({ id: 'ctr-00000042', ownerAgentId: record.id }), owner: record };
      },
    });

    const record = manager.spawn({ mode: 'spawn', task: 'add a slugify helper', proposedUnits: [{ task: 'add a slugify helper' }] });

    expect(owned).toEqual([record]);
    expect(record).toMatchObject({ contractId: 'ctr-00000042', contractRole: 'owner', status: 'running', reviewMode: 'contract' });
    expect(record.proposedUnits).toEqual([{ task: 'add a slugify helper' }]);
    expect(ran).toHaveLength(0);
    expect(manager.getStatus(record.id)).toBe(record);
  });

  test('outside-contract, unit-bound and owner-bound spawns never reach the runner', () => {
    const owned: AgentRecord[] = [];
    const manager = new AgentManager({
      archetypeLoader: { loadArchetype: () => null },
      messageBus: { registerAgent() {} },
      configManager: configManager(),
      executor: { async runAgent() {} },
      contractRunner: { startForOwner(record) { owned.push(record); throw new Error('not reached'); } },
    });

    manager.spawn({ mode: 'spawn', task: 'side task', outsideContract: true });
    manager.spawn({ mode: 'spawn', task: 'unit brief', outsideContract: true }, { contractId: 'ctr-00000001', contractUnitId: 'u1' });
    manager.spawn({ mode: 'spawn', task: 'the ask', template: 'orchestrator', outsideContract: true }, { contractId: 'ctr-00000002', contractRole: 'owner', progress: 'queued' });

    expect(owned).toHaveLength(0);
  });

  test('with no contract runner composed such a spawn throws and registers nothing', () => {
    const manager = new AgentManager({
      archetypeLoader: { loadArchetype: () => null },
      messageBus: { registerAgent() {} },
      configManager: configManager(),
      executor: { async runAgent() {} },
    });

    expect(() => manager.spawn({ mode: 'spawn', task: 'add a slugify helper' })).toThrow('No contract runner is composed');
    expect(manager.list()).toHaveLength(0);
  });

  test('a runner that throws fails the owner record and the spawn', async () => {
    let attemptedStarts = 0, executions = 0;
    const manager = new AgentManager({
      archetypeLoader: { loadArchetype: () => null },
      messageBus: { registerAgent() {} },
      configManager: configManager(),
      executor: { async runAgent() { executions++; } },
      contractRunner: { startForOwner() { attemptedStarts++; throw new Error('store unavailable'); } },
    });

    expect(() => manager.spawn({ mode: 'spawn', task: 'add a slugify helper' })).toThrow('store unavailable');
    expect(attemptedStarts).toBe(1);
    expect(manager.list()).toHaveLength(1);
    const [record] = manager.list();
    expect(record).toMatchObject({ status: 'failed', error: 'The contract could not start: store unavailable' });
    expect(record?.completedAt).toBeDefined();
    await flush();
    expect(executions).toBe(0);
  });
});

function check(id: string, at: number, result: UnitCheck['result']): UnitCheck {
  return {
    id,
    at,
    trigger: 'completion',
    goal: { probabilityUnmet: 0.1, verdict: 'met', outcome: 'act' },
    quality: {},
    result,
    problems: result === 'nudge' ? ['unmet'] : [],
    decisionIds: ['d-1'],
    evidenceDigest: 'digest',
  };
}

function reportedContract(): Contract {
  return makeContract({
    id: 'ctr-0000cafe',
    sessionId: SESSION_ID,
    status: 'running',
    goal: 'A CSV parser wired into convert',
    ask: 'build the CSV import',
    statusLine: 'Contract ctr-0000cafe: running',
    criteria: [makeCriterion({ id: 'c1', status: 'met' }), makeCriterion({ id: 'c2', status: 'unread' })],
    units: [
      makeUnit({ id: 'u1', title: 'Parser', status: 'passed', criteria: [makeCriterion({ id: 'u1.c1', status: 'met' })], checks: [check('u1.k2', 30, 'pass'), check('u1.k1', 10, 'nudge')] }),
      makeUnit({ id: 'u2', title: 'Wiring', status: 'running', criteria: [makeCriterion({ id: 'u2.c1', status: 'unmet' })] }),
    ],
    checks: [check('ctr-0000cafe.k1', 20, 'recorded')],
    decisions: [
      { id: 'x1', at: 5, action: 'planned', targetId: 'ctr-0000cafe', reason: 'two units', decisionIds: ['d-0'] },
      { id: 'x2', at: 11, action: 'nudged', targetId: 'u1', reason: 'criterion u1.c1 unmet', decisionIds: ['d-1'] },
    ],
    escalations: [{
      id: 'e1', at: 40, scope: 'unit', targetId: 'u2', reason: 'stalled',
      question: 'Unit u2 has made no progress. Stop it or keep going?', unmetCriterionIds: ['u2.c1'],
    }],
  });
}

describe('agent tool contracts and contract-history modes', () => {
  test('contracts lists the session\'s contracts with status, goal, ask, units and criteria met of judged', async () => {
    const { runner, tool } = harness([reportedContract()]);

    const result = await tool.execute({ mode: 'contracts' });

    expect(result.success).toBe(true);
    expect(runner.listFilters).toEqual([{ sessionId: SESSION_ID, includeTerminal: true }]);
    const output = JSON.parse(result.output!) as { count: number; contracts: unknown[] };
    expect(output.count).toBe(1);
    expect(output.contracts[0]).toEqual({
      id: 'ctr-0000cafe',
      status: 'running',
      goal: 'A CSV parser wired into convert',
      ask: 'build the CSV import',
      ownerAgentId: 'agent-owner',
      units: [{ id: 'u1', title: 'Parser', status: 'passed' }, { id: 'u2', title: 'Wiring', status: 'running' }],
      // c1 and u1.c1 met; u2.c1 unmet; c2 not yet read.
      criteriaMet: 2,
      criteriaJudged: 3,
      statusLine: 'Contract ctr-0000cafe: running',
    });
  });

  test('contracts passes includeTerminal through and returns the views at detail full', async () => {
    const contract = reportedContract();
    const { runner, tool } = harness([contract]);

    const result = await tool.execute({ mode: 'contracts', includeTerminal: false, detail: 'full' });

    expect(runner.listFilters).toEqual([{ sessionId: SESSION_ID, includeTerminal: false }]);
    const output = JSON.parse(result.output!) as { contracts: ContractView[] };
    expect(output.contracts[0]).toEqual(JSON.parse(JSON.stringify(contract)));
  });

  test('contract-history summarizes the decisions, every check oldest first, and the escalations', async () => {
    const { tool } = harness([reportedContract()]);

    const result = await tool.execute({ mode: 'contract-history', contractId: 'ctr-0000cafe' });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!) as Record<string, unknown>;
    expect(output).toMatchObject({ mode: 'contract-history', contractId: 'ctr-0000cafe', status: 'running' });
    expect(output.decisions).toEqual([
      { at: 5, action: 'planned', targetId: 'ctr-0000cafe', reason: 'two units' },
      { at: 11, action: 'nudged', targetId: 'u1', reason: 'criterion u1.c1 unmet' },
    ]);
    expect(output.checks).toEqual([
      { id: 'u1.k1', at: 10, trigger: 'completion', result: 'nudge', goal: 'met', problems: ['unmet'] },
      { id: 'ctr-0000cafe.k1', at: 20, trigger: 'completion', result: 'recorded', goal: 'met', problems: [] },
      { id: 'u1.k2', at: 30, trigger: 'completion', result: 'pass', goal: 'met', problems: [] },
    ]);
    expect(output.escalations).toEqual([{
      id: 'e1', at: 40, scope: 'unit', targetId: 'u2', reason: 'stalled',
      question: 'Unit u2 has made no progress. Stop it or keep going?', resolved: false,
    }]);
  });

  test('contract-history at detail full returns the records, and needs a known contractId', async () => {
    const contract = reportedContract();
    const { tool } = harness([contract]);

    const full = JSON.parse((await tool.execute({ mode: 'contract-history', contractId: contract.id, detail: 'full' })).output!) as Record<string, unknown>;
    expect(full.decisions).toEqual(JSON.parse(JSON.stringify(contract.decisions)));
    expect(full.escalations).toEqual(JSON.parse(JSON.stringify(contract.escalations)));

    const missing = await tool.execute({ mode: 'contract-history' });
    expect(missing).toEqual({ success: false, error: 'contract-history requires contractId' });
    const unknown = await tool.execute({ mode: 'contract-history', contractId: 'ctr-ffffffff' });
    expect(unknown).toEqual({ success: false, error: "Unknown contract: 'ctr-ffffffff'" });
  });
});

describe('workflow tool contract definition', () => {
  test('start with definition contract starts a contract through the runner', async () => {
    const { manager } = harness();
    const runner = fakeRunner(manager);
    const services = createWorkflowServices();
    const tool = createWorkflowTool(services, { contractRunner: runner, projectRoot: PROJECT_ROOT, resolveSessionId: () => SESSION_ID });

    const result = await tool.execute({ mode: 'start', definition: 'contract', task: 'add a slugify helper' });

    expect(result.success).toBe(true);
    expect(runner.starts).toEqual([{ ask: 'add a slugify helper', sessionId: SESSION_ID, origin: 'agent-tool', projectRoot: PROJECT_ROOT }]);
    expect(startedContract(result)).toBe(true);
    expect(JSON.parse(result.output!)).toMatchObject({ contractStarted: true, contractId: 'ctr-00000001', status: 'queued' });
    // A contract is not a tracked state machine.
    expect(services.workflowManager.list()).toHaveLength(0);
  });

  test('the tracked definitions still start state machines without the runner', async () => {
    const { manager } = harness();
    const runner = fakeRunner(manager);
    const services = createWorkflowServices();
    const tool = createWorkflowTool(services, { contractRunner: runner, projectRoot: PROJECT_ROOT, resolveSessionId: () => SESSION_ID });

    const result = await tool.execute({ mode: 'start', definition: 'fix_loop', task: 'fix the date test' });

    expect(result.success).toBe(true);
    expect(runner.starts).toHaveLength(0);
    expect(JSON.parse(result.output!)).toMatchObject({ definition: 'fix_loop', currentState: 'apply' });
    const unknown = await tool.execute({ mode: 'start', definition: 'no_such_definition', task: 'x' });
    expect(unknown.success).toBe(false);
  });
});


test('a completion repair contract retains the original ask and receives its private remaining-work context', async () => {
  const { tool, runner } = harness();
  const repair = JSON.stringify({ kind: 'completion-repair', review: { findings: [{ preserve: ['parser.ts reviewed'], remaining: ['server.ts'] }] } });
  const result = await withCompletionRepairContext(repair, () => tool.execute({ mode: 'batch-spawn', authoritativeTask: 'Review the repository and deliver review.md.', tasks: [{ task: 'Review server.ts only; retain the parser review.' }] }));
  expect(result.success, result.error).toBeTrue();
  expect(runner.starts[0]!.ask).toBe('Review the repository and deliver review.md.');
  expect(runner.starts[0]!.taskEvidence).toBe(repair);
  expect(result.output).not.toContain('parser.ts reviewed');
});


test('brief fidelity checks the real shared context and task-specific evidence instead of dropping them', async () => {
  const { tool, runner, ran } = harness();
  const fake = fakePort((name, _question, state) => {
    const input = state as never as { context?: string; assignments: { context?: string; requiredEvidence?: string[] }[] };
    const complete = input.context === 'Reuse the existing review.md and completed parser review.'
      && input.assignments[0]?.context === input.context && input.assignments[0]?.requiredEvidence?.includes('Exact server source receipts.');
    return noulAnswer(name === 'constraint_conflict' && !complete ? .99 : .01);
  });
  installJudgmentPort(fake.port);
  const result = await tool.execute({ mode: 'batch-spawn', authoritativeTask: 'Continue the saved review and amend its artifact.',
    context: 'Reuse the existing review.md and completed parser review.', requiredEvidence: ['Exact server source receipts.'],
    tasks: [{ task: 'Inspect remaining server interactions; report to the coordinator.', outsideContract: true }] });
  expect(result.success, result.error).toBeTrue();
  await flush();
  expect(ran).toHaveLength(1);
  expect(runner.starts).toHaveLength(0);
  expect(fake.requests).toHaveLength(1);
});
