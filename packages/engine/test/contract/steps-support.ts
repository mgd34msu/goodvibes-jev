/**
 * Shared pieces for the correction and finishing tests (R.6): a planner that
 * answers the contract plan, fix plans and amendments by the prompt it is
 * given, the answers the fake port gives the stall route, the owner reply and
 * the group and deliverable judges, and small helpers over the harness.
 */
import { spawnSync } from 'node:child_process';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { DecompositionRunner, DecompositionRunnerRequest } from '../../sdk/src/platform/core/plan-decomposition.js';
import { buildAmendmentPrompt, buildFixPlannerPrompt, type ContractView } from '../../sdk/src/platform/contract/index.js';
import { draftUnit, plannerOutput, type AnswerContext, type DraftPlan } from './plan-support.js';
import type { AgentScript, AgentStep, Harness } from './runner-support.js';

export const UNMET = 0.9;
export const MET = 0.03;

export const terminal = (h: Harness, contractId: string): boolean => {
  const status = h.store.get(contractId)?.status;
  return status === 'passed' || status === 'failed' || status === 'cancelled';
};

export function contractOf(h: Harness, contractId: string): ContractView {
  const contract = h.store.get(contractId);
  if (contract === null) throw new Error(`no contract ${contractId}`);
  return contract;
}

export function git(cwd: string, ...args: string[]): string {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).stdout;
}

/** The judge a question belongs to, from the evidence it reads. */
export function judgeOf(context: AnswerContext): 'unit' | 'group' | 'deliverable' | null {
  if (context.name !== 'goal' && !/^criterion_\d+$/.test(context.name)) return null;
  const evidence = context.state['evidence'] as Record<string, unknown> | undefined;
  if (evidence === undefined) return null;
  if ('units' in evidence) return 'group';
  if ('criteria' in evidence) return 'deliverable';
  return 'unit';
}

/** The text of the criterion a judge question asks about, or '' for the goal question. */
export function criterionTextOf(context: AnswerContext): string {
  const instructions = context.question.type === 'noul' ? context.question.instructions : undefined;
  return instructions !== null && typeof instructions === 'object' && !Array.isArray(instructions) && 'criterion' in instructions ? String(instructions['criterion']) : '';
}

/** Every judge reads met for an output that carries a planned fix's answers. */
export function fixedOutputsMeet(context: AnswerContext): unknown {
  const output = context.state['output'];
  if (judgeOf(context) !== null && typeof output === 'string' && output.includes('Planned fix')) return noulAnswer(MET);
  return undefined;
}

/** Answers the stall route with `route` at `confidence`, recording each state it was asked about. */
export function routeAnswer(route: 'split' | 'fresh' | 'owner', asked: Record<string, unknown>[] = [], confidence = 0.95) {
  return (context: AnswerContext): unknown => {
    if (context.name !== 'route') return undefined;
    asked.push(context.state);
    return choiceAnswer(context.question, route, confidence);
  };
}

/** Answers the owner reply with the next scripted reading. */
export function replyAnswers(readings: { readonly reading: 'approve' | 'reject' | 'amend' | 'unclear'; readonly confidence?: number }[]) {
  return (context: AnswerContext): unknown => {
    if (context.name !== 'reading') return undefined;
    const next = readings.shift();
    if (next === undefined) throw new Error('no scripted owner reply reading left');
    return choiceAnswer(context.question, next.reading, next.confidence ?? 0.97);
  };
}

/** The first override that answers wins. */
export function answers(...overrides: ((context: AnswerContext) => unknown)[]) {
  return (context: AnswerContext): unknown => {
    for (const override of overrides) {
      const answer = override(context);
      if (answer !== undefined) return answer;
    }
    return undefined;
  };
}

/** A fix plan: one fix group whose units each serve the given target criteria. */
export function fixPlan(units: readonly { readonly serves: readonly string[]; readonly files?: readonly string[]; readonly dependsOn?: readonly string[] }[]): DraftPlan {
  return {
    goal: 'Repair what the check found',
    criteria: [],
    groups: [{
      id: 'g1', title: 'Repair', goal: 'Repair what the check found', kind: 'fix', dependsOn: [], criteria: [],
      units: units.map((unit, index) => draftUnit(`u${index + 1}`, {
        title: `Fix ${index + 1}`,
        files: [...(unit.files ?? [])],
        dependsOn: [...(unit.dependsOn ?? [])],
        criteria: [{ id: `u${index + 1}.c1`, text: `the repair ${index + 1} holds`, serves: [...unit.serves] }],
      })),
    }],
  };
}

export interface StepPlanner {
  readonly runner: DecompositionRunner;
  readonly requests: DecompositionRunnerRequest[];
  /** The requests of one kind, in order. */
  of(kind: 'plan' | 'fix' | 'amend'): DecompositionRunnerRequest[];
}

/**
 * Answers the contract plan with `plan`, a fix request with `fix(prompt)`, and
 * an amendment with `amend(prompt)`, telling them apart by system prompt.
 */
export function stepPlanner(plan: DraftPlan | ((count: number) => DraftPlan), handlers: { readonly fix?: (prompt: string) => string; readonly amend?: (prompt: string) => string } = {}): StepPlanner {
  const requests: DecompositionRunnerRequest[] = [];
  const kindOf = (request: DecompositionRunnerRequest): 'plan' | 'fix' | 'amend' => (
    request.systemPrompt === buildFixPlannerPrompt() ? 'fix' : request.systemPrompt === buildAmendmentPrompt() ? 'amend' : 'plan'
  );
  let plans = 0;
  const runner: DecompositionRunner = {
    async run(request) {
      requests.push(request);
      const kind = kindOf(request);
      let output: string;
      if (kind === 'fix') {
        if (handlers.fix === undefined) throw new Error('no fix plan scripted');
        output = handlers.fix(request.userPrompt);
      } else if (kind === 'amend') {
        if (handlers.amend === undefined) throw new Error('no amendment scripted');
        output = handlers.amend(request.userPrompt);
      } else {
        plans += 1;
        output = plannerOutput(typeof plan === 'function' ? plan(plans) : plan);
      }
      return { status: 'completed', output, elapsedMs: 1, agentId: `planner-${requests.length}` };
    },
  };
  return { runner, requests, of: (kind) => requests.filter((request) => kindOf(request) === kind) };
}

/** The planner's answer for an amendment. */
export function amendmentOutput(criteria: readonly { readonly id?: string; readonly text: string; readonly serves?: readonly string[] }[], brief?: string): string {
  return `\`\`\`json\n${JSON.stringify({ ...(brief === undefined ? {} : { brief }), criteria })}\n\`\`\`\n`;
}

/** An agent that finishes at once with `text`, having written src/<file>. */
export function finishes(text: string, file = 'src/csv.ts'): AgentScript {
  return () => [{ files: { [file]: `${text}\n` }, text }];
}

/** An agent that keeps answering `[unmet]` at every completion, changing its file each time. */
export function keepsFailing(times: number, file = 'src/csv.ts'): AgentScript {
  return () => Array.from({ length: times }, (_, index): AgentStep => ({ files: { [file]: `attempt ${index}\n` }, text: `[unmet] attempt ${index}` }));
}

/**
 * Scripts looked up by unit id, with `fallback` for ids not known in advance
 * (a deliverable fix group's units are named after the contract id).
 */
export function scriptsWith(known: Readonly<Record<string, AgentScript>>, fallback: (unitId: string) => AgentScript | undefined): Readonly<Record<string, AgentScript>> {
  return new Proxy(known, {
    get: (target, key) => (typeof key === 'string' ? (target[key] ?? fallback(key)) : undefined),
  });
}
