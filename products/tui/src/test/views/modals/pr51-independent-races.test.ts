// The former interview race probes now protect passive history: replacing or
// refreshing a saved record must never revive semantic evaluation or mutation.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { ProjectPlanningState } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { createPlanningModalSurface, type PlanningModalService } from '../../../views/modals/planning-modal.ts';
import { ConfigModal } from '../../../input/config-modal.ts';
import { actionCtx, captureCommands, viewText } from './modal-surface-test-helpers.ts';

let previous: ReturnType<typeof installJudgmentPort>;
let judgment: ReturnType<typeof fakePort>;
beforeEach(() => { judgment = fakePort(() => noulAnswer(0.99)); previous = installJudgmentPort(judgment.port); });
afterEach(() => { expect(judgment.requests).toEqual([]); installJudgmentPort(previous); });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function state(): ProjectPlanningState { return { id: 'state-1', projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', goal: 'Inspect retry behavior only', knownContext: [], openQuestions: [], answeredQuestions: [], decisions: [], assumptions: [], constraints: [], risks: [], tasks: [], dependencies: [], verificationGates: [], agentAssignments: [], readiness: 'needs-user-input', executionApproved: false, createdAt: 0, updatedAt: 1 }; }
function serviceFor(saved: ProjectPlanningState): PlanningModalService { return {
  status: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', passiveOnly: true, counts: { states: 1, decisions: 0, languageArtifacts: 0, workPlans: 0, workPlanTasks: 0 }, capabilities: [] }),
  getState: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', state: saved, revision: { sourceId: 'fixture-source', generation: 'a'.repeat(64) } }),
  listDecisions: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', decisions: [] }),
  getLanguage: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', language: null }),
}; }

test('a stale approval action cannot evaluate or approve a newer saved revision during refresh', async () => {
  const original = state(); const newer = { ...original, goal: 'Change the payment flow instead', updatedAt: 2 };
  const retained = structuredClone({ original, newer }); const gate = deferred(); let reads = 0;
  const capabilities: string[] = [];
  const service = new Proxy({ ...serviceFor(original), getState: async () => {
    if (++reads > 1) await gate.promise;
    return { ok: true as const, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', state: reads > 1 ? newer : original };
  } }, { get(target, key, receiver) {
    capabilities.push(String(key));
    if (!Object.hasOwn(target, key)) throw new Error('Passive history requested an undeclared capability');
    return Reflect.get(target, key, receiver);
  } });
  const surface = createPlanningModalSurface({ service, projectId: 'proj-1' });
  surface.onOpen?.(() => {}); await flush();
  expect(viewText(surface.buildView())).toContain(original.goal);
  const cap = captureCommands(); const native: string[] = [];
  const ctx = actionCtx({ id: 'answer:1:approve-execution', label: 'Stale approval' }, { ...cap.extra, submitInput: text => native.push(text) });
  surface.onAction?.('refresh', ctx);
  surface.onAction?.('submit', ctx); surface.onAction?.('approve', ctx);
  expect(reads).toBe(2); expect(cap.calls).toEqual([]);
  gate.resolve(); await flush();
  expect(viewText(surface.buildView())).toContain(newer.goal);
  surface.onAction?.('submit', ctx); surface.onAction?.('approve', ctx); await flush();
  expect(cap.calls).toEqual([]); expect(native).toEqual([]);
  expect(capabilities).not.toContain('evaluate'); expect(capabilities).not.toContain('applyStateAction');
  expect({ original, newer }).toEqual(retained);
  surface.onClose?.();
});

test('repeated Enter during and after a passive refresh cannot read or dispatch an answer', async () => {
  const saved = { ...state(), openQuestions: [{ id: 'q1', prompt: 'Which saved components should change?', status: 'open' as const }] };
  const gate = deferred(); let reads = 0;
  const service: PlanningModalService = { ...serviceFor(saved), getState: async () => {
    if (++reads > 1) await gate.promise;
    return { ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', state: saved, revision: { sourceId: 'fixture-source', generation: 'a'.repeat(64) } };
  } };
  const surface = createPlanningModalSurface({ service, projectId: 'proj-1' });
  const modal = new ConfigModal(); modal.open(surface); await flush(); modal.syncStructure();
  const cap = captureCommands(); const native: string[] = [];
  const ctx = { print: () => {}, ...cap.extra, submitInput: (text: string) => native.push(text) };
  expect(modal.fireAction('enter', ctx)).toBe(false);
  expect(modal.fireAction('r', ctx)).toBe(true);
  for (let count = 0; count < 3; count++) expect(modal.fireAction('enter', ctx)).toBe(false);
  expect(reads).toBe(2); gate.resolve(); await flush(); modal.syncStructure();
  expect(viewText(surface.buildView())).toContain(saved.openQuestions[0]!.prompt);
  for (let count = 0; count < 3; count++) expect(modal.fireAction('enter', ctx)).toBe(false);
  expect(reads).toBe(2); expect(cap.calls).toEqual([]); expect(native).toEqual([]);
  expect(saved.openQuestions).toHaveLength(1); expect(saved.executionApproved).toBe(false);
  modal.close();
});
