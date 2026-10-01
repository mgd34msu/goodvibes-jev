import type { JsonValue, YesNoReading } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentInputError, snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { executePolicyCheck } from '../../gate/execute-policy-check.js';
import type { ProjectPlanningQuestion } from './types.js';
import { planningAnswerTopic, planningRecommendationSpecific } from './batteries/answer-actions.js';

export interface ProjectPlanningAnswerAction {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly answer: string;
  readonly kind?: 'answer' | 'approve';
  readonly disabled?: boolean;
}

/** Local question binding only; source IDs never become judgment identifiers. */
export type ProjectPlanningAnswerQuestion = Readonly<Pick<ProjectPlanningQuestion,
  'id' | 'prompt' | 'whyItMatters' | 'recommendedAnswer' | 'consequence' | 'status'>>;

export interface ProjectPlanningAnswerActionsReading {
  readonly question: ProjectPlanningAnswerQuestion;
  /** Semantic suggestions only. The pure composer adds manual answer actions. */
  readonly actions: readonly ProjectPlanningAnswerAction[];
  readonly recommendation: string | null;
  readonly topics: Readonly<Record<'scope' | 'tasks' | 'verification' | 'approval', YesNoReading>>;
  readonly recommendationSpecific: YesNoReading | null;
  readonly decisionIds: readonly string[];
}

export interface ProjectPlanningAnswerReadOptions {
  readonly signal?: AbortSignal;
}

const TOPIC_SITE = 'knowledge.planning.answer-topic';
const RECOMMENDATION_SITE = 'knowledge.planning.recommendation-specific';
const QUESTION_FIELDS = ['id', 'prompt', 'whyItMatters', 'recommendedAnswer', 'consequence', 'status'] as const;
const supported = (reading: YesNoReading): boolean => reading.verdict === 'yes' && reading.outcome === 'act';

/** Project only after the complete original input passed privacy inspection. */
function questionFrom(snapshot: unknown): ProjectPlanningAnswerQuestion {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) throw new JudgmentInputError('unsupported-input');
  const record = snapshot as Record<string, unknown>;
  const id = record['id'];
  const prompt = record['prompt'];
  if (typeof id !== 'string' || typeof prompt !== 'string') throw new JudgmentInputError('unsupported-input');
  for (const field of QUESTION_FIELDS.slice(2)) {
    if (record[field] !== undefined && typeof record[field] !== 'string') throw new JudgmentInputError('unsupported-input');
  }
  const status = record['status'];
  if (status !== undefined && status !== 'open' && status !== 'answered' && status !== 'skipped') throw new JudgmentInputError('unsupported-input');
  return Object.freeze({
    id, prompt,
    ...(status === undefined ? {} : { status }),
    ...(record['whyItMatters'] === undefined ? {} : { whyItMatters: record['whyItMatters'] as string }),
    ...(record['recommendedAnswer'] === undefined ? {} : { recommendedAnswer: record['recommendedAnswer'] as string }),
    ...(record['consequence'] === undefined ? {} : { consequence: record['consequence'] as string }),
  });
}

/**
 * Read which suggestions fit a planning question. This never approves a plan
 * or sends an answer. Full-input privacy inspection precedes port acquisition,
 * question construction and recording; no raw metadata leaves this process.
 */
export async function readProjectPlanningAnswerActions(
  input: ProjectPlanningQuestion,
  options: ProjectPlanningAnswerReadOptions = {},
): Promise<ProjectPlanningAnswerActionsReading> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const question = questionFrom(snapshotJudgmentInput(input));
  const facts: Record<string, JsonValue> = { id: 'question_0', prompt: question.prompt };
  for (const field of ['whyItMatters', 'recommendedAnswer', 'consequence'] as const) {
    const value = question[field];
    if (value !== undefined) facts[field] = value;
  }
  const state = { question: facts };
  const callOptions = signal === undefined ? {} : { signal };
  const port = judgmentPort(TOPIC_SITE);
  const topics = await executePolicyCheck(() => planningAnswerTopic.run(port, state, { site: TOPIC_SITE, ...callOptions }), signal);
  signal?.throwIfAborted();
  const recommendation = question.recommendedAnswer?.trim()
    ? await executePolicyCheck(() => planningRecommendationSpecific.run(port, state, { site: RECOMMENDATION_SITE, ...callOptions }), signal)
    : null;
  signal?.throwIfAborted();
  const specific = recommendation?.readings.specific ?? null;
  const retained = specific !== null && supported(specific) ? question.recommendedAnswer! : null;
  const actions = suggestedActions({
    scope: supported(topics.readings.scope), tasks: supported(topics.readings.tasks),
    verification: supported(topics.readings.verification), approval: supported(topics.readings.approval),
  }, retained);
  // Action labels contain only the fixed suggestion IDs, never caller text.
  const action = actions.length === 0 ? 'suggestions:withheld' : `suggestions:offer:${actions.map((entry) => entry.id).join(',')}`;
  signal?.throwIfAborted();
  topics.recordAction(action);
  signal?.throwIfAborted();
  recommendation?.recordAction(retained === null ? 'recommendation:withheld' : 'recommendation:offer');
  signal?.throwIfAborted();
  return Object.freeze({
    question,
    actions: Object.freeze(actions.map((entry) => Object.freeze(entry))),
    recommendation: retained,
    topics: Object.freeze({ ...topics.readings }),
    recommendationSpecific: specific === null ? null : Object.freeze({ ...specific }),
    decisionIds: Object.freeze([topics.result.decisionId, recommendation?.result.decisionId].filter((id): id is string => id !== undefined)),
  });
}

function compactAnswerDetail(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 86 ? `${normalized.slice(0, 83)}...` : normalized;
}

function suggestedActions(
  topics: Readonly<Record<'scope' | 'tasks' | 'verification' | 'approval', boolean>>,
  recommendation: string | null,
): ProjectPlanningAnswerAction[] {
  const canned: ProjectPlanningAnswerAction[] = [];
  if (topics.approval) {
    canned.push({
      id: 'approve-execution',
      label: 'Approve execution',
      detail: 'Mark this plan approved so execution may proceed.',
      answer: 'Approve this planning state for execution.',
      kind: 'approve',
    });
  }
  if (topics.scope) {
    canned.push({
      id: 'scope-focused-first-pass',
      label: 'Use focused first-pass scope',
      detail: 'Fill a concrete end-to-end scope for this goal and keep unrelated work out.',
      answer: 'Use a focused first-pass scope for this goal.',
    });
  }
  if (topics.tasks) {
    canned.push({
      id: 'tasks-default-breakdown',
      label: 'Create default task breakdown',
      detail: 'Create inspect, implement, wire, and verify tasks with dependencies.',
      answer: 'Create the default task breakdown for this goal.',
    });
  }
  if (topics.verification) {
    canned.push({
      id: 'verification-default-gates',
      label: 'Use standard verification gates',
      detail: 'Require focused regression coverage, typecheck/build validation, and a runtime smoke where feasible.',
      answer: 'Use standard verification gates for this goal.',
    });
  }
  if (recommendation !== null) {
    canned.push({
      id: 'recommended',
      label: 'Use recommended answer',
      detail: compactAnswerDetail(recommendation),
      answer: recommendation,
    });
  }
  if (topics.scope) {
    canned.push({
      id: 'scope-end-to-end',
      label: 'End-to-end required scope',
      detail: 'Let the plan include every component needed to make this work, but avoid unrelated cleanup.',
      answer: 'Scope is everything required to make the requested outcome work end-to-end. Include TUI, daemon composition, configuration, docs, and tests if they are required. Do not include unrelated cleanup or broad refactors unless they are necessary for this task.',
    });
    canned.push({
      id: 'scope-tui-first',
      label: 'TUI-first scope',
      detail: 'Fix TUI behavior here; report SDK blockers instead of patching around SDK-owned bugs.',
      answer: 'Scope is TUI-owned behavior first. If a blocker is SDK-owned, report the exact SDK contract/runtime issue instead of patching around it in the TUI. Include daemon composition only where the TUI owns the wiring.',
    });
  }

  const seenAnswers = new Set<string>();
  return canned.filter((action) => {
    const key = action.answer.trim().toLowerCase().replace(/\s+/g, ' ');
    if (key.length > 0 && seenAnswers.has(key)) return false;
    if (key.length > 0) seenAnswers.add(key);
    return true;
  });
}

/**
 * Pure, local composition. A missing or obsolete reading never blocks manual
 * input; it only removes its semantic suggestions. No port or recorder is used.
 */
export function buildProjectPlanningAnswerActions(
  question: ProjectPlanningQuestion,
  draftAnswer: string,
  reading?: ProjectPlanningAnswerActionsReading,
): readonly ProjectPlanningAnswerAction[] {
  const matches = reading !== undefined && QUESTION_FIELDS.every((key) => question[key] === reading.question[key]);
  const actions: ProjectPlanningAnswerAction[] = matches ? [...reading.actions] : [];
  actions.push({
    id: 'ask-narrower',
    label: 'I am not sure yet',
    detail: 'Break this into smaller concrete choices with examples and a recommended default.',
    answer: `I do not know enough to answer "${question.prompt}" as asked. Break it into smaller concrete questions with 2-4 specific choices, explain the tradeoffs, recommend a default, and ask me the first one.`,
  });
  actions.push({
    id: 'custom',
    label: 'Submit typed answer',
    detail: draftAnswer ? compactAnswerDetail(draftAnswer) : 'Type an answer first; this row submits it to chat.',
    answer: draftAnswer.trim(),
    disabled: !draftAnswer.trim(),
  });
  return actions;
}
