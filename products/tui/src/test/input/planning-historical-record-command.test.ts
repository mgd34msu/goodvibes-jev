import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore, ProjectPlanningService } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { selectedPlanningTarget } from '../../input/commands/planning-action-target.ts';
import { registerPlanningRuntimeCommands } from '../../input/commands/planning-runtime.ts';

const roots: string[] = [];
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(fakePort(name => noulAnswer(name === 'scope' || name === 'approval' ? 0.99 : 0.01)).port); });
afterEach(() => {
  installJudgmentPort(previous);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'planning-record-command-')); roots.push(root);
  const path = join(root, 'planning.sqlite');
  const store = new KnowledgeStore({ dbPath: path });
  const service = new ProjectPlanningService(store);
  await service.upsertState({ projectId: 'fixture', state: {
    goal: '  Inspect retries\nwithout widening scope  ', scope: 'Only retry helpers', knownContext: ['Keep requests local'],
    openQuestions: [{ id: '2', prompt: 'Which retry helpers belong in scope?', status: 'open' }, { id: 'other', prompt: 'Which tests should run?', status: 'open' }],
    tasks: [{ id: 'inspect', title: 'Inspect retry behavior', verification: ['Run retry tests'] }],
    verificationGates: [{ id: 'tests', description: 'Retry tests pass' }], executionApproved: false,
    metadata: { savedOwner: 'historical fixture', custom: { retain: true } },
  } });
  const registry = new CommandRegistry(); registerPlanningRuntimeCommands(registry);
  const output: string[] = []; const opened: string[] = [];
  const ctx = {
    print: (message: string) => output.push(message), openModal: (name: string) => { opened.push(name); },
    workspace: { projectPlanningService: service, projectPlanningProjectId: 'fixture' },
    dispatchNativeIntakeTurn: async () => { throw new Error('Historical record edits cannot dispatch native intake'); },
  } as unknown as CommandContext;
  const execute = (args: string[]) => registry.execute('project-plan', args, ctx);
  return { path, store, service, execute, output, opened };
}

async function reopened(path: string) {
  const store = new KnowledgeStore({ dbPath: path }); await store.init();
  return { sources: store.listSources(1000).sort((a, b) => a.id.localeCompare(b.id)), state: await new ProjectPlanningService(store).getState({ projectId: 'fixture' }) };
}

for (const action of ['approve', 'answer']) {
  test(`explicit historical ${action} rejects a replaced revision without changing saved bytes`, async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(70_000);
    try {
      const f = await fixture();
      const selected = await f.service.getState({ projectId: 'fixture' });
      await f.service.upsertState({ projectId: 'fixture', state: { ...selected.state!, goal: 'A replacement goal', executionApproved: true,
        metadata: { ...selected.state!.metadata, approvedAt: 42, approvedFrom: 'previous-owner' } } });
      const before = await reopened(f.path); const bytes = readFileSync(f.path);
      expect(before.state.state!.updatedAt).toBe(selected.state!.updatedAt);
      expect(before.state.revision).not.toEqual(selected.revision);
      await f.execute([action, ...selectedPlanningTarget(selected.state!.id, selected.revision!), ...(action === 'answer' ? ['2', 'Too late'] : [])]);
      expect(f.output.join('\n')).toContain('Planning changed.');
      expect(f.opened).toEqual([]);
      expect(readFileSync(f.path)).toEqual(bytes);
      expect(await reopened(f.path)).toEqual(before);
    } finally { clock.mockRestore(); }
  });
}

test('selected numeric IDs and explicit current indexes still edit saved questions without reopening an interview', async () => {
  const f = await fixture();
  const selected = await f.service.getState({ projectId: 'fixture' });
  const evaluate = spyOn(f.service, 'evaluate').mockImplementation(async () => { throw new Error('No fresh interview evaluation'); });
  try {
    await f.execute(['answer', ...selectedPlanningTarget(selected.state!.id, selected.revision!), '2', 'Only retry helpers.']);
    const afterSelected = await f.service.getState({ projectId: 'fixture' });
    expect(afterSelected.state!.answeredQuestions.map(question => question.id)).toEqual(['2']);
    expect(afterSelected.state!.openQuestions.map(question => question.id)).toEqual(['other']);
    await f.execute(['answer', '1', 'Run the remaining tests.']);
    const answered = await f.service.getState({ projectId: 'fixture' });
    await f.execute(['approve', ...selectedPlanningTarget(answered.state!.id, answered.revision!)]);
    const restored = (await reopened(f.path)).state;
    expect(restored.state!.answeredQuestions.map(question => [question.id, question.answer])).toEqual([
      ['2', 'Only retry helpers.'], ['other', 'Run the remaining tests.'],
    ]);
    expect(restored.state!.openQuestions).toEqual([]);
    expect(restored.state!.executionApproved).toBe(true);
    expect(restored.state!.metadata).toMatchObject({ savedOwner: 'historical fixture', custom: { retain: true }, approvedFrom: 'plan-command' });
    expect(restored.state!.goal).toBe(selected.state!.goal);
    expect(f.output.join('\n')).toContain('Historical planning approval recorded; no native work authorized.');
    expect(f.output.join('\n')).not.toContain('Next question:');
    expect(f.output.join('\n')).not.toContain('Readiness:');
    expect(evaluate).not.toHaveBeenCalled();
  } finally { evaluate.mockRestore(); }
});

test('history and native recovery view commands preserve saved approval metadata and file bytes', async () => {
  const f = await fixture(); await f.execute(['approve']);
  const before = await reopened(f.path); const bytes = readFileSync(f.path);
  await f.execute(['history']); await f.execute(['panel']); await f.execute([]);
  expect(f.opened.slice(-3)).toEqual(['planning-modal', 'native-work-ledger-modal', 'native-work-ledger-modal']);
  expect(readFileSync(f.path)).toEqual(bytes);
  expect(await reopened(f.path)).toEqual(before);
});
