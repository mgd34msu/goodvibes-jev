import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore, ProjectPlanningService, evaluateProjectPlanningReadiness, type ProjectPlanningStateUpsertInput } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { JudgmentInputError, snapshotJudgmentInput } from '../sdk/src/platform/gate/judgment-input.js';
import { loadSqlJsEngine, SQLiteStore, type SqlDatabase } from '../sdk/src/platform/state/sqlite-store.js';
import { createSchema } from '../sdk/src/platform/knowledge/store-schema.js';
import { listStoreSnapshots } from '../sdk/src/platform/state/store-snapshots.js';
import { StoreMigrationError, StoreSchemaDowngradeError } from '../sdk/src/platform/state/store-versioning.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';

let previous: JudgmentPort | undefined;
const roots: string[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fileSnapshot(path: string): Buffer | null {
  try { return readFileSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function input(extra: Partial<ProjectPlanningStateUpsertInput['state']> = {}): ProjectPlanningStateUpsertInput {
  return { projectId: 'private-project-identifier', state: {
    goal: 'Improve retry handling by capping delay at 30 seconds.', scope: 'Retry helper only',
    tasks: [{ id: 'private-task-identifier', title: 'Cap retry delay', verification: ['Run retry cap test'] }],
    executionApproved: true, ...extra,
  } };
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'planning-readiness-')); roots.push(root);
  const path = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath: path });
  const bus = new RuntimeEventBus();
  const service = new ProjectPlanningService(store, { runtimeBus: bus });
  await store.init();
  return { path, store, service, bus };
}
function install(value = 0.99) { const fake = fakePort(() => noulAnswer(value)); installJudgmentPort(fake.port); return fake; }
function delayed() {
  const fake = fakePort(() => noulAnswer(0.99)), entered = deferred(), gate = deferred();
  const port: JudgmentPort = { ...fake.port, async ask(request) { entered.resolve(); await gate.promise; return fake.port.ask(request); } };
  installJudgmentPort(port);
  return { fake, port, entered, gate };
}

test('actual service accepts a concrete old keyword, preserves approval and publishes its tasks', async () => {
  const f = await fixture(); const fake = install();
  const result = await f.service.upsertState(input());
  expect(result.state?.readiness).toBe('executable');
  expect((await f.service.getWorkPlanSnapshot(input())).tasks[0]?.title).toBe('Cap retry delay');
  const request = JSON.stringify(fake.requests);
  expect(request).toContain('Improve retry handling');
  expect(request).not.toContain('private-project-identifier');
  expect(request).not.toContain('private-task-identifier');
  const unapproved = await f.service.evaluate(input({ executionApproved: false }));
  expect(unapproved.gaps.map(gap => gap.kind)).toEqual(['unapproved-execution']);
});

test('unrelated answers and decisions cannot clear an ambiguous goal without keyword overlap', async () => {
  const f = await fixture(); const fake = install(0.01);
  const result = await f.service.evaluate(input({ goal: 'Make the experience world class.',
    answeredQuestions: [{ id: 'owner', prompt: 'Who owns rollout?', answer: 'The platform team.', status: 'answered' }],
    decisions: [{ id: 'editor', title: 'Editor choice', decision: 'Use vim', status: 'accepted' }],
  }));
  expect(result.gaps.map(gap => gap.kind)).toEqual(['ambiguous-language']);
  expect(JSON.stringify(fake.requests)).toContain('The platform team.');
  expect(JSON.stringify(fake.requests)).toContain('Use vim');
  expect((await f.service.status(input())).counts.states).toBe(0);
});

for (const value of [undefined, 0.5]) {
  test(`unavailable or inconclusive readiness (${value}) stays blocked and never fabricates ambiguity`, async () => {
    const f = await fixture(); if (value !== undefined) install(value);
    const result = await f.service.upsertState(input());
    expect(result.state?.readiness).toBe('needs-user-input');
    const evaluation = await f.service.evaluate(input());
    expect(evaluation.gaps.map(gap => gap.kind)).toEqual(['readiness-unavailable']);
  });
}

test('complete caller and stored-source privacy admission precedes any semantic request', async () => {
  const f = await fixture(); const fake = install();
  const before = fileSnapshot(f.path);
  await expect(f.service.upsertState(input({ metadata: { password: 'SYNTHETIC_NOT_A_REAL_SECRET' } }))).rejects.toBeInstanceOf(JudgmentInputError);
  expect(fake.requests).toHaveLength(0); expect(fileSnapshot(f.path)).toEqual(before);
  const seeded = await f.service.upsertState(input());
  await f.store.upsertSource({ ...seeded.source!, metadata: { ...seeded.source!.metadata, apiKey: 'SYNTHETIC_NOT_A_REAL_SECRET' } });
  const requests = fake.requests.length, bytes = fileSnapshot(f.path);
  await expect(f.service.evaluate({ projectId: input().projectId })).rejects.toBeInstanceOf(JudgmentInputError);
  await expect(f.service.upsertState(input())).rejects.toBeInstanceOf(JudgmentInputError);
  expect(fake.requests).toHaveLength(requests); expect(fileSnapshot(f.path)).toEqual(bytes);
});

for (const target of ['state', 'work-plan'] as const) {
  test(`another handle’s same-value ${target} replacement retires the original observation`, async () => {
    const f = await fixture(); install();
    const seeded = await f.service.upsertState(input());
    const other = new KnowledgeStore({ dbPath: f.path }); await other.init();
    const source = target === 'state' ? seeded.source! : other.listSources(100).find(row => row.metadata.planningArtifactKind === 'work-plan')!;
    const generation = other.getSourceGeneration(source.id);
    const held = delayed(); const pending = f.service.upsertState(input({ goal: 'Add jitter to retry delays.' }));
    await held.entered.promise;
    const originalRow = other.getSourceSnapshot({ id: source.id }).raw!;
    // Low-level same-row injection retains exact canonical stored clocks.
    // The public source read model has numeric compatibility clocks instead.
    await other.replaceSourceRecord({ ...source, createdAt: originalRow.created_at,
      updatedAt: originalRow.updated_at } as unknown as typeof source);
    expect(other.getSourceGeneration(source.id)).toBe(generation);
    const bytes = fileSnapshot(f.path); held.gate.resolve();
    await expect(pending).rejects.toThrow();
    expect(fileSnapshot(f.path)).toEqual(bytes);
    expect((await f.service.getState({ projectId: input().projectId })).state?.goal).toBe(input().state.goal);
  });
}

for (const change of ['cancel', 'port-aba', 'bus-aba'] as const) {
  test(`${change} during a non-cooperating reader publishes no sources or events`, async () => {
    const f = await fixture(); const held = delayed(), controller = new AbortController();
    const events: unknown[] = [];
    f.bus.on('WORK_PLAN_TASK_CREATED', event => { events.push(event); });
    const bytes = fileSnapshot(f.path);
    const pending = f.service.upsertState(input(), { signal: controller.signal });
    await held.entered.promise;
    if (change === 'cancel') controller.abort();
    else if (change === 'port-aba') { installJudgmentPort(undefined); installJudgmentPort(held.port); }
    else { f.service.attachRuntimeBus(null); f.service.attachRuntimeBus(f.bus); }
    // Cancellation and installation retirement interrupt an uncooperative reader.
    if (change !== 'bus-aba') await expect(pending).rejects.toThrow();
    held.gate.resolve();
    if (change === 'bus-aba') await expect(pending).rejects.toThrow();
    expect(fileSnapshot(f.path)).toEqual(bytes); expect(events).toEqual([]);
  });
}

test('retirement during the store initialization await after reading prevents the real transaction', async () => {
  const f = await fixture(); const fake = install(), entered = deferred(), gate = deferred();
  const original = f.store.init.bind(f.store); let calls = 0;
  f.store.init = async () => { if (++calls === 2) { entered.resolve(); await gate.promise; } await original(); };
  const bytes = fileSnapshot(f.path), pending = f.service.upsertState(input());
  await entered.promise;
  expect(fake.requests).toHaveLength(1);
  installJudgmentPort(undefined); installJudgmentPort(fake.port);
  gate.resolve();
  await expect(pending).rejects.toThrow(); expect(fileSnapshot(f.path)).toEqual(bytes);
});

test('caller mutation across init cannot retarget state, task or project ownership', async () => {
  const f = await fixture(); install(); const entered = deferred(), gate = deferred();
  const original = f.store.init.bind(f.store); let calls = 0;
  f.store.init = async () => { if (++calls === 1) { entered.resolve(); await gate.promise; } await original(); };
  const request = { projectId: input().projectId, state: { ...input().state, goal: 'Original requested goal' } };
  const pending = f.service.upsertState(request); await entered.promise;
  request.projectId = 'other-project'; request.state.goal = 'Later goal'; gate.resolve();
  const result = await pending;
  expect(result.projectId).toBe('private-project-identifier'); expect(result.state?.goal).toBe('Original requested goal');
});


test('same-value port replacement inside the locked transaction boundary cannot publish either row', async () => {
  const f = await fixture(); const fake = install();
  const sqlite = (f.store as unknown as { sqlite: SQLiteStore }).sqlite;
  const transaction = sqlite.transactPersisted.bind(sqlite);
  sqlite.transactPersisted = function<T>(
    operation: (db: SqlDatabase) => { readonly changed: boolean; readonly value: T },
    onCommit: () => void,
    afterDurable?: (value: T, db: SqlDatabase) => void,
  ) {
    return transaction((db) => {
      installJudgmentPort(undefined); installJudgmentPort(fake.port);
      return operation(db);
    }, onCommit, afterDurable);
  };
  const bytes = fileSnapshot(f.path);
  await expect(f.service.upsertState(input())).rejects.toThrow();
  expect(fileSnapshot(f.path)).toEqual(bytes);
  expect((await f.service.status(input())).counts).toMatchObject({ states: 0, workPlans: 0 });
});

test('event-triggered retirement never emits an invalidation under the replacement bus', async () => {
  const f = await fixture(); install(); const replacement = new RuntimeEventBus();
  const unexpected: unknown[] = [];
  replacement.on('WORK_PLAN_SNAPSHOT_INVALIDATED', event => { unexpected.push(event); });
  f.bus.on('WORK_PLAN_TASK_CREATED', () => { f.service.attachRuntimeBus(replacement); });
  await expect(f.service.upsertState(input())).rejects.toThrow('was published');
  expect(unexpected).toEqual([]);
  expect((await f.service.getState({ projectId: input().projectId })).state?.goal).toBe(input().state.goal);
});

test('an actual clarifying answer can make an approved plan executable without replacing task ownership', async () => {
  const f = await fixture(); install(0.01);
  await f.service.upsertState(input({ goal: 'Improve setup', openQuestions: [{ id: 'clarify', prompt: 'What should setup do differently?' }] }));
  const originalTask = (await f.service.getWorkPlanSnapshot(input())).tasks[0]!;
  const fake = install();
  const answer = 'Offer a retry button after a failed connection without discarding the entered endpoint.';
  const result = await f.service.answerQuestion({ projectId: input().projectId, questionId: 'clarify', answer });
  expect(result).toMatchObject({ answered: true, evaluation: { readiness: 'executable' } });
  expect(result.state?.answeredQuestions[0]?.answer).toBe(answer);
  expect(JSON.stringify(fake.requests)).toContain(answer);
  const retained = (await f.service.getWorkPlanSnapshot(input())).tasks[0]!;
  expect(retained.taskId).toBe(originalTask.taskId);
  expect(retained.createdAt).toBe(originalTask.createdAt);
});


test('fresh-file evaluation stays read-only and the first planning mutation creates the database', async () => {
  const f = await fixture(); install();
  expect(fileSnapshot(f.path)).toBeNull();
  expect((await f.service.evaluate(input())).readiness).toBe('executable');
  expect(fileSnapshot(f.path)).toBeNull();
  const saved = await f.service.upsertState(input());
  expect(saved.state?.readiness).toBe('executable');
  expect(fileSnapshot(f.path)).not.toBeNull();
});

test('cancellation in the outer answer await reports that the answer was already published', async () => {
  const f = await fixture(); install();
  await f.service.upsertState(input({ openQuestions: [{ id: 'q', prompt: 'Which cap?' }] }));
  const controller = new AbortController();
  const apply = f.service.applyStateAction.bind(f.service);
  f.service.applyStateAction = async (request, options) => {
    const result = await apply(request, options);
    expect(result.applied).toBe(true);
    controller.abort();
    return result;
  };
  await expect(f.service.answerQuestion({ projectId: input().projectId, questionId: 'q', answer: '30 seconds' }, { signal: controller.signal }))
    .rejects.toThrow('was published');
  expect((await f.service.getState({ projectId: input().projectId })).state?.answeredQuestions[0]?.answer).toBe('30 seconds');
});


for (const mode of ['upsert', 'action'] as const) {
  test(`a same-byte publication after the original source read cannot be adopted by ${mode}`, async () => {
    const f = await fixture(); const fake = install();
    await f.service.upsertState(input());
    const source = await f.service.getState({ projectId: input().projectId });
    const bytes = readFileSync(f.path), requests = fake.requests.length;
    const original = f.store.getSourceSnapshot.bind(f.store); let replaced = false;
    f.store.getSourceSnapshot = (selector) => {
      const snapshot = original(selector);
      if (!replaced && snapshot.source?.id === source.source!.id) {
        replaced = true;
        // Simulate another coordinated writer's same-image atomic publication
        // after our detached read, before readiness can acquire its source owner.
        const replacement = `${f.path}.test-replacement`;
        writeFileSync(replacement, bytes); renameSync(replacement, f.path);
      }
      return snapshot;
    };
    if (mode === 'upsert') await expect(f.service.upsertState(input())).rejects.toThrow();
    else expect(await f.service.applyStateAction({ projectId: input().projectId,
      expected: { kind: 'revision', revision: source.revision! }, action: { kind: 'approve' },
    })).toMatchObject({ applied: false, reason: 'state-changed' });
    expect(replaced).toBe(true); expect(fake.requests).toHaveLength(requests);
    expect(readFileSync(f.path)).toEqual(bytes);
  });
}


// Synthetic witnesses, never real card data. These tests exercise the service,
// the persisted source boundary, and a new store/service handle after reopen.
test('generated Luhn-collision clocks survive the actual planning publication lifecycle', async () => {
  const collision = 1700000000004;
  expect(() => snapshotJudgmentInput(collision)).toThrow(JudgmentInputError);
  const clock = spyOn(Date, 'now').mockReturnValue(collision);
  try {
    const f = await fixture(); const fake = install();
    const request = input({ executionApproved: false,
      openQuestions: [{ id: 'cap', prompt: 'Which delay cap should be used?' }],
    });
    await f.service.evaluate(request);
    expect(fileSnapshot(f.path)).toBeNull();
    const seeded = await f.service.upsertState(request);
    expect(fileSnapshot(f.path)).not.toBeNull();
    expect(seeded.state?.createdAt).toBe(collision);
    expect(seeded.source?.createdAt).toBe(collision);
    const original = f.store.getSourceSnapshot({ id: seeded.source!.id });
    expect(original.raw?.created_at).toBe(new Date(collision).toISOString());
    expect((original.source!.metadata.value as Record<string, unknown>).createdAt).toBe(new Date(collision).toISOString());
    // Numeric API compatibility is not an input-admission exemption.
    const bytes = fileSnapshot(f.path), requests = fake.requests.length;
    await expect(evaluateProjectPlanningReadiness(seeded.state!)).rejects.toMatchObject({ problem: 'card-material' });
    await expect(f.service.upsertState({ projectId: request.projectId, state: seeded.state! }))
      .rejects.toMatchObject({ problem: 'card-material' });
    expect(fake.requests).toHaveLength(requests);
    expect(fileSnapshot(f.path)).toEqual(bytes);
    const answer = await f.service.answerQuestion({ projectId: request.projectId,
      questionId: 'cap', answer: 'Use a 30 second cap.' });
    expect(answer.answered).toBe(true);
    const approved = await f.service.applyStateAction({ projectId: request.projectId,
      expected: { kind: 'current' }, action: { kind: 'approve' } });
    expect(approved.applied).toBe(true);
    const task = (await f.service.getWorkPlanSnapshot(request)).tasks[0]!;
    await f.service.setWorkPlanTaskStatus({ projectId: request.projectId, taskId: task.taskId, status: 'done' });
    const reopened = new ProjectPlanningService(new KnowledgeStore({ dbPath: f.path }));
    expect((await reopened.evaluate({ projectId: request.projectId })).readiness).toBe('executable');
    // Re-publication must also admit the stored terminal work-plan clock.
    const result = await reopened.applyStateAction({ projectId: request.projectId,
      expected: { kind: 'current' }, action: { kind: 'approve' } });
    expect(result.applied).toBe(true);
    expect(JSON.stringify(fake.requests)).not.toContain(String(collision));
  } finally { clock.mockRestore(); }
});

test('typed task-update cannot persist a caller-forged completion clock', async () => {
  // Isolate the malicious caller from the separately tested generated-clock bug.
  const clock = spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const f = await fixture(); const fake = install();
    const created = await f.service.createWorkPlanTask({ projectId: input().projectId,
      task: { taskId: 'typed-clock-task', title: 'Ordinary local task' } });
    const bytes = fileSnapshot(f.path), requests = fake.requests.length;
    await expect(f.service.updateWorkPlanTask({ projectId: input().projectId,
      taskId: created.task!.taskId, patch: { status: 'done', completedAt: 4111111111111111 },
    })).rejects.toMatchObject({ problem: 'card-material' });
    expect(fileSnapshot(f.path)).toEqual(bytes);
    expect(fake.requests).toHaveLength(requests);
  } finally { clock.mockRestore(); }
});

for (const target of ['createdAt', 'updatedAt', 'answeredAt', 'approvedAt', 'completedAt'] as const) {
  test(`lower-store forged ${target} stays subject to complete admission after reopen`, async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const f = await fixture(); const fake = install();
      await f.service.upsertState(input());
      const kind = target === 'completedAt' ? 'work-plan' : 'state';
      const source = f.store.listSources(100).find(row => row.metadata.planningArtifactKind === kind)!;
      const value = source.metadata.value as Record<string, unknown>;
      const forged = 4111111111111111;
      let changed: Record<string, unknown>;
      if (target === 'completedAt') {
        const tasks = value.tasks as readonly Record<string, unknown>[];
        changed = { ...value, tasks: tasks.map((task, index) => index === 0
          ? { ...task, status: 'done', completedAt: forged } : task) };
      } else if (target === 'answeredAt') {
        changed = { ...value, answeredQuestions: [{ id: 'cap', prompt: 'Which cap?',
          status: 'answered', answer: '30 seconds', answeredAt: forged }] };
      } else if (target === 'approvedAt') {
        changed = { ...value, executionApproved: true,
          metadata: { approvedFrom: 'plan-command', approvedAt: forged } };
      } else changed = { ...value, [target]: forged };
      await f.store.upsertSource({ ...source, metadata: { ...source.metadata, value: changed } });
      const bytes = fileSnapshot(f.path), requests = fake.requests.length;
      const events: unknown[] = [];
      f.bus.on('WORK_PLAN_TASK_CREATED', event => { events.push(event); });
      f.bus.on('WORK_PLAN_TASK_UPDATED', event => { events.push(event); });
      f.bus.on('WORK_PLAN_TASK_STATUS_CHANGED', event => { events.push(event); });
      const reopened = new ProjectPlanningService(new KnowledgeStore({ dbPath: f.path }), { runtimeBus: f.bus });
      await expect(reopened.upsertState(input())).rejects.toMatchObject({ problem: 'card-material' });
      expect(events).toEqual([]); // No full task/previousTask reaches event/telemetry subscribers.
      if (kind === 'state') {
        await expect(reopened.evaluate({ projectId: input().projectId })).rejects.toMatchObject({ problem: 'card-material' });
      }
      expect(fake.requests).toHaveLength(requests);
      expect(fileSnapshot(f.path)).toEqual(bytes);
    } finally { clock.mockRestore(); }
  });
}


for (const target of ['createdAt', 'lastCrawledAt'] as const) {
  test(`lower-store forged source ${target} cannot be canonically migrated`, async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const f = await fixture(); const fake = install();
      const seeded = await f.service.upsertState(input());
      await f.store.replaceSourceRecord({ ...seeded.source!, [target]: 4111111111111111 });
      const bytes = fileSnapshot(f.path), requests = fake.requests.length;
      const events: unknown[] = [];
      f.bus.on('WORK_PLAN_TASK_CREATED', event => { events.push(event); });
      f.bus.on('WORK_PLAN_TASK_UPDATED', event => { events.push(event); });
      f.bus.on('WORK_PLAN_TASK_STATUS_CHANGED', event => { events.push(event); });
      const reopened = new ProjectPlanningService(new KnowledgeStore({ dbPath: f.path }), { runtimeBus: f.bus });
      await expect(reopened.upsertState(input())).rejects.toMatchObject({ problem: 'card-material' });
      expect(events).toEqual([]); // No full task/previousTask reaches event/telemetry subscribers.
      expect(fake.requests).toHaveLength(requests);
      expect(fileSnapshot(f.path)).toEqual(bytes);
    } finally { clock.mockRestore(); }
  });
}

test('numeric compatibility source rewrite changes raw generation and retires an active publication', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const f = await fixture(); install();
    const seeded = await f.service.upsertState(input());
    const other = new KnowledgeStore({ dbPath: f.path }); await other.init();
    const source = other.getSource(seeded.source!.id)!;
    const generation = other.getSourceGeneration(source.id);
    const held = delayed(); const pending = f.service.upsertState(input({ goal: 'Add bounded jitter.' }));
    await held.entered.promise;
    // Deliberately use the public numeric view: this is NOT a same-byte rewrite.
    await other.replaceSourceRecord(source);
    expect(other.getSourceGeneration(source.id)).not.toBe(generation);
    const bytes = fileSnapshot(f.path); held.gate.resolve();
    await expect(pending).rejects.toThrow();
    expect(fileSnapshot(f.path)).toEqual(bytes);
  } finally { clock.mockRestore(); }
});

test('legacy numeric collision source remains refused without migration on reopen', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const f = await fixture(); const fake = install();
    const seeded = await f.service.upsertState(input());
    await f.store.replaceSourceRecord({ ...seeded.source!, createdAt: 1700000000004 });
    const bytes = fileSnapshot(f.path), requests = fake.requests.length;
    const reopenedStore = new KnowledgeStore({ dbPath: f.path });
    const reopened = new ProjectPlanningService(reopenedStore);
    await expect(reopened.upsertState(input())).rejects.toMatchObject({ problem: 'card-material' });
    expect(fake.requests).toHaveLength(requests);
    expect(fileSnapshot(f.path)).toEqual(bytes);
    expect(reopenedStore.getSourceSnapshot({ id: seeded.source!.id }).raw?.created_at).toBe(1700000000004);
  } finally { clock.mockRestore(); }
});


test('admitted legacy numeric clocks migrate without changing numeric public reads', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const f = await fixture(); install();
    const seeded = await f.service.upsertState(input());
    await f.store.replaceSourceRecord({ ...seeded.source!, metadata: {
      ...seeded.source!.metadata, value: seeded.state!,
    } });
    expect(f.store.getSourceSnapshot({ id: seeded.source!.id }).raw?.created_at).toBe(1000);
    const reopenedStore = new KnowledgeStore({ dbPath: f.path });
    const reopened = new ProjectPlanningService(reopenedStore);
    const migrated = await reopened.upsertState(input());
    expect(migrated.state?.createdAt).toBe(1000);
    expect(migrated.source?.createdAt).toBe(1000);
    expect(reopenedStore.getSourceSnapshot({ id: seeded.source!.id }).raw?.created_at).toBe(new Date(1000).toISOString());
  } finally { clock.mockRestore(); }
});


test('constructor admits the exact default project before credential-erasing normalization', async () => {
  const f = await fixture(); const fake = install();
  const bytes = fileSnapshot(f.path);
  expect(() => new ProjectPlanningService(f.store, {
    defaultProjectId: 'password=SYNTHETIC_NOT_A_REAL_SECRET', runtimeBus: f.bus,
  })).toThrow(JudgmentInputError);
  expect(fake.requests).toHaveLength(0);
  expect(fileSnapshot(f.path)).toEqual(bytes);
  const service = new ProjectPlanningService(f.store, { runtimeBus: f.bus });
  expect((await service.evaluate({ state: input().state })).state.projectId).toBe('default');
  expect(fileSnapshot(f.path)).toEqual(bytes);
});


for (const target of ['createdAt', 'updatedAt'] as const) for (const malformed of ['not-a-clock', '0x18bcfe56804']) {
  test(`malformed lower-store ${target} (${malformed}) is refused rather than repaired into a new clock`, async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const f = await fixture(); const fake = install();
      const seeded = await f.service.upsertState(input());
      await f.store.replaceSourceRecord({ ...seeded.source!, [target]: malformed } as unknown as NonNullable<typeof seeded.source>);
      const bytes = fileSnapshot(f.path), requests = fake.requests.length;
      const reopenedStore = new KnowledgeStore({ dbPath: f.path });
      const reopened = new ProjectPlanningService(reopenedStore);
      await expect(reopened.evaluate({ projectId: input().projectId })).rejects.toMatchObject({ problem: 'unsupported-input' });
      await expect(reopened.upsertState(input())).rejects.toMatchObject({ problem: 'unsupported-input' });
      // The direct canonical writer must enforce the same rule, independently of
      // the service's original-row admission.
      await expect(reopenedStore.upsertCanonicalSource({ ...seeded.source! }))
        .rejects.toMatchObject({ problem: 'unsupported-input' });
      expect(fake.requests).toHaveLength(requests);
      expect(fileSnapshot(f.path)).toEqual(bytes);
    } finally { clock.mockRestore(); }
  });
}


test('knowledge v8 upgrade snapshots original bytes and stamps v9 without rewriting legacy rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'planning-version-')); roots.push(root);
  const path = join(root, 'knowledge.sqlite');
  const legacy = new SQLiteStore(path, { coordinated: true });
  // Historical v8 setup intentionally stays v8. The base table definitions are
  // unchanged by the marker-only v9 format barrier.
  await legacy.init(createSchema, { storeName: 'knowledge store', schemaVersion: 8 });
  legacy.run(`INSERT INTO knowledge_sources
    (id, connector_id, source_type, status, tags, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ['legacy-row', 'legacy-connector', 'manual', 'indexed', '[]', '{ "kept": "same bytes" }', 1700000000004, 1000]);
  await legacy.save();
  const originalRows = legacy.exec('SELECT * FROM knowledge_sources ORDER BY id');
  expect(legacy.exec('PRAGMA user_version')[0]?.values).toEqual([[8]]);
  legacy.close();
  const before = readFileSync(path);
  expect(listStoreSnapshots(path)).toEqual([]);
  const upgraded = new KnowledgeStore({ dbPath: path });
  try {
    await upgraded.init();
    const sqlite = (upgraded as unknown as { sqlite: SQLiteStore }).sqlite;
    expect(sqlite.exec('PRAGMA user_version')[0]?.values).toEqual([[9]]);
    expect(sqlite.exec('SELECT * FROM knowledge_sources ORDER BY id')).toEqual(originalRows);
    const snapshots = listStoreSnapshots(path);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.reason).toBe('pre-migration-v8-to-v9');
    expect(readFileSync(snapshots[0]!.path)).toEqual(before);
    const SQL = await loadSqlJsEngine();
    const saved = new SQL.Database(readFileSync(path));
    try { expect(saved.exec('PRAGMA user_version')[0]?.values).toEqual([[9]]); }
    finally { saved.close(); }
  } finally { await upgraded.close(); }
});

test('first canonical planning publication is v9 and an old-target v8 open refuses without mutation', async () => {
  const f = await fixture(); install();
  expect(fileSnapshot(f.path)).toBeNull();
  const seeded = await f.service.upsertState(input());
  expect(typeof f.store.getSourceSnapshot({ id: seeded.source!.id }).raw?.created_at).toBe('string');
  const SQL = await loadSqlJsEngine();
  const persisted = new SQL.Database(readFileSync(f.path));
  try { expect(persisted.exec('PRAGMA user_version')[0]?.values).toEqual([[9]]); }
  finally { persisted.close(); }
  const before = readFileSync(f.path), snapshots = listStoreSnapshots(f.path);
  const oldTarget = new SQLiteStore(f.path, { coordinated: true });
  let oldSchemaCalls = 0;
  await expect(oldTarget.init(() => { oldSchemaCalls++; }, {
    storeName: 'knowledge store', schemaVersion: 8,
  })).rejects.toBeInstanceOf(StoreSchemaDowngradeError);
  expect(oldSchemaCalls).toBe(0);
  expect(readFileSync(f.path)).toEqual(before);
  expect(listStoreSnapshots(f.path)).toEqual(snapshots);
});


test('historical v8 missing a durable table refuses v9 upgrade without silent recreation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'planning-corrupt-v8-')); roots.push(root);
  const path = join(root, 'knowledge.sqlite');
  const legacy = new SQLiteStore(path, { coordinated: true });
  await legacy.init(createSchema, { storeName: 'knowledge store', schemaVersion: 8 });
  legacy.run('DROP TABLE work_ledgers');
  await legacy.save(); legacy.close();
  const before = readFileSync(path);
  const upgraded = new KnowledgeStore({ dbPath: path });
  await expect(upgraded.init()).rejects.toBeInstanceOf(StoreMigrationError);
  expect(upgraded.isReady).toBe(false);
  expect(readFileSync(path)).toEqual(before);
  const snapshots = listStoreSnapshots(path);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.reason).toBe('pre-migration-v8-to-v9');
  expect(readFileSync(snapshots[0]!.path)).toEqual(before);
  const SQL = await loadSqlJsEngine();
  const persisted = new SQL.Database(readFileSync(path));
  try {
    expect(persisted.exec('PRAGMA user_version')[0]?.values).toEqual([[8]]);
    expect(persisted.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_ledgers'")).toEqual([]);
  } finally { persisted.close(); }
});
