import type {
  ProjectPlanningState,
  ProjectPlanningDecision, ProjectPlanningLanguageArtifact,
} from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { ConfigModalSurface } from '../../input/config-modal-types.ts';
import { createPlanningModalSurface, type PlanningModalService } from '../../views/modals/planning-modal.ts';

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
  const decision: ProjectPlanningDecision = { id: 'golden-decision-1', title: 'Use a golden fixture', decision: 'Freeze all ids/timestamps for a byte-stable render.', status: 'accepted' };
  const language: ProjectPlanningLanguageArtifact = { projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', terms: [{ term: 'golden fixture', definition: 'A deterministic, frozen input used for byte-stable tests.' }], ambiguities: [], updatedAt: 0 };
  return {
    status: async () => ({ ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', passiveOnly: true, counts: { states: 1, decisions: 1, languageArtifacts: 1, workPlans: 0, workPlanTasks: 0 }, capabilities: [] }),
    getState: async () => ({ ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', state }),
    listDecisions: async () => ({ ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', decisions: [decision] }),
    getLanguage: async () => ({ ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', language }),
  };
}

/**
 * Deterministic golden fixture. All ids/timestamps are frozen literals. Because
 * every service method is Promise-based, this helper is async, it opens the
 * surface, waits a macrotask so the fire-and-forget load resolves, then returns.
 */
export async function planningModalGoldenSurface(): Promise<ConfigModalSurface> {
  const surface = createPlanningModalSurface({ service: buildGoldenService(), projectId: 'golden-project' });
  surface.onOpen?.(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  return surface;
}
