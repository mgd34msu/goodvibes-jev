import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { ProjectPlanningState } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { createPlanningModalSurface, type PlanningModalService } from '../../../views/modals/planning-modal.ts';
import { actionCtx, captureCommands, viewText } from './modal-surface-test-helpers.ts';

let previous: ReturnType<typeof installJudgmentPort>;
let judgment: ReturnType<typeof fakePort>;
beforeEach(() => { judgment = fakePort(() => noulAnswer(0.99)); previous = installJudgmentPort(judgment.port); });
afterEach(() => { expect(judgment.requests).toEqual([]); installJudgmentPort(previous); });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(goal = 'Inspect saved retry behavior') {
  const state: ProjectPlanningState = {
    id: 'state-1', projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', goal,
    knownContext: [], openQuestions: [{ id: 'q1', prompt: 'Which saved components belonged in scope?', status: 'open' }],
    answeredQuestions: [], decisions: [], assumptions: [], constraints: [], risks: [], tasks: [], dependencies: [],
    verificationGates: [], agentAssignments: [], readiness: 'needs-user-input', executionApproved: false,
    createdAt: 0, updatedAt: 1,
  };
  const result = { ok: true as const, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', state, revision: { sourceId: 'fixture-source', generation: 'a'.repeat(64) } };
  const reads: string[] = [];
  const service: PlanningModalService = {
    status: async () => { reads.push('status'); return { ...result, passiveOnly: true, counts: { states: 1, decisions: 0, languageArtifacts: 0, workPlans: 0, workPlanTasks: 0 }, capabilities: [] }; },
    getState: async () => { reads.push('state'); return result; },
    listDecisions: async () => { reads.push('decisions'); return { ...result, decisions: [] }; },
    getLanguage: async () => { reads.push('language'); return { ...result, language: null }; },
  };
  return { result, service, reads };
}
async function open(service: PlanningModalService) {
  const surface = createPlanningModalSurface({ service, projectId: 'proj-1' });
  surface.onOpen?.(() => {}); await flush(); return surface;
}

test('opening and refreshing historical records need only four passive service methods', async () => {
  const f = fixture();
  const service = new Proxy(f.service, { get(target, key, receiver) {
    if (!Object.hasOwn(target, key)) throw new Error(`Unexpected service capability: ${String(key)}`);
    return Reflect.get(target, key, receiver);
  } });
  const surface = await open(service);
  expect(viewText(surface.buildView())).toContain(f.result.state.goal);
  expect(f.reads).toEqual(['status', 'state', 'decisions', 'language']);
  surface.onAction?.('refresh', actionCtx(null)); await flush();
  expect(f.reads).toEqual(['status', 'state', 'decisions', 'language', 'status', 'state', 'decisions', 'language']);
  expect(surface.actions?.map(action => action.id)).toEqual(['refresh']);
  surface.onClose?.();
});

test('legacy records without a saved revision remain readable but cannot answer, approve, dismiss or submit native text', async () => {
  const f = fixture(); const { revision: _revision, ...legacy } = f.result;
  const surface = await open({ ...f.service, getState: async () => legacy });
  expect(viewText(surface.buildView())).toContain(f.result.state.openQuestions[0]!.prompt);
  const cap = captureCommands(); const inputs: string[] = []; let closes = 0;
  for (const id of ['scope-focused-first-pass', 'approve-execution', 'custom']) {
    const ctx = actionCtx({ id: `answer:1:${id}`, label: 'Stale interview action' }, { ...cap.extra, submitInput: text => inputs.push(text), close: () => { closes++; } });
    for (const action of ['submit', 'approve', 'dismiss']) surface.onAction?.(action, ctx);
  }
  await flush();
  expect(cap.calls).toEqual([]); expect(inputs).toEqual([]); expect(closes).toBe(0);
  expect(surface.buildView().tabs.flatMap(tab => tab.rows).every(row => row.selectable === false)).toBe(true);
  surface.onClose?.();
});

test('later refresh wins when older passive reads settle out of order', async () => {
  const old = fixture('Older saved goal'); const current = fixture('Newer saved goal'); const gate = deferred(); let reads = 0;
  const surface = await open({ ...current.service, getState: async () => { if (++reads === 1) { await gate.promise; return old.result; } return current.result; } });
  surface.onAction?.('refresh', actionCtx(null)); await flush();
  expect(viewText(surface.buildView())).toContain('Newer saved goal');
  gate.resolve(); await flush();
  expect(viewText(surface.buildView())).toContain('Newer saved goal');
  expect(viewText(surface.buildView())).not.toContain('Older saved goal');
  surface.onClose?.();
});

test('closing during a read prevents a late repaint or replacement of reopened history', async () => {
  const old = fixture('Closed saved goal'); const current = fixture('Reopened saved goal'); const gate = deferred(); let reads = 0, renders = 0;
  const surface = createPlanningModalSurface({ projectId: 'proj-1', service: { ...current.service, getState: async () => { if (++reads === 1) { await gate.promise; return old.result; } return current.result; } } });
  surface.onOpen?.(() => { renders++; }); surface.onClose?.();
  const closedRenders = renders;
  gate.resolve(); await flush(); expect(renders).toBe(closedRenders);
  surface.onOpen?.(() => { renders++; }); await flush();
  expect(viewText(surface.buildView())).toContain('Reopened saved goal');
  expect(viewText(surface.buildView())).not.toContain('Closed saved goal');
  surface.onClose?.();
});

test('an older read settling after reopen cannot replace the new snapshot', async () => {
  const old = fixture('Old generation'); const current = fixture('New generation'); const gate = deferred(); let reads = 0;
  const surface = await open({ ...current.service, getState: async () => { if (++reads === 1) { await gate.promise; return old.result; } return current.result; } });
  surface.onClose?.(); surface.onOpen?.(() => {}); await flush();
  expect(viewText(surface.buildView())).toContain('New generation');
  gate.resolve(); await flush();
  expect(viewText(surface.buildView())).toContain('New generation');
  expect(viewText(surface.buildView())).not.toContain('Old generation');
  surface.onClose?.();
});

test('an unavailable passive read exposes no private error and explicit refresh can recover', async () => {
  const f = fixture(); let reads = 0;
  const surface = await open({ ...f.service, getState: async () => { if (++reads === 1) throw new Error('private fixture storage detail'); return f.result; } });
  expect(viewText(surface.buildView())).toContain('Historical planning records unavailable.');
  expect(viewText(surface.buildView())).not.toContain('private fixture storage detail');
  surface.onAction?.('refresh', actionCtx(null)); await flush();
  expect(surface.buildView().degraded).toBeUndefined(); expect(viewText(surface.buildView())).toContain(f.result.state.goal);
  surface.onClose?.();
});

test('returned state mutations cannot alter an already displayed historical snapshot', async () => {
  const f = fixture(); const surface = await open(f.service);
  Reflect.set(f.result.state, 'goal', 'Mutated after read');
  Reflect.set(f.result.state.openQuestions[0]!, 'prompt', 'Mutated question');
  expect(viewText(surface.buildView())).toContain('Inspect saved retry behavior');
  expect(viewText(surface.buildView())).toContain('Which saved components belonged in scope?');
  expect(viewText(surface.buildView())).not.toContain('Mutated');
  surface.onClose?.();
});
