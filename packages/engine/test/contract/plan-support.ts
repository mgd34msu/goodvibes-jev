/**
 * Shared pieces for the planning tests: a valid two-part plan with its ask, a
 * request shape builder, a scripted Jev port, a fake planner runner and a
 * config reader. Tests change what they exercise.
 */
import type { Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { DecompositionRunner, DecompositionRunnerRequest, DecompositionRunResult } from '../../sdk/src/platform/core/plan-decomposition.js';
import type { ContractPlan } from '../../sdk/src/platform/contract/plan-schema.js';
import type { ContractConfigReader, RequestShape, ShapeReading, UnitRoute } from '../../sdk/src/platform/contract/index.js';

export const ASK = 'Add a CSV parser and a JSON formatter, each with unit tests, and wire both into the convert command.';

export interface DraftCriterion { id: string; text: string; quote: string | undefined }
export interface DraftDerived { id: string; text: string; serves: string[] }
export interface DraftUnit {
  id: string; title: string; goal: string; role: string; brief: string;
  dependsOn: string[]; files: string[]; attempts: number | undefined; criteria: DraftDerived[];
}
export interface DraftGroup {
  id: string; title: string; goal: string; kind: 'work' | 'fix' | 'integration';
  dependsOn: string[]; criteria: DraftDerived[]; units: DraftUnit[];
}
export interface DraftPlan { goal: string; criteria: DraftCriterion[]; groups: DraftGroup[] }

export function draftUnit(id: string, overrides: Partial<DraftUnit> = {}): DraftUnit {
  return {
    id,
    title: `Unit ${id}`,
    goal: `Goal of ${id}`,
    role: 'implement',
    brief: `Do the work of ${id}.`,
    dependsOn: [],
    files: [],
    attempts: undefined,
    criteria: [{ id: `${id}.c1`, text: `${id} works`, serves: ['c1'] }],
    ...overrides,
  };
}

/** A valid plan for ASK: g1 holds two independent units, g2 is the integration group. */
export function validPlan(): DraftPlan {
  return {
    goal: 'A convert command that parses CSV and formats JSON',
    criteria: [
      { id: 'c1', text: 'A CSV parser with unit tests exists', quote: 'Add a CSV parser' },
      { id: 'c2', text: 'A JSON formatter with unit tests exists', quote: 'a JSON formatter' },
      { id: 'c3', text: 'The convert command uses the parser and the formatter', quote: 'wire both into the convert command' },
    ],
    groups: [
      {
        id: 'g1', title: 'Modules', goal: 'The parser and the formatter', kind: 'work', dependsOn: [],
        criteria: [{ id: 'g1.c1', text: 'Both modules pass their tests', serves: ['c1', 'c2'] }],
        units: [
          draftUnit('u1', { title: 'CSV parser', role: 'implement', files: ['src/csv.ts'], criteria: [{ id: 'u1.c1', text: 'src/csv.ts parses CSV and its tests pass', serves: ['c1'] }] }),
          draftUnit('u2', { title: 'JSON formatter', role: 'implement', files: ['src/json.ts'], criteria: [{ id: 'u2.c1', text: 'src/json.ts formats JSON and its tests pass', serves: ['c2'] }] }),
        ],
      },
      {
        id: 'g2', title: 'Integration', goal: 'Wire the modules into convert', kind: 'integration', dependsOn: ['g1'],
        criteria: [],
        units: [draftUnit('u3', { title: 'Wire convert', role: 'integration', criteria: [{ id: 'u3.c1', text: 'convert reads CSV and writes JSON', serves: ['c3'] }] })],
      },
    ],
  };
}

/** A valid one-unit plan for ASK: no integration group. */
export function singleUnitPlan(): DraftPlan {
  const plan = validPlan();
  return {
    ...plan,
    groups: [{
      id: 'g1', title: 'All', goal: 'Everything', kind: 'work', dependsOn: [], criteria: [],
      units: [draftUnit('u1', { criteria: [{ id: 'u1.c1', text: 'Everything works', serves: ['c1', 'c2', 'c3'] }] })],
    }],
  };
}

export const asPlan = (draft: DraftPlan): ContractPlan => draft;

/** The planner's answer carrying `draft` as its last fenced JSON block. */
export function plannerOutput(draft: DraftPlan): string {
  return `Here is the plan.\n\n\`\`\`json\n${JSON.stringify(draft, null, 2)}\n\`\`\`\n`;
}

const NO_AT_ACT: ShapeReading = { verdict: 'no', probability: 0.03, outcome: 'act' };
const YES_AT_ACT: ShapeReading = { verdict: 'yes', probability: 0.97, outcome: 'act' };

/** A shape where every question reads no at act, with the named ones read yes at act. */
export function shapeOf(yes: readonly (keyof Omit<RequestShape, 'decisionIds'>)[] = [], overrides: Partial<RequestShape> = {}): RequestShape {
  const read = (name: keyof Omit<RequestShape, 'decisionIds'>): ShapeReading => (yes.includes(name) ? YES_AT_ACT : NO_AT_ACT);
  return {
    forbids_delegation: read('forbids_delegation'),
    requests_parallel_agents: read('requests_parallel_agents'),
    forbids_writing: read('forbids_writing'),
    asks_for_attempts: read('asks_for_attempts'),
    decisionIds: [],
    ...overrides,
  };
}

/** What a scripted answer override sees. */
export interface AnswerContext {
  readonly name: string;
  readonly question: Question;
  readonly state: Record<string, unknown>;
}

/**
 * A port that answers every planning question as a clean plan would (traced,
 * covered, checkable, not topology-only, implement, not narrowing, and every
 * shape question no), unless `override` returns an answer.
 */
export function planningPort(override: (context: AnswerContext) => unknown = () => undefined) {
  return fakePort((name, question, state) => {
    const scripted = override({ name, question, state: (state ?? {}) as Record<string, unknown> });
    if (scripted !== undefined) return scripted;
    switch (name) {
      case 'relation': return choiceAnswer(question, 'supports', 0.95);
      case 'role': return choiceAnswer(question, 'implement', 0.95);
      case 'checkable': return noulAnswer(0.95);
      default: return noulAnswer(0.03);
    }
  });
}

/** The unit title a unit-shape request is about. */
export function unitTitleOf(state: Record<string, unknown>): string | undefined {
  const unit = state['unit'];
  return unit !== null && typeof unit === 'object' ? String((unit as Record<string, unknown>)['title']) : undefined;
}

/** A planner runner that answers from a script, one result per run, and records every request. */
export function scriptedRunner(results: readonly (string | Partial<DecompositionRunResult>)[]) {
  const requests: DecompositionRunnerRequest[] = [];
  const runner: DecompositionRunner = {
    async run(request) {
      requests.push(request);
      const next = results[Math.min(requests.length - 1, results.length - 1)];
      if (next === undefined) throw new Error('scripted runner has no result');
      if (typeof next === 'string') return { status: 'completed', output: next, elapsedMs: 1, agentId: `planner-${requests.length}` };
      return { status: 'completed', output: '', elapsedMs: 1, agentId: `planner-${requests.length}`, ...next };
    },
  };
  return { runner, requests };
}

/** A config reader over `contract.*` values (the category) and dotted keys such as the `planner.*` bounds. */
export function configReader(contract: Record<string, unknown> = {}, dotted: Record<string, unknown> = {}): ContractConfigReader {
  // The real reader is typed per key; a test reader over plain values cannot be, hence the widening.
  return {
    get: (key: string): unknown => dotted[key],
    getCategory: (name: string): unknown => (name === 'contract' ? contract : undefined),
  } as unknown as ContractConfigReader;
}

export const PLANNER_ROUTE: UnitRoute = { model: 'model-a', provider: 'provider-a', reason: 'planner tier: deep reasoning' };
