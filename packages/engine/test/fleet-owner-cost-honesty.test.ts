/**
 * Cost trust for a contract's owner row.
 *
 * The owner runs no model turn itself, so it has no resolved model, and its
 * usage is filled from the contract's agents when the contract ends: a
 * mixed-model rollup. Pricing it with one model is wrong and "unpriced" is
 * misleading while the units priced fine.
 *
 * The owner ROW adopts the contract's summed cost and model descriptor; the
 * contract node carries a model descriptor derived from its members. The owner
 * is excluded from every member sum, so this never double-counts.
 */

import { describe, expect, test } from 'bun:test';
import { adaptContract, repriceContractOwnerNode } from '../sdk/src/platform/runtime/fleet/adapters/contract.js';
import { createProcessRegistry } from '../sdk/src/platform/runtime/fleet/index.js';
import type { ProcessNode, ProcessRegistry } from '../sdk/src/platform/runtime/fleet/index.js';
import type { ProcessRegistryDeps } from '../sdk/src/platform/runtime/fleet/registry.js';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/manager.js';
import type { ContractView } from '../sdk/src/platform/contract/types.js';
import { makeContract, makeGroup, makeUnit } from './contract/fixtures.js';

const T0 = 1_750_000_000_000;
const USAGE = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1 };

function makeAgent(o: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    task: 'work', template: 'engineer', tools: [], status: 'running', startedAt: T0, toolCallCount: 0,
    orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only', ...o,
  };
}
function makeDeps(o: Partial<ProcessRegistryDeps> = {}): ProcessRegistryDeps {
  return {
    agentManager: { list: () => [], cancel: () => false },
    processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
    watcherRegistry: { list: () => [], stopWatcher: () => null },
    workflow: {
      workflowManager: { list: () => [], cancel: () => false },
      triggerManager: { list: () => [], remove: () => false, enable: () => false, disable: () => false },
      scheduleManager: { list: () => [], remove: () => false, enable: () => false, disable: () => false },
    },
    now: () => T0 + 5_000, ...o,
  };
}
function nodeById(registry: ProcessRegistry, id: string): ProcessNode {
  const node = registry.getNode(id);
  if (!node) throw new Error(`node not found: ${id}`);
  return node;
}

describe('repriceContractOwnerNode + contract model descriptor (unit)', () => {
  const contractNode: ProcessNode = {
    id: 'contract:c', kind: 'contract', label: 'contract c', state: 'executing-tool', elapsedMs: 0,
    model: '2 models', costUsd: 0.446, costState: 'priced', costSource: 'catalog', pricingAsOf: '2026-09-01',
    capabilities: { interruptible: false, killable: true, pausable: false, resumable: false, steerable: false },
  };
  const unpricedOwner: ProcessNode = {
    id: 'owner', kind: 'agent', label: 'orchestrator (owner)', state: 'executing-tool', elapsedMs: 0,
    costUsd: null, costState: 'unpriced', capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: false },
  };

  test('unpriced owner adopts the contract cost, its provenance and the model descriptor', () => {
    const repriced = repriceContractOwnerNode(unpricedOwner, contractNode);
    expect(repriced).not.toBe(unpricedOwner);
    expect(repriced.costUsd).toBe(0.446);
    expect(repriced.costState).toBe('priced');
    expect(repriced.costSource).toBe('catalog');
    expect(repriced.pricingAsOf).toBe('2026-09-01');
    expect(repriced.model).toBe('2 models');
  });

  test('already-priced owner is left untouched (same reference)', () => {
    const priced = { ...unpricedOwner, costUsd: 1.0, costState: 'priced' as const };
    expect(repriceContractOwnerNode(priced, contractNode)).toBe(priced);
  });

  test('an unpriced contract cannot reprice the owner (stays unpriced, same reference)', () => {
    const unpricedContract = { ...contractNode, costUsd: null, costState: 'unpriced' as const };
    expect(repriceContractOwnerNode(unpricedOwner, unpricedContract)).toBe(unpricedOwner);
  });

  test('adaptContract sets a model descriptor from members: single / multiple / none', () => {
    const member = (id: string, model?: string): ProcessNode => ({
      id, kind: 'agent', label: id, state: 'done', elapsedMs: 0, model, costUsd: null, costState: 'unpriced',
      capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
    });
    const contract = makeContract({ id: 'c' }) as ContractView;
    expect(adaptContract(contract, [member('a', 'm1')], T0).model).toBe('m1');
    expect(adaptContract(contract, [member('a', 'm1'), member('b', 'm2')], T0).model).toBe('2 models');
    expect(adaptContract(contract, [member('a')], T0).model).toBeUndefined();
  });
});

describe('registry integration: owner priced, contract model, no double-count', () => {
  test('the owner row is repriced to the contract total; the member sum still excludes the owner', () => {
    const contract = makeContract({
      id: 'ctr', ownerAgentId: 'owner-1', createdAt: T0,
      groups: [makeGroup({ id: 'g1', unitIds: ['u1', 'u2'] })],
      units: [makeUnit({ id: 'u1', agentIds: ['eng'] }), makeUnit({ id: 'u2', agentIds: ['int'] })],
    });
    const agents = [
      // Owner: no model, so priceUsage returns null and it prices as unpriced. Its
      // usage is the rollup of the unit agents, as the runner fills it.
      makeAgent({ id: 'owner-1', contractId: 'ctr', contractRole: 'owner', usage: { inputTokens: 2000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 2, turnCount: 2 } }),
      makeAgent({ id: 'eng', contractId: 'ctr', contractRole: 'unit', contractUnitId: 'u1', model: 'm1', usage: { ...USAGE } }),
      makeAgent({ id: 'int', contractId: 'ctr', contractRole: 'unit', contractUnitId: 'u2', model: 'm2', usage: { ...USAGE } }),
    ];
    const priceUsage = (model: string | undefined): number | null =>
      model === 'm1' ? 0.3 : model === 'm2' ? 0.146 : null;
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      contractRunner: { list: () => [contract as ContractView], cancel: () => false },
      priceUsage,
    }));

    const contractNode = nodeById(registry, 'contract:ctr');
    expect(contractNode.model).toBe('2 models');
    expect(contractNode.costUsd).toBeCloseTo(0.446, 6);
    expect(contractNode.usage?.inputTokens).toBe(2000); // the two unit agents, owner excluded

    const owner = nodeById(registry, 'owner-1');
    expect(owner.costState).toBe('priced');
    expect(owner.costUsd).toBeCloseTo(0.446, 6);
    expect(owner.model).toBe('2 models');

    // The owner's repriced cost is display-only: the unit agents alone sum to it.
    const leafSum = [nodeById(registry, 'eng'), nodeById(registry, 'int')]
      .reduce((sum, node) => sum + (node.costUsd ?? 0), 0);
    expect(leafSum).toBeCloseTo(0.446, 6);
    registry.dispose();
  });
});
