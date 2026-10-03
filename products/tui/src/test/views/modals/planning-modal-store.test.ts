import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore, ProjectPlanningService } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { CommandRegistry, type CommandContext } from '../../../input/command-registry.ts';
import { ConfigModal } from '../../../input/config-modal.ts';
import { registerPlanningRuntimeCommands } from '../../../input/commands/planning-runtime.ts';
import { createPlanningModalSurface, type PlanningModalService } from '../../../views/modals/planning-modal.ts';
import type { ConfigModalSurface } from '../../../input/config-modal-types.ts';
import { actionCtx } from './modal-surface-test-helpers.ts';

const roots: string[] = [];
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(fakePort(name => noulAnswer(name === 'scope' || name === 'approval' ? 0.99 : 0.01)).port); });
afterEach(() => {
  installJudgmentPort(previous);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const row = (surface: ConfigModalSurface, suffix: string) => surface.buildView().tabs[0]!.rows.find(item => item.id.endsWith(`:${suffix}`))!;

async function fixture(openQuestions = true) {
  const root = mkdtempSync(join(tmpdir(), 'planning-modal-store-')); roots.push(root);
  const path = join(root, 'planning.sqlite');
  const store = new KnowledgeStore({ dbPath: path });
  const service = new ProjectPlanningService(store);
  await service.upsertState({ projectId: 'fixture', state: {
    goal: 'Inspect retries', scope: 'Only retry helpers', knownContext: ['Keep requests local'],
    openQuestions: openQuestions ? [{ id: '2', prompt: 'Which retry helpers belong in scope?', status: 'open' }, { id: 'other', prompt: 'Which tests should run?', status: 'open' }] : [],
    tasks: [{ id: 'inspect', title: 'Inspect retry behavior', verification: ['Run retry tests'] }],
    verificationGates: [{ id: 'tests', description: 'Retry tests pass' }], executionApproved: false,
  } });
  const registry = new CommandRegistry(); registerPlanningRuntimeCommands(registry);
  const output: string[] = [];
  const ctx = {
    print: (message: string) => output.push(message), openModal: () => {},
    session: { runtime: { sessionId: 'fixture' }, sessionLineageTracker: { setOriginalTask: () => {} } },
    workspace: { projectPlanningService: service, projectPlanningProjectId: 'fixture' },
    ops: { planManager: { getActive: () => null, list: () => [], dismiss: () => ({ outcome: 'no-active-plan' }) } },
    platform: {}, provider: {}, extensions: {}, renderRequest: () => {}, exit: () => {},
  } as unknown as CommandContext;
  const execute = (name: string, args: string[]) => registry.execute(name, args, ctx);
  const modalService: PlanningModalService = {
    status: input => service.status(input), getState: input => service.getState(input),
    listDecisions: input => service.listDecisions(input), getLanguage: input => service.getLanguage(input),
    evaluate: input => service.evaluate(input),
  };
  return { path, store, service, registry, ctx, execute, output, modalService };
}
async function open(service: PlanningModalService) {
  const surface = createPlanningModalSurface({ service, projectId: 'fixture' });
  surface.onOpen?.(() => {}); await flush(); return surface;
}
async function reopened(path: string) {
  const store = new KnowledgeStore({ dbPath: path }); await store.init();
  return { sources: store.listSources(1000).sort((a, b) => a.id.localeCompare(b.id)), state: await new ProjectPlanningService(store).getState({ projectId: 'fixture' }) };
}

for (const action of ['approve', 'answer'] as const) {
  test(`a delayed real ${action} command cannot write a same-millisecond replacement plan`, async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(70_000);
    try {
      const f = await fixture(); const surface = await open(f.modalService); const entered = deferred(), command = deferred(), done = deferred();
      const selected = await f.service.getState({ projectId: 'fixture' });
      const ctx = actionCtx(action === 'answer' ? row(surface, 'scope-focused-first-pass') : null, {
        executeCommand: async (name, args) => { entered.resolve(); await command.promise; try { return await f.execute(name, args); } finally { done.resolve(); } },
      });
      surface.onAction?.(action === 'answer' ? 'submit' : 'approve', ctx); await entered.promise;
      await f.service.upsertState({ projectId: 'fixture', state: { ...selected.state!, goal: 'A replacement goal', tasks: [{ id: 'replacement', title: 'Replacement work' }] } });
      const before = await reopened(f.path); const bytes = readFileSync(f.path);
      expect(before.state.state!.updatedAt).toBe(selected.state!.updatedAt);
      expect(before.state.revision).not.toEqual(selected.revision);
      command.resolve(); await done.promise; await flush();
      expect(f.output.join('\n')).toContain('Planning changed.');
      expect(readFileSync(f.path)).toEqual(bytes);
      expect(await reopened(f.path)).toEqual(before);
      surface.onClose?.();
    } finally { clock.mockRestore(); }
  });
}

test('a selected numeric question ID reaches the real store as an ID, while manual indexes remain supported', async () => {
  const f = await fixture(); const surface = await open(f.modalService); const done = deferred();
  surface.onAction?.('submit', actionCtx(row(surface, 'scope-focused-first-pass'), { executeCommand: async (name, args) => { try { return await f.execute(name, args); } finally { done.resolve(); } } }));
  await done.promise;
  const afterSelected = await f.service.getState({ projectId: 'fixture' });
  expect(afterSelected.state!.answeredQuestions.map(question => question.id)).toEqual(['2']);
  expect(afterSelected.state!.openQuestions.map(question => question.id)).toEqual(['other']);
  await f.execute('project-plan', ['answer', '1', 'Run the remaining tests.']);
  await f.execute('project-plan', ['approve']);
  const restored = (await reopened(f.path)).state;
  expect(restored.state!.answeredQuestions.map(question => question.id)).toEqual(['2', 'other']);
  expect(restored.state!.executionApproved).toBe(true);
  expect(f.output.join('\n')).toContain('Project planning approved.');
  surface.onClose?.();
});

test('two real ConfigModal Enter events admit one source read and one persisted answer', async () => {
  const f = await fixture(); const sourceRead = deferred(), done = deferred(); let reads = 0, commands = 0;
  const surface = createPlanningModalSurface({ projectId: 'fixture', service: { ...f.modalService, getState: async input => {
    if (++reads > 1) await sourceRead.promise;
    return f.service.getState(input);
  } } });
  const modal = new ConfigModal(); modal.open(surface); await flush(); modal.syncStructure();
  modal.jumpToRow('planning', row(surface, 'scope-focused-first-pass').id);
  const ctx = { print: () => {}, executeCommand: async (name: string, args: string[]) => { commands++; try { return await f.execute(name, args); } finally { done.resolve(); } } };
  modal.fireAction('enter', ctx); modal.fireAction('enter', ctx);
  expect(reads).toBe(2); sourceRead.resolve(); await done.promise;
  expect(commands).toBe(1);
  expect((await reopened(f.path)).state.state!.answeredQuestions).toHaveLength(1);
  modal.close();
});

test('a changed source after awaited evaluation holds even when timestamps and synthetic question text match', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(80_000);
  try {
    const f = await fixture(false); const entered = deferred(), evaluation = deferred(); let evaluations = 0;
    const surface = await open({ ...f.modalService, evaluate: async input => {
      if (++evaluations === 2) { entered.resolve(); await evaluation.promise; }
      return f.service.evaluate(input);
    } });
    const statuses: string[] = []; let commands = 0;
    surface.onAction?.('submit', actionCtx(row(surface, 'approve-execution'), { setStatus: message => statuses.push(message), executeCommand: async (name, args) => { commands++; return f.execute(name, args); } }));
    await entered.promise;
    const selected = await f.service.getState({ projectId: 'fixture' });
    await f.service.upsertState({ projectId: 'fixture', state: { ...selected.state!, goal: 'Different goal requiring a fresh review' } });
    const bytes = readFileSync(f.path); const before = await reopened(f.path);
    evaluation.resolve(); await flush(); await flush();
    expect(commands).toBe(0); expect(statuses.some(status => status.includes('changed'))).toBe(true);
    expect(readFileSync(f.path)).toEqual(bytes); expect(await reopened(f.path)).toEqual(before);
    surface.onClose?.();
  } finally { clock.mockRestore(); }
});
