import { expect, test } from 'bun:test';
import { createEmptyWorkLedgerState, createWorkLedger } from '../sdk/src/platform/workflow/work-ledger/service.js';
import { createLocalWorkLedgerReadBinding } from '../sdk/src/platform/workflow/work-ledger/read-client.js';
import type { WorkLedgerActor, WorkLedgerDecision, WorkLedgerState, WorkLedgerStorage } from '../sdk/src/platform/workflow/work-ledger/types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  let state = createEmptyWorkLedgerState('host-project');
  let gate: ReturnType<typeof deferred> | undefined;
  const entered = deferred();
  const observers = new Set<(state: WorkLedgerState) => void>();
  const actors: WorkLedgerActor[] = [];
  let sequence = 0;
  const storage: WorkLedgerStorage = {
    async read() { if (gate) { entered.resolve(); await gate.promise; } return structuredClone(state); },
    async transaction<T>(decide: (state: unknown) => WorkLedgerDecision<T>) {
      const decision = decide(structuredClone(state));
      if (decision.next) state = structuredClone(decision.next);
      return decision.value;
    },
    subscribe(listener) { observers.add(listener); return () => { observers.delete(listener); }; },
  };
  const owner = createWorkLedger({ projectId: 'host-project', storage, clock: { now: () => 100, newId: kind => `${kind}-${++sequence}` } });
  const coordinator = owner.authority.issueActor({ projectId: 'host-project', actorId: 'host', role: 'coordinator' });
  function bind(actorId = 'consumer', projectId = 'host-project') {
    const binding = createLocalWorkLedgerReadBinding({ available: true, projectId, actorId, service: owner.service, authority: {
      issueActor(identity) { const actor = owner.authority.issueActor(identity); actors.push(actor); return actor; },
      revokeActor: actor => owner.authority.revokeActor(actor),
    } });
    if (!binding.available) throw new Error('Expected local binding');
    return binding.client;
  }
  async function create() {
    const result = await owner.service.execute({ type: 'create', requestId: `request-${state.revision}`, expectedRevision: state.revision, title: 'Task', goal: 'Ship', criteria: ['Checked'] }, coordinator);
    expect(result.kind).toBe('accepted');
  }
  function publish() { for (const observer of observers) observer(structuredClone(state)); }
  return { owner, actors, observers, bind, create, publish, entered,
    hold() { gate = deferred(); return gate; },
  };
}

test('two clients share one host binding, expose only reads, and dispose independently', async () => {
  const f = fixture(); const a = f.bind('a'); const b = f.bind('b');
  expect(Object.keys(a).sort()).toEqual(['dispose', 'history', 'projectId', 'readSnapshot', 'subscribe']);
  expect(Object.isFrozen(a)).toBe(true);
  expect(a.projectId).toBe('host-project');
  expect(f.actors[0]).not.toBe(f.actors[1]);
  const seenA: number[] = []; const seenB: number[] = [];
  a.subscribe(s => { seenA.push(s.revision); }); b.subscribe(s => { seenB.push(s.revision); });
  await f.create(); f.publish(); await Promise.resolve();
  expect(seenA).toEqual([1]); expect(seenB).toEqual([1]);
  expect((await a.readSnapshot()).works[0]).not.toHaveProperty('allowedActions');
  expect((await b.readSnapshot()).revision).toBe(1);
  a.dispose(); a.dispose(); expect(f.observers.size).toBe(1);
  await expect(a.readSnapshot()).rejects.toMatchObject({ code: 'closed' });
  await expect(a.history(0)).rejects.toMatchObject({ code: 'closed' });
  expect(() => a.subscribe(() => {})).toThrow('disposed');
  await f.create(); f.publish(); await Promise.resolve();
  expect(seenA).toEqual([1]); expect(seenB).toEqual([1, 2]);
  expect((await b.history(0)).length).toBe(2);
  b.dispose(); expect(f.observers.size).toBe(0); await f.owner.service.close();
});

test('host-selected project mismatch refuses at actor issuance; unavailable never acquires an owner', () => {
  const f = fixture(); expect(() => f.bind('a', 'client-selected-project')).toThrow('project mismatch');
  const result = createLocalWorkLedgerReadBinding({ available: false, reason: 'No authenticated host binding' });
  expect(result).toEqual({ available: false, reason: 'No authenticated host binding' });
  expect(Object.keys(result).sort()).toEqual(['available', 'reason']);
});

test('subscribe before snapshot and cursor history recovers coalesced changes', async () => {
  const f = fixture(); const client = f.bind(); const seen: number[] = [];
  const stop = client.subscribe(s => { seen.push(s.cursor); expect(s.works.every(w => !('allowedActions' in w))).toBe(true); });
  const initial = await client.readSnapshot();
  await f.create(); await f.create(); f.publish(); f.publish(); await Promise.resolve();
  expect(seen).toEqual([2]);
  expect((await client.history(initial.cursor)).map(e => e.sequence)).toEqual([1, 2]);
  expect(await client.history(2)).toEqual([]);
  await expect(client.history(-1)).rejects.toMatchObject({ code: 'invalid_cursor' });
  stop(); stop(); expect(f.observers.size).toBe(0); client.dispose(); await f.owner.service.close();
});

test('snapshot and history remain detached authoritative reads', async () => {
  const f = fixture(); const client = f.bind(); await f.create();
  const snapshot = await client.readSnapshot(); snapshot.works[0]!.work.title = 'changed';
  const history = await client.history(0); history[0]!.work.title = 'changed';
  expect((await client.readSnapshot()).works[0]?.work.title).toBe('Task');
  expect((await client.history(0))[0]?.work.title).toBe('Task');
  client.dispose(); await f.owner.service.close();
});

test('host revocation stops private actor reads and subscriptions', async () => {
  const f = fixture(); const client = f.bind(); let calls = 0;
  client.subscribe(() => { calls++; }); f.owner.authority.revokeActor(f.actors[0]!);
  expect(f.observers.size).toBe(0);
  await expect(client.readSnapshot()).rejects.toMatchObject({ code: 'forbidden' });
  await expect(client.history(0)).rejects.toMatchObject({ code: 'forbidden' });
  expect(() => client.subscribe(() => {})).toThrow();
  await f.create(); f.publish(); await Promise.resolve(); expect(calls).toBe(0);
  client.dispose(); await f.owner.service.close();
});

test('dispose while a read is held prevents delivery without closing other consumers', async () => {
  const f = fixture(); const a = f.bind('a'); const b = f.bind('b'); const gate = f.hold();
  const pending = a.readSnapshot().catch(error => error);
  await f.entered.promise; a.dispose(); gate.resolve(); expect(await pending).toMatchObject({ code: 'forbidden' });
  expect((await b.readSnapshot()).revision).toBe(0); b.dispose(); await f.owner.service.close();
});

test('host close drains held reads and fences both consumers', async () => {
  const f = fixture(); const a = f.bind('a'); const b = f.bind('b'); const gate = f.hold();
  const pending = a.history(0).catch(error => error);
  await f.entered.promise; let closed = false;
  const closing = f.owner.service.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  await expect(b.readSnapshot()).rejects.toMatchObject({ code: 'closed' });
  gate.resolve(); expect(await pending).toMatchObject({ code: 'closed' }); await closing;
  a.dispose(); b.dispose();
});

test('reentrant consumer disposal in a notification detaches safely and listener failures are isolated', async () => {
  const f = fixture(); const a = f.bind('a'); const b = f.bind('b');
  a.subscribe(() => { a.dispose(); }); b.subscribe(() => { throw new Error('observer'); });
  await f.create(); f.publish(); await Promise.resolve();
  expect(f.observers.size).toBe(1); expect((await b.readSnapshot()).revision).toBe(1);
  b.dispose(); await f.owner.service.close();
});

test('a miscomposed service snapshot cannot relabel or publish another project', async () => {
  const f = fixture();
  const binding = createLocalWorkLedgerReadBinding({ available: true, projectId: 'host-project', actorId: 'reader', authority: f.owner.authority, service: {
    ...f.owner.service,
    async readSnapshot(actor) { return { ...await f.owner.service.readSnapshot(actor), projectId: 'wrong-project' }; },
    subscribe(actor, listener) { return f.owner.service.subscribe(actor, snapshot => listener({ ...snapshot, projectId: 'wrong-project' })); },
  } });
  if (!binding.available) throw new Error('Expected binding');
  await expect(binding.client.readSnapshot()).rejects.toMatchObject({ code: 'forbidden' });
  let calls = 0; binding.client.subscribe(() => { calls++; });
  await f.create(); f.publish(); await Promise.resolve(); expect(calls).toBe(0);
  binding.client.dispose(); await f.owner.service.close();
});
