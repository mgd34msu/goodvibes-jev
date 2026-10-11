import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  KnowledgeStore, ProjectPlanningService,
  type ProjectPlanningStateActionInput, type ProjectPlanningStateUpsertInput,
} from '@goodvibes-jev/engine/sdk/platform/knowledge';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'planning-revision-')); roots.push(root);
  const path = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath: path });
  const service = new ProjectPlanningService(store);
  const authored: ProjectPlanningStateUpsertInput['state'] = {
    goal: 'Inspect retry behavior only', scope: 'Retry helper', executionApproved: false,
    openQuestions: [{ id: 'q1', prompt: 'Which retry cases need coverage?', status: 'open' }],
    tasks: [{ id: 'retry', title: 'Inspect retries', verification: ['Run retry tests'] }],
    verificationGates: [{ id: 'tests', description: 'Retry tests pass' }],
  };
  await service.upsertState({ projectId: 'fixture', state: authored });
  const selected = await service.getState({ projectId: 'fixture' });
  expect(selected.revision).toBeDefined();
  return { root, path, store, service, selected, authored };
}
async function persisted(path: string) {
  const reopened = new KnowledgeStore({ dbPath: path });
  await reopened.init();
  return reopened.listSources(1000).sort((a,b) => a.id.localeCompare(b.id));
}
const selectedAction = (f: Awaited<ReturnType<typeof fixture>>, action: ProjectPlanningStateActionInput['action']): ProjectPlanningStateActionInput => ({
  projectId: 'fixture', expected: { kind: 'revision', revision: f.selected.revision! }, action,
});

for (const action of [{ kind: 'approve' }, { kind: 'answer', questionId: 'q1', answer: 'Cover the cap.' }] as const) {
  test(`a stale ${action.kind} holds with byte-identical SQLite and no work-plan writes`, async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(50_000);
    try {
      const f = await fixture();
      await f.service.upsertState({ projectId: 'fixture', state: { ...f.authored, goal: 'A different plan', tasks: [{ id: 'different', title: 'Different task' }] } });
      const latest = await f.service.getState({ projectId: 'fixture' });
      expect(latest.state!.updatedAt).toBe(f.selected.state!.updatedAt);
      expect(latest.revision!.generation).not.toBe(f.selected.revision!.generation);
      const rows = await persisted(f.path); const bytes = readFileSync(f.path);
      const result = await f.service.applyStateAction(selectedAction(f, action));
      expect(result).toMatchObject({ applied: false, reason: 'state-changed', state: { goal: 'A different plan', executionApproved: false } });
      expect(readFileSync(f.path)).toEqual(bytes);
      expect(await persisted(f.path)).toEqual(rows);
    } finally { clock.mockRestore(); }
  });
}

test('generation includes persisted source columns outside the planning state', async () => {
  const f = await fixture();
  const source = f.store.getSource(f.selected.revision!.sourceId)!;
  await f.store.upsertSource({ ...source, summary: 'Updated source summary' });
  const result = await f.service.applyStateAction(selectedAction(f, { kind: 'approve' }));
  expect(result).toMatchObject({ applied: false, reason: 'state-changed' });
});

test('a mutable source-cache object cannot change the stored generation or grant approval', async () => {
  const f = await fixture();
  const cached = f.store.getSource(f.selected.revision!.sourceId)!;
  const cachedState = cached.metadata.value as { goal: string; executionApproved: boolean };
  cachedState.goal = 'Poisoned cache'; cachedState.executionApproved = true;
  const read = await f.service.getState({ projectId: 'fixture' });
  expect(read.state).toMatchObject({ goal: 'Inspect retry behavior only', executionApproved: false });
  expect(read.revision).toEqual(f.selected.revision);
  expect(f.store.getSourceGeneration(cached.id)).toBe(f.selected.revision!.generation);
  const answered = await f.service.applyStateAction(selectedAction(f, { kind: 'answer', questionId: 'q1', answer: 'Cover retry limits.' }));
  expect(answered).toMatchObject({ applied: true, state: { goal: 'Inspect retry behavior only', executionApproved: false } });
});

for (const mode of ['revision', 'current'] as const) {
  test(`${mode} mode holds when a writer wins during the conditional store init await`, async () => {
    const f = await fixture(); const entered = deferred(); const gate = deferred();
    const originalInit = f.store.init.bind(f.store); let calls = 0;
    f.store.init = async () => { if (++calls === 2) { entered.resolve(); await gate.promise; } await originalInit(); };
    const pending = f.service.applyStateAction({ projectId: 'fixture', expected: mode === 'current' ? { kind: 'current' } : { kind: 'revision', revision: f.selected.revision! }, action: { kind: 'approve' } });
    await entered.promise;
    await f.service.upsertState({ projectId: 'fixture', state: { ...f.authored, goal: 'Intervening writer goal' } });
    const bytes = readFileSync(f.path); const rows = await persisted(f.path);
    gate.resolve();
    const result = await pending;
    expect(result).toMatchObject({ applied: false, reason: 'state-changed', state: { goal: 'Intervening writer goal', executionApproved: false } });
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(await persisted(f.path)).toEqual(rows);
  });
}

test('two answers with one selected revision produce one applied result and one hold', async () => {
  const f = await fixture();
  const input = selectedAction(f, { kind: 'answer', questionId: 'q1', answer: 'Cover retry limits.' });
  const results = await Promise.all([f.service.applyStateAction(input), f.service.applyStateAction(input)]);
  expect(results.filter(result => result.applied)).toHaveLength(1);
  expect(results.filter(result => !result.applied && result.reason === 'state-changed')).toHaveLength(1);
  const loaded = await f.service.getState({ projectId: 'fixture' });
  expect(loaded.state!.answeredQuestions).toHaveLength(1);
  expect(loaded.state!.openQuestions).toEqual([]);
});

test('caller mutation during init cannot retarget the captured revision or action', async () => {
  const f = await fixture(); const entered = deferred(); const gate = deferred();
  const originalInit = f.store.init.bind(f.store); let calls = 0;
  f.store.init = async () => { if (++calls === 1) { entered.resolve(); await gate.promise; } await originalInit(); };
  const revision = { ...f.selected.revision! };
  const action = { kind: 'answer' as const, questionId: 'q1', answer: 'Original answer' };
  const pending = f.service.applyStateAction({ projectId: 'fixture', expected: { kind: 'revision', revision }, action });
  await entered.promise;
  await f.service.upsertState({ projectId: 'fixture', state: { ...f.authored, goal: 'A replacement plan' } });
  revision.generation = (await f.service.getState({ projectId: 'fixture' })).revision!.generation;
  action.answer = 'Mutated answer';
  const bytes = readFileSync(f.path); gate.resolve();
  expect(await pending).toMatchObject({ applied: false, reason: 'state-changed' });
  expect(readFileSync(f.path)).toEqual(bytes);
});

test('successful explicit approval persists and its revision agrees after reopening SQLite', async () => {
  const f = await fixture();
  const result = await f.service.applyStateAction(selectedAction(f, { kind: 'approve' }));
  expect(result).toMatchObject({ applied: true, state: { executionApproved: true, metadata: { approvedFrom: 'plan-command' } } });
  if (result.applied) expect(typeof result.state.metadata?.approvedAt).toBe('number');
  if (!result.applied) throw new Error('Expected explicit approval');
  const reopened = new KnowledgeStore({ dbPath: f.path }); await reopened.init();
  const loaded = await new ProjectPlanningService(reopened).getState({ projectId: 'fixture' });
  expect(loaded.state).toEqual(result.state);
  expect(loaded.revision).toEqual(result.revision);
});

test('metadata cannot choose an approval action or bypass its selected revision', async () => {
  const f = await fixture();
  const input = { ...selectedAction(f, { kind: 'answer', questionId: 'q1', answer: 'Cover retries.' }),
    metadata: { action: 'approve', executionApproved: true, expected: 'current' } };
  const result = await f.service.applyStateAction(input);
  expect(result).toMatchObject({ applied: true, state: { executionApproved: false } });
});

test('missing/invalid questions hold without source or work-plan writes', async () => {
  const f = await fixture(); const bytes = readFileSync(f.path);
  for (const action of [
    { kind: 'answer', questionId: 'missing', answer: 'Answer' },
    { kind: 'answer', questionId: 'q1', answer: ' ' },
    { kind: 'answer', answer: 'Answer' },
  ] as const) expect((await f.service.applyStateAction(selectedAction(f, action))).applied).toBe(false);
  expect(readFileSync(f.path)).toEqual(bytes);
});

test('a conditional source creation with an absent precondition never overwrites a winner', async () => {
  const f = await fixture();
  const input = { id: 'conditional-source', connectorId: 'fixture', sourceType: 'dataset' as const, status: 'indexed' as const, metadata: { note: 'first' } };
  const results = await Promise.all([f.store.upsertSourceIfCurrent(input, null), f.store.upsertSourceIfCurrent({ ...input, metadata: { note: 'second' } }, null)]);
  expect(results.map(result => result.kind).sort()).toEqual(['held', 'written']);
  expect(f.store.getSourceSnapshot({ id: input.id }).source?.metadata.note).toBe('first');
});

test('legacy answer reports a persisted conflict without syncing or overwriting another owner', async () => {
  const f = await fixture(); const entered = deferred(); const gate = deferred();
  const originalInit = f.store.init.bind(f.store); let calls = 0;
  f.store.init = async () => { if (++calls === 2) { entered.resolve(); await gate.promise; } await originalInit(); };
  const pending = f.service.answerQuestion({ projectId: 'fixture', questionId: 'q1', answer: 'Stale answer' });
  await entered.promise;
  const other = new ProjectPlanningService(new KnowledgeStore({ dbPath: f.path }));
  await other.upsertState({ projectId: 'fixture', state: { ...f.authored, goal: 'Other owner replacement', tasks: [{ id: 'other', title: 'Other work' }] } });
  const bytes = readFileSync(f.path); const rows = await persisted(f.path);
  gate.resolve();
  expect(await pending).toMatchObject({ answered: false, reason: 'state-changed', state: { goal: 'Other owner replacement' }, evaluation: { state: { goal: 'Other owner replacement' } } });
  expect(readFileSync(f.path)).toEqual(bytes);
  expect(await persisted(f.path)).toEqual(rows);
});

test('legacy answer reports pending local changes without discarding the batch', async () => {
  const f = await fixture();
  await f.store.batch(async () => {
    await f.store.upsertJobRun({ id: 'pending-answer-job', jobId: 'fixture', status: 'completed', mode: 'inline' });
    expect(await f.service.answerQuestion({ projectId: 'fixture', questionId: 'q1', answer: 'Held answer' }))
      .toMatchObject({ answered: false, reason: 'pending-local-changes', state: { answeredQuestions: [] } });
  });
  const reopened = new KnowledgeStore({ dbPath: f.path }); await reopened.init();
  expect(reopened.getJobRun('pending-answer-job')?.status).toBe('completed');
  expect((await new ProjectPlanningService(reopened).getState({ projectId: 'fixture' })).state!.answeredQuestions).toEqual([]);
});

test('legacy duplicate answers yield one success and one honest hold', async () => {
  const f = await fixture();
  const input = { projectId: 'fixture', questionId: 'q1', answer: 'One answer' };
  const results = await Promise.all([f.service.answerQuestion(input), f.service.answerQuestion(input)]);
  expect(results.filter(result => result.answered)).toHaveLength(1);
  expect(results.filter(result => !result.answered && result.reason === 'state-changed')).toHaveLength(1);
  expect((await f.service.getState({ projectId: 'fixture' })).state!.answeredQuestions).toHaveLength(1);
});

test('legacy answer captures identity and answer before initialization awaits', async () => {
  const f = await fixture(); const entered = deferred(); const gate = deferred();
  const originalInit = f.store.init.bind(f.store); let calls = 0;
  f.store.init = async () => { if (++calls === 1) { entered.resolve(); await gate.promise; } await originalInit(); };
  const input = { projectId: 'fixture', questionId: 'q1', answer: 'Original answer' };
  const pending = f.service.answerQuestion(input);
  await entered.promise;
  input.projectId = 'different'; input.questionId = 'different'; input.answer = 'Changed answer';
  gate.resolve();
  expect(await pending).toMatchObject({ answered: true, projectId: 'fixture', question: { id: 'q1', answer: 'Original answer' } });
});
