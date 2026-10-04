/**
 * Planned-fix groups (docs/design/contract-runner.md section 5.2): the
 * planning model receives a target (a unit, a group or the deliverable), the
 * criteria that are not met or not shown with their latest readings and
 * severities, the last evidence and nudges, and returns a fix plan in the
 * contract plan's schema with one group. Code checks it here; the Jev unit
 * checks (role, scope) run on its units; trace and coverage are not asked
 * again, since fix criteria serve target criteria that already trace to the
 * user.
 *
 * The fix group becomes ordinary contract structure: group `<target>.f<round>`
 * of kind `fix`, units `<group>.u<n>` whose criteria have origin `fix` and
 * serve the target's criteria, with shared-file serialization edges between
 * units (orchestration/task-graph.ts).
 */
import { emptyWorkItemUsage } from '../orchestration/types.js';
import { planTaskGraph, type TaskSeverity } from '../orchestration/task-graph.js';
import { wouldCreateCycle } from '../orchestration/graph-dynamics.js';
import { UNIT_ROLES } from '../../events/contract.js';
import type { ContractConfig } from './config.js';
import { latestSeverity } from './nudge.js';
import { parseContractPlan, type ContractPlan, type PlannedGroup, type PlanProblem } from './plan-schema.js';
import type { ContractGroup, ContractUnit, Criterion, NativeContractSource, UnitRole } from './types.js';

/** The part a fix group repairs. */
export type FixScope = 'unit' | 'group' | 'deliverable';

/** What the fix planner is told about the target. */
export interface FixBrief {
  /** Complete root source, retained even when repairing only one derived unit. */
  readonly nativeSource?: NativeContractSource | undefined;
  readonly scope: FixScope;
  readonly targetId: string;
  readonly title: string;
  readonly goal: string;
  /** The target's judged criteria, with their current status. */
  readonly criteria: readonly Criterion[];
  /** Criteria the fix must serve: every one not met or not shown. */
  readonly requiredIds: readonly string[];
  /** The last corrections sent (unit targets), newest last. */
  readonly lastNudges: readonly string[];
  /** Failing gates, each with the tail of its output. */
  readonly gateFailures: readonly string[];
  /** The target's output: the unit's report, the group's unit answers, or the contract's answer. */
  readonly output: string;
  /** Files the target's work touched so far. */
  readonly touchedPaths: readonly string[];
  /** A merge conflict the fix must resolve. */
  readonly conflict?: { readonly branch: string; readonly files: readonly string[] } | undefined;
}

/** Fix units may do these kinds of work; integration belongs to the plan's integration group, and checking is Jev's. */
const FIX_ROLES: readonly UnitRole[] = UNIT_ROLES.filter((role) => role !== 'integration');

/** The fix planner's system prompt. */
export function buildFixPlannerPrompt(): string {
  return [
    'You plan a repair: one group of units that fixes what a contract check found wrong with one part of the work.',
    'Read the repository as much as you need with your read-only tools, then answer with exactly one fenced ```json block of this shape and nothing after it:',
    '',
    '```json',
    '{',
    '  "goal": "one sentence: what the repair achieves",',
    '  "criteria": [],',
    '  "groups": [',
    '    {',
    '      "id": "g1", "kind": "fix", "title": "...", "goal": "...", "dependsOn": [],',
    '      "units": [',
    '        {',
    '          "id": "u1", "title": "...", "goal": "...", "role": "implement",',
    '          "brief": "exactly what to change, where, and why",',
    '          "dependsOn": [], "files": ["src/a.ts"],',
    '          "criteria": [ { "id": "u1.c1", "text": "checkable requirement", "serves": ["<id of a criterion of the part being repaired>"] } ]',
    '        }',
    '      ]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Rules:',
    '- Exactly one group. Units are "u1", "u2"...; a unit "dependsOn" names other units of the group; no cycles.',
    '- Every unit has at least one criterion, and every criterion lists in "serves" the criteria of the repaired part it serves.',
    '- Every criterion of the repaired part listed as not met or not shown is served by at least one unit criterion.',
    '- Roles: "implement" (changes files), "research" (reads and reports, changes nothing), "design" (answers with a plan, changes nothing).',
    '- There are no review, test or verification units: every unit is checked against its criteria as it goes. Put "the tests for X pass" in the criteria of the unit that fixes X.',
    '- Units that do not depend on each other run at the same time; units that change the same file are run one after another.',
    '- A unit must not undo what already works: the criteria listed as met stay met.',
  ].join('\n');
}

function criterionLine(criterion: Criterion): string {
  const severity = latestSeverity(criterion);
  return `- [${criterion.id}] (${criterion.status}${severity === undefined ? '' : `, ${severity}`}) ${criterion.text}`;
}

/** The fix planner's user prompt; on a repair, every problem and the previous plan. */
export function buildFixPlannerRequest(brief: FixBrief, repair?: { readonly problems: readonly PlanProblem[]; readonly previousPlan: string }): string {
  const sections = [
    `## The part to repair (${brief.scope} ${brief.targetId})\nTitle: ${brief.title}\nGoal: ${brief.goal}`,
    '## Its criteria\n' + brief.criteria.map(criterionLine).join('\n'),
    '## Criteria the repair must serve\n' + brief.requiredIds.join(', '),
  ];
  if (brief.nativeSource !== undefined) sections.push('## Immutable native source\nPreserve this complete goal and ordered criteria; repair only derived work.\n' + JSON.stringify(brief.nativeSource));
  if (brief.conflict !== undefined) {
    sections.push(`## Merge conflict\nThe work on branch ${brief.conflict.branch} conflicts with the contract's branch in: ${brief.conflict.files.join(', ')}. Bring that branch's changes in (git merge ${brief.conflict.branch}) and resolve the conflicts so both sides' behaviour is kept.`);
  }
  if (brief.lastNudges.length > 0) sections.push('## The last corrections sent\n' + brief.lastNudges.map((text) => `---\n${text}`).join('\n'));
  if (brief.gateFailures.length > 0) sections.push('## Failing gates\n' + brief.gateFailures.join('\n\n'));
  if (brief.output.trim().length > 0) sections.push('## What the work reported\n' + brief.output);
  if (brief.touchedPaths.length > 0) sections.push('## Files the work changed\n' + brief.touchedPaths.join('\n'));
  if (repair !== undefined) {
    sections.push('## Problems with your previous plan\nFix every one and return the whole corrected plan.\n'
      + repair.problems.map((problem) => `- [${problem.code}${problem.targetId === undefined ? '' : ` ${problem.targetId}`}] ${problem.message}`).join('\n')
      + '\n\nPrevious plan:\n```json\n' + repair.previousPlan + '\n```');
  }
  return sections.join('\n\n');
}

function problem(code: PlanProblem['code'], message: string, targetId?: string): PlanProblem {
  return { code, message, ...(targetId === undefined ? {} : { targetId }) };
}

/** The code checks on a fix plan. Returns the plan's one group when there are no problems. */
export function validateFixPlan(text: string, brief: FixBrief, limits: Pick<ContractConfig, 'maxUnits'>): { readonly group?: PlannedGroup; readonly plan?: ContractPlan; readonly problems: PlanProblem[] } {
  const parsed = parseContractPlan(text);
  if (!parsed.ok) return { problems: [...parsed.problems] };
  const { plan } = parsed;
  if (plan.groups.length !== 1) return { plan, problems: [problem('unparseable', `A fix plan has exactly one group; this one has ${plan.groups.length}.`)] };
  const group = plan.groups[0]!;
  const problems: PlanProblem[] = [];
  if (group.units.length === 0) problems.push(problem('no-units', 'The fix group has no units.'));
  if (group.units.length > limits.maxUnits) problems.push(problem('too-many-units', `The fix group has ${group.units.length} units; the limit is ${limits.maxUnits}.`));
  const targetIds = new Set(brief.criteria.map((criterion) => criterion.id));
  const unitIds = new Set<string>();
  const nodes = group.units.map((unit) => ({ id: unit.id, title: unit.title, dependsOn: [] as string[] }));
  for (const unit of group.units) {
    if (!/^u\d+$/.test(unit.id)) problems.push(problem('bad-id', `Unit id "${unit.id}" does not have the form u<n>.`, unit.id));
    if (unitIds.has(unit.id)) problems.push(problem('duplicate-id', `Unit id "${unit.id}" is used more than once.`, unit.id));
    unitIds.add(unit.id);
    if (!(FIX_ROLES as readonly string[]).includes(unit.role)) {
      problems.push(problem('unknown-role', `Unit ${unit.id} has role "${unit.role}"; a fix unit's role is one of ${FIX_ROLES.join(', ')}.`, unit.id));
    }
    if (unit.attempts !== undefined && unit.attempts !== 1) problems.push(problem('attempts', `Unit ${unit.id} has ${unit.attempts} attempts; a fix unit runs once.`, unit.id));
    if (unit.criteria.length === 0) problems.push(problem('unit-without-criteria', `Unit ${unit.id} has no criteria.`, unit.id));
    for (const criterion of unit.criteria) {
      if (criterion.serves.length === 0) problems.push(problem('serves-missing', `Criterion ${criterion.id} serves none of the repaired part's criteria.`, criterion.id));
      for (const served of criterion.serves.filter((id) => !targetIds.has(id))) {
        problems.push(problem('serves-unknown', `Criterion ${criterion.id} serves "${served}", which is not a criterion of the part being repaired.`, criterion.id));
      }
    }
  }
  for (const unit of group.units) {
    for (const dep of unit.dependsOn) {
      if (!unitIds.has(dep)) {
        problems.push(problem('unknown-dependency', `Unit ${unit.id} depends on "${dep}", which is not a unit of the fix group.`, unit.id));
        continue;
      }
      const cycle = wouldCreateCycle({ items: nodes }, unit.id, dep);
      if (cycle !== null) problems.push(problem('cycle', `Unit ${unit.id} depending on ${dep} makes a cycle: ${cycle.join(' -> ')}.`, unit.id));
      else nodes.find((node) => node.id === unit.id)!.dependsOn.push(dep);
    }
  }
  const served = new Set(group.units.flatMap((unit) => unit.criteria.flatMap((criterion) => criterion.serves)));
  for (const id of brief.requiredIds.filter((required) => !served.has(required))) {
    problems.push(problem('uncovered-criterion', `No fix unit criterion serves ${id}, which is not met or not shown.`, id));
  }
  return problems.length > 0 ? { plan, problems } : { plan, group, problems };
}

/**
 * Where a fix unit goes in the serialization order of fix units that change
 * the same file (orchestration/task-graph.ts): the most severe latest severity
 * among the criteria it serves. A unit whose criteria have no severity read
 * (unshown criteria, or a reading below act) takes the middle place, after one
 * read critical and before one read only minor. The rank orders work and is
 * reported nowhere.
 */
function severityOf(serves: readonly string[], criteria: readonly Criterion[]): TaskSeverity {
  const read = criteria.filter((criterion) => serves.includes(criterion.id)).map(latestSeverity);
  if (read.includes('critical')) return 'critical';
  if (read.includes('minor') && !read.includes('major') && read.every((severity) => severity !== undefined)) return 'minor';
  return 'major';
}

/**
 * The fix group and its units for the contract tree: fresh ids under
 * `<target>.f<round>`, criteria with origin `fix`, and dependency edges from
 * the plan plus shared-file serialization, most severe first.
 */
export function buildFixGroup(brief: FixBrief, round: number, planned: PlannedGroup): { readonly group: ContractGroup; readonly units: ContractUnit[] } {
  const groupId = `${brief.targetId}.f${round}`;
  const idOf = new Map(planned.units.map((unit, index) => [unit.id, `${groupId}.u${index + 1}`]));
  const { specs } = planTaskGraph(planned.units.map((unit) => ({
    id: idOf.get(unit.id)!,
    title: unit.title,
    task: unit.brief,
    severity: severityOf(unit.criteria.flatMap((criterion) => criterion.serves), brief.criteria),
    files: unit.files,
    dependsOn: unit.dependsOn.map((dep) => idOf.get(dep)!),
  })));
  const units = planned.units.map((unit, index): ContractUnit => {
    const id = idOf.get(unit.id)!;
    return {
      id,
      groupId,
      title: unit.title,
      goal: unit.goal,
      brief: unit.brief,
      role: unit.role as UnitRole,
      dependsOn: specs[index]!.dependsOn ?? [],
      files: [...unit.files],
      attempts: 1,
      criteria: unit.criteria.map((criterion, k): Criterion => ({
        id: `${id}.c${k + 1}`,
        text: criterion.text,
        origin: 'fix',
        serves: [...criterion.serves],
        disposition: 'judged',
        status: 'unread',
        readings: [],
      })),
      status: 'pending',
      agentIds: [],
      checks: [],
      nudges: [],
      fixRounds: 0,
      freshAgents: 0,
      transportRetries: 0,
      touchedPaths: [],
      usage: emptyWorkItemUsage(),
    };
  });
  const group: ContractGroup = {
    id: groupId,
    title: planned.title,
    goal: planned.goal,
    kind: 'fix',
    repairs: { scope: brief.scope, targetId: brief.targetId, criterionIds: [...brief.requiredIds] },
    dependsOn: [],
    criteria: [],
    unitIds: units.map((unit) => unit.id),
    status: 'pending',
    checks: [],
    fixRounds: 0,
    usage: emptyWorkItemUsage(),
  };
  return { group, units };
}

/**
 * A fresh agent for a unit whose own work item already closed (worktree mode,
 * after its work merged): a one-unit fix group built in code, carrying the
 * unit's brief and its criteria verbatim.
 */
export function buildFreshGroup(unit: ContractUnit, round: number): { readonly group: ContractGroup; readonly units: ContractUnit[] } {
  const judged = unit.criteria.filter((criterion) => criterion.disposition === 'judged');
  return buildFixGroup(
    { scope: 'unit', targetId: unit.id, title: unit.title, goal: unit.goal, criteria: judged, requiredIds: judged.map((criterion) => criterion.id), lastNudges: [], gateFailures: [], output: '', touchedPaths: unit.touchedPaths },
    round,
    {
      id: 'g1',
      title: `Fresh start on ${unit.title}`,
      goal: unit.goal,
      kind: 'fix',
      dependsOn: [],
      criteria: [],
      units: [{
        id: 'u1',
        title: unit.title,
        goal: unit.goal,
        role: unit.role === 'integration' ? 'implement' : unit.role,
        brief: `${unit.brief}\n\nThe earlier attempt at this work is already in the tree; start from it with a clean approach and bring every criterion to met.`,
        dependsOn: [],
        files: [...unit.files],
        attempts: 1,
        criteria: judged.map((criterion) => ({ id: criterion.id, text: criterion.text, serves: [criterion.id] })),
      }],
    },
  );
}
