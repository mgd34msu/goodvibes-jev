import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore, ProjectPlanningService } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigModal } from '../../../input/config-modal.ts';
import { createPlanningModalSurface, type PlanningModalService } from '../../../views/modals/planning-modal.ts';
import { actionCtx, viewText } from './modal-surface-test-helpers.ts';

const roots: string[] = [];
const stores: KnowledgeStore[] = [];
let previous: ReturnType<typeof installJudgmentPort>;
let judgment: ReturnType<typeof fakePort>;
beforeEach(() => {
  judgment = fakePort(() => noulAnswer(0.99));
  previous = installJudgmentPort(judgment.port);
});
afterEach(async () => {
  installJudgmentPort(previous);
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function openStore(path: string) {
  const store = new KnowledgeStore({ dbPath: path }); stores.push(store);
  return { store, service: new ProjectPlanningService(store) };
}
function passiveService(service: ProjectPlanningService): PlanningModalService {
  // The view gets only storage reads. Supplying a semantic reader or mutation
  // method here would expand the public view contract and fail the typecheck.
  return {
    status: input => service.status(input), getState: input => service.getState(input),
    listDecisions: input => service.listDecisions(input), getLanguage: input => service.getLanguage(input),
  };
}
async function savedRecord(openQuestions: boolean, approved: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'planning-modal-store-')); roots.push(root);
  const path = join(root, 'planning.sqlite');
  const { store, service } = openStore(path);
  await service.upsertState({ projectId: 'fixture', state: {
    goal: 'Inspect historical retries', scope: 'Only retry helpers', knownContext: ['Keep requests local'],
    openQuestions: openQuestions ? [{ id: '2', prompt: 'Which saved retry helpers belong in scope?', status: 'open', recommendedAnswer: 'Saved recommendation only' }] : [],
    answeredQuestions: [{ id: 'answered', prompt: 'Keep the original record?', answer: 'Yes, exactly. 界 e\u0301 😀', status: 'answered', answeredAt: 123 }],
    tasks: [{ id: 'inspect', title: 'Inspect retry behavior', status: 'completed', verification: ['Run retry tests'] }],
    verificationGates: [{ id: 'tests', description: 'Retry tests pass' }], executionApproved: approved,
    metadata: { active: true, approvedAt: approved ? 456 : null, approvedFrom: approved ? 'saved-operator' : null, opaqueHistory: ['preserve', { tail: 'exact-source-tail' }] },
  } });
  await store.close();
  const reopened = openStore(path); await reopened.store.init();
  judgment.requests.length = 0;
  return { path, ...reopened };
}
async function record(store: KnowledgeStore, service: ProjectPlanningService) {
  return { sources: structuredClone(store.listSources(1000).sort((a, b) => a.id.localeCompare(b.id))), state: await service.getState({ projectId: 'fixture' }) };
}

for (const questions of [true, false]) for (const approved of [true, false]) {
  test(`saved ${questions ? 'question' : 'no-question'} history, approval ${approved}, is read-only across open, refresh, close and restart`, async () => {
    const f = await savedRecord(questions, approved);
    const before = await record(f.store, f.service); const bytes = readFileSync(f.path);
    const evaluate = spyOn(f.service, 'evaluate');
    const stateWrite = spyOn(f.service, 'upsertState');
    const apply = spyOn(f.service, 'applyStateAction');
    const sourceWrite = spyOn(f.store, 'upsertSource');
    const sourceReplace = spyOn(f.store, 'replaceSourceRecord');
    const conditionalWrite = spyOn(f.store, 'upsertSourceIfCurrent');
    const surface = createPlanningModalSurface({ service: passiveService(f.service), projectId: 'fixture' });
    const modal = new ConfigModal(); const commands: string[] = []; const nativeInputs: string[] = [];
    const context = { print: () => {}, executeCommand: async (name: string) => { commands.push(name); }, submitInput: (text: string) => nativeInputs.push(text) };
    try {
      modal.open(surface); await flush(); modal.syncStructure();
      expect(viewText(surface.buildView())).toContain('Inspect historical retries');
      expect(viewText(surface.buildView())).toContain(`historical approval ${approved ? 'yes' : 'no'}`);
      if (questions) expect(viewText(surface.buildView())).toContain('Which saved retry helpers belong in scope?');
      expect(surface.actions?.map(action => action.id)).toEqual(['refresh']);
      expect(surface.buildView().tabs.flatMap(tab => tab.rows).every(row => row.selectable === false)).toBe(true);
      expect(modal.fireAction('enter', context)).toBe(false);
      expect(modal.fireAction('a', context)).toBe(false);
      expect(modal.fireAction('d', context)).toBe(false);
      // Stale callbacks from the former interview must be inert even if invoked
      // directly, rather than merely being absent from the keyboard hint row.
      for (const action of ['submit', 'approve', 'dismiss']) surface.onAction?.(action, actionCtx({ id: 'answer:1:approve-execution', label: 'Approve execution' }, context));
      for (let count = 0; count < 2; count++) { expect(modal.fireAction('r', context)).toBe(true); await flush(); }
      modal.close(); modal.open(surface); await flush(); modal.close();
      expect(evaluate).not.toHaveBeenCalled(); expect(judgment.requests).toEqual([]);
      for (const write of [stateWrite, apply, sourceWrite, sourceReplace, conditionalWrite]) expect(write).not.toHaveBeenCalled();
      expect(commands).toEqual([]); expect(nativeInputs).toEqual([]);
      expect(readFileSync(f.path)).toEqual(bytes);
      expect(await record(f.store, f.service)).toEqual(before);
      await f.store.close();
      const restarted = openStore(f.path); await restarted.store.init();
      const after = await record(restarted.store, restarted.service);
      expect(after).toEqual(before);
      expect(after.state.state?.executionApproved).toBe(approved);
      expect(after.state.state?.metadata).toEqual(before.state.state?.metadata);
      expect(after.state.state?.answeredQuestions[0]?.answer).toBe('Yes, exactly. 界 e\u0301 😀');
      const restartedSurface = createPlanningModalSurface({ service: passiveService(restarted.service), projectId: 'fixture' });
      modal.open(restartedSurface); await flush(); modal.close();
      expect(await record(restarted.store, restarted.service)).toEqual(before);
      expect(readFileSync(f.path)).toEqual(bytes); expect(judgment.requests).toEqual([]);
    } finally {
      modal.close();
      for (const spy of [evaluate, stateWrite, apply, sourceWrite, sourceReplace, conditionalWrite]) spy.mockRestore();
    }
  });
}
