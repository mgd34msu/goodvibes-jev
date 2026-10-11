/**
 * The contract plan the planning model writes (docs/design/contract-runner.md
 * sections 3.2 and 3.3): its JSON shape, `parseContractPlan`, and
 * `validateContractPlan`, the deterministic checks that run before any Jev
 * check. Everything here is code: ids, graphs, counts and string matches are
 * never judged.
 */
import { checkNativeSourcePlan } from './native-source.js';
import { normalizeForMatch } from '@goodvibes-jev/judgment';
import { GROUP_KINDS, UNIT_ROLES, type ContractPlanProblem } from '../../events/contract.js';
import { PLANNER_DECOMPOSITION_TOOLS } from '../agents/planner-decomposition-runner.js';
import { wouldCreateCycle, type GraphNode } from '../orchestration/graph-dynamics.js';
import { MAX_ATTEMPTS } from '../orchestration/types.js';
import { delegationForbidden, saysYesAtAct } from './batteries/request-shape.js';
import type { GroupKind, NativeContractSource, RequestShape, UnitRole } from './types.js';

// ── The plan ──────────────────────────────────────────────────────────────────

/** A contract criterion as planned: the user's words it comes from are required. */
export interface PlannedStatedCriterion {
  readonly id: string;
  readonly text: string;
  /** Absent only in a plan that failed to give one (check 4 reports it). */
  readonly quote: string | undefined;
}

/** A group or unit criterion as planned: the contract criteria it serves. */
export interface PlannedDerivedCriterion {
  readonly id: string;
  readonly text: string;
  readonly serves: readonly string[];
}

export interface PlannedUnit {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  /** As written; `validateContractPlan` reports a value outside UNIT_ROLES. */
  readonly role: string;
  readonly brief: string;
  readonly dependsOn: readonly string[];
  readonly files: readonly string[];
  /** Absent means the configured default (`contract.defaultAttempts`). */
  readonly attempts: number | undefined;
  readonly criteria: readonly PlannedDerivedCriterion[];
}

export interface PlannedGroup {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly kind: GroupKind;
  readonly dependsOn: readonly string[];
  readonly criteria: readonly PlannedDerivedCriterion[];
  readonly units: readonly PlannedUnit[];
}

export interface ContractPlan {
  readonly goal: string;
  readonly criteria: readonly PlannedStatedCriterion[];
  readonly groups: readonly PlannedGroup[];
}

/** One thing wrong with a plan: a code check or a Jev check found it. */
export type PlanProblem = ContractPlanProblem & { readonly code: PlanProblemCode };

/** Every problem code, in the order the checks run. */
export const PLAN_PROBLEM_CODES = [
  // Parsing.
  'unparseable',
  // Check 1: ids and graphs.
  'bad-id', 'duplicate-id', 'unknown-dependency', 'cycle',
  // Check 2: criteria present and linked.
  'no-criteria', 'no-units', 'empty-group', 'unit-without-criteria', 'serves-missing', 'serves-unknown',
  // Roles and group kinds the plan may use.
  'unknown-role', 'group-kind',
  // Check 3: coverage by counting.
  'uncovered-criterion',
  // Check 4: quotes.
  'quote-not-found',
  // Check 5: the integration group.
  'integration-missing', 'integration-shape', 'integration-unexpected',
  // Check 6: a parallel request honoured.
  'parallel-missing',
  // Check 7: attempts.
  'attempts',
  // Check 8: size.
  'too-many-units',
  // A drafted plan kept (draft-plan.ts).
  'draft-changed', 'native-source-changed',
  // Jev checks (plan-checks.ts).
  'untraced', 'uncovered-requirement', 'not-checkable', 'verification-unit', 'role-mismatch', 'narrows',
] as const;
export type PlanProblemCode = (typeof PLAN_PROBLEM_CODES)[number];

function problem(code: PlanProblemCode, message: string, targetId?: string): PlanProblem {
  return { code, message, ...(targetId === undefined ? {} : { targetId }) };
}

// ── Parsing ───────────────────────────────────────────────────────────────────

export type ParsedContractPlan =
  | { readonly ok: true; readonly plan: ContractPlan; /** The JSON text the plan was parsed from. */ readonly json: string }
  | { readonly ok: false; readonly problems: readonly PlanProblem[] };

const FENCED_BLOCK = /```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi;

/** The last fenced code block in `text`, or undefined when there is none. */
export function lastFencedBlock(text: string): string | undefined {
  let last: string | undefined;
  for (const match of text.matchAll(FENCED_BLOCK)) last = match[1];
  return last;
}

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reads one JSON object into typed fields, collecting every field error rather than stopping at the first. */
class FieldReader {
  readonly errors: string[] = [];

  string(object: Json, key: string, where: string, options: { readonly optional?: boolean } = {}): string | undefined {
    const value = object[key];
    if (value === undefined && options.optional) return undefined;
    if (typeof value === 'string' && value.trim().length > 0) return value;
    this.errors.push(`${where}.${key} must be a non-empty string`);
    return undefined;
  }

  strings(object: Json, key: string, where: string): readonly string[] {
    const value = object[key];
    if (value === undefined) return [];
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value as string[];
    this.errors.push(`${where}.${key} must be an array of strings`);
    return [];
  }

  objects(object: Json, key: string, where: string, options: { readonly optional?: boolean } = {}): readonly Json[] {
    const value = object[key];
    if (value === undefined && options.optional) return [];
    if (Array.isArray(value) && value.every(isObject)) return value;
    this.errors.push(`${where}.${key} must be an array of objects`);
    return [];
  }
}

function readDerived(reader: FieldReader, raw: Json, where: string): PlannedDerivedCriterion {
  return {
    id: reader.string(raw, 'id', where) ?? '',
    text: reader.string(raw, 'text', where) ?? '',
    serves: reader.strings(raw, 'serves', where),
  };
}

function readUnit(reader: FieldReader, raw: Json, where: string): PlannedUnit {
  const attempts = raw['attempts'];
  if (attempts !== undefined && typeof attempts !== 'number') reader.errors.push(`${where}.attempts must be a number`);
  return {
    id: reader.string(raw, 'id', where) ?? '',
    title: reader.string(raw, 'title', where) ?? '',
    goal: reader.string(raw, 'goal', where) ?? '',
    role: reader.string(raw, 'role', where) ?? '',
    brief: reader.string(raw, 'brief', where) ?? '',
    dependsOn: reader.strings(raw, 'dependsOn', where),
    files: reader.strings(raw, 'files', where),
    attempts: typeof attempts === 'number' ? attempts : undefined,
    criteria: reader.objects(raw, 'criteria', where).map((criterion, index) => readDerived(reader, criterion, `${where}.criteria[${index}]`)),
  };
}

function readGroup(reader: FieldReader, raw: Json, where: string): PlannedGroup {
  const kind = raw['kind'] ?? 'work';
  if (typeof kind !== 'string' || !(GROUP_KINDS as readonly string[]).includes(kind)) {
    reader.errors.push(`${where}.kind must be one of ${GROUP_KINDS.join(', ')}`);
  }
  return {
    id: reader.string(raw, 'id', where) ?? '',
    title: reader.string(raw, 'title', where) ?? '',
    goal: reader.string(raw, 'goal', where) ?? '',
    kind: (GROUP_KINDS as readonly string[]).includes(kind as string) ? (kind as GroupKind) : 'work',
    dependsOn: reader.strings(raw, 'dependsOn', where),
    criteria: reader.objects(raw, 'criteria', where, { optional: true }).map((criterion, index) => readDerived(reader, criterion, `${where}.criteria[${index}]`)),
    units: reader.objects(raw, 'units', where).map((unit, index) => readUnit(reader, unit, `${where}.units[${index}]`)),
  };
}

/**
 * Parses the planner's output: the last fenced JSON block, read field by
 * field. Anything unreadable is one `unparseable` problem per fault, so a
 * repair request names every one of them.
 */
export function parseContractPlan(text: string): ParsedContractPlan {
  const json = lastFencedBlock(text);
  if (json === undefined) return { ok: false, problems: [problem('unparseable', 'The answer has no fenced JSON block; return the plan as exactly one ```json block.')] };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    return { ok: false, problems: [problem('unparseable', `The JSON block does not parse: ${error instanceof Error ? error.message : String(error)}`)] };
  }
  if (!isObject(raw)) return { ok: false, problems: [problem('unparseable', 'The JSON block must be one object with goal, criteria and groups.')] };
  const reader = new FieldReader();
  const plan: ContractPlan = {
    goal: reader.string(raw, 'goal', 'plan') ?? '',
    criteria: reader.objects(raw, 'criteria', 'plan').map((criterion, index) => {
      const where = `plan.criteria[${index}]`;
      return {
        id: reader.string(criterion, 'id', where) ?? '',
        text: reader.string(criterion, 'text', where) ?? '',
        quote: typeof criterion['quote'] === 'string' && criterion['quote'].trim().length > 0 ? criterion['quote'] : undefined,
      };
    }),
    groups: reader.objects(raw, 'groups', 'plan').map((group, index) => readGroup(reader, group, `plan.groups[${index}]`)),
  };
  if (reader.errors.length > 0) return { ok: false, problems: reader.errors.map((error) => problem('unparseable', error)) };
  return { ok: true, plan, json };
}

/** The plan as the JSON text the planner is shown on a repair. */
export function renderContractPlan(plan: ContractPlan): string {
  return JSON.stringify(plan, null, 2);
}

// ── Plan queries ──────────────────────────────────────────────────────────────

export function planUnits(plan: ContractPlan): readonly PlannedUnit[] {
  return plan.groups.flatMap((group) => group.units);
}

export function isUnitRole(role: string): role is UnitRole {
  return (UNIT_ROLES as readonly string[]).includes(role);
}

/** Whether a dependency path leads from `fromId` to `toId` among `nodes`. */
function reaches(nodes: readonly GraphNode[], fromId: string, toId: string): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const stack = [fromId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === toId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) stack.push(dep);
  }
  return false;
}

/**
 * The first group holding two units with no dependency path between them,
 * which is what honouring a request for parallel agents means (check 6).
 */
export function findParallelGroup(plan: ContractPlan): PlannedGroup | undefined {
  return plan.groups.find((group) => {
    const units = group.units;
    for (let i = 0; i < units.length; i += 1) {
      for (let j = i + 1; j < units.length; j += 1) {
        const a = units[i]!.id;
        const b = units[j]!.id;
        if (!reaches(units, a, b) && !reaches(units, b, a)) return true;
      }
    }
    return false;
  });
}

/** Attempts a unit runs with: its own, else the configured default. */
export function effectiveAttempts(unit: PlannedUnit, defaultAttempts: number): number {
  return unit.attempts ?? defaultAttempts;
}

// ── Code checks ───────────────────────────────────────────────────────────────

/** The settings the code checks read. */
export interface PlanLimits {
  /** `contract.maxUnits`. */
  readonly maxUnits: number;
  /** `contract.defaultAttempts`. */
  readonly defaultAttempts: number;
}

const GROUP_ID = /^g\d+$/;
const UNIT_ID = /^u\d+$/;
const CONTRACT_CRITERION_ID = /^c\d+$/;

function ownedCriterionId(ownerId: string, id: string): boolean {
  return id.startsWith(`${ownerId}.c`) && /^\d+$/.test(id.slice(ownerId.length + 2));
}

/** Check 1: id formats, uniqueness, dependencies in scope, and no cycles. */
function checkIdsAndGraphs(plan: ContractPlan): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const seen = new Set<string>();
  const claim = (id: string, pattern: (id: string) => boolean, expected: string): void => {
    if (!pattern(id)) problems.push(problem('bad-id', `Id "${id}" does not have the form ${expected}.`, id));
    if (seen.has(id)) problems.push(problem('duplicate-id', `Id "${id}" is used more than once; every id must be unique.`, id));
    seen.add(id);
  };
  for (const criterion of plan.criteria) claim(criterion.id, (id) => CONTRACT_CRITERION_ID.test(id), 'c<n>');
  for (const group of plan.groups) {
    claim(group.id, (id) => GROUP_ID.test(id), 'g<n>');
    for (const criterion of group.criteria) claim(criterion.id, (id) => ownedCriterionId(group.id, id), `${group.id}.c<n>`);
    for (const unit of group.units) {
      claim(unit.id, (id) => UNIT_ID.test(id), 'u<n>');
      for (const criterion of unit.criteria) claim(criterion.id, (id) => ownedCriterionId(unit.id, id), `${unit.id}.c<n>`);
    }
  }
  problems.push(...checkGraph(plan.groups, 'group', 'group'));
  for (const group of plan.groups) problems.push(...checkGraph(group.units, 'unit', `unit in group ${group.id}`));
  return problems;
}

/**
 * Every dependency names a node in the same scope, and adding the edges one by
 * one never closes a cycle (the engine's own cycle test, edge by edge).
 */
function checkGraph(nodes: readonly GraphNode[], kind: 'group' | 'unit', scope: string): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const ids = new Set(nodes.map((node) => node.id));
  const built: { id: string; title: string; dependsOn: string[] }[] = nodes.map((node) => ({ id: node.id, title: node.id, dependsOn: [] }));
  const graph = { items: built };
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!ids.has(dep)) {
        problems.push(problem('unknown-dependency', `${kind} ${node.id} depends on "${dep}", which is not a ${scope}.`, node.id));
        continue;
      }
      const cycle = wouldCreateCycle(graph, node.id, dep);
      if (cycle !== null) {
        problems.push(problem('cycle', `${kind} ${node.id} depending on ${dep} makes a cycle: ${cycle.join(' -> ')}.`, node.id));
        continue;
      }
      built.find((entry) => entry.id === node.id)!.dependsOn.push(dep);
    }
  }
  return problems;
}

/** Check 2: criteria exist, every unit has some, and every derived criterion serves contract criteria. */
function checkCriteriaLinks(plan: ContractPlan): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const contractIds = new Set(plan.criteria.map((criterion) => criterion.id));
  if (plan.criteria.length === 0) problems.push(problem('no-criteria', 'The plan has no contract criteria; list what the user requires, each with their words.'));
  if (planUnits(plan).length === 0) problems.push(problem('no-units', 'The plan has no units.'));
  const checkServes = (criterion: PlannedDerivedCriterion): void => {
    if (criterion.serves.length === 0) {
      problems.push(problem('serves-missing', `Criterion ${criterion.id} serves no contract criterion; name the contract criteria it serves.`, criterion.id));
    }
    for (const id of criterion.serves.filter((served) => !contractIds.has(served))) {
      problems.push(problem('serves-unknown', `Criterion ${criterion.id} serves "${id}", which is not a contract criterion.`, criterion.id));
    }
  };
  for (const group of plan.groups) {
    if (group.units.length === 0) problems.push(problem('empty-group', `Group ${group.id} has no units.`, group.id));
    group.criteria.forEach(checkServes);
    for (const unit of group.units) {
      if (unit.criteria.length === 0) problems.push(problem('unit-without-criteria', `Unit ${unit.id} has no acceptance criteria.`, unit.id));
      unit.criteria.forEach(checkServes);
    }
  }
  return problems;
}

/** Roles and group kinds a contract plan may use. */
function checkRolesAndKinds(plan: ContractPlan): PlanProblem[] {
  const problems: PlanProblem[] = [];
  for (const group of plan.groups) {
    if (group.kind === 'fix') {
      problems.push(problem('group-kind', `Group ${group.id} has kind "fix"; a contract plan has only work groups and one integration group.`, group.id));
    }
    for (const unit of group.units.filter((planned) => !isUnitRole(planned.role))) {
      problems.push(problem(
        'unknown-role',
        `Unit ${unit.id} has role "${unit.role}"; the roles are ${UNIT_ROLES.join(', ')}. Checking other units' work is not a unit: put the check in the criteria of the unit it would check.`,
        unit.id,
      ));
    }
  }
  return problems;
}

/** Check 3: every contract criterion is served by at least one unit criterion. */
function checkCoverage(plan: ContractPlan): PlanProblem[] {
  const served = new Set(planUnits(plan).flatMap((unit) => unit.criteria.flatMap((criterion) => criterion.serves)));
  return plan.criteria
    .filter((criterion) => !served.has(criterion.id))
    .map((criterion) => problem('uncovered-criterion', `No unit criterion serves contract criterion ${criterion.id} ("${criterion.text}").`, criterion.id));
}

/** Check 4: every contract criterion quotes the ask verbatim. */
function checkQuotes(plan: ContractPlan, ask: string): PlanProblem[] {
  const haystack = normalizeForMatch(ask);
  const problems: PlanProblem[] = [];
  for (const criterion of plan.criteria) {
    if (criterion.quote === undefined) {
      problems.push(problem('quote-not-found', `Contract criterion ${criterion.id} has no quote; give the user's exact words it comes from.`, criterion.id));
    } else if (!haystack.includes(normalizeForMatch(criterion.quote))) {
      problems.push(problem('quote-not-found', `The quote for ${criterion.id} ("${criterion.quote}") is not in the user's request; quote their exact words.`, criterion.id));
    }
  }
  return problems;
}

/** Check 5: a multi-unit plan ends with exactly one integration group; a single-unit plan has none. */
function checkIntegration(plan: ContractPlan): PlanProblem[] {
  const units = planUnits(plan);
  const integrationGroups = plan.groups.filter((group) => group.kind === 'integration');
  if (units.length <= 1) {
    const extra = [
      ...integrationGroups.map((group) => group.id),
      ...units.filter((unit) => unit.role === 'integration').map((unit) => unit.id),
    ];
    return extra.map((id) => problem('integration-unexpected', `A single-unit plan has no integration group or integration unit; remove ${id}.`, id));
  }
  if (integrationGroups.length === 0) {
    return [problem('integration-missing', 'A plan with more than one unit ends with one group of kind "integration" holding one unit with role "integration" that depends on every other group.')];
  }
  const problems: PlanProblem[] = [];
  if (integrationGroups.length > 1) {
    problems.push(problem('integration-shape', `The plan has ${integrationGroups.length} integration groups; it needs exactly one.`, integrationGroups[1]!.id));
  }
  const integration = integrationGroups[0]!;
  if (plan.groups[plan.groups.length - 1] !== integration) {
    problems.push(problem('integration-shape', `Integration group ${integration.id} must be the last group.`, integration.id));
  }
  const missing = plan.groups.filter((group) => group !== integration && !integration.dependsOn.includes(group.id)).map((group) => group.id);
  if (missing.length > 0) {
    problems.push(problem('integration-shape', `Integration group ${integration.id} must depend on every other group; add ${missing.join(', ')}.`, integration.id));
  }
  if (integration.units.length !== 1 || integration.units[0]!.role !== 'integration') {
    problems.push(problem('integration-shape', `Integration group ${integration.id} must hold exactly one unit, with role "integration".`, integration.id));
  }
  for (const group of plan.groups.filter((candidate) => candidate !== integration)) {
    for (const unit of group.units.filter((candidate) => candidate.role === 'integration')) {
      problems.push(problem('integration-shape', `Unit ${unit.id} has role "integration" outside the integration group.`, unit.id));
    }
  }
  return problems;
}

/** Check 6: a request for parallel agents is honoured by a group of independent units. */
function checkParallel(plan: ContractPlan, shape: RequestShape): PlanProblem[] {
  if (!saysYesAtAct(shape.requests_parallel_agents) || planUnits(plan).length <= 1) return [];
  if (findParallelGroup(plan) !== undefined) return [];
  return [problem('parallel-missing', 'The user asked for agents working in parallel: put the independent units in one group with no dependency between them.')];
}

/** Check 7: attempts stay at one unless several were asked for, and never pass MAX_ATTEMPTS. */
function checkAttempts(plan: ContractPlan, shape: RequestShape, limits: PlanLimits): PlanProblem[] {
  const severalAllowed = saysYesAtAct(shape.asks_for_attempts) || limits.defaultAttempts > 1;
  const problems: PlanProblem[] = [];
  for (const unit of planUnits(plan)) {
    const attempts = effectiveAttempts(unit, limits.defaultAttempts);
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
      problems.push(problem('attempts', `Unit ${unit.id} has ${attempts} attempts; attempts is a whole number from 1 to ${MAX_ATTEMPTS}.`, unit.id));
    } else if (attempts > 1 && !severalAllowed) {
      problems.push(problem('attempts', `Unit ${unit.id} has ${attempts} attempts, but the user did not ask for several attempts; set attempts to 1.`, unit.id));
    }
  }
  return problems;
}

/**
 * Check 8: the plan fits `contract.maxUnits`. A contract whose user forbids
 * delegation runs in the session itself (section 6.6), which is one unit.
 */
function checkSize(plan: ContractPlan, shape: RequestShape, limits: PlanLimits): PlanProblem[] {
  const count = planUnits(plan).length;
  if (delegationForbidden(shape) && count > 1) {
    return [problem('too-many-units', `The user does not allow handing the work to other agents, so the plan has exactly one unit; it has ${count}. Merge them into one.`)];
  }
  return count > limits.maxUnits
    ? [problem('too-many-units', `The plan has ${count} units; the limit is ${limits.maxUnits}. Merge related units.`)]
    : [];
}

/**
 * The code checks of section 3.3, all of them, in order. Check 9 (a request
 * that forbids writing) is enforced rather than checked: `unitToolContract`
 * makes every unit read-only.
 */
export function validateContractPlan(plan: ContractPlan, ask: string, shape: RequestShape, limits: PlanLimits, nativeSource?: Pick<NativeContractSource, 'goal' | 'criteria'>): PlanProblem[] {
  return [
    ...checkIdsAndGraphs(plan),
    ...checkCriteriaLinks(plan),
    ...checkRolesAndKinds(plan),
    ...checkCoverage(plan),
    ...(nativeSource === undefined ? checkQuotes(plan, ask) : checkNativeSourcePlan(plan, nativeSource)),
    ...checkIntegration(plan),
    ...checkParallel(plan, shape),
    ...checkAttempts(plan, shape, limits),
    ...checkSize(plan, shape, limits),
  ];
}

/**
 * Problems that leave a plan impossible to run, whoever approves it: the
 * orchestration engine cannot schedule a unit with a missing or circular
 * dependency, a duplicate id, an unknown role, or an attempt count it does not
 * support.
 */
export const UNRUNNABLE_PLAN_PROBLEMS: ReadonlySet<PlanProblemCode> = new Set([
  'native-source-changed', 'unparseable', 'bad-id', 'duplicate-id', 'unknown-dependency', 'cycle', 'no-units', 'empty-group', 'unknown-role', 'group-kind', 'attempts', 'too-many-units',
]);

// ── The tool contract (section 3.4, and check 9) ──────────────────────────────

export interface UnitToolContract {
  /** True when the unit may not change files or run commands. */
  readonly readOnly: boolean;
  /** The tool set a read-only unit is restricted to; absent keeps the template's tools. */
  readonly tools?: readonly string[] | undefined;
  readonly restrictTools: boolean;
}

/**
 * Implementation and integration units keep the write and exec tools unless
 * the user forbade writing (a yes at act); research and design units, and
 * every unit of a contract that forbids writing, get the planner's read-only
 * tool set as a hard restriction.
 */
export function unitToolContract(role: UnitRole, shape: RequestShape): UnitToolContract {
  const writes = (role === 'implement' || role === 'integration') && !saysYesAtAct(shape.forbids_writing);
  return writes
    ? { readOnly: false, restrictTools: false }
    : { readOnly: true, tools: PLANNER_DECOMPOSITION_TOOLS, restrictTools: true };
}
