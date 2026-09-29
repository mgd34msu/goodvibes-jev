/**
 * A plan drafted before the contract started (docs/design/contract-runner.md
 * 10.4): a launched plan proposal or workstream draft. Its units become the
 * contract's units as drafted; the planner writes the contract criteria from
 * the draft's goal and the request, each unit's criteria, and the groups that
 * hold the units. Every plan check still runs, and one more code check keeps
 * the planner to the draft.
 */
import type { ContractPlan, PlannedGroup, PlanProblem } from './plan-schema.js';
import type { DraftedPlan, DraftedUnit } from './types.js';

/** The draft as the runner stores it: units numbered `u1`, `u2`... in draft order, dependencies renamed with them. */
export function numberDraft(draft: { readonly goal: string; readonly units: readonly DraftedUnit[] }): DraftedPlan {
  if (draft.units.length === 0) throw new Error('a drafted plan needs at least one unit');
  const ids = new Map<string, string>();
  draft.units.forEach((unit, index) => {
    if (ids.has(unit.id)) throw new Error(`the drafted plan names unit ${unit.id} twice`);
    ids.set(unit.id, `u${index + 1}`);
  });
  return {
    goal: draft.goal,
    units: draft.units.map((unit) => ({
      id: ids.get(unit.id)!,
      title: unit.title,
      brief: unit.brief,
      dependsOn: unit.dependsOn.map((dependency) => {
        const renamed = ids.get(dependency);
        if (renamed === undefined) throw new Error(`drafted unit ${unit.id} depends on ${dependency}, which the draft does not have`);
        return renamed;
      }),
      ...(unit.files === undefined ? {} : { files: [...unit.files] }),
      ...(unit.attempts === undefined ? {} : { attempts: unit.attempts }),
    })),
  };
}

/** The planner request's section for a drafted plan. */
export function draftSection(draft: DraftedPlan): string {
  return [
    '## The plan already drafted',
    'This plan was drafted and approved before the contract started. Keep every drafted unit with its id, title and brief exactly as written, and give it the role its brief calls for.',
    'Keep every drafted dependency: a unit that depends on another is either in the same group with that unit in its "dependsOn", or in a group that depends, directly or through other groups, on the group holding that unit.',
    'Write the goal and the contract criteria from the draft\'s goal and the request, and the criteria of every unit. Add no units except the integration unit the rules require for a plan with more than one unit.',
    '```json',
    JSON.stringify(draft, null, 2),
    '```',
  ].join('\n');
}

function problem(message: string, targetId?: string): PlanProblem {
  return { code: 'draft-changed', message, ...(targetId === undefined ? {} : { targetId }) };
}

/** Group ids a group depends on, directly or through other groups. */
function groupAncestors(groups: readonly PlannedGroup[], groupId: string): Set<string> {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const seen = new Set<string>();
  const stack = [...(byId.get(groupId)?.dependsOn ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(byId.get(next)?.dependsOn ?? []));
  }
  return seen;
}

/**
 * Whether the plan kept the draft (a code check, like the other structure
 * checks: ids, texts and graph edges are compared exactly). Every drafted
 * unit is there with its title, brief and attempts; every drafted dependency
 * is kept inside a group or by the group order; no unit is added except an
 * integration unit.
 */
export function checkDraftFidelity(plan: ContractPlan, draft: DraftedPlan): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const placed = new Map<string, { readonly group: PlannedGroup; readonly unit: PlannedGroup['units'][number] }>();
  for (const group of plan.groups) for (const unit of group.units) placed.set(unit.id, { group, unit });
  const drafted = new Set(draft.units.map((unit) => unit.id));

  for (const unit of draft.units) {
    const found = placed.get(unit.id);
    if (found === undefined) {
      problems.push(problem(`Drafted unit ${unit.id} ("${unit.title}") is missing from the plan.`, unit.id));
      continue;
    }
    if (found.unit.title !== unit.title) problems.push(problem(`Unit ${unit.id} must keep its drafted title "${unit.title}".`, unit.id));
    if (found.unit.brief !== unit.brief) problems.push(problem(`Unit ${unit.id} must keep its drafted brief word for word.`, unit.id));
    if (unit.attempts !== undefined && found.unit.attempts !== unit.attempts) {
      problems.push(problem(`Unit ${unit.id} was drafted with ${unit.attempts} attempts.`, unit.id));
    }
    for (const dependency of unit.dependsOn) {
      const other = placed.get(dependency);
      if (other === undefined) continue;
      const sameGroup = other.group.id === found.group.id && found.unit.dependsOn.includes(dependency);
      const byGroupOrder = groupAncestors(plan.groups, found.group.id).has(other.group.id);
      if (!sameGroup && !byGroupOrder) {
        problems.push(problem(`Unit ${unit.id} depends on ${dependency} in the draft; the plan must keep that order.`, unit.id));
      }
    }
  }
  for (const [id, { unit }] of placed) {
    if (!drafted.has(id) && unit.role !== 'integration') {
      problems.push(problem(`Unit ${id} ("${unit.title}") is not in the draft; only the integration unit may be added.`, id));
    }
  }
  return problems;
}
