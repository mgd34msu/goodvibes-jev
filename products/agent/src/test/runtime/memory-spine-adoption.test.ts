/**
 * The memory-spine adoption policy (reconcileMemorySpineAdoption): the single
 * decision of whether the agent's memory spine routes over the wire (an adopted
 * daemon owns the store) or stays local. Tested here in isolation against a spy
 * MemorySpineClient double and a scripted probe, no real daemon, no network, so
 * every branch (adopt / deactivate-on-loss / no-op / re-adopt) is exercised fast
 * and deterministically. The real-daemon proof lives in
 * memory-spine-rest-transport.test.ts and memory-spine-agent-wiring.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { reconcileMemorySpineAdoption } from '../../runtime/memory-spine-adoption.ts';
import type { MemorySpineClient, MemoryTransport } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';

type SpyClient = Pick<MemorySpineClient, 'active' | 'activate' | 'deactivate'> & {
  readonly activateCalls: MemoryTransport[];
  readonly deactivateCalls: string[];
};

function spyClient(initialActive: boolean): SpyClient {
  let active = initialActive;
  const activateCalls: MemoryTransport[] = [];
  const deactivateCalls: string[] = [];
  return {
    get active() { return active; },
    activate: (transport: MemoryTransport) => { active = true; activateCalls.push(transport); },
    deactivate: (reason: string) => { active = false; deactivateCalls.push(reason); },
    activateCalls,
    deactivateCalls,
  };
}

const FAKE_TRANSPORT = {} as MemoryTransport;

describe('reconcileMemorySpineAdoption', () => {
  test('adopts the daemon (activates) when reachable and not yet active', async () => {
    const client = spyClient(false);
    await reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => 'online',
    });
    expect(client.active).toBe(true);
    expect(client.activateCalls).toEqual([FAKE_TRANSPORT]);
    expect(client.deactivateCalls).toEqual([]);
  });

  test('deactivates (hands back to local) when a previously-adopted daemon stops answering', async () => {
    const client = spyClient(true);
    await reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => 'offline',
    });
    expect(client.active).toBe(false);
    expect(client.deactivateCalls).toEqual(['daemon unreachable on periodic reachability check']);
    expect(client.activateCalls).toEqual([]);
  });

  test('accepts a custom deactivate reason', async () => {
    const client = spyClient(true);
    await reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => 'unknown',
      deactivateReason: 'custom reason for this test',
    });
    expect(client.deactivateCalls).toEqual(['custom reason for this test']);
  });

  test('is a no-op when already local and the daemon is still unreachable', async () => {
    const client = spyClient(false);
    await reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => 'offline',
    });
    expect(client.active).toBe(false);
    expect(client.activateCalls).toEqual([]);
    expect(client.deactivateCalls).toEqual([]);
  });

  test('is a no-op when already adopted and the daemon is still reachable', async () => {
    const client = spyClient(true);
    await reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => 'online',
    });
    expect(client.active).toBe(true);
    expect(client.activateCalls).toEqual([]);
    expect(client.deactivateCalls).toEqual([]);
  });

  test('re-adopts a daemon that reappears after a prior deactivation: the whole-process-lifetime recheck', async () => {
    const client = spyClient(true);
    // First tick: daemon goes away -> deactivate.
    await reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => 'offline',
    });
    expect(client.active).toBe(false);
    // Later tick: daemon comes back -> re-activate, without any special-casing.
    await reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => 'online',
    });
    expect(client.active).toBe(true);
    expect(client.activateCalls).toEqual([FAKE_TRANSPORT]);
    expect(client.deactivateCalls).toEqual(['daemon unreachable on periodic reachability check']);
  });

  test('fires onAttach exactly on the adoption edge: once per (re)attach, never on a no-op', async () => {
    const client = spyClient(false);
    let attachCount = 0;
    const opts = {
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      onAttach: () => { attachCount += 1; },
    };
    // Boot attach: reachable && not active -> activate + onAttach.
    await reconcileMemorySpineAdoption({ ...opts, probeReachability: async () => 'online' });
    expect(attachCount).toBe(1);
    // Already adopted and still reachable: a no-op, so no second consuming read.
    await reconcileMemorySpineAdoption({ ...opts, probeReachability: async () => 'online' });
    expect(attachCount).toBe(1);
    // Daemon drops: deactivate, no onAttach.
    await reconcileMemorySpineAdoption({ ...opts, probeReachability: async () => 'offline' });
    expect(attachCount).toBe(1);
    // Daemon reappears: this is a fresh attach, so onAttach fires again.
    await reconcileMemorySpineAdoption({ ...opts, probeReachability: async () => 'online' });
    expect(attachCount).toBe(2);
  });

  test('an onAttach rejection is swallowed so a failed receipt read never undoes the adoption', async () => {
    const client = spyClient(false);
    await reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => 'online',
      onAttach: () => { throw new Error('receipt read exploded'); },
    });
    // Adoption still stands; the reconcile resolved without throwing.
    expect(client.active).toBe(true);
    expect(client.activateCalls).toEqual([FAKE_TRANSPORT]);
  });

  test('a probe rejection propagates rather than being swallowed', async () => {
    const client = spyClient(false);
    await expect(reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => { throw new Error('probe exploded'); },
    })).rejects.toThrow('probe exploded');
    // Neither activate nor deactivate ran, the caller (bootstrap.ts's onError /
    // interval catch) is solely responsible for deciding what a failed check means.
    expect(client.activateCalls).toEqual([]);
    expect(client.deactivateCalls).toEqual([]);
  });
});

/**
 * The build floor, at the place it actually bites.
 *
 * The floor is not a warning: a daemon below it is REFUSED, and refusing means
 * this reconciler does not adopt. What the operator gets is the state they would
 * have with no daemon configured, local memory store, no wire, no inbound
 * dispatch, plus one notice. These tests drive that through the same seam
 * production uses (`mayAdopt`), so "refused" is proven as "not adopted" rather
 * than as a verdict object nobody acts on.
 */
describe('reconcileMemorySpineAdoption: the daemon build floor refuses adoption', () => {
  test('a reachable daemon below the floor is NOT adopted', async () => {
    const client = spyClient(false);
    await reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => 'online',
      mayAdopt: () => false,
    });
    // Reachable, and still local. This is the whole point of the floor.
    expect(client.active).toBe(false);
    expect(client.activateCalls).toEqual([]);
  });

  test('a refused daemon fires no attach edge, so nothing downstream binds to it', async () => {
    const client = spyClient(false);
    let attachCount = 0;
    await reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => 'online',
      mayAdopt: () => false,
      onAttach: () => { attachCount += 1; },
    });
    // onAttach is what activates the inbound continuation dispatch and consumes
    // daemon receipts. Neither may happen against a daemon this build refused.
    expect(attachCount).toBe(0);
    expect(client.active).toBe(false);
  });

  test('a reachable daemon at or above the floor is adopted normally', async () => {
    const client = spyClient(false);
    let attachCount = 0;
    await reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => 'online',
      mayAdopt: () => true,
      onAttach: () => { attachCount += 1; },
    });
    expect(client.active).toBe(true);
    expect(client.activateCalls).toEqual([FAKE_TRANSPORT]);
    expect(attachCount).toBe(1);
  });

  test('the gate is asked only after reachability: an unreachable daemon is not judged', async () => {
    const client = spyClient(false);
    let asked = 0;
    await reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => 'offline',
      mayAdopt: () => { asked += 1; return true; },
    });
    // Reading /status off a daemon that is not answering is pointless work and
    // would produce an 'unknown' verdict about nothing.
    expect(asked).toBe(0);
    expect(client.active).toBe(false);
  });

  test('the gate is not asked when the daemon is already adopted', async () => {
    const client = spyClient(true);
    let asked = 0;
    await reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => 'online',
      mayAdopt: () => { asked += 1; return true; },
    });
    // Already active and still reachable is a no-op; the floor was settled on
    // the attach that adopted it.
    expect(asked).toBe(0);
    expect(client.activateCalls).toEqual([]);
  });

  test('a daemon updated mid-session is adopted on the next reconcile', async () => {
    const client = spyClient(false);
    let daemonVersionMeetsFloor = false;
    const reconcile = (): Promise<void> => reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => 'online',
      mayAdopt: () => daemonVersionMeetsFloor,
    });

    // Heartbeat ticks against an old daemon: refused every time, never adopted.
    await reconcile();
    await reconcile();
    expect(client.active).toBe(false);

    // The operator updates the daemon. The gate is re-asked rather than cached,
    // so the very next tick adopts, no restart of this process required.
    daemonVersionMeetsFloor = true;
    await reconcile();
    expect(client.active).toBe(true);
    expect(client.activateCalls).toEqual([FAKE_TRANSPORT]);
  });

  test('an async gate is awaited before anything routes over the wire', async () => {
    const client = spyClient(false);
    await reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => 'online',
      // Production reads /status here, so the gate is genuinely asynchronous.
      mayAdopt: async () => false,
    });
    expect(client.active).toBe(false);
    expect(client.activateCalls).toEqual([]);
  });

  test('no gate at all keeps the previous behaviour: adopt on reachability alone', async () => {
    const client = spyClient(false);
    await reconcileMemorySpineAdoption({
      memorySpineClient: client,
      transport: FAKE_TRANSPORT,
      probeReachability: async () => 'online',
    });
    expect(client.active).toBe(true);
  });
});
