/**
 * hosted-session-workspace-floor.test.ts
 *
 * The sharing decision, made checkable.
 *
 * The engine composes ONE client floor per workspace and shares it across every
 * hosted session in that workspace, because the floor's cost is a provider
 * discovery pass, config file watchers, a plugin manager and a project index,
 * per-machine or per-workspace truths that duplicate badly. These tests pin the
 * three properties that decision rests on: one construction per workspace, a
 * reference count that releases at zero and not before, and a construction that
 * two simultaneous callers share rather than race.
 */

import { expect, test } from 'bun:test';
import { HostedWorkspaceFloors, type HostedWorkspaceFloor, type HostedWorkspaceFloorLease } from '../sdk/src/platform/hosted-sessions/workspace-floor.ts';
import type { ClientRuntimeServices } from '../sdk/src/platform/runtime/client-services.ts';

/** A floor stand-in that records its own construction and disposal. */
/** The cache tests never run a session on a floor, so no runner method is ever called. */
const NO_SESSIONS_RUNNER = {} as HostedWorkspaceFloor['contractRunner'];

function makeFactory() {
  const constructed: string[] = [];
  const disposed: string[] = [];
  let gate: Promise<void> | null = null;
  const factory = async ({ workspaceRoot }: { workspaceRoot: string }): Promise<HostedWorkspaceFloor> => {
    if (gate) await gate;
    constructed.push(workspaceRoot);
    return {
      services: { workingDirectory: workspaceRoot } as unknown as ClientRuntimeServices,
      contractRunner: NO_SESSIONS_RUNNER,
      dispose: (): void => { disposed.push(workspaceRoot); },
    };
  };
  return {
    factory,
    constructed,
    disposed,
    hold(): () => void {
      let release = (): void => {};
      gate = new Promise<void>((resolve) => { release = (): void => { gate = null; resolve(); }; });
      return release;
    },
  };
}

/** Let queued microtasks (the deferred disposal) run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('two sessions in one workspace share one floor', async () => {
  const spy = makeFactory();
  const floors = new HostedWorkspaceFloors(spy.factory);

  const first = await floors.acquire('/w/one');
  const second = await floors.acquire('/w/one');

  expect(spy.constructed).toEqual(['/w/one']);
  expect(second.floor).toBe(first.floor);
  expect(floors.size()).toBe(1);
});

test('two workspaces get two floors', async () => {
  const spy = makeFactory();
  const floors = new HostedWorkspaceFloors(spy.factory);

  await floors.acquire('/w/one');
  await floors.acquire('/w/two');

  expect(spy.constructed.sort()).toEqual(['/w/one', '/w/two']);
  expect([...floors.workspaces()].sort()).toEqual(['/w/one', '/w/two']);
});

test('a floor is disposed when its LAST session releases it, and not before', async () => {
  const spy = makeFactory();
  const floors = new HostedWorkspaceFloors(spy.factory);

  const first = await floors.acquire('/w/one');
  const second = await floors.acquire('/w/one');

  first.release();
  await settle();
  expect(spy.disposed).toEqual([]);
  expect(floors.size()).toBe(1);

  second.release();
  await settle();
  expect(spy.disposed).toEqual(['/w/one']);
  expect(floors.size()).toBe(0);
});

test('releasing twice drops one reference, not two', async () => {
  const spy = makeFactory();
  const floors = new HostedWorkspaceFloors(spy.factory);

  const first = await floors.acquire('/w/one');
  const second = await floors.acquire('/w/one');

  first.release();
  first.release();
  await settle();
  // The second lease is still holding it: a double release must not take a
  // floor out from under a session that is still using it.
  expect(spy.disposed).toEqual([]);

  second.release();
  await settle();
  expect(spy.disposed).toEqual(['/w/one']);
});

test('a workspace acquired again after its floor went away is composed fresh', async () => {
  const spy = makeFactory();
  const floors = new HostedWorkspaceFloors(spy.factory);

  (await floors.acquire('/w/one')).release();
  await settle();
  await floors.acquire('/w/one');

  expect(spy.constructed).toEqual(['/w/one', '/w/one']);
});

test('two simultaneous acquires share ONE construction rather than racing two', async () => {
  const spy = makeFactory();
  const floors = new HostedWorkspaceFloors(spy.factory);
  const release = spy.hold();

  const both = Promise.all([floors.acquire('/w/one'), floors.acquire('/w/one')]);
  release();
  const [first, second] = await both;

  // Two provider-discovery passes for one workspace is exactly what the cache
  // exists to prevent, and a race would produce them.
  expect(spy.constructed).toEqual(['/w/one']);
  expect(first.floor).toBe(second.floor);
});

test('disposing the cache disposes every floor and refuses new ones', async () => {
  const spy = makeFactory();
  const floors = new HostedWorkspaceFloors(spy.factory);

  await floors.acquire('/w/one');
  await floors.acquire('/w/two');
  await floors.dispose();

  expect(spy.disposed.sort()).toEqual(['/w/one', '/w/two']);
  expect(floors.size()).toBe(0);
  await expect(floors.acquire('/w/three')).rejects.toThrow(/disposed/);
});

test('a floor whose disposal throws is dropped from the cache anyway', async () => {
  const floors = new HostedWorkspaceFloors(async ({ workspaceRoot }) => ({
    services: { workingDirectory: workspaceRoot } as unknown as ClientRuntimeServices,
    contractRunner: NO_SESSIONS_RUNNER,
    dispose: (): void => { throw new Error('a watcher would not let go'); },
  }));

  const lease = await floors.acquire('/w/one');
  lease.release();
  await settle();

  // The leak is named in the log; it must not keep a dead entry alive in the
  // cache, or the next acquire hands out a floor that was already torn down.
  expect(floors.size()).toBe(0);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('shutdown owns a pending factory and its late cleanup, and refuses every waiting lease', async () => {
  const entered = deferred();
  const factoryGate = deferred();
  const disposing = deferred();
  const cleanupGate = deferred();
  let cleaned = 0;
  const floors = new HostedWorkspaceFloors(async ({ workspaceRoot }) => {
    entered.resolve();
    await factoryGate.promise;
    return {
      services: { workingDirectory: workspaceRoot } as ClientRuntimeServices,
      contractRunner: NO_SESSIONS_RUNNER,
      async dispose() {
        disposing.resolve();
        await cleanupGate.promise;
        cleaned += 1;
      },
    };
  });
  const acquisitions = Promise.allSettled([floors.acquire('/w/one'), floors.acquire('/w/one')]);
  await entered.promise;
  let closed = false;
  const closing = floors.dispose().then(() => { closed = true; });
  let closedAgain = false;
  const closingAgain = floors.dispose().then(() => { closedAgain = true; });
  try {
    await settle();
    expect(closed).toBe(false);
    expect(closedAgain).toBe(false);
    await expect(floors.acquire('/w/one')).rejects.toThrow(/disposed/);
    factoryGate.resolve();
    await disposing.promise;
    expect(floors.size()).toBe(0);
    expect(floors.floors()).toEqual([]);
    expect(floors.workspaces()).toEqual([]);
    await settle();
    expect(closed).toBe(false);
    expect(closedAgain).toBe(false);
  } finally {
    factoryGate.resolve();
    cleanupGate.resolve();
    await Promise.all([closing, closingAgain]);
  }
  expect((await acquisitions).map(result => result.status)).toEqual(['rejected', 'rejected']);
  expect(cleaned).toBe(1);
  await floors.dispose();
  expect(cleaned).toBe(1);
});

test('a rejected factory clears its flight for retry, and shutdown drains rejection without inspecting it', async () => {
  const spy = makeFactory();
  const entered = deferred();
  const gate = deferred();
  let attempts = 0;
  const rejection = Object.defineProperty({}, 'message', { get() { throw new Error('must not inspect factory rejection'); } });
  const floors = new HostedWorkspaceFloors(async input => {
    attempts += 1;
    if (attempts === 1) throw rejection;
    if (attempts === 3) {
      entered.resolve();
      await gate.promise;
      throw rejection;
    }
    return spy.factory(input);
  });
  const failures = await Promise.allSettled([floors.acquire('/w/one'), floors.acquire('/w/one')]);
  expect(failures.map(result => result.status)).toEqual(['rejected', 'rejected']);
  expect(attempts).toBe(1);
  const lease = await floors.acquire('/w/one');
  lease.release();
  const pending = Promise.allSettled([floors.acquire('/w/two')]);
  await entered.promise;
  const closing = floors.dispose();
  gate.resolve();
  await closing;
  expect((await pending)[0]?.status).toBe('rejected');
  expect(spy.disposed).toEqual(['/w/one']);
  expect(floors.size()).toBe(0);
});

test('a lease acquisition that yields to final release borrows a fresh floor', async () => {
  const spy = makeFactory();
  const floors = new HostedWorkspaceFloors(spy.factory);
  const first = await floors.acquire('/w/one');
  const acquiring = floors.acquire('/w/one');
  first.release();
  const second = await acquiring;
  expect(second.floor).not.toBe(first.floor);
  expect(spy.constructed).toEqual(['/w/one', '/w/one']);
  await floors.dispose();
  second.release();
  expect(spy.disposed).toEqual(['/w/one', '/w/one']);
});

test('shutdown drains cleanup already started by a final release', async () => {
  const spy = makeFactory();
  const entered = deferred();
  const gate = deferred();
  const floors = new HostedWorkspaceFloors(async input => {
    const floor = await spy.factory(input);
    return { ...floor, async dispose() { entered.resolve(); await gate.promise; await floor.dispose(); } };
  });
  const lease = await floors.acquire('/w/one');
  lease.release();
  await entered.promise;
  let closed = false;
  const closing = floors.dispose().then(() => { closed = true; });
  try {
    await settle();
    expect(closed).toBe(false);
    lease.release();
  } finally {
    gate.resolve();
    await closing;
  }
  expect(spy.disposed).toEqual(['/w/one']);
});

test('a factory can await recursive shutdown without deadlocking or releasing external drain callers early', async () => {
  const spy = makeFactory();
  const requested = deferred();
  const gate = deferred();
  const floors = new HostedWorkspaceFloors(async input => {
    await Promise.resolve();
    await floors.dispose();
    requested.resolve();
    await gate.promise;
    return spy.factory(input);
  });
  const acquiring = Promise.allSettled([floors.acquire('/w/one')]);
  await requested.promise;
  let closed = false;
  const closing = floors.dispose().then(() => { closed = true; });
  try {
    await settle();
    expect(closed).toBe(false);
  } finally {
    gate.resolve();
    await closing;
  }
  expect((await acquiring)[0]?.status).toBe('rejected');
  expect(spy.disposed).toEqual(['/w/one']);
  expect(floors.size()).toBe(0);
});

test('a disposer can await recursive shutdown and release leases without double disposal', async () => {
  const spy = makeFactory();
  const entered = deferred();
  const gate = deferred();
  let first!: HostedWorkspaceFloorLease;
  let second!: HostedWorkspaceFloorLease;
  const floors = new HostedWorkspaceFloors(async input => {
    const floor = await spy.factory(input);
    return { ...floor, async dispose() {
      first.release();
      second.release();
      await Promise.resolve();
      await floors.dispose();
      entered.resolve();
      await gate.promise;
      await floor.dispose();
    } };
  });
  first = await floors.acquire('/w/one');
  second = await floors.acquire('/w/two');
  first.release();
  await entered.promise;
  let closed = false;
  const closing = floors.dispose().then(() => { closed = true; });
  try {
    await settle();
    expect(closed).toBe(false);
  } finally {
    gate.resolve();
    await closing;
  }
  expect(spy.disposed.sort()).toEqual(['/w/one', '/w/two']);
  expect(floors.size()).toBe(0);
});
