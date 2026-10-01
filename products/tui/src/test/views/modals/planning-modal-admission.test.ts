import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { ProjectPlanningState } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { createPlanningModalSurface, type PlanningModalService } from '../../../views/modals/planning-modal.ts';
import type { ConfigModalSurface } from '../../../input/config-modal-types.ts';
import { actionCtx, captureCommands } from './modal-surface-test-helpers.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(fakePort(name => noulAnswer(name === 'scope' ? 0.99 : 0.01)).port); });
afterEach(() => { installJudgmentPort(previous); });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const state: ProjectPlanningState = {
    id: 'state-1', projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', goal: 'Inspect retry behavior',
    knownContext: [], openQuestions: [{ id: 'q1', prompt: 'Which components belong in scope?', status: 'open' }],
    answeredQuestions: [], decisions: [], assumptions: [], constraints: [], risks: [], tasks: [], dependencies: [],
    verificationGates: [], agentAssignments: [], readiness: 'needs-user-input', executionApproved: false,
    createdAt: 0, updatedAt: 1,
  };
  const result = { ok: true as const, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', state, revision: { sourceId: 'fixture-source', generation: 'a'.repeat(64) } };
  const service: PlanningModalService = {
    status: async () => ({ ...result, passiveOnly: true, counts: { states: 1, decisions: 0, languageArtifacts: 0, workPlans: 0, workPlanTasks: 0 }, capabilities: [] }),
    getState: async () => result,
    listDecisions: async () => ({ ...result, decisions: [] }),
    getLanguage: async () => ({ ...result, language: null }),
    evaluate: async () => ({ ...result, readiness: state.readiness, gaps: [] }),
  };
  return { result, service };
}
const row = (surface: ConfigModalSurface) => surface.buildView().tabs[0]!.rows.find(r => r.id.endsWith(':scope-focused-first-pass'))!;
async function open(service: PlanningModalService) {
  const surface = createPlanningModalSurface({ service, projectId: 'proj-1' });
  surface.onOpen?.(() => {}); await flush(); return surface;
}

test('submission admission stays held while the actual command promise is pending', async () => {
  const { service } = fixture(); const surface = await open(service); const gate = deferred();
  let commands = 0;
  const ctx = actionCtx(row(surface), { executeCommand: async () => { commands++; await gate.promise; } });
  surface.onAction?.('submit', ctx); await flush();
  surface.onAction?.('submit', ctx); await flush();
  expect(commands).toBe(1);
  gate.resolve(); await flush(); surface.onClose?.();
});

test('top-level approval shares synchronous admission and the captured revision', async () => {
  const f = fixture(); const surface = await open(f.service); const gate = deferred();
  const commands: string[][] = [];
  const ctx = actionCtx(null, { executeCommand: async (_name, args) => { commands.push(args); await gate.promise; } });
  surface.onAction?.('approve', ctx); surface.onAction?.('approve', ctx);
  expect(commands).toEqual([['approve', '--selected-revision', f.result.state.id, f.result.revision.sourceId, f.result.revision.generation]]);
  gate.resolve(); await flush(); surface.onClose?.();
});

test('legacy reads without a persisted revision hold view mutations but keep custom entry', async () => {
  const f = fixture(); const { revision: _revision, ...legacy } = f.result;
  const surface = await open({ ...f.service, getState: async () => legacy });
  const cap = captureCommands(); const statuses: string[] = [];
  surface.onAction?.('approve', actionCtx(null, { ...cap.extra, setStatus: message => statuses.push(message) }));
  await flush();
  surface.onAction?.('submit', actionCtx(row(surface), { ...cap.extra, setStatus: message => statuses.push(message) }));
  await flush();
  expect(cap.calls).toEqual([]);
  expect(statuses).toEqual(Array(2).fill('The selected planning revision is unavailable. Refresh before changing it.'));
  let closed = false;
  const custom = surface.buildView().tabs[0]!.rows.find(item => item.id.endsWith(':custom'))!;
  surface.onAction?.('submit', actionCtx(custom, { close: () => { closed = true; } }));
  expect(closed).toBe(true); surface.onClose?.();
});

test('mutating a returned service object cannot retarget the already selected approval', async () => {
  const f = fixture(); const surface = await open(f.service); const original = { ...f.result.revision };
  f.result.revision.generation = 'b'.repeat(64);
  Reflect.set(f.result.state, 'goal', 'A later mutable object value');
  const cap = captureCommands(); surface.onAction?.('approve', actionCtx(null, cap.extra));
  await flush();
  expect(cap.calls).toEqual([['project-plan', ['approve', '--selected-revision', f.result.state.id, original.sourceId, original.generation]]]);
  surface.onClose?.();
});

test('a failed command releases admission for an explicit retry and contains the failure', async () => {
  const { service } = fixture(); const surface = await open(service);
  let commands = 0; const statuses: string[] = [];
  const ctx = actionCtx(row(surface), {
    executeCommand: async () => { if (++commands === 1) throw new Error('synthetic private failure'); },
    setStatus: message => statuses.push(message),
  });
  surface.onAction?.('submit', ctx); await flush();
  surface.onAction?.('submit', ctx); await flush();
  expect(commands).toBe(2);
  expect(statuses).toContain('Could not submit the planning answer. Refresh before trying again.');
  expect(statuses.join('\n')).not.toContain('synthetic private failure');
  surface.onClose?.();
});

test('a failed source read releases admission without dispatching a command', async () => {
  const f = fixture(); let reads = 0;
  const surface = await open({ ...f.service, getState: async () => { if (++reads === 2) throw new Error('synthetic source failure'); return f.result; } });
  const cap = captureCommands(); const ctx = actionCtx(row(surface), cap.extra);
  surface.onAction?.('submit', ctx); await flush(); expect(cap.calls).toEqual([]);
  surface.onAction?.('submit', ctx); await flush(); expect(cap.calls).toHaveLength(1);
  surface.onClose?.();
});

test('an older generation settling after reopen cannot release the new generation admission', async () => {
  const f = fixture(); const oldRead = deferred(); const newRead = deferred(); let reads = 0;
  const surface = await open({ ...f.service, getState: async () => {
    const call = ++reads;
    if (call === 2) await oldRead.promise;
    if (call === 4) await newRead.promise;
    return f.result;
  } });
  const cap = captureCommands();
  surface.onAction?.('submit', actionCtx(row(surface), cap.extra));
  surface.onClose?.(); surface.onOpen?.(() => {}); await flush();
  surface.onAction?.('submit', actionCtx(row(surface), cap.extra));
  oldRead.resolve(); await flush();
  surface.onAction?.('submit', actionCtx(row(surface), cap.extra));
  expect(reads).toBe(4);
  expect(cap.calls).toEqual([]);
  newRead.resolve(); await flush();
  expect(cap.calls).toHaveLength(1);
  surface.onClose?.();
});
