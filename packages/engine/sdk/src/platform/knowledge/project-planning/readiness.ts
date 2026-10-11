import { captureJudgmentPort, JudgmentPortMissingError, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import type { JsonValue } from '@goodvibes-jev/judgment';
import { JudgmentInputError, snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { planningGoalSpecified } from './batteries/readiness.js';
import type {
  ProjectPlanningEvaluation,
  ProjectPlanningGap,
  ProjectPlanningQuestion,
  ProjectPlanningReadiness,
  ProjectPlanningState,
} from './types.js';

/** A reading owns the immutable state and its publication restrictions. */
export interface PreparedPlanningReadiness {
  readonly evaluation: ProjectPlanningEvaluation;
  readonly assertCurrent: () => void;
}

export async function evaluateProjectPlanningReadiness(
  state: ProjectPlanningState,
  options: JudgmentReadingOptions = {},
): Promise<ProjectPlanningEvaluation> {
  const prepared = await prepareProjectPlanningReadiness(state, options);
  prepared.assertCurrent();
  return prepared.evaluation;
}

export async function prepareProjectPlanningReadiness(
  input: ProjectPlanningState,
  options: JudgmentReadingOptions = {},
): Promise<PreparedPlanningReadiness> {
  const signal = options.signal, callerCurrent = options.assertCurrent;
  const check = () => { signal?.throwIfAborted(); callerCurrent?.(); };
  check();
  // Admit the complete state before projection, including unknown metadata.
  const state = snapshotJudgmentInput(input) as ProjectPlanningState;
  if (!state.goal.trim()) return { evaluation: composeReadiness(state, 'unavailable'), assertCurrent: check };
  const reading = await readPlanningSemanticFacts(planningSemanticFacts(state), options);
  reading.assertCurrent();
  return { evaluation: composeReadiness(state, reading.semantic), assertCurrent: reading.assertCurrent };
}

/** Pure projection; it grants no input admission or publication authority. */
export function planningSemanticFacts(state: ProjectPlanningState): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify({
    goal: state.goal, scope: state.scope, knownContext: state.knownContext,
    constraints: state.constraints, assumptions: state.assumptions,
    tasks: state.tasks.map(task => ({ title: task.title, why: task.why, verification: task.verification })),
    answeredQuestions: state.answeredQuestions.map(question => ({ prompt: question.prompt, answer: question.answer, status: question.status })),
    decisions: state.decisions.map(decision => ({ title: decision.title, context: decision.context, decision: decision.decision, status: decision.status })),
  })) as Record<string, JsonValue>;
}

/** Independently admit every supplied fact before acquiring the semantic port. */
export async function readPlanningSemanticFacts(input: Record<string, JsonValue>, options: JudgmentReadingOptions = {}) {
  const signal = options.signal, callerCurrent = options.assertCurrent;
  const check = () => { signal?.throwIfAborted(); callerCurrent?.(); };
  check();
  const facts = snapshotJudgmentInput(input) as Record<string, JsonValue>;
  let authority: ReturnType<typeof captureJudgmentPort>;
  try { authority = captureJudgmentPort(SITE, { signal, assertCurrent: check }); }
  catch (error) {
    if (!(error instanceof JudgmentPortMissingError)) throw error;
    check();
    return { semantic: 'unavailable' as const, assertCurrent: check };
  }
  let semantic: 'specified' | 'ambiguous' | 'unavailable' = 'unavailable';
  try {
    const run = await planningGoalSpecified.run(authority.port, facts, { site: SITE, signal: authority.signal });
    authority.assertCurrent();
    const reading = run.readings.specified;
    if (reading.outcome === 'act') semantic = reading.verdict === 'yes' ? 'specified' : 'ambiguous';
    run.recordAction(`readiness:${semantic}`);
    authority.assertCurrent();
  } catch (error) {
    authority.assertCurrent();
    // A failed reading remains unavailable; it cannot become a language verdict.
    if (error instanceof JudgmentInputError) throw error;
    semantic = 'unavailable';
  }
  authority.assertCurrent();
  return { semantic, assertCurrent: authority.assertCurrent };
}

const SITE = 'knowledge.planning.goal-specified';

export function composeReadiness(state: ProjectPlanningState, semantic: 'specified' | 'ambiguous' | 'unavailable'): ProjectPlanningEvaluation {
  const gaps: ProjectPlanningGap[] = [];
  const goal = state.goal.trim();
  if (!goal) {
    gaps.push(blockingQuestion(
      'missing-goal',
      'The plan needs a concrete goal before it can be executed.',
      'What outcome should this plan produce?',
      'A clear outcome lets the TUI inspect the right code and ask only relevant follow-up questions.',
      'State the user-visible behavior or project change that should exist when the work is done.',
    ));
  }
  if (!state.scope?.trim() && state.constraints.length === 0) {
    gaps.push(blockingQuestion(
      'missing-scope',
      'The plan has no explicit boundary for what is included or excluded.',
      'What is in scope, and what should be left out for this pass?',
      'Scope boundaries prevent the planning loop from turning a focused change into unrelated work.',
      'Define the first-pass scope and separate out-of-scope work from the current acceptance criteria.',
    ));
  }
  for (const question of state.openQuestions) {
    if ((question.status ?? 'open') === 'open') {
      gaps.push({
        id: `open-question:${question.id}`,
        kind: 'open-question',
        severity: 'blocking',
        message: `Open planning question: ${question.prompt}`,
        question,
      });
    }
  }
  if (goal && semantic === 'ambiguous') {
    gaps.push(blockingQuestion(
      'ambiguous-language',
      'The goal and recorded context do not yet specify a concrete outcome.',
      'What concrete behavior or project change should this goal produce?',
      'Clarifying the desired outcome prevents agents from implementing the wrong thing.',
      'Describe the expected behavior and clarify how it differs from the current behavior.',
    ));
  } else if (goal && semantic === 'unavailable') {
    gaps.push({ id: 'readiness-unavailable', kind: 'readiness-unavailable', severity: 'blocking',
      message: 'The semantic readiness reading is unavailable or inconclusive. Retry evaluation before execution.' });
  }
  if (goal && state.tasks.length === 0) {
    gaps.push(blockingQuestion(
      'missing-tasks',
      'The plan has no decomposed tasks.',
      'What are the smallest useful implementation tasks for this goal?',
      'Task decomposition is what lets the TUI identify dependencies, parallel agent work, and verification gates.',
      'Create task records with likely files, dependencies, and verification notes.',
    ));
  }
  if (state.tasks.length > 1 && state.dependencies.length === 0) {
    gaps.push({
      id: 'missing-dependencies',
      kind: 'missing-dependencies',
      severity: 'advisory',
      message: 'Multiple tasks exist but no dependency graph has been recorded.',
    });
  }
  const tasksWithoutVerification = state.tasks
    .filter((task) => (task.verification?.length ?? 0) === 0)
    .map((task) => task.id);
  const hasRequiredGate = state.verificationGates.some((gate) => gate.required !== false);
  if (state.tasks.length > 0 && tasksWithoutVerification.length > 0 && !hasRequiredGate) {
    gaps.push({
      id: 'missing-verification',
      kind: 'missing-verification',
      severity: 'blocking',
      message: 'The plan has tasks but no verification gates or per-task verification.',
      question: {
        id: 'verification-gates',
        prompt: 'How should this plan prove that the work is correct?',
        whyItMatters: 'Verification gates keep execution from ending at code changes that were never checked.',
        recommendedAnswer: 'Record concrete tests, commands, manual checks, or release gates for the changed behavior.',
        consequence: 'The plan should not be executable until verification exists.',
      },
      relatedTaskIds: tasksWithoutVerification,
    });
  }
  const blocking = gaps.some((gap) => gap.severity === 'blocking');
  if (!blocking && !state.executionApproved) {
    gaps.push({
      id: 'unapproved-execution',
      kind: 'unapproved-execution',
      severity: 'blocking',
      message: 'The plan is structurally ready but has not been approved for execution.',
      question: {
        id: 'approve-execution',
        prompt: 'Is this plan approved for execution?',
        whyItMatters: 'The TUI owns user approval before local work or agent assignments begin.',
        recommendedAnswer: 'Approve only after the goal, scope, tasks, dependencies, and verification gates look right.',
      },
    });
  }
  const readiness = readinessFromGaps(gaps);
  return {
    ok: true,
    projectId: state.projectId,
    knowledgeSpaceId: state.knowledgeSpaceId,
    readiness,
    gaps,
    ...(gaps[0]?.question ? { nextQuestion: gaps[0].question } : {}),
    state: {
      ...state,
      readiness,
    },
  };
}

function readinessFromGaps(gaps: readonly ProjectPlanningGap[]): ProjectPlanningReadiness {
  if (gaps.length === 0) return 'executable';
  if (gaps.some((gap) => gap.severity === 'blocking')) return 'needs-user-input';
  return 'not-ready';
}

function blockingQuestion(
  kind: ProjectPlanningGap['kind'],
  message: string,
  prompt: string,
  whyItMatters: string,
  recommendedAnswer: string,
): ProjectPlanningGap {
  const question: ProjectPlanningQuestion = {
    id: kind,
    prompt,
    whyItMatters,
    recommendedAnswer,
  };
  return {
    id: kind,
    kind,
    severity: 'blocking',
    message,
    question,
  };
}
