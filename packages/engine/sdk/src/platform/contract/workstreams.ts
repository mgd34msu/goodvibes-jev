/**
 * How a contract runs on the orchestration engine (docs/design/contract-runner.md
 * sections 6.1, 7.3 and 7.4): one engine per contract, one workstream per
 * group (the group id is the workstream id), one work item per unit (the unit
 * id is the item id).
 *
 * A group's workstream has one engineer phase. Its capacity is
 * `contract.maxParallelUnits` in worktree mode and 1 in shared mode, and every
 * group is elastic (`releasePolicy: 'reviewed-and-merged'`), so units across
 * all contracts are bounded by the fleet ceiling and a dependent unit starts
 * only after its dependency passed and merged.
 *
 * Shared mode also takes a lock per project root for the time a group runs,
 * so one unit at a time changes a shared working tree across every contract in
 * the process: a unit's diff against its baseline is exactly its own, and its
 * gates never see another unit's half-finished edits.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CreateWorkstreamInput } from '../orchestration/engine.js';
import type { BudgetCeiling, PhaseSpec, WorkItemSpec, WorkItemUsage } from '../orchestration/types.js';
import { briefWithPreviousChecks, buildUnitBrief } from './brief.js';
import type { ContractConfig } from './config.js';
import { unitToolContract } from './plan-schema.js';
import type { Contract, ContractGroup, ContractUnit, UnitRole } from './types.js';

/** The agent archetype for a unit's role. A design unit runs as a general agent held read-only by its tool contract. */
export function unitTemplate(role: UnitRole): 'engineer' | 'integrator' | 'researcher' | 'general' {
  if (role === 'implement') return 'engineer';
  if (role === 'integration') return 'integrator';
  if (role === 'research') return 'researcher';
  return 'general';
}

/** Units that may run at once in one group: 1 in shared mode, `contract.maxParallelUnits` in worktree mode. */
export function phaseCapacity(contract: Pick<Contract, 'isolation'>, config: Pick<ContractConfig, 'maxParallelUnits'>): number {
  return contract.isolation === 'shared' ? 1 : Math.max(1, config.maxParallelUnits);
}

/**
 * The one phase every group runs. In worktree mode the phase commits the
 * unit's whole item worktree onto its item branch when the unit passed (the
 * worktree holds only that unit's work), which is what the engine's
 * integration lane then merges into the contract branch. In shared mode it
 * commits nothing: the contract commits its touched paths when the
 * deliverable passes.
 */
export function unitPhases(isolation: Contract['isolation'], capacity: number): PhaseSpec[] {
  return [{ role: 'engineer', capacity, kind: 'engineer', gate: { scope: isolation === 'worktree' ? 'all' : 'off', gates: [] } }];
}

/** What remains of a ceiling after `used`, or undefined when there is no ceiling. Money and token arithmetic, in code. */
export function remainingBudget(ceiling: BudgetCeiling | undefined, used: WorkItemUsage): BudgetCeiling | undefined {
  if (ceiling === undefined) return undefined;
  const tokens = used.inputTokens + used.outputTokens;
  return {
    ...(ceiling.maxTokens === undefined ? {} : { maxTokens: Math.max(0, ceiling.maxTokens - tokens) }),
    ...(ceiling.maxCostUsd === undefined ? {} : { maxCostUsd: Math.max(0, ceiling.maxCostUsd - (used.costUsd ?? 0)) }),
  };
}

/** The work item for one unit: its brief (with "Previous checks" once it was checked), route, tool contract and binding. */
export function unitWorkItem(contract: Contract, group: ContractGroup, unit: ContractUnit): WorkItemSpec {
  if (contract.shape === undefined) throw new Error(`contract ${contract.id} has no request shape`);
  if (unit.route === undefined) throw new Error(`unit ${unit.id} has no route; the route selector must pick one before its agent is spawned`);
  const tools = unitToolContract(unit.role, contract.shape);
  const groupUnitIds = new Set(group.unitIds);
  return {
    id: unit.id,
    title: unit.title,
    task: briefWithPreviousChecks(buildUnitBrief(contract, group, unit), unit),
    dependsOn: unit.dependsOn.filter((id) => groupUnitIds.has(id)),
    contractId: contract.id,
    contractUnitId: unit.id,
    route: unit.route,
    ...(tools.tools === undefined ? {} : { tools: [...tools.tools] }),
    restrictTools: tools.restrictTools,
    template: unitTemplate(unit.role),
    files: [...unit.files],
    ...(unit.attempts > 1 ? { attempts: unit.attempts, autoAcceptWinner: false } : {}),
  };
}

/** The workstream that runs one group. `used` is the contract's usage so far, for the remaining budget. */
export function groupWorkstreamInput(
  contract: Contract,
  group: ContractGroup,
  config: Pick<ContractConfig, 'maxParallelUnits'>,
  used: WorkItemUsage,
): CreateWorkstreamInput {
  const units = group.unitIds.map((unitId) => {
    const unit = contract.units.find((candidate) => candidate.id === unitId);
    if (unit === undefined) throw new Error(`group ${group.id} names unit ${unitId}, which the contract does not have`);
    return unit;
  });
  const budget = remainingBudget(contract.budget, used);
  return {
    id: group.id,
    title: group.title,
    phases: unitPhases(contract.isolation, phaseCapacity(contract, config)),
    items: units.map((unit) => unitWorkItem(contract, group, unit)),
    ...(budget === undefined ? {} : { budget }),
    isolation: contract.isolation,
    releasePolicy: 'reviewed-and-merged',
  };
}

// ── The shared-tree lock (design 6.1) ─────────────────────────────────────────

/** Waiters per shared working tree, first in first out; the head holds the lock. */
const sharedTreeQueues = new Map<string, Array<() => void>>();

function treeKey(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

/**
 * Takes the lock on a shared working tree for every contract in this process.
 * Resolves with the release function once the caller holds it; release is
 * idempotent. `signal` withdraws a caller still waiting (the promise then
 * rejects with the signal's reason).
 */
export function acquireSharedTree(root: string, signal?: AbortSignal): Promise<() => void> {
  const key = treeKey(root);
  const queue = sharedTreeQueues.get(key) ?? [];
  sharedTreeQueues.set(key, queue);
  return new Promise<() => void>((resolveLock, rejectLock) => {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const index = queue.indexOf(grant);
      if (index !== -1) queue.splice(index, 1);
      if (index === 0) queue[0]?.();
      if (queue.length === 0) sharedTreeQueues.delete(key);
    };
    const grant = (): void => {
      signal?.removeEventListener('abort', onAbort);
      resolveLock(release);
    };
    const onAbort = (): void => {
      release();
      rejectLock(signal?.reason instanceof Error ? signal.reason : new Error('stopped while waiting for the shared working tree'));
    };
    if (signal?.aborted) {
      rejectLock(signal.reason instanceof Error ? signal.reason : new Error('stopped while waiting for the shared working tree'));
      if (queue.length === 0) sharedTreeQueues.delete(key);
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    queue.push(grant);
    if (queue.length === 1) grant();
  });
}

/** How many callers hold or wait for a shared tree (tests and status). */
export function sharedTreeWaiters(root: string): number {
  return sharedTreeQueues.get(treeKey(root))?.length ?? 0;
}
