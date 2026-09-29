/**
 * The contract tree in the fleet (docs/design/contract-runner.md section 8.3):
 * contract, group and unit nodes from the runner's views, each criterion's
 * reading on the node's `check`, usage and cost summed from the agents that
 * did the work (the owner never counted), node ids that never collide across
 * contracts, and a registry snapshot of a running contract with its agents
 * nested under the right nodes.
 */
import { describe, expect, test } from 'bun:test';
import {
  adaptContract,
  adaptContractGroup,
  adaptContractUnit,
  contractGroupNodeId,
  contractNodeId,
  contractUnitNodeId,
  deriveCheckSummary,
} from '../sdk/src/platform/runtime/fleet/adapters/contract.js';
import { createProcessRegistry } from '../sdk/src/platform/runtime/fleet/index.js';
import type { ProcessNode, ProcessRegistry } from '../sdk/src/platform/runtime/fleet/index.js';
import type { ProcessRegistryDeps } from '../sdk/src/platform/runtime/fleet/registry.js';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/manager.js';
import type { Contract, ContractView, CriterionReading, UnitCheck } from '../sdk/src/platform/contract/types.js';
import { makeContract, makeCriterion, makeGroup, makeUnit } from './contract/fixtures.js';

const T0 = 1_750_000_000_000;
const USAGE = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1 };

function reading(verdict: CriterionReading['verdict'], outcome: CriterionReading['outcome'], extra: Partial<CriterionReading> = {}): CriterionReading {
  return { checkId: 'u1.k1', at: T0 + 10, probabilityUnmet: verdict === 'met' ? 0.05 : 0.9, verdict, outcome, decisionId: 'd1', ...extra };
}

function check(id: string, at: number): UnitCheck {
  return {
    id, at, trigger: 'completion', goal: { probabilityUnmet: 0.1, verdict: 'met', outcome: 'act' },
    quality: {}, result: 'nudge', decisionIds: [], evidenceDigest: 'x',
  };
}

function agentNode(id: string, overrides: Partial<ProcessNode> = {}): ProcessNode {
  return {
    id, kind: 'agent', label: id, state: 'executing-tool', elapsedMs: 0, startedAt: T0, costUsd: null, costState: 'unpriced',
    capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: true },
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    task: 'do work', template: 'engineer', tools: [], status: 'running', startedAt: T0, toolCallCount: 0,
    orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ProcessRegistryDeps> = {}): ProcessRegistryDeps {
  return {
    agentManager: { list: () => [], cancel: () => false },
    contractRunner: { list: () => [], cancel: () => false },
    processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
    watcherRegistry: { list: () => [], stopWatcher: () => null },
    workflow: {
      workflowManager: { list: () => [], cancel: () => false },
      triggerManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
      scheduleManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
    },
    now: () => T0 + 5_000,
    ...overrides,
  };
}

function nodeById(registry: ProcessRegistry, id: string): ProcessNode {
  const node = registry.getNode(id);
  if (!node) throw new Error(`node not found: ${id}`);
  return node;
}

/** A contract mid-run: criteria read, one unit nudged, a best-of-N unit with two attempts, a planner. */
function runningContract(): Contract {
  return makeContract({
    id: 'ctr-run',
    ownerAgentId: 'owner',
    plannerAgentIds: ['planner'],
    createdAt: T0,
    status: 'running',
    criteria: [
      makeCriterion({ id: 'c1', status: 'met', readings: [reading('met', 'act')] }),
      makeCriterion({ id: 'c2', text: 'Runs on every platform in parallel', status: 'unread', disposition: 'met-by-structure' }),
    ],
    groups: [makeGroup({ id: 'g1', unitIds: ['u1', 'u2'], status: 'running', criteria: [makeCriterion({ id: 'g1.c1', origin: 'derived', serves: ['c1'], quote: undefined })] })],
    units: [
      makeUnit({
        id: 'u1', status: 'nudged', agentIds: ['eng-1'], activeAgentId: 'eng-1',
        criteria: [
          makeCriterion({ id: 'u1.c1', status: 'met', readings: [reading('unmet', 'act', { severity: 'major' }), reading('met', 'act')] }),
          makeCriterion({ id: 'u1.c2', status: 'unmet', readings: [reading('unmet', 'act', { severity: 'critical' })] }),
          makeCriterion({ id: 'u1.c3', status: 'unshown', readings: [reading('unshown', 'confirm')] }),
          makeCriterion({ id: 'u1.c4', status: 'unread' }),
        ],
        checks: [check('u1.k1', T0 + 10), check('u1.k2', T0 + 20)],
        nudges: [
          { id: 'n1', checkId: 'u1.k1', at: T0 + 11, kinds: ['unmet'], criterionIds: ['u1.c2'], text: 'fix', delivery: 'hold', agentId: 'eng-1' },
          { id: 'n2', checkId: 'u1.k2', at: T0 + 21, kinds: ['unshown'], criterionIds: ['u1.c3'], text: 'show', delivery: 'bus', agentId: 'eng-1' },
        ],
        route: { model: 'model-a', provider: 'provider-a', reason: 'fits the unit' },
      }),
      makeUnit({
        id: 'u2', attempts: 2, status: 'running', agentIds: ['att-0', 'att-1'],
        attemptUnits: [
          makeUnit({ id: 'u2#a0', attemptOf: 'u2', attemptIndex: 0, status: 'running', agentIds: ['att-0'], activeAgentId: 'att-0' }),
          makeUnit({ id: 'u2#a1', attemptOf: 'u2', attemptIndex: 1, status: 'held-merge', agentIds: ['att-1'] }),
        ],
      }),
    ],
  });
}

describe('contract fleet adapters: ids', () => {
  test('ids are namespaced and carry the contract, since every contract names its groups g1 and units u1', () => {
    expect(contractNodeId('ctr-a')).toBe('contract:ctr-a');
    expect(contractGroupNodeId('ctr-a', 'g1')).toBe('group:ctr-a:g1');
    expect(contractUnitNodeId('ctr-a', 'u1')).toBe('unit:ctr-a:u1');
    expect(contractGroupNodeId('ctr-a', 'g1')).not.toBe(contractGroupNodeId('ctr-b', 'g1'));
    expect(contractUnitNodeId('ctr-a', 'u1')).not.toBe(contractUnitNodeId('ctr-b', 'u1'));
  });
});

describe('contract fleet adapters: each criterion\'s reading', () => {
  test('a unit check summary lists every judged criterion with its latest verdict, outcome and severity', () => {
    const contract = runningContract();
    const summary = deriveCheckSummary(contract.units[0]!, contract.units[0]!.nudges.length);
    expect(summary).toEqual({
      criteria: [
        { id: 'u1.c1', text: expect.any(String), verdict: 'met', outcome: 'act' },
        { id: 'u1.c2', text: expect.any(String), verdict: 'unmet', outcome: 'act', severity: 'critical' },
        { id: 'u1.c3', text: expect.any(String), verdict: 'unshown', outcome: 'confirm' },
        { id: 'u1.c4', text: expect.any(String), verdict: 'unread' },
      ],
      met: 1,
      judged: 4,
      nudges: 2,
      lastCheckAt: T0 + 20,
    });
  });

  test('criteria the plan excluded or met by structure are not judged and are not listed', () => {
    const contract = runningContract();
    const node = adaptContract(contract as ContractView, [], T0 + 100);
    expect(node.check?.criteria.map((criterion) => criterion.id)).toEqual(['c1']);
    expect(node.check?.judged).toBe(1);
    expect(node.check?.met).toBe(1);
    // The contract counts every correction sent to any of its units.
    expect(node.check?.nudges).toBe(2);
  });

  test('a node with nothing judged carries no check summary (absent, never an empty shell)', () => {
    const contract = makeContract({ criteria: [makeCriterion({ id: 'c1', disposition: 'excluded' })] });
    expect(deriveCheckSummary(contract, 0)).toBeUndefined();
    expect(adaptContract(contract as ContractView, [], T0).check).toBeUndefined();
  });
});

describe('contract fleet adapters: node shapes', () => {
  test('contract node: root, live status as its activity, killable while running, never steerable', () => {
    const contract = runningContract();
    const node = adaptContract(contract as ContractView, [], T0 + 100);
    expect(node).toMatchObject({
      id: 'contract:ctr-run', kind: 'contract', label: 'contract ctr-run', task: contract.ask, state: 'executing-tool',
      startedAt: T0, elapsedMs: 100, currentActivity: { kind: 'phase', text: 'running' },
      capabilities: { interruptible: false, killable: true, steerable: false },
      sessionRef: { sessionId: 'session-1', agentId: 'owner' },
    });
    expect(node.parentId).toBeUndefined();
  });

  test('group node: child of its contract; killable only while a unit agent is working', () => {
    const contract = runningContract();
    const live = adaptContractGroup(contract.groups[0]!, contract as ContractView, [agentNode('eng-1')], T0 + 50);
    expect(live).toMatchObject({ id: 'group:ctr-run:g1', kind: 'contract-group', parentId: 'contract:ctr-run', state: 'executing-tool', startedAt: T0 });
    expect(live.capabilities).toMatchObject({ killable: true, steerable: false, interruptible: false });
    expect(live.check?.criteria.map((criterion) => criterion.id)).toEqual(['g1.c1']);
    const idle = adaptContractGroup(contract.groups[0]!, contract as ContractView, [agentNode('eng-1', { state: 'done', completedAt: T0 + 5 })], T0 + 50);
    expect(idle.capabilities.killable).toBe(false);
  });

  test('unit node: reads as its working agent, and interrupt, kill and steer go to that agent', () => {
    const contract = runningContract();
    const unit = contract.units[0]!;
    const thinking = agentNode('eng-1', { state: 'thinking' });
    const node = adaptContractUnit(unit, contract as ContractView, { activeAgent: thinking, memberNodes: [thinking], messageBusPresent: true, now: T0 + 50 });
    expect(node).toMatchObject({
      id: 'unit:ctr-run:u1', kind: 'contract-unit', parentId: 'group:ctr-run:g1', state: 'thinking',
      model: 'model-a', provider: 'provider-a', sessionRef: { agentId: 'eng-1' },
      capabilities: { interruptible: true, killable: true, steerable: true },
    });
    const noBus = adaptContractUnit(unit, contract as ContractView, { activeAgent: thinking, memberNodes: [thinking], messageBusPresent: false, now: T0 });
    expect(noBus.capabilities.steerable).toBe(false);
    const stalled = agentNode('eng-1', { state: 'stalled' });
    expect(adaptContractUnit(unit, contract as ContractView, { activeAgent: stalled, memberNodes: [stalled], messageBusPresent: true, now: T0 }).state).toBe('stalled');
    // A finished agent leaves nothing to interrupt, kill or steer.
    const finished = agentNode('eng-1', { state: 'done', completedAt: T0 + 30 });
    const idle = adaptContractUnit(unit, contract as ContractView, { activeAgent: finished, memberNodes: [finished], messageBusPresent: true, now: T0 + 50 });
    expect(idle.capabilities).toMatchObject({ interruptible: false, killable: false, steerable: false });
  });

  test('unit statuses map to fleet states', () => {
    const contract = runningContract();
    const stateOf = (status: Contract['units'][number]['status']): string =>
      adaptContractUnit(makeUnit({ id: 'ux', status }), contract as ContractView, { memberNodes: [], messageBusPresent: true, now: T0 }).state;
    expect(stateOf('pending')).toBe('queued');
    expect(stateOf('blocked')).toBe('stalled');
    expect(stateOf('checking')).toBe('executing-tool');
    expect(stateOf('held')).toBe('executing-tool');
    expect(stateOf('awaiting-owner')).toBe('idle');
    expect(stateOf('held-merge')).toBe('paused');
    expect(stateOf('passed')).toBe('done');
    expect(stateOf('failed')).toBe('failed');
    expect(stateOf('cancelled')).toBe('killed');
  });

  test('an attempt unit hangs under its plan unit with its place among the attempts', () => {
    const contract = runningContract();
    const attempt = contract.units[1]!.attemptUnits![1]!;
    const node = adaptContractUnit(attempt, contract as ContractView, { memberNodes: [], messageBusPresent: true, now: T0 });
    expect(node.parentId).toBe('unit:ctr-run:u2');
    expect(node.state).toBe('paused');
    expect(node.attemptGroup).toEqual({ groupId: 'u2', index: 1, total: 2, held: true, ready: false });
  });

  test('usage and cost are summed from member agents: all priced, mixed, none priced', () => {
    const contract = runningContract();
    const priced = (id: string, cost: number): ProcessNode => agentNode(id, { usage: { ...USAGE, toolCallCount: 2 }, costUsd: cost, costState: 'priced', costSource: 'catalog', pricingAsOf: '2026-09-01' });
    const unpriced = (id: string): ProcessNode => agentNode(id, { usage: { ...USAGE, toolCallCount: 1 } });
    const all = adaptContract(contract as ContractView, [priced('a', 0.25), priced('b', 0.5)], T0);
    expect(all).toMatchObject({ costUsd: 0.75, costState: 'priced', costSource: 'catalog', pricingAsOf: '2026-09-01' });
    expect(all.usage).toMatchObject({ inputTokens: 2000, outputTokens: 200, toolCallCount: 4 });
    expect(adaptContract(contract as ContractView, [priced('a', 0.25), unpriced('b')], T0)).toMatchObject({ costUsd: 0.25, costState: 'estimated' });
    expect(adaptContract(contract as ContractView, [unpriced('b')], T0)).toMatchObject({ costUsd: null, costState: 'unpriced' });
    expect(adaptContract(contract as ContractView, [], T0).usage).toBeUndefined();
  });
});

describe('contract fleet: a running contract in the registry', () => {
  test('contract, group, units and attempt units, with every agent nested under the node it works for', () => {
    const contract = runningContract();
    const agents = [
      makeAgent({ id: 'owner', template: 'orchestrator', contractId: 'ctr-run', contractRole: 'owner', usage: { ...USAGE } }),
      makeAgent({ id: 'planner', template: 'planner', contractId: 'ctr-run', contractRole: 'planner', status: 'completed', completedAt: T0 + 5, usage: { ...USAGE }, model: 'm' }),
      makeAgent({ id: 'eng-1', contractId: 'ctr-run', contractRole: 'unit', contractUnitId: 'u1', usage: { ...USAGE }, model: 'm' }),
      makeAgent({ id: 'att-0', contractId: 'ctr-run', contractRole: 'unit', contractUnitId: 'u2#a0', usage: { ...USAGE }, model: 'm' }),
      makeAgent({ id: 'att-1', contractId: 'ctr-run', contractRole: 'unit', contractUnitId: 'u2#a1', status: 'completed', completedAt: T0 + 9, usage: { ...USAGE }, model: 'm' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      contractRunner: { list: () => [contract as ContractView], cancel: () => false },
      priceUsage: () => 0.1,
    }));
    const snapshot = registry.query();
    const ids = new Set(snapshot.nodes.map((node) => node.id));
    for (const node of snapshot.nodes) {
      if (node.parentId !== undefined) expect(ids.has(node.parentId)).toBe(true);
    }
    expect(registry.query({ kinds: ['contract', 'contract-group', 'contract-unit'] }).nodes.map((node) => node.id).sort()).toEqual([
      'contract:ctr-run', 'group:ctr-run:g1', 'unit:ctr-run:u1', 'unit:ctr-run:u2', 'unit:ctr-run:u2#a0', 'unit:ctr-run:u2#a1',
    ]);
    expect(nodeById(registry, 'owner').parentId).toBe('contract:ctr-run');
    expect(nodeById(registry, 'owner').label).toBe('orchestrator (owner)');
    expect(nodeById(registry, 'planner').parentId).toBe('contract:ctr-run');
    expect(nodeById(registry, 'eng-1').parentId).toBe('unit:ctr-run:u1');
    expect(nodeById(registry, 'att-0').parentId).toBe('unit:ctr-run:u2#a0');
    expect(nodeById(registry, 'att-1').parentId).toBe('unit:ctr-run:u2#a1');
    // Members: planner, eng-1, att-0, att-1 (owner excluded): four agents at 1000 input tokens each.
    const contractNode = nodeById(registry, 'contract:ctr-run');
    expect(contractNode.usage?.inputTokens).toBe(4000);
    expect(contractNode.costUsd).toBeCloseTo(0.4, 10);
    // The group counts its units' agents (u1 and u2's attempts), not the planner.
    expect(nodeById(registry, 'group:ctr-run:g1').usage?.inputTokens).toBe(3000);
    // A plan unit's agents are its attempts' agents, each counted once.
    expect(nodeById(registry, 'unit:ctr-run:u2').usage?.inputTokens).toBe(2000);
    expect(nodeById(registry, 'unit:ctr-run:u2#a0').usage?.inputTokens).toBe(1000);
    // The owner row adopts the contract's cost.
    expect(nodeById(registry, 'owner').costUsd).toBeCloseTo(0.1, 10); // priced on its own: priceUsage prices any model
    // The unit's criterion readings travel on its node.
    expect(nodeById(registry, 'unit:ctr-run:u1').check).toMatchObject({ met: 1, judged: 4, nudges: 2 });
    registry.dispose();
  });

  test('an unpriced owner row adopts the contract total from the registry', () => {
    const contract = runningContract();
    const agents = [
      makeAgent({ id: 'owner', contractId: 'ctr-run', contractRole: 'owner', usage: { ...USAGE } }),
      makeAgent({ id: 'eng-1', contractId: 'ctr-run', contractRole: 'unit', contractUnitId: 'u1', usage: { ...USAGE }, model: 'priced' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      contractRunner: { list: () => [contract as ContractView], cancel: () => false },
      priceUsage: (model) => (model === 'priced' ? 0.2 : null),
    }));
    expect(nodeById(registry, 'owner')).toMatchObject({ costUsd: 0.2, costState: 'priced', model: 'priced' });
    registry.dispose();
  });
});
