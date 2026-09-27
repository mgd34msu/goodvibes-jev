/**
 * An owner's amendment (docs/design/contract-runner.md section 6.3): the
 * owner's reply read as "change what is required" goes to the planning model
 * as an instruction for the escalation's target (a unit, a group or the
 * deliverable). The planner may reword, drop or add criteria and, for a unit,
 * rewrite its brief. Reworded and added criteria have origin `owner`: the
 * owner said it, so their trace to the user's words is not asked again.
 *
 * The planner answers with one fenced JSON block; code checks it (ids, links)
 * and asks for a repair up to `contract.planRepairLimit` times. A change that
 * cannot be made into criteria goes back to the owner.
 *
 * An amendment gives the target a fresh fix-round budget: the owner changed
 * what is required, so the rounds spent on the old requirement do not count.
 */
import { readContractConfig } from './config.js';
import { lastFencedBlock } from './plan-schema.js';
import { readPlannerBounds } from './planner.js';
import type { ContractRun } from './run-context.js';
import type { StepContext } from './steps.js';
import type { Criterion, Escalation } from './types.js';

/** One criterion as the planner returns it. */
interface AmendedCriterion {
  readonly id: string | undefined;
  readonly text: string;
  readonly serves: readonly string[] | undefined;
}

interface Amendment {
  readonly brief: string | undefined;
  readonly criteria: readonly AmendedCriterion[];
}

export type AmendmentOutcome = { readonly kind: 'applied'; readonly summary: string } | { readonly kind: 'problems'; readonly problems: readonly string[] };

/** The amendment planner's system prompt. */
export function buildAmendmentPrompt(): string {
  return [
    'You change the requirements of one part of a contract as its owner instructs.',
    'Answer with exactly one fenced ```json block of this shape and nothing after it:',
    '',
    '```json',
    '{ "brief": "the part\'s brief, rewritten only if the instruction changes the work", "criteria": [ { "id": "an existing criterion id, kept or reworded", "text": "checkable requirement", "serves": ["c1"] }, { "text": "a new requirement", "serves": ["c2"] } ] }',
    '```',
    '',
    'Rules:',
    '- Follow the owner\'s instruction exactly: reword, drop or add criteria only as it says, and keep every other criterion word for word with its id.',
    '- Leave a dropped criterion out. A new criterion has no id.',
    '- Every criterion must be checkable from the finished work: its files, its output, or a command run against it.',
    '- "serves" names the contract criteria a criterion serves; it is required for a unit or group, and left out for the deliverable.',
    '- "brief" is for a unit only; leave it out to keep the brief as it is.',
  ].join('\n');
}

interface Target {
  readonly title: string;
  readonly goal: string;
  readonly brief?: string | undefined;
  readonly criteria: Criterion[];
  /** Whether criteria name the contract criteria they serve. */
  readonly serves: boolean;
}

function targetOf(run: ContractRun, escalation: Escalation): Target | undefined {
  const { contract } = run;
  if (escalation.scope === 'unit') {
    const unit = run.unit(escalation.targetId);
    return unit === undefined ? undefined : { title: unit.title, goal: unit.goal, brief: unit.brief, criteria: unit.criteria, serves: true };
  }
  if (escalation.scope === 'group') {
    const group = run.group(escalation.targetId);
    return group === undefined ? undefined : { title: group.title, goal: group.goal, criteria: group.criteria, serves: true };
  }
  if (escalation.scope === 'deliverable') return { title: contract.goal, goal: contract.goal, criteria: contract.criteria, serves: false };
  return undefined;
}

/** The amendment planner's user prompt. */
export function buildAmendmentRequest(escalation: Escalation, target: Target, servable: readonly Criterion[], instruction: string, problems: readonly string[] = []): string {
  const sections = [
    "## The owner's instruction\n" + instruction,
    '## The question the owner answered\n' + escalation.question,
    `## The part to change (${escalation.scope} ${escalation.targetId})\nTitle: ${target.title}\nGoal: ${target.goal}` + (target.brief === undefined ? '' : `\nBrief: ${target.brief}`),
    '## Its criteria now\n' + target.criteria
      .filter((criterion) => criterion.disposition === 'judged')
      .map((criterion) => `- ${criterion.id} (${criterion.status})${target.serves ? ` serves ${criterion.serves.join(', ')}` : ''}: ${criterion.text}`)
      .join('\n'),
  ];
  if (target.serves) {
    sections.push('## Criteria a criterion may serve\n' + servable.map((criterion) => `- ${criterion.id}: ${criterion.text}`).join('\n'));
  }
  if (problems.length > 0) sections.push('## Problems with your previous answer\nFix every one.\n' + problems.map((problem) => `- ${problem}`).join('\n'));
  return sections.join('\n\n');
}

type Json = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Parses and checks an amendment in code: ids that exist, links to contract criteria, at least one criterion. */
export function parseAmendment(text: string, target: Target, servableIds: ReadonlySet<string>): { readonly amendment?: Amendment; readonly problems: string[] } {
  const block = lastFencedBlock(text);
  if (block === undefined) return { problems: ['The answer has no fenced JSON block.'] };
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch (error) {
    return { problems: [`The JSON block does not parse: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!isObject(raw) || !Array.isArray(raw['criteria'])) return { problems: ['The JSON block must be an object with a "criteria" array.'] };
  const problems: string[] = [];
  const existing = new Set(target.criteria.map((criterion) => criterion.id));
  const seen = new Set<string>();
  const criteria: AmendedCriterion[] = [];
  raw['criteria'].forEach((entry: unknown, index: number) => {
    if (!isObject(entry) || typeof entry['text'] !== 'string' || entry['text'].trim().length === 0) {
      problems.push(`criteria[${index}] needs a non-empty "text".`);
      return;
    }
    const id = typeof entry['id'] === 'string' && entry['id'].length > 0 ? entry['id'] : undefined;
    if (id !== undefined && !existing.has(id)) problems.push(`criteria[${index}] names "${id}", which is not one of the part's criteria; leave "id" out for a new criterion.`);
    if (id !== undefined && seen.has(id)) problems.push(`Criterion "${id}" appears more than once.`);
    if (id !== undefined) seen.add(id);
    const serves = Array.isArray(entry['serves']) ? entry['serves'].filter((served): served is string => typeof served === 'string') : undefined;
    if (target.serves) {
      const kept = id === undefined ? undefined : target.criteria.find((criterion) => criterion.id === id)?.serves;
      const effective = serves ?? kept ?? [];
      if (effective.length === 0) problems.push(`criteria[${index}] must name the contract criteria it serves.`);
      for (const served of effective.filter((served) => !servableIds.has(served))) problems.push(`criteria[${index}] serves "${served}", which is not a criterion it may serve.`);
    }
    criteria.push({ id, text: entry['text'].trim(), serves });
  });
  if (criteria.length === 0) problems.push('At least one criterion must remain.');
  const brief = typeof raw['brief'] === 'string' && raw['brief'].trim().length > 0 ? raw['brief'].trim() : undefined;
  return problems.length > 0 ? { problems } : { amendment: { brief, criteria }, problems };
}

/** A fresh owner-criterion id under `prefix` (`<target>.o<n>`, or `o<n>` for the deliverable). */
function ownerId(prefix: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const id = `${prefix}o${n}`;
    if (!taken.has(id)) return id;
  }
}

/** The target's criteria after the amendment; the ones the planner kept word for word keep their readings. */
function amendedCriteria(target: Target, amendment: Amendment, prefix: string, allIds: Set<string>): { readonly criteria: Criterion[]; readonly notes: string[] } {
  const notes: string[] = [];
  const criteria = amendment.criteria.map((entry): Criterion => {
    const previous = entry.id === undefined ? undefined : target.criteria.find((criterion) => criterion.id === entry.id);
    const serves = target.serves ? [...(entry.serves ?? previous?.serves ?? [])] : [];
    if (previous !== undefined && previous.text === entry.text && serves.join() === previous.serves.join()) return previous;
    const id = ownerId(prefix, allIds);
    allIds.add(id);
    notes.push(previous === undefined ? `added ${id}` : `reworded ${previous.id} as ${id}`);
    return { id, text: entry.text, origin: 'owner', serves, disposition: 'judged', status: 'unread', readings: [] };
  });
  const kept = new Set(criteria.map((criterion) => criterion.id));
  const reworded = new Set(amendment.criteria.map((entry) => entry.id).filter((id): id is string => id !== undefined));
  for (const criterion of target.criteria) {
    if (criterion.disposition === 'judged' && !kept.has(criterion.id) && !reworded.has(criterion.id)) notes.push(`dropped ${criterion.id}`);
  }
  // Criteria that are not judged (excluded, met by structure) are not the planner's to change.
  return { criteria: [...target.criteria.filter((criterion) => criterion.disposition !== 'judged'), ...criteria], notes };
}

/**
 * The criteria a target's criteria may serve: a planned-fix unit serves the
 * criteria of the target its group repairs; everything else serves the
 * contract's criteria.
 */
function servableCriteria(run: ContractRun, escalation: Escalation): Criterion[] {
  const { contract } = run;
  const unit = escalation.scope === 'unit' ? run.unit(escalation.targetId) : undefined;
  const repairs = unit === undefined ? undefined : run.group(unit.groupId)?.repairs;
  if (repairs === undefined) return contract.criteria;
  const all = [...contract.criteria, ...contract.groups.flatMap((group) => group.criteria), ...contract.units.flatMap((candidate) => candidate.criteria)];
  return all.filter((criterion) => repairs.criterionIds.includes(criterion.id));
}

/**
 * Runs the amendment planner for the escalation's target and applies its
 * answer. Returns the problems when the change could not be made.
 */
export async function amendTarget(run: ContractRun, escalation: Escalation, instruction: string, context: StepContext): Promise<AmendmentOutcome> {
  const { contract } = run;
  const target = targetOf(run, escalation);
  if (target === undefined) return { kind: 'problems', problems: [`${escalation.scope} ${escalation.targetId} has no criteria to change`] };
  const config = readContractConfig(context.configManager);
  const route = await context.routeSelector({ purpose: 'planner', contract: run.view() });
  const servable = servableCriteria(run, escalation);
  const servableIds = new Set(servable.map((criterion) => criterion.id));
  let problems: string[] = [];
  for (let attempt = 0; attempt <= config.planRepairLimit; attempt += 1) {
    const result = await context.decompositionRunner.run({
      goal: contract.ask,
      workingDir: contract.projectRoot,
      systemPrompt: buildAmendmentPrompt(),
      userPrompt: buildAmendmentRequest(escalation, target, servable, instruction, problems),
      bounds: readPlannerBounds(context.configManager),
      attempt: attempt === 0 ? 'initial' : 'repair',
      route,
      signal: run.abort.signal,
    });
    if (result.agentId !== undefined) contract.plannerAgentIds.push(result.agentId);
    if (result.status !== 'completed') return { kind: 'problems', problems: [`the planner did not finish (${result.status}${result.detail === undefined ? '' : `: ${result.detail}`})`] };
    const parsed = parseAmendment(result.output, target, servableIds);
    problems = parsed.problems;
    if (parsed.amendment === undefined) continue;
    const allIds = new Set([...contract.criteria, ...contract.groups.flatMap((group) => group.criteria), ...contract.units.flatMap((unit) => unit.criteria)].map((criterion) => criterion.id));
    const prefix = escalation.scope === 'deliverable' ? '' : `${escalation.targetId}.`;
    const { criteria, notes } = amendedCriteria(target, parsed.amendment, prefix, allIds);
    if (escalation.scope === 'unit') {
      const unit = run.unit(escalation.targetId)!;
      unit.criteria = criteria;
      if (parsed.amendment.brief !== undefined && parsed.amendment.brief !== unit.brief) {
        unit.brief = parsed.amendment.brief;
        notes.push('brief rewritten');
      }
      unit.fixRounds = 0;
      unit.freshAgents = 0;
    } else if (escalation.scope === 'group') {
      const group = run.group(escalation.targetId)!;
      group.criteria = criteria;
      group.fixRounds = 0;
    } else {
      contract.criteria = criteria;
      contract.fixRounds = 0;
    }
    const summary = notes.length === 0 ? 'criteria unchanged' : notes.join('; ');
    run.decide('owner-replied', escalation.targetId, `amended as the owner instructed: ${summary}`, [], route);
    return { kind: 'applied', summary };
  }
  return { kind: 'problems', problems };
}
