/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Plan proposal to contract (docs/design/contract-runner.md 10.4).
 * `draftFromProposal()` maps a PlanProposal (platform/core/plan-proposal.ts,
 * produced by the planner decomposition pipeline) into a `DraftedPlan`, and
 * `fromPlanProposal()` launches that plan as a contract through
 * `runner.startFromPlan`: the planner keeps the drafted units, writes their
 * criteria and the contract criteria from the proposal's goal, and every plan
 * check runs.
 *
 * The mapping:
 *  - ONE drafted unit per proposal work item. The item's `title` is the unit's
 *    title and its `brief` the unit's brief, kept verbatim. The item's id is
 *    carried so `dependsOn` lines up; the runner renumbers the ids to u1..
 *    itself.
 *  - Inter-item dependencies carry over as the unit's `dependsOn`.
 *  - `likelyFiles` becomes the unit's `files`; a best-of-N `attempts` count
 *    carries through as the unit's `attempts`.
 *  - The proposal's task is the plan's goal and the contract's ask.
 *
 * Assert at assembly: `assemblePlanProposal` already rejects dangling
 * dependencies and cycles, but a caller could hand in a hand-built or mutated
 * proposal that never went through the assembler, so both are checked again
 * here and a violation THROWS rather than launching a plan that would gate a
 * unit on nothing or deadlock every unit in a cycle.
 */
import type { BudgetCeiling } from './types.js';
import type { PlanProposal } from '../core/plan-proposal.js';
import type { ContractRunner, StartedContract } from '../contract/runner.js';
import type { DraftedPlan, DraftedUnit } from '../contract/types.js';

/** What a proposal launch needs beyond the proposal itself. */
export interface ProposalLaunchInput {
  readonly sessionId: string;
  readonly projectRoot: string;
  readonly isolation?: 'auto' | 'worktree' | 'shared' | undefined;
  /** The conversation agent that asked, when there is one. */
  readonly parentAgentId?: string | undefined;
  readonly budget?: BudgetCeiling | undefined;
}

/** Throws if any item's `dependsOn` references an unknown item, or if the dependency graph contains a cycle. */
function assertAcyclicAndResolved(proposal: PlanProposal): void {
  const ids = new Set(proposal.workItems.map((wi) => wi.id));
  const byId = new Map(proposal.workItems.map((wi) => [wi.id, wi] as const));

  for (const wi of proposal.workItems) {
    for (const dep of wi.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(
          `fromPlanProposal: work item "${wi.title}" (${wi.id}) depends on unknown item id "${dep}", the proposal is not internally consistent`,
        );
      }
    }
  }

  // Iterative DFS cycle detection over ids (white/grey/black).
  const state = new Map<string, 'visiting' | 'done'>();
  const onCycle = (id: string): never => {
    const title = byId.get(id)?.title ?? id;
    throw new Error(`fromPlanProposal: dependency cycle detected involving work item "${title}" (${id}), cannot launch a plan that would deadlock`);
  };
  const visit = (start: string): void => {
    const stack: Array<{ id: string; deps: string[]; i: number }> = [{ id: start, deps: byId.get(start)?.dependsOn ?? [], i: 0 }];
    state.set(start, 'visiting');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.i >= frame.deps.length) {
        state.set(frame.id, 'done');
        stack.pop();
        continue;
      }
      const next = frame.deps[frame.i++]!;
      const seen = state.get(next);
      if (seen === 'visiting') onCycle(next);
      if (seen === 'done') continue;
      state.set(next, 'visiting');
      stack.push({ id: next, deps: byId.get(next)?.dependsOn ?? [], i: 0 });
    }
  };
  for (const wi of proposal.workItems) {
    if (!state.has(wi.id)) visit(wi.id);
  }
}

/** The drafted plan for a proposal: one unit per work item. Throws on a dangling dependency or a cycle. */
export function draftFromProposal(proposal: PlanProposal): DraftedPlan {
  assertAcyclicAndResolved(proposal);
  const units: DraftedUnit[] = proposal.workItems.map((wi) => ({
    id: wi.id,
    title: wi.title,
    brief: wi.brief,
    dependsOn: [...wi.dependsOn],
    ...(wi.likelyFiles !== undefined && wi.likelyFiles.length > 0 ? { files: [...wi.likelyFiles] } : {}),
    ...(wi.attempts !== undefined ? { attempts: wi.attempts } : {}),
  }));
  return { goal: proposal.task, units };
}

/** Launches the proposal as a contract through `runner.startFromPlan`. Throws on a dangling dependency or a cycle, before anything starts. */
export function fromPlanProposal(
  runner: Pick<ContractRunner, 'startFromPlan'>,
  proposal: PlanProposal,
  launch: ProposalLaunchInput,
): StartedContract {
  const draft = draftFromProposal(proposal);
  return runner.startFromPlan({
    ask: proposal.task,
    sessionId: launch.sessionId,
    origin: 'proposal',
    projectRoot: launch.projectRoot,
    draft,
    ...(launch.isolation !== undefined ? { isolation: launch.isolation } : {}),
    ...(launch.parentAgentId !== undefined ? { parentAgentId: launch.parentAgentId } : {}),
    ...(launch.budget !== undefined ? { budget: launch.budget } : {}),
  });
}

/**
 * Approve-and-launch as ONE confirmed act: build the drafted plan and start
 * its contract in a single call. The `confirm: true` flag is the explicit
 * confirmation; without it nothing starts (a structured refusal, not a throw),
 * so a surface renders proposal -> confirm -> running through this one
 * function.
 */
export function approveAndLaunchProposal(
  runner: Pick<ContractRunner, 'startFromPlan'>,
  proposal: PlanProposal,
  launch: ProposalLaunchInput,
  opts: { readonly confirm?: boolean | undefined } = {},
): { launched: true; contractId: string; ownerAgentId: string } | { launched: false; requiresConfirm: true } {
  if (opts.confirm !== true) {
    return { launched: false, requiresConfirm: true };
  }
  const started = fromPlanProposal(runner, proposal, launch);
  return { launched: true, contractId: started.contract.id, ownerAgentId: started.owner.id };
}
