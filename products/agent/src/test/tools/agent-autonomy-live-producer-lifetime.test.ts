import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createRuntimeStore, createDomainDispatch } from '../../runtime/store/index.ts';
import type { RuntimeTask } from '@/runtime/index.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createTasksReadModel } from '../helpers/ui-read-models.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';
import { AgentResearchRunRegistry, researchRunStorePath } from '../../agent/research-run-registry.ts';
import { autonomyLiveNativeFacts, captureAutonomyLiveRecords } from '../../tools/agent-harness-autonomy-live-records.ts';

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function fixture() {
  const store = createRuntimeStore(), dispatch = createDomainDispatch(store), tasks = createTasksReadModel(store);
  const context = { platform: { readModels: { tasks } } } as unknown as CommandContext;
  return { store, dispatch, tasks, context };
}
function task(id: string, queuedAt = 4001): RuntimeTask {
  return { id, kind: 'exec', title: `Synthetic task ${id}`, status: 'queued', owner: 'native-test', cancellable: true, childTaskIds: [], queuedAt };
}
async function createReceipt(store: ArtifactStore, createdAt: number) {
  const clock = spyOn(Date, 'now').mockReturnValue(createdAt);
  try { return await store.create({ kind: 'data', text: 'Native receipt artifact', metadata: { purpose: 'watcher-run-receipt', status: 'The selected watcher finished successfully.', operation: 'watcher-run' } }); }
  finally { clock.mockRestore(); }
}
function privacyFixture(before?: () => void) {
  let invoked = false;
  return fakePort((name, question, state) => {
    if (!invoked) { invoked = true; before?.(); }
    if (name === 'kind' && question.type === 'choice' && Object.hasOwn(question.criteria, 'owner_profile')) {
      if (!state || typeof state !== 'object' || !('field' in state) || typeof state.field !== 'string') throw new Error('Missing native field');
      return choiceAnswer(question, state.field === 'accessToken' ? 'secret' : 'other', 0.999);
    }
    if (name === 'status' && question.type === 'choice' && Object.hasOwn(question.criteria, 'succeeded')) return choiceAnswer(question, 'succeeded', 0.999);
    if (['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name)) return noulAnswer(0.001);
    throw new Error(`Unexpected autonomy privacy question ${name}`);
  });
}

describe('Autonomy complete native live-source boundary', () => {
  test('native startup returns literal statuses and cancellable flags without semantic transport', () => {
    const f = fixture(), fake = fakePort(() => { throw new Error('Startup hosted read'); }); installJudgmentPort(fake.port);
    f.dispatch.syncRuntimeTask({ ...task('one'), result: { accessToken: 'synthetic-startup-private' } });
    expect(autonomyLiveNativeFacts(f.context).tasks).toEqual([{ status: 'queued', cancellable: true }]);
    expect(fake.requests).toHaveLength(0);
  });
  test('complete tail enters privacy before bounded preview and preserves native read-only controls', async () => {
    const f = fixture(), fake = privacyFixture(); installJudgmentPort(fake.port);
    const tail = 'synthetic-complete-tail', guards: Array<() => void> = [];
    f.dispatch.syncRuntimeTask({ ...task('one'), result: `${'x'.repeat(1500)} ${tail}` });
    const result = await captureAutonomyLiveRecords(f.context, { sourceOwner: ordinaryResearchOwner(), retainCurrent: guard => { guards.push(guard); } });
    expect(JSON.stringify(fake.requests)).toContain(tail);
    expect(result.tasks[0]?.output?.preview?.length).toBeLessThanOrEqual(240);
    expect(result.tasks[0]?.status).toBe('queued');
    expect(result.tasks[0]?.controls?.find(control => control.id === 'inspect')?.effect).toBe('read-only');
    expect(result.tasks[0]?.controls?.find(control => control.id === 'cancel')?.state).toBe('available');
    expect(f.store.getState().tasks.tasks.get('one')?.status).toBe('queued');
    guards.forEach(guard => guard());
  });
  test('protected task payload remains usable while credential values never enter transport or output', async () => {
    const f = fixture(), fake = privacyFixture(); installJudgmentPort(fake.port);
    f.dispatch.syncRuntimeTask({ ...task('one'), result: { accessToken: 'synthetic-private-payload', message: 'Complete ordinary native output' } });
    const result = await captureAutonomyLiveRecords(f.context, { sourceOwner: ordinaryResearchOwner() });
    expect(result.tasks[0]?.output?.preview).toContain('[REDACTED]');
    expect(result.tasks[0]?.status).toBe('queued');
    expect(JSON.stringify(result)).not.toContain('synthetic-private-payload');
    expect(JSON.stringify(fake.requests)).not.toContain('synthetic-private-payload');
  });
  test('a hidden credential on the twenty-first native row holds before the presentation limit', async () => {
    const f = fixture(), fake = privacyFixture(); installJudgmentPort(fake.port);
    for (let index = 0; index < 21; index++) {
      const record = task(`task-${index}`, 5000 - index);
      if (index === 20) Object.defineProperty(record, 'accessToken', { value: 'synthetic-hidden-tail-private', enumerable: false });
      f.dispatch.syncRuntimeTask(record);
    }
    await expect(captureAutonomyLiveRecords(f.context, { sourceOwner: ordinaryResearchOwner() })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(JSON.stringify(fake.requests)).not.toContain('synthetic-hidden-tail-private');
    expect(fake.requests.some(request => JSON.stringify(request).includes('accessToken'))).toBe(true);
  });
  test('returned pure source guards retain omitted tail rows and reject native A to B to A', async () => {
    const f = fixture(), fake = privacyFixture(); installJudgmentPort(fake.port);
    for (let index = 0; index < 21; index++) f.dispatch.syncRuntimeTask(task(`task-${index}`, 5000 - index));
    const guards: Array<() => void> = [];
    const result = await captureAutonomyLiveRecords(f.context, { sourceOwner: ordinaryResearchOwner(), retainCurrent: guard => { guards.push(guard); } });
    expect(result.tasks).toHaveLength(20); guards.forEach(guard => guard());
    const original = f.store.getState().tasks.tasks.get('task-20'); if (!original) throw new Error('Missing actual tail row');
    f.dispatch.syncRuntimeTask({ ...original, title: 'Changed native row' }); f.dispatch.syncRuntimeTask(original);
    expect(() => guards.forEach(guard => guard())).toThrow(ToolInputProjectionError);
  });
  test('unrelated native domain updates do not retire the retained task observation', async () => {
    const f = fixture(), fake = privacyFixture(), guards: Array<() => void> = []; installJudgmentPort(fake.port);
    f.dispatch.syncRuntimeTask(task('one'));
    const result = await captureAutonomyLiveRecords(f.context, { sourceOwner: ordinaryResearchOwner(), retainCurrent: guard => { guards.push(guard); } });
    f.dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'unrelated-worker', task: 'Unrelated native domain' });
    expect(result.tasks[0]?.status).toBe('queued');
    expect(() => guards.forEach(guard => guard())).not.toThrow();
  });
  test('an installed snapshot reader without its native observation subscription is held', async () => {
    const fake = privacyFixture(); installJudgmentPort(fake.port);
    const context = { platform: { readModels: { tasks: { getSnapshot: () => ({ tasks: [task('one')] }) } } } } as unknown as CommandContext;
    await expect(captureAutonomyLiveRecords(context)).rejects.toThrow(ToolInputProjectionError);
    expect(fake.requests).toHaveLength(0);
  });
  test('pending source change cannot publish a native row after a canonical privacy reply', async () => {
    const f = fixture(); f.dispatch.syncRuntimeTask(task('one'));
    const fake = privacyFixture(() => f.dispatch.transitionRuntimeTask('one', 'running')); installJudgmentPort(fake.port);
    await expect(captureAutonomyLiveRecords(f.context, { sourceOwner: ordinaryResearchOwner() })).rejects.toThrow();
    expect(f.store.getState().tasks.tasks.get('one')?.status).toBe('running');
  });
  test('borrowed snapshot accessors hold without invocation or transport', async () => {
    const f = fixture(), fake = privacyFixture(); installJudgmentPort(fake.port); let reads = 0;
    Object.defineProperty(f.tasks, 'getSnapshot', { get() { reads++; return () => ({ tasks: [] }); } });
    await expect(captureAutonomyLiveRecords(f.context)).rejects.toThrow(ToolInputProjectionError);
    expect(reads).toBe(0); expect(fake.requests).toHaveLength(0);
  });
  test('borrowed native subscription accessors hold before snapshot invocation or transport', async () => {
    const f = fixture(), fake = privacyFixture(); installJudgmentPort(fake.port); let reads = 0, snapshots = 0;
    const getSnapshot = f.tasks.getSnapshot; f.tasks.getSnapshot = () => { snapshots++; return getSnapshot(); };
    Object.defineProperty(f.tasks, 'subscribe', { get() { reads++; return () => () => {}; } });
    await expect(captureAutonomyLiveRecords(f.context)).rejects.toThrow(ToolInputProjectionError);
    expect(reads).toBe(0); expect(snapshots).toBe(0); expect(fake.requests).toHaveLength(0);
  });
  test('hidden native row accessors hold without invocation or transport', async () => {
    const f = fixture(), fake = privacyFixture(); installJudgmentPort(fake.port); let reads = 0;
    f.dispatch.syncRuntimeTask(task('one'));
    const original = f.store.getState().tasks.tasks.get('one'); if (!original) throw new Error('Missing actual row');
    Object.defineProperty(original, 'hiddenTail', { get() { reads++; return 'secret'; }, enumerable: false });
    await expect(captureAutonomyLiveRecords(f.context)).rejects.toThrow(ToolInputProjectionError);
    expect(reads).toBe(0); expect(fake.requests).toHaveLength(0);
  });
  test('installed unreadable snapshots hold rather than invent empty native state', async () => {
    const f = fixture(); f.tasks.getSnapshot = () => { throw new Error('Actual native source failure'); };
    await expect(captureAutonomyLiveRecords(f.context)).rejects.toThrow(ToolInputProjectionError);
    expect(() => autonomyLiveNativeFacts(f.context)).toThrow(ToolInputProjectionError);
  });
  test('retained producer method guards reject a replacement accessor without executing it', async () => {
    const f = fixture(), fake = privacyFixture(), guards: Array<() => void> = []; installJudgmentPort(fake.port); f.dispatch.syncRuntimeTask(task('one'));
    await captureAutonomyLiveRecords(f.context, { sourceOwner: ordinaryResearchOwner(), retainCurrent: guard => { guards.push(guard); } });
    let reads = 0; Object.defineProperty(f.tasks, 'getSnapshot', { get() { reads++; throw new Error('Replacement accessor'); } });
    expect(() => guards.forEach(guard => guard())).toThrow(ToolInputProjectionError); expect(reads).toBe(0);
  });
  test('actual research file is screened before eight-run summaries and physical ABA retires its read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autonomy-source-'));
    const shellPaths = { homeDirectory: root, workingDirectory: root, resolveProjectPath: (...parts: string[]) => join(root, ...parts) };
    const context = { platform: {}, workspace: { shellPaths } } as unknown as CommandContext;
    try {
      const path = researchRunStorePath(shellPaths); mkdirSync(join(path, '..'), { recursive: true });
      const registry = new AgentResearchRunRegistry(path);
      for (let index = 0; index < 9; index++) registry.create({ title: `Synthetic research ${index}`, question: `Complete question ${index}`, goal: 'Synthetic native goal', note: `Complete native note ${index}` });
      const fake = privacyFixture(), guards: Array<() => void> = []; installJudgmentPort(fake.port);
      const result = await captureAutonomyLiveRecords(context, { sourceOwner: ordinaryResearchOwner(), retainCurrent: guard => { guards.push(guard); } });
      expect(result.researchRuns).toHaveLength(8); expect(JSON.stringify(fake.requests)).toContain('Complete question 0');
      guards.forEach(guard => guard()); const original = readFileSync(path, 'utf8');
      writeFileSync(path, original.replace('Complete question 0', 'Changed question')); writeFileSync(path, original);
      expect(() => guards.forEach(guard => guard())).toThrow(ToolInputProjectionError);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('real native artifact receipts use the existing purpose-specific evidence reading and stay read-only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autonomy-receipt-'));
    try {
      const store = new ArtifactStore({ rootDir: root });
      const artifact = await createReceipt(store, 1_900_000_000_001);
      const context = { platform: { artifactStore: store } } as unknown as CommandContext;
      const fake = privacyFixture(), receipt = fakePort((name, question, state) => {
        if (name !== 'status' || question.type !== 'choice' || !Object.hasOwn(question.criteria, 'succeeded')
          || JSON.stringify(state) !== JSON.stringify(artifact)) throw new Error('Unexpected complete native receipt reading');
        return choiceAnswer(question, 'succeeded', 0.999);
      });
      installJudgmentPort({ model: fake.port.model, ask: request => request.context?.battery === 'agent.personal-ops.receipt-status'
        ? receipt.port.ask(request) : fake.port.ask(request) });
      const result = await captureAutonomyLiveRecords(context, { sourceOwner: ordinaryResearchOwner() });
      expect(result.watcherReceipts[0]?.id).toBe(`watcher-receipt:${artifact.id}`);
      expect(result.watcherReceipts[0]?.status).toBe('succeeded');
      expect(result.watcherReceipts[0]?.controls?.every(control => control.effect === 'read-only')).toBe(true);
      expect(receipt.requests).toHaveLength(1);
      expect(receipt.requests[0]?.context?.battery).toBe('agent.personal-ops.receipt-status');
      expect(artifact.createdAt).toBe(1_900_000_000_001);
      expect(store.get(artifact.id)).toEqual(artifact);
      expect(store.get(artifact.id)?.metadata.status).toBe('The selected watcher finished successfully.');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('a native card-shaped artifact epoch holds before the receipt reading and leaves the original artifact intact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autonomy-receipt-'));
    try {
      const store = new ArtifactStore({ rootDir: root });
      const artifact = await createReceipt(store, 1_900_000_000_000);
      const context = { platform: { artifactStore: store } } as unknown as CommandContext;
      const fake = privacyFixture(); installJudgmentPort(fake.port);
      let published = 0;
      await expect(captureAutonomyLiveRecords(context, { sourceOwner: ordinaryResearchOwner() })
        .then(result => { published++; return result; })).rejects.toMatchObject({ name: 'JudgmentInputError', problem: 'card-material' });
      expect(published).toBe(0);
      expect(fake.requests.filter(request => request.context?.battery === 'agent.personal-ops.receipt-status')).toHaveLength(0);
      expect(JSON.stringify(fake.requests)).not.toContain(String(artifact.createdAt));
      expect(artifact.createdAt).toBe(1_900_000_000_000);
      expect(store.get(artifact.id)).toEqual(artifact);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('cancellation during an outstanding canonical reply cannot publish records', async () => {
    const f = fixture(); f.dispatch.syncRuntimeTask(task('one'));
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), fake = privacyFixture();
    const port: JudgmentPort = { model: fake.port.model, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } }; installJudgmentPort(port);
    const controller = new AbortController(), work = captureAutonomyLiveRecords(f.context, { signal: controller.signal, sourceOwner: ordinaryResearchOwner() });
    await entered.promise; controller.abort(); release.resolve(); await expect(work).rejects.toThrow();
  });
});
