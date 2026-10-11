/** Reconstructed from the previously qualified 23-case suite; actual manager, synthetic peers. */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { DistributedRuntimeManager } from '../sdk/src/platform/runtime/remote/distributed-runtime-manager.js';
import type { DistributedRuntimeSnapshotStore, DistributedWorkAdmission } from '../sdk/src/platform/runtime/remote/distributed-runtime-types.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function authority() {
  const lifetime = new AbortController(); let current = true; let claims = 0;
  const admission: DistributedWorkAdmission = { signal: lifetime.signal,
    assertCurrent() { if (!current) throw new Error('fixture source changed'); }, claim() { claims++; } };
  cleanups.push(() => lifetime.abort());
  return { admission, lifetime, changeSource() { current = false; }, get claims() { return claims; } };
}
async function fixture() {
  const path = join(makeProjectTempDir('distributed-admission'), 'remote.json');
  const manager = new DistributedRuntimeManager(path); cleanups.push(() => manager.writes.drain());
  await manager.start();
  const requested = await manager.requestPairing({ peerKind: 'device', label: 'Synthetic phone', capabilities: ['device.screen.capture'] });
  await manager.approvePairRequest(requested.request.id);
  const verified = await manager.verifyPairRequest(requested.request.id, requested.challenge);
  expect(verified).not.toBeNull();
  const auth = { peer: verified!.peer, token: verified!.token };
  return { manager, path, auth, peerId: auth.peer.id };
}
function pauseNextPersist(manager: DistributedRuntimeManager) {
  const entered = deferred(); const release = deferred();
  const original = manager.store.persist.bind(manager.store);
  const mock = spyOn(manager.store, 'persist').mockImplementationOnce(async snapshot => {
    entered.resolve(); await release.promise; await original(snapshot);
  });
  cleanups.push(() => { release.resolve(); mock.mockRestore(); });
  return { entered, release };
}

describe('host-owned distributed work admission', () => {
  test('cancellation during actual manager startup queues no work and consumes no decision', async () => {
    const f = await fixture(); const owner = authority(); const restarted = new DistributedRuntimeManager(f.path);
    cleanups.push(() => restarted.writes.drain());
    const entered = deferred(); const release = deferred(); const original = restarted.store.load.bind(restarted.store);
    const load = spyOn(restarted.store, 'load').mockImplementationOnce(async () => { entered.resolve(); await release.promise; return original(); });
    cleanups.push(() => { release.resolve(); load.mockRestore(); });
    const pending = restarted.invokePeer({ peerId: f.peerId, command: 'device.screen.capture', type: 'device.capability', admission: owner.admission });
    const settled = pending.then(() => ({ rejected: false }), () => ({ rejected: true }));
    await entered.promise; owner.lifetime.abort(); release.resolve();
    expect((await settled).rejected).toBe(true); expect(restarted.listWork()).toEqual([]); expect(owner.claims).toBe(0);
  });
  for (const invalidate of ['cancel', 'source'] as const) {
    test(`${invalidate} while the claimed record is persisting prevents exposure to the peer`, async () => {
      const f = await fixture(); const owner = authority();
      const queued = await f.manager.enqueueWork({ peerId: f.peerId, command: 'device.screen.capture', admission: owner.admission });
      expect(owner.claims).toBe(0);
      const gate = pauseNextPersist(f.manager); const pull = f.manager.claimWork(f.auth); await gate.entered.promise;
      if (invalidate === 'cancel') owner.lifetime.abort(); else owner.changeSource();
      gate.release.resolve(); expect(await pull).toEqual([]); expect(owner.claims).toBe(0);
      await f.manager.writes.drain();
      expect(f.manager.listWork().find(work => work.id === queued.id)?.status).toBe('cancelled');
      const disk = JSON.parse(readFileSync(f.path, 'utf8')) as DistributedRuntimeSnapshotStore;
      expect(disk.work.find(work => work.id === queued.id)?.status).toBe('cancelled');
    });
  }
  test('a successful exact claim consumes once and normal completion releases its owner', async () => {
    const f = await fixture(); const owner = authority();
    const queued = await f.manager.enqueueWork({ peerId: f.peerId, command: 'device.screen.capture', payload: { capture: 'screen' }, admission: owner.admission });
    const [claimed] = await f.manager.claimWork(f.auth);
    expect(claimed?.id).toBe(queued.id); expect(claimed?.payload).toEqual({ capture: 'screen' }); expect(owner.claims).toBe(1);
    expect(await f.manager.claimWork(f.auth)).toEqual([]);
    expect((await f.manager.completeWork(f.auth, queued.id, { result: { ok: true } }))?.status).toBe('completed');
    expect(f.manager.workAdmissions.size).toBe(0); expect(owner.claims).toBe(1);
  });
  test('persisted guarded work cannot be claimed after restart without its ephemeral owner', async () => {
    const f = await fixture(); const owner = authority();
    const guarded = await f.manager.enqueueWork({ peerId: f.peerId, command: 'device.screen.capture', admission: owner.admission });
    const ordinary = await f.manager.enqueueWork({ peerId: f.peerId, command: 'ordinary-status' });
    const restarted = new DistributedRuntimeManager(f.path); cleanups.push(() => restarted.writes.drain()); await restarted.start();
    expect((await restarted.claimWork(f.auth)).map(work => work.id)).toEqual([ordinary.id]);
    expect(restarted.listWork().find(work => work.id === guarded.id)?.status).toBe('cancelled'); expect(owner.claims).toBe(0);
  });
  test('a disconnect cannot replay a consumed guarded operation under a new lease', async () => {
    const f = await fixture(); const owner = authority();
    const work = await f.manager.enqueueWork({ peerId: f.peerId, command: 'device.screen.capture', admission: owner.admission });
    expect((await f.manager.claimWork(f.auth))[0]?.id).toBe(work.id);
    await f.manager.disconnectPeer(f.peerId, { requeueClaimedWork: true }); expect(await f.manager.claimWork(f.auth)).toEqual([]);
    expect(f.manager.listWork().find(item => item.id === work.id)?.status).toBe('cancelled'); expect(owner.claims).toBe(1);
  });
  test('cancellation while the peer is pending wakes invoke and refuses a late completion', async () => {
    const f = await fixture(); const owner = authority();
    const request = f.manager.invokePeer({ peerId: f.peerId, command: 'device.screen.capture', admission: owner.admission, waitMs: 5_000 }).catch(() => null);
    while (f.manager.listWork().length === 0) await Bun.sleep(5);
    const [work] = await f.manager.claimWork(f.auth); expect(work).toBeDefined(); owner.lifetime.abort();
    const result = await request; if (result) expect(result.work.status).toBe('cancelled');
    const late = await f.manager.completeWork(f.auth, work!.id, { result: { secretCapture: 'late' } });
    expect(late?.status).toBe('cancelled'); expect(late?.result).toBeUndefined();
  });
  test('one admission cannot reserve two works and caller mutation cannot widen the captured payload', async () => {
    const f = await fixture(); const owner = authority(); const payload = { capture: 'screen' };
    const pending = f.manager.enqueueWork({ peerId: f.peerId, command: 'device.screen.capture', payload, admission: owner.admission });
    payload.capture = 'camera'; const work = await pending;
    await expect(f.manager.enqueueWork({ peerId: f.peerId, command: 'device.camera.front', admission: owner.admission })).rejects.toThrow('already reserved');
    expect((await f.manager.claimWork(f.auth))[0]?.payload).toEqual({ capture: 'screen' });
    expect(f.manager.listWork()).toHaveLength(1); expect(owner.claims).toBe(1); await f.manager.cancelWork(work.id);
  });
  test('rotating a peer credential invalidates queued authority even when its profile is unchanged', async () => {
    const f = await fixture(); const owner = authority();
    const work = await f.manager.enqueueWork({ peerId: f.peerId, command: 'device.screen.capture', admission: owner.admission });
    const rotated = await f.manager.rotatePeerToken(f.peerId); expect(rotated).not.toBeNull();
    expect(await f.manager.claimWork({ peer: rotated!.peer, token: rotated!.token })).toEqual([]);
    expect(f.manager.listWork().find(item => item.id === work.id)?.status).toBe('cancelled'); expect(owner.claims).toBe(0);
  });
  test('a pull authenticated before rotation cannot acquire fresh guarded work for the replacement token', async () => {
    const f = await fixture(); const owner = authority(); const rotated = await f.manager.rotatePeerToken(f.peerId); expect(rotated).not.toBeNull();
    const work = await f.manager.enqueueWork({ peerId: f.peerId, command: 'device.screen.capture', admission: owner.admission });
    expect(await f.manager.claimWork(f.auth)).toEqual([]); expect(f.manager.work.get(work.id)?.status).toBe('queued'); expect(owner.claims).toBe(0);
    expect((await f.manager.claimWork({ peer: rotated!.peer, token: rotated!.token })).map(item => item.id)).toEqual([work.id]);
    expect(owner.claims).toBe(1); await f.manager.cancelWork(work.id);
  });
  test('disconnect and reconnect with the same token and final profile cannot revive queued authority', async () => {
    const f = await fixture(); const owner = authority();
    const profile = () => f.manager.listPeers().map(peer => ({ id: peer.id, kind: peer.kind, label: peer.label,
      capabilities: peer.capabilities, commands: peer.commands, permissions: peer.permissions,
      status: peer.status, activeTokenId: peer.activeTokenId, metadata: peer.metadata }));
    const before = profile(); const revision = f.manager.peerRevision(f.peerId);
    const work = await f.manager.enqueueWork({ peerId: f.peerId, command: 'device.screen.capture', admission: owner.admission });
    await f.manager.disconnectPeer(f.peerId); expect(f.manager.peerRevision(f.peerId)).toBeGreaterThan(revision);
    const auth = await f.manager.authenticatePeerToken(f.auth.token.value); expect(auth).not.toBeNull();
    expect(profile()).toEqual(before); expect(f.manager.peerRevision(f.peerId)).toBeGreaterThan(revision + 1);
    expect(await f.manager.claimWork(auth!)).toEqual([]); expect(f.manager.listWork().find(item => item.id === work.id)?.status).toBe('cancelled'); expect(owner.claims).toBe(0);
  });
  for (const mutation of ['disconnect', 'revoke', 'rotate', 'profile'] as const) {
    test(`${mutation} invalidates lifecycle at invocation before the helper's first await`, async () => {
      const f = await fixture(); const before = f.manager.peers.get(f.peerId); const revision = f.manager.peerRevision(f.peerId);
      const pending = mutation === 'disconnect' ? f.manager.disconnectPeer(f.peerId) : mutation === 'revoke' ? f.manager.revokePeerToken(f.peerId)
        : mutation === 'rotate' ? f.manager.rotatePeerToken(f.peerId) : f.manager.heartbeatPeer(f.auth, { capabilities: [] });
      expect(f.manager.peerRevision(f.peerId)).toBeGreaterThan(revision); expect(f.manager.peerMutationPending(f.peerId)).toBe(true);
      expect(f.manager.peers.get(f.peerId)).toBe(before); await pending; expect(f.manager.peerMutationPending(f.peerId)).toBe(false);
    });
  }
  for (const mutation of ['disconnect', 'rotate'] as const) {
    test(`new admission refuses while ${mutation} is held in startup before changing the old peer`, async () => {
      const f = await fixture(); const owner = authority(); const before = f.manager.peers.get(f.peerId);
      const entered = deferred(); const release = deferred(); const original = f.manager.store.load.bind(f.manager.store);
      const load = spyOn(f.manager.store, 'load').mockImplementationOnce(async () => { entered.resolve(); await release.promise; return original(); });
      cleanups.push(() => { release.resolve(); load.mockRestore(); }); f.manager.loaded = false;
      const pending = mutation === 'disconnect' ? f.manager.disconnectPeer(f.peerId) : f.manager.rotatePeerToken(f.peerId); await entered.promise;
      expect(f.manager.peerMutationPending(f.peerId)).toBe(true); expect(f.manager.peers.get(f.peerId)).toBe(before);
      await expect(f.manager.enqueueWork({ peerId: f.peerId, command: 'device.screen.capture', admission: owner.admission })).rejects.toThrow('mutation is pending');
      expect(f.manager.work.size).toBe(0); expect(owner.claims).toBe(0); release.resolve(); await pending; expect(f.manager.peerMutationPending(f.peerId)).toBe(false);
    });
  }
  test('ordinary paired to connected completion does not invalidate successful authority', async () => {
    const f = await fixture(); const owner = authority(); const peer = f.manager.peers.get(f.peerId)!;
    f.manager.peers.set(f.peerId, { ...peer, status: 'paired' }); const revision = f.manager.peerRevision(f.peerId);
    const work = await f.manager.enqueueWork({ peerId: f.peerId, command: 'device.screen.capture', admission: owner.admission });
    expect((await f.manager.claimWork(f.auth))[0]?.id).toBe(work.id);
    expect((await f.manager.completeWork(f.auth, work.id, { result: { ok: true } }))?.status).toBe('completed');
    expect(f.manager.peerRevision(f.peerId)).toBe(revision); expect(owner.claims).toBe(1);
  });
  test('unchanged heartbeat and authentication preserve authority but a profile ABA invalidates it', async () => {
    const f = await fixture(); const owner = authority(); const revision = f.manager.peerRevision(f.peerId);
    const work = await f.manager.enqueueWork({ peerId: f.peerId, command: 'device.screen.capture', admission: owner.admission });
    await f.manager.heartbeatPeer(f.auth); await f.manager.authenticatePeerToken(f.auth.token.value); expect(f.manager.peerRevision(f.peerId)).toBe(revision);
    await f.manager.heartbeatPeer(f.auth, { capabilities: [] }); await f.manager.heartbeatPeer(f.auth, { capabilities: f.auth.peer.capabilities });
    expect(f.manager.listPeers()[0]?.capabilities).toEqual(f.auth.peer.capabilities); expect(f.manager.peerRevision(f.peerId)).toBeGreaterThan(revision + 1);
    expect(await f.manager.claimWork(f.auth)).toEqual([]); expect(f.manager.listWork().find(item => item.id === work.id)?.status).toBe('cancelled'); expect(owner.claims).toBe(0);
  });
  test('a snapshot read inside the owner guard cannot expire a lease and then revive its late completion', async () => {
    const f = await fixture(); const owner = authority(); const check = owner.admission.assertCurrent.bind(owner.admission);
    let beforeRead: (() => void) | undefined; owner.admission.assertCurrent = () => { check(); beforeRead?.(); f.manager.getSnapshot(); };
    const work = await f.manager.enqueueWork({ peerId: f.peerId, command: 'device.screen.capture', admission: owner.admission });
    await f.manager.claimWork(f.auth, { leaseMs: 5_000 }); const revision = f.manager.peerRevision(f.peerId);
    const now = Date.now(); const clock = spyOn(Date, 'now').mockReturnValue(now); beforeRead = () => { clock.mockReturnValue(now + 6_000); };
    try {
      expect(f.manager.peerRevision(f.peerId)).toBe(revision); expect(f.manager.work.get(work.id)?.status).toBe('claimed');
      const completed = await f.manager.completeWork(f.auth, work.id, { result: { secretCapture: 'late' } });
      expect(completed?.status).toBe('cancelled'); expect(completed?.result).toBeUndefined(); expect(f.manager.workAdmissions.size).toBe(0);
      expect(f.manager.peerRevision(f.peerId)).toBeGreaterThan(revision); expect(owner.claims).toBe(1);
    } finally { clock.mockRestore(); }
  });
  test('a claim delayed past its lease in persistence is refused without any snapshot read', async () => {
    const f = await fixture(); const owner = authority();
    const work = await f.manager.enqueueWork({ peerId: f.peerId, command: 'device.screen.capture', admission: owner.admission });
    const gate = pauseNextPersist(f.manager); const pull = f.manager.claimWork(f.auth, { leaseMs: 5_000 }); await gate.entered.promise;
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000);
    try { gate.release.resolve(); expect(await pull).toEqual([]); expect(f.manager.work.get(work.id)?.status).toBe('cancelled'); expect(f.manager.workAdmissions.size).toBe(0); expect(owner.claims).toBe(0); }
    finally { clock.mockRestore(); }
  });
  test('a timed-out guarded invoke cancels queued work and detaches its ephemeral lifetime', async () => {
    const f = await fixture(); const owner = authority();
    const result = await f.manager.invokePeer({ peerId: f.peerId, command: 'device.screen.capture', admission: owner.admission, waitMs: 20 });
    expect(result.completed).toBe(false); expect(result.work.status).toBe('cancelled'); expect(f.manager.workAdmissions.size).toBe(0);
    expect(await f.manager.claimWork(f.auth)).toEqual([]); expect(owner.claims).toBe(0);
  });
  test('expired claimed authority is reaped by the real lease read and never serialized', async () => {
    const f = await fixture(); const owner = authority();
    const work = await f.manager.enqueueWork({ peerId: f.peerId, command: 'device.screen.capture', admission: owner.admission });
    await f.manager.claimWork(f.auth, { leaseMs: 5_000 }); const json = JSON.stringify(f.manager.getSnapshot());
    expect(json).not.toContain('workAdmissions'); expect(json).not.toContain('assertCurrent'); expect(json).not.toContain('signal');
    const now = Date.now(); const clock = spyOn(Date, 'now').mockReturnValue(now + 6_000);
    try { expect(f.manager.listWork().find(item => item.id === work.id)?.status).toBe('cancelled'); expect(f.manager.workAdmissions.size).toBe(0); expect(await f.manager.claimWork(f.auth)).toEqual([]); expect(owner.claims).toBe(1); }
    finally { clock.mockRestore(); }
  });
});
