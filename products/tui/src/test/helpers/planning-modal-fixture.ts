import type {
  ProjectPlanningAnswerActionsReading, ProjectPlanningQuestion, ProjectPlanningState,
  ProjectPlanningEvaluation, ProjectPlanningDecision, ProjectPlanningLanguageArtifact,
} from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { YesNoReading } from '@goodvibes-jev/judgment';
import type { ConfigModalSurface } from '../../input/config-modal-types.ts';
import { createPlanningModalSurface, type PlanningModalService } from '../../views/modals/planning-modal.ts';

const YES: YesNoReading = { kind: 'yes-no', probability: 0.99, verdict: 'yes', outcome: 'act' };
const NO: YesNoReading = { kind: 'yes-no', probability: 0.01, verdict: 'no', outcome: 'act' };

/** Recorded synthetic presentation evidence; no provider or process-global port. */
function goldenReading(question: ProjectPlanningQuestion): ProjectPlanningAnswerActionsReading {
  return {
    question,
    topics: { scope: YES, tasks: NO, verification: NO, approval: NO },
    recommendationSpecific: YES,
    recommendation: question.recommendedAnswer ?? null,
    decisionIds: ['golden-planning-topic', 'golden-planning-recommendation'],
    actions: [
      { id: 'scope-focused-first-pass', label: 'Use focused first-pass scope', detail: 'Fill a concrete end-to-end scope for this goal and keep unrelated work out.', answer: 'Use a focused first-pass scope for this goal.' },
      { id: 'scope-end-to-end', label: 'End-to-end required scope', detail: 'Let the plan include every component needed to make this work, but avoid unrelated cleanup.', answer: 'Scope is everything required to make the requested outcome work end-to-end. Include TUI, daemon composition, configuration, docs, and tests if they are required. Do not include unrelated cleanup or broad refactors unless they are necessary for this task.' },
      { id: 'scope-tui-first', label: 'TUI-first scope', detail: 'Fix TUI behavior here; report SDK blockers instead of patching around SDK-owned bugs.', answer: 'Scope is TUI-owned behavior first. If a blocker is SDK-owned, report the exact SDK contract/runtime issue instead of patching around it in the TUI. Include daemon composition only where the TUI owns the wiring.' },
    ],
  };
}

function buildGoldenService(): PlanningModalService {
  const state: ProjectPlanningState = {
    id: 'golden-state-1', projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project',
    goal: 'Ship the golden fixture end-to-end.', scope: 'Golden fixture scope only.', knownContext: ['Seeded for a deterministic golden render.'],
    openQuestions: [{ id: 'golden-question-1', prompt: 'What is in scope for this golden fixture?', whyItMatters: 'Keeps the render deterministic.', recommendedAnswer: 'Use a focused first-pass scope for this goal.', status: 'open' }],
    answeredQuestions: [{ id: 'golden-question-0', prompt: 'Is this a golden fixture?', status: 'answered', answer: 'Yes.', answeredAt: 0 }],
    decisions: [], assumptions: [], constraints: [], risks: [],
    tasks: [{ id: 'golden-task-1', title: 'Implement the golden fixture', status: 'pending', dependencies: [], verification: ['bun test src/test/views/modals/planning-modal.test.ts'] }],
    dependencies: [], verificationGates: [{ id: 'golden-gate-1', description: 'Golden render is byte-stable.', status: 'pending', required: true }],
    agentAssignments: [{ taskId: 'golden-task-1', agentType: 'worker', canRunConcurrently: false }],
    readiness: 'needs-user-input', executionApproved: false, createdAt: 0, updatedAt: 0,
  };
  const evaluation: ProjectPlanningEvaluation = {
    ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', readiness: 'needs-user-input',
    gaps: [{ id: 'golden-gap-1', kind: 'open-question', severity: 'blocking', message: 'One open question remains.' }],
    nextQuestion: state.openQuestions[0], state,
  };
  const decision: ProjectPlanningDecision = { id: 'golden-decision-1', title: 'Use a golden fixture', decision: 'Freeze all ids/timestamps for a byte-stable render.', status: 'accepted' };
  const language: ProjectPlanningLanguageArtifact = { projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', terms: [{ term: 'golden fixture', definition: 'A deterministic, frozen input used for byte-stable tests.' }], ambiguities: [], updatedAt: 0 };
  return {
    status: async () => ({ ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', passiveOnly: true, counts: { states: 1, decisions: 1, languageArtifacts: 1, workPlans: 0, workPlanTasks: 0 }, capabilities: [] }),
    getState: async () => ({ ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', state }),
    listDecisions: async () => ({ ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', decisions: [decision] }),
    getLanguage: async () => ({ ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', language }),
    evaluate: async () => evaluation,
  };
}

/**
 * Deterministic golden fixture. All ids/timestamps are frozen literals. Because
 * every service method is Promise-based, this helper is async, it opens the
 * surface, waits a macrotask so the fire-and-forget load resolves, then returns.
 */
export async function planningModalGoldenSurface(waitForReading?: Promise<void>): Promise<ConfigModalSurface> {
  const surface = createPlanningModalSurface({ service: buildGoldenService(), projectId: 'golden-project', readAnswerActions: async (question) => { await waitForReading; return goldenReading(question); } });
  surface.onOpen?.(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  return surface;
}
