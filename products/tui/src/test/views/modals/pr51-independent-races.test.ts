// Original portable probes were run unchanged before repair and archived with their failing log.
// These fixtures now include the required THE95 stored-revision contract; race schedules are unchanged.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { ProjectPlanningState } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { createPlanningModalSurface, type PlanningModalService } from '../../../views/modals/planning-modal.ts';
import { ConfigModal } from '../../../input/config-modal.ts';
import { actionCtx, captureCommands } from './modal-surface-test-helpers.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(fakePort(name => noulAnswer(name === 'approval' || name === 'scope' ? 0.99 : 0.01)).port); });
afterEach(() => { installJudgmentPort(previous); });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function state(): ProjectPlanningState { return { id: 'state-1', projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', goal: 'Inspect retry behavior only', knownContext: [], openQuestions: [], answeredQuestions: [], decisions: [], assumptions: [], constraints: [], risks: [], tasks: [], dependencies: [], verificationGates: [], agentAssignments: [], readiness: 'needs-user-input', executionApproved: false, createdAt: 0, updatedAt: 1 }; }
function serviceFor(saved: ProjectPlanningState): PlanningModalService { return {
  status: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', passiveOnly: true, counts: { states: 1, decisions: 0, languageArtifacts: 0, workPlans: 0, workPlanTasks: 0 }, capabilities: [] }),
  getState: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', state: saved, revision: { sourceId: 'fixture-source', generation: 'a'.repeat(64) } }),
  listDecisions: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', decisions: [] }),
  getLanguage: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', language: null }),
  evaluate: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', readiness: saved.readiness, gaps: [], state: saved, revision: { sourceId: 'fixture-source', generation: 'a'.repeat(64) } }),
}; }

test('an approval selected on an old plan cannot approve a newer revision returned by evaluation', async () => {
  const original = state();
  const newer = { ...original, goal: 'Change the payment flow instead', updatedAt: 2 };
  const question = { id: 'unapproved-execution', prompt: 'May this plan proceed to execution?' };
  let evaluations = 0;
  const entered = deferred(), gate = deferred();
  const service: PlanningModalService = { ...serviceFor(original), evaluate: async () => {
    if (++evaluations > 1) { entered.resolve(); await gate.promise; }
    return { ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', readiness: 'needs-user-input', gaps: [], nextQuestion: question, state: evaluations > 1 ? newer : original };
  } };
  const surface = createPlanningModalSurface({ service, projectId: 'proj-1' });
  surface.onOpen?.(() => {}); await flush();
  const row = surface.buildView().tabs[0]!.rows.find(r => r.id.endsWith(':approve-execution'))!;
  const cap = captureCommands(); const statuses: string[] = [];
  surface.onAction?.('submit', actionCtx(row, { ...cap.extra, setStatus: text => statuses.push(text) }));
  await entered.promise; gate.resolve(); await flush();
  expect(cap.calls).toEqual([]);
  expect(statuses.some(s => s.includes('changed'))).toBe(true);
  surface.onClose?.();
});

test('repeated Enter while the source read is pending cannot dispatch the same answer twice', async () => {
  const saved = { ...state(), openQuestions: [{ id: 'q1', prompt: 'Which components should change?', status: 'open' as const }] };
  const gate = deferred(); let reads = 0;
  const service: PlanningModalService = { ...serviceFor(saved), getState: async () => { if (++reads > 1) await gate.promise; return { ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', state: saved, revision: { sourceId: 'fixture-source', generation: 'a'.repeat(64) } }; } };
  const surface = createPlanningModalSurface({ service, projectId: 'proj-1' });
  const modal = new ConfigModal(); modal.open(surface); await flush(); modal.syncStructure();
  const row = surface.buildView().tabs[0]!.rows.find(r => r.id.endsWith(':scope-focused-first-pass'))!;
  modal.jumpToRow('planning', row.id);
  const cap = captureCommands(); const ctx = { print: () => {}, ...cap.extra };
  expect(modal.fireAction('enter', ctx)).toBe(true);
  expect(modal.fireAction('enter', ctx)).toBe(true);
  gate.resolve(); await flush();
  expect(cap.calls).toHaveLength(1);
  modal.close();
});
