import { expect, test } from 'bun:test';
import { setImmediate } from 'node:timers/promises';
import {
  createEmptyWorkLedgerState, type WorkLedgerActor, type WorkLedgerDecision,
  type WorkLedgerState, type WorkLedgerStorage,
} from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import { createNativeWorkLedgerOwner } from '../../runtime/work-ledger-composition.js';
import { createRuntimeAcquisitionScope } from '../../runtime/acquisition.js';

const projectId = 'fixture-project';
const command = { type: 'create', requestId: 'request-one', expectedRevision: 0,
  title: 'Owned work', goal: 'Persist the native ledger', criteria: ['The receipt survives restart'] };
function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<WorkLedgerStorage & { close(): Promise<void> }> = {}) {
  const events: string[] = [];
  let state = createEmptyWorkLedgerState(projectId);
  const listeners = new Set<(state: WorkLedgerState) => void>();
  const storage = {
    async read() { events.push('read'); return structuredClone(state); },
    async transaction<T>(decide: (current: unknown) => WorkLedgerDecision<T>): Promise<T> {
      events.push('transaction');
      const decision = decide(structuredClone(state));
      if (decision.next) {
        state = structuredClone(decision.next);
        for (const listener of listeners) listener(structuredClone(state));
      }
      return decision.value;
    },
    subscribe(listener: (state: WorkLedgerState) => void) {
      events.push('observe'); listeners.add(listener);
      return () => { events.push('unobserve'); listeners.delete(listener); };
    },
    async close() { events.push('storage.close'); },
    ...overrides,
  };
  const knowledgeStore = {
    async openWorkLedgerStorage(id: string) { events.push(`open:${id}`); return storage; },
  };
  const owner = createNativeWorkLedgerOwner({ projectId, knowledgeStore });
  const actor = owner.authority.issueActor({ actorId: 'trusted-host', projectId, role: 'coordinator' });
  return { owner, actor, storage, knowledgeStore, events, listeners };
}

test('native owner uses one lazy project storage and exposes no actor authority on its service', async () => {
  const fx = fixture();
  expect(fx.events).toEqual([]);
  expect('authority' in fx.owner.service).toBe(false);
  expect('issueActor' in fx.owner.service).toBe(false);
  const accepted = await fx.owner.service.execute(command, fx.actor);
  expect(accepted).toMatchObject({ kind: 'accepted', replayed: false });
  if (accepted.kind === 'accepted') expect(accepted.event.workId).toMatch(/^work:[0-9a-f-]{36}$/);
  expect((await fx.owner.service.readSnapshot(fx.actor)).revision).toBe(1);
  expect(await fx.owner.service.history(0, fx.actor)).toHaveLength(1);
  expect(fx.events.filter(event => event.startsWith('open:'))).toEqual([`open:${projectId}`]);
  await fx.owner.close();
  expect(fx.events.slice(-2)).toEqual(['unobserve', 'storage.close']);
  expect(fx.owner.close()).toBe(fx.owner.service.close());
});

test('closing an unused native ledger opens no persistence', async () => {
  const fx = fixture();
  await fx.owner.close();
  expect(fx.events).toEqual([]);
  expect(await fx.owner.service.execute(command, fx.actor)).toMatchObject({ kind: 'rejected', code: 'closed' });
  expect(() => fx.owner.authority.issueActor({ actorId: 'late', projectId, role: 'worker' })).toThrow('closed');
});

test('close fences synchronously but drains commands admitted before lazy acquisition starts', async () => {
  const opened = gate(); const entered = gate(); const storageDrain = gate();
  const fx = fixture({ async close() { fx.events.push('storage.close'); await storageDrain.promise; } });
  fx.knowledgeStore.openWorkLedgerStorage = async (id) => {
    fx.events.push(`open:${id}`); entered.resolve(); await opened.promise; return fx.storage;
  };
  const admitted = fx.owner.service.execute(command, fx.actor);
  const closing = fx.owner.close();
  let closed = false; void closing.then(() => { closed = true; });
  expect(fx.owner.close()).toBe(closing);
  expect(await fx.owner.service.execute({ ...command, requestId: 'late' }, fx.actor)).toMatchObject({ code: 'closed' });
  await expect(fx.owner.service.readSnapshot(fx.actor)).rejects.toMatchObject({ code: 'closed' });
  expect(() => fx.owner.service.subscribe(fx.actor, () => {})).toThrow('closed');
  await entered.promise;
  expect(closed).toBe(false);
  opened.resolve();
  expect(await admitted).toMatchObject({ kind: 'accepted' });
  await setImmediate();
  expect(fx.events).not.toContain('observe');
  expect(closed).toBe(false);
  storageDrain.resolve(); await closing;
  expect(closed).toBe(true);
});

test('native close waits for already admitted reads and stops pending observer acquisition', async () => {
  const read = gate<unknown>(); const entered = gate(); const fx = fixture({
    async read() { entered.resolve(); return read.promise; },
  });
  let observed = 0;
  fx.owner.service.subscribe(fx.actor, () => { observed++; });
  const reading = fx.owner.service.readSnapshot(fx.actor);
  const outcome = reading.catch(error => error);
  await entered.promise;
  const closing = fx.owner.service.close();
  let closed = false; void closing.then(() => { closed = true; });
  for (const listener of fx.listeners) listener(createEmptyWorkLedgerState(projectId));
  await setImmediate(); expect(closed).toBe(false); expect(observed).toBe(0);
  read.resolve(createEmptyWorkLedgerState(projectId));
  expect(await outcome).toMatchObject({ code: 'closed' });
  await closing; expect(fx.listeners.size).toBe(0);
});

test('actor revocation and foreign handles cannot acquire native ledger admission', async () => {
  const fx = fixture(); const foreign = fixture();
  expect(await fx.owner.service.execute(command, foreign.actor)).toMatchObject({ code: 'forbidden' });
  expect(await fx.owner.service.execute(command, {} as WorkLedgerActor)).toMatchObject({ code: 'forbidden' });
  fx.owner.authority.revokeActor(fx.actor);
  await expect(fx.owner.service.readSnapshot(fx.actor)).rejects.toMatchObject({ code: 'forbidden' });
  expect(fx.events).toEqual([]);
  await fx.owner.close(); await foreign.owner.close();
});

test('lazy acquisition failure is visible to reads and cleanup without retrying a different store', async () => {
  const fx = fixture(); const failure = new Error('fixture store failed to open');
  let opens = 0;
  fx.knowledgeStore.openWorkLedgerStorage = async () => { opens++; throw failure; };
  await expect(fx.owner.service.readSnapshot(fx.actor)).rejects.toMatchObject({ code: 'storage_error' });
  expect(await fx.owner.service.execute(command, fx.actor)).toMatchObject({ kind: 'indeterminate', requestId: command.requestId });
  await expect(fx.owner.close()).rejects.toMatchObject({ errors: [failure] });
  expect(opens).toBe(1);
  expect(fx.events).toEqual([]);
});

test('observer setup failure still closes the acquired adapter', async () => {
  const failure = new Error('fixture observer setup failed');
  const fx = fixture({ subscribe() { throw failure; } });
  await expect(fx.owner.service.readSnapshot(fx.actor)).rejects.toMatchObject({ code: 'storage_error' });
  await expect(fx.owner.close()).rejects.toMatchObject({ errors: [failure] });
  expect(fx.events).toContain('storage.close');
});

test('failed observer shutdown cannot strand adapter cleanup or its backing owner', async () => {
  const observerFailure = new Error('fixture observer teardown failed');
  const adapterFailure = new Error('fixture adapter teardown failed');
  const fx = fixture({
    subscribe() { return () => { fx.events.push('unobserve'); throw observerFailure; }; },
    async close() { fx.events.push('storage.close'); throw adapterFailure; },
  });
  const scope = createRuntimeAcquisitionScope('native ledger failure fixture');
  scope.registry.add('backing knowledge store', () => { fx.events.push('knowledge.close'); });
  scope.registry.add('native work ledger', fx.owner.close);
  await fx.owner.service.readSnapshot(fx.actor);
  await expect(scope.close()).rejects.toMatchObject({ failures: [{ label: 'native work ledger', error: { errors: [observerFailure, adapterFailure] } }] });
  expect(fx.events.slice(-3)).toEqual(['unobserve', 'storage.close', 'knowledge.close']);
});

test('reverse acquisition drain keeps backing store alive through adapter shutdown', async () => {
  const adapterDrain = gate(); const entered = gate();
  const fx = fixture({ async close() { fx.events.push('storage.close'); entered.resolve(); await adapterDrain.promise; } });
  const scope = createRuntimeAcquisitionScope('native ledger drain fixture');
  scope.registry.add('backing knowledge store', () => { fx.events.push('knowledge.close'); });
  scope.registry.add('native work ledger', fx.owner.close);
  await fx.owner.service.execute(command, fx.actor);
  const closing = scope.close();
  await entered.promise;
  expect(fx.events).not.toContain('knowledge.close');
  adapterDrain.resolve(); await closing;
  expect(fx.events.slice(-2)).toEqual(['storage.close', 'knowledge.close']);
});

test('execution journal shares lazy host store and publishes only safe status projection', async () => {
  const fx = fixture();
  const created = await fx.owner.service.execute(command, fx.actor);
  if (created.kind !== 'accepted') throw new Error('create failed');
  const claimed = await fx.owner.service.execute({ type: 'claim', requestId: 'claim-native', expectedRevision: 1, workId: created.event.workId }, fx.actor);
  if (claimed.kind !== 'accepted') throw new Error('claim failed');
  const attempt = claimed.event.attempts[0]!;
  await fx.owner.executionJournal.prepare({ id: 'native', target: { workId: created.event.workId, workRevision: claimed.event.work.revision, criteriaRevision: 1, attemptId: attempt.id, attemptRevision: attempt.revision }, sessionId: 'session', projectRoot: '/fixture' }, fx.actor);
  const view = (await fx.owner.service.readSnapshot(fx.actor)).works[0]!;
  expect(view.execution?.status).toBe('pending');
  expect('runnerReceipt' in view.execution!).toBe(false);
  expect('publication' in view.execution!).toBe(false);
  expect(fx.events.filter(event => event.startsWith('open:'))).toHaveLength(1);
  await fx.owner.close();
  await expect(fx.owner.executionJournal.list(fx.actor)).rejects.toThrow('closed');
});
