import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import type { AutomationRunTelemetry } from '../../automation/runs.js';
import type {
  DistributedPendingWork,
  DistributedWorkAdmission,
  DistributedWorkAdmissionOwner,
  DistributedPeerRecord,
  DistributedRuntimeManagerState,
  DistributedWorkPriority,
  DistributedWorkType,
  StoredPeerRecord,
} from './distributed-runtime-types.js';
import {
  buildAudit,
  sanitizePeer,
  sortWork,
  summarizeValue,
} from './distributed-runtime-utils.js';
import {
  persistDistributedRuntime,
  pruneAndPersistDistributedRuntime,
  publishDistributedRuntimeEvent,
  recordDistributedRuntimeAudit,
  resolveDistributedRuntimeWaiters,
  startDistributedRuntime,
  waitForDistributedWork,
} from './distributed-runtime-store.js';

// The marker survives restart; its executable owner deliberately does not.
const ADMISSION_REQUIRED = '__hostAdmissionRequired';
const reservedAdmissions = new WeakSet<object>();
function signature(work: DistributedPendingWork): string {
  return JSON.stringify([work.peerId, work.peerKind, work.type, work.command, work.payload,
    work.priority, work.timeoutMs, work.sessionId, work.routeId, work.automationRunId,
    work.automationJobId, work.approvalId]);
}
function releaseAdmission(state: DistributedRuntimeManagerState, id: string): void {
  state.workAdmissions.get(id)?.detach();
  state.workAdmissions.delete(id);
}
function assertAdmission(state: DistributedRuntimeManagerState, work: DistributedPendingWork,
  unclaimed: boolean): DistributedWorkAdmissionOwner | undefined {
  if (work.metadata[ADMISSION_REQUIRED] !== true && !state.workAdmissions.has(work.id)) return;
  const owner = state.workAdmissions.get(work.id);
  if (!owner) throw new Error('Distributed work has no current host admission.');
  const validate = () => {
    const current = state.work.get(work.id);
    const peer = state.peers.get(work.peerId);
    if (state.workAdmissions.get(work.id) !== owner || !current || !['queued', 'claimed'].includes(current.status)
      || (unclaimed && owner.claimed) || (owner.claimed && current.status !== 'claimed')
      || (current.status === 'claimed' && current.leaseExpiresAt !== undefined && current.leaseExpiresAt <= Date.now())
      || owner.requestSignature !== signature(current) || state.peerRevision(work.peerId) !== owner.peerRevision
      || state.peerMutationPending(work.peerId)
      || !peer || peer.status === 'revoked' || peer.activeTokenId !== owner.peerTokenId) {
      throw new Error('Distributed work has no current host admission.');
    }
  };
  validate();
  owner.signal.throwIfAborted(); owner.assertCurrent(); owner.signal.throwIfAborted();
  // A host snapshot guard can itself expire leases and detach this owner.
  validate();
  return owner;
}
function refuseAdmission(state: DistributedRuntimeManagerState, id: string): void {
  releaseAdmission(state, id);
  const current = state.work.get(id);
  if (!current || !['queued', 'claimed'].includes(current.status)) return;
  const cancelled: DistributedPendingWork = { ...current, status: 'cancelled',
    error: 'host-admission-no-longer-current', completedAt: Date.now(), updatedAt: Date.now(), leaseExpiresAt: undefined };
  state.work.set(id, cancelled);
  recordDistributedRuntimeAudit(state, buildAudit('work-cancelled', 'host-admission', { peerId: current.peerId, workId: id, note: cancelled.error }));
  resolveDistributedRuntimeWaiters(state, cancelled);
}
function persistRefusal(state: DistributedRuntimeManagerState): void {
  // An old queued snapshot is also fenced after restart by its persisted marker.
  void persistDistributedRuntime(state).catch(() => logger.warn('Distributed host-admission cancellation could not be persisted.'));
}
/** Read/start boundaries reap authority that cannot survive expiry or restart. */
export function reconcileDistributedWorkAdmissions(state: DistributedRuntimeManagerState): boolean {
  let changed = false;
  for (const [id, owner] of state.workAdmissions) {
    const work = state.work.get(id);
    if (!work || !['queued', 'claimed'].includes(work.status)) releaseAdmission(state, id);
    else if (work.status === 'queued' && owner.claimed) { refuseAdmission(state, id); changed = true; }
  }
  for (const work of state.work.values()) {
    if (work.metadata[ADMISSION_REQUIRED] === true && ['queued', 'claimed'].includes(work.status)
      && !state.workAdmissions.has(work.id)) { refuseAdmission(state, work.id); changed = true; }
  }
  return changed;
}

export async function enqueueDistributedWork(
  state: DistributedRuntimeManagerState,
  input: {
    readonly admission?: DistributedWorkAdmission | undefined;
    readonly peerId: string;
    readonly type?: DistributedWorkType | undefined;
    readonly command: string;
    readonly payload?: unknown | undefined;
    readonly priority?: DistributedWorkPriority | undefined;
    readonly actor?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly sessionId?: string | undefined;
    readonly routeId?: string | undefined;
    readonly automationRunId?: string | undefined;
    readonly automationJobId?: string | undefined;
    readonly approvalId?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  },
): Promise<DistributedPendingWork> {
  const originalAdmission = input.admission;
  const admission = originalAdmission ? { signal: originalAdmission.signal,
    assertCurrent: originalAdmission.assertCurrent.bind(originalAdmission), claim: originalAdmission.claim.bind(originalAdmission) } : undefined;
  if (admission && state.peerMutationPending(input.peerId)) throw new Error('Distributed peer mutation is pending.');
  const startingPeerRevision = admission && state.loaded ? state.peerRevision(input.peerId) : undefined;
  // Keep borrowed caller mutation out of the queued action during startup.
  if (admission) { const { admission: _owner, ...data } = input; input = { ...structuredClone(data), admission }; }
  await startDistributedRuntime(state);
  const peer = state.peers.get(input.peerId);
  if (!peer) throw new Error(`Unknown distributed peer: ${input.peerId}`);
  if (admission) {
    admission.signal.throwIfAborted(); admission.assertCurrent(); admission.signal.throwIfAborted();
    if (startingPeerRevision !== undefined && state.peerRevision(input.peerId) !== startingPeerRevision) throw new Error('Distributed peer changed during admission startup.');
    if (state.peerMutationPending(input.peerId) || peer.status === 'revoked' || reservedAdmissions.has(originalAdmission!)) throw new Error('Distributed work admission is unavailable or already reserved.');
    reservedAdmissions.add(originalAdmission!);
  }
  const now = Date.now();
  const work: DistributedPendingWork = {
    id: `rwork-${randomUUID().slice(0, 8)}`,
    peerId: peer.id,
    peerKind: peer.kind,
    type: input.type ?? 'invoke',
    command: input.command.trim() || 'invoke',
    priority: input.priority ?? 'normal',
    status: 'queued',
    payload: input.payload,
    createdAt: now,
    updatedAt: now,
    queuedBy: input.actor ?? 'operator',
    timeoutMs: input.timeoutMs,
    sessionId: input.sessionId,
    routeId: input.routeId,
    automationRunId: input.automationRunId,
    automationJobId: input.automationJobId,
    approvalId: input.approvalId,
    metadata: { ...(input.metadata ?? {}), ...(admission ? { [ADMISSION_REQUIRED]: true } : {}) },
  };
  if (admission) {
    const abort = () => { refuseAdmission(state, work.id); persistRefusal(state); };
    const owner: DistributedWorkAdmissionOwner = { ...admission, requestSignature: signature(work), peerTokenId: peer.activeTokenId, peerRevision: state.peerRevision(peer.id),
      claimed: false, detach: () => admission.signal.removeEventListener('abort', abort) };
    state.workAdmissions.set(work.id, owner);
    admission.signal.addEventListener('abort', abort, { once: true });
  }
  state.work.set(work.id, work);
  recordDistributedRuntimeAudit(state, buildAudit('work-queued', input.actor ?? 'operator', {
    peerId: peer.id,
    workId: work.id,
    note: `${work.command} -> ${peer.label}`,
  }));
  try {
    if (admission) assertAdmission(state, work, true);
    await bridgeQueuedDistributedWork(state, peer, work);
    await pruneAndPersistDistributedRuntime(state);
    if (admission) {
      admission.signal.throwIfAborted(); admission.assertCurrent();
      const current = state.work.get(work.id)!;
      if (!['completed', 'failed'].includes(current.status)) assertAdmission(state, work, false);
    }
    publishDistributedRuntimeEvent(state, 'remote-work-queued', { peer: sanitizePeer(peer), work });
    if (admission) {
      admission.signal.throwIfAborted(); admission.assertCurrent();
      const current = state.work.get(work.id)!;
      if (!['completed', 'failed'].includes(current.status)) assertAdmission(state, work, false);
    }
    return state.work.get(work.id) ?? work;
  } catch (error) {
    if (admission) { refuseAdmission(state, work.id); await persistDistributedRuntime(state); }
    throw error;
  }
}

export async function invokeDistributedPeer(
  state: DistributedRuntimeManagerState,
  input: {
    readonly admission?: DistributedWorkAdmission | undefined;
    readonly peerId: string;
    /**
     * Work type. Defaults to 'invoke'; a caller with a typed family of its own
     * (e.g. 'device.capability') names it so the peer can route on type rather
     * than on the command string.
     */
    readonly type?: DistributedWorkType | undefined;
    readonly command: string;
    readonly payload?: unknown | undefined;
    readonly priority?: DistributedWorkPriority | undefined;
    readonly actor?: string | undefined;
    readonly waitMs?: number | undefined;
    readonly timeoutMs?: number | undefined;
    readonly sessionId?: string | undefined;
    readonly routeId?: string | undefined;
    readonly automationRunId?: string | undefined;
    readonly automationJobId?: string | undefined;
    readonly approvalId?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  },
): Promise<{ work: DistributedPendingWork; completed: boolean }> {
  const work = await enqueueDistributedWork(state, {
    admission: input.admission,
    peerId: input.peerId,
    type: input.type,
    command: input.command,
    payload: input.payload,
    priority: input.priority,
    actor: input.actor,
    timeoutMs: input.timeoutMs,
    sessionId: input.sessionId,
    routeId: input.routeId,
    automationRunId: input.automationRunId,
    automationJobId: input.automationJobId,
    approvalId: input.approvalId,
    metadata: input.metadata,
  });
  if (!input.waitMs || input.waitMs <= 0) {
    return { work, completed: false };
  }
  const settled = await waitForDistributedWork(state, work.id, input.waitMs);
  if (!settled && input.admission) {
    refuseAdmission(state, work.id); await persistDistributedRuntime(state);
    return { work: state.work.get(work.id) ?? work, completed: false };
  }
  return {
    work: settled ?? work,
    completed: Boolean(settled && settled.status !== 'queued' && settled.status !== 'claimed'),
  };
}

export async function claimDistributedWork(
  state: DistributedRuntimeManagerState,
  auth: { readonly peer: DistributedPeerRecord; readonly token: { readonly id: string } },
  input: {
    readonly maxItems?: number | undefined;
    readonly leaseMs?: number | undefined;
  } = {},
): Promise<DistributedPendingWork[]> {
  await startDistributedRuntime(state);
  const peer = state.peers.get(auth.peer.id);
  if (!peer) return [];
  const maxItems = Math.min(10, Math.max(1, Math.trunc(input.maxItems ?? 4)));
  const leaseMs = Math.max(5_000, Math.trunc(input.leaseMs ?? 45_000));
  const queued = sortWork(state.work.values())
    .filter((item) => item.peerId === peer.id && item.status === 'queued')
    .slice(0, maxItems);
  const now = Date.now();
  const claimed: DistributedPendingWork[] = [];
  for (const item of queued) {
    try {
      const owner = assertAdmission(state, item, true);
      // A stale pull cannot acquire fresh work, but genuinely stale owners are reaped first.
      if (owner && owner.peerTokenId !== auth.token.id) continue;
    }
    catch { refuseAdmission(state, item.id); continue; }
    const next: DistributedPendingWork = {
      ...item,
      status: 'claimed',
      claimTokenId: auth.token.id,
      claimedAt: now,
      leaseExpiresAt: now + leaseMs,
      updatedAt: now,
    };
    state.work.set(item.id, next);
    claimed.push(next);
    recordDistributedRuntimeAudit(state, buildAudit('work-claimed', peer.id, {
      peerId: peer.id,
      workId: item.id,
      note: item.command,
    }));
  }
  await pruneAndPersistDistributedRuntime(state);
  if (claimed.length > 0) {
    publishDistributedRuntimeEvent(state, 'remote-work-claimed', {
      peer: sanitizePeer(state.peers.get(peer.id)!),
      workIds: claimed.map((item) => item.id),
    });
  }
  const delivered: DistributedPendingWork[] = [];
  for (const item of claimed) {
    try {
      const owner = assertAdmission(state, item, true);
      if (owner) {
        if (owner.peerTokenId !== auth.token.id) throw new Error('Distributed pull token does not own this admission.');
        if (state.work.get(item.id) !== item) throw new Error('Distributed claim was replaced.');
        owner.claimed = true; // Fence reentrant/duplicate claims before the host callback.
        owner.claim(); assertAdmission(state, item, false);
      }
      delivered.push(item);
    } catch { refuseAdmission(state, item.id); persistRefusal(state); }
  }
  // No awaits after final validation and before returning peer work.
  return delivered.filter(item => {
    try {
      const owner = assertAdmission(state, item, false);
      if (owner && owner.peerTokenId !== auth.token.id) throw new Error('Distributed pull token changed.');
      return true;
    }
    catch { refuseAdmission(state, item.id); persistRefusal(state); return false; }
  });
}

export async function completeDistributedWork(
  state: DistributedRuntimeManagerState,
  auth: { readonly peer: DistributedPeerRecord; readonly token: { readonly id: string } },
  workId: string,
  input: {
    readonly status?: 'completed' | 'failed' | 'cancelled' | undefined;
    readonly result?: unknown | undefined;
    readonly error?: string | undefined;
    readonly telemetry?: AutomationRunTelemetry | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  } = {},
): Promise<DistributedPendingWork | null> {
  await startDistributedRuntime(state);
  const current = state.work.get(workId);
  if (!current || current.peerId !== auth.peer.id) return null;
  if (current.claimTokenId && current.claimTokenId !== auth.token.id) return null;
  if (current.metadata[ADMISSION_REQUIRED] === true || state.workAdmissions.has(workId)) {
    try {
      const owner = assertAdmission(state, current, false);
      if (current.status !== 'claimed' || !owner?.claimed) throw new Error('Host work was not admitted to the peer.');
    } catch { refuseAdmission(state, workId); await persistDistributedRuntime(state); return state.work.get(workId) ?? null; }
  }
  const status = input.status ?? (input.error ? 'failed' : 'completed');
  const updated: DistributedPendingWork = {
    ...current,
    status,
    result: input.result,
    error: input.error,
    telemetry: input.telemetry as DistributedPendingWork['telemetry'],
    completedAt: Date.now(),
    updatedAt: Date.now(),
    leaseExpiresAt: undefined,
    metadata: {
      ...current.metadata,
      ...(input.metadata ?? {}),
      ...(current.metadata[ADMISSION_REQUIRED] === true ? { [ADMISSION_REQUIRED]: true } : {}),
    },
  };
  releaseAdmission(state, workId);
  state.work.set(workId, updated);
  const peer = state.peers.get(auth.peer.id);
  if (peer) {
    state.peers.set(peer.id, {
      ...peer,
      status: 'connected',
      lastSeenAt: Date.now(),
      lastConnectedAt: Date.now(),
    });
  }
  const actor = auth.peer.id;
  recordDistributedRuntimeAudit(state, buildAudit(
    status === 'completed' ? 'work-completed' : status === 'failed' ? 'work-failed' : 'work-cancelled',
    actor,
    {
      peerId: auth.peer.id,
      workId,
      note: status === 'completed' ? summarizeValue(input.result) || 'no result' : (input.error ?? status),
    },
  ));
  await bridgeCompletedDistributedWork(
    state,
    state.peers.get(auth.peer.id) ?? ensurePlaceholderPeer(state, auth.peer.id, current.peerKind),
    updated,
  );
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-work-settled', {
    peer: sanitizePeer(state.peers.get(auth.peer.id)!),
    work: updated,
  });
  resolveDistributedRuntimeWaiters(state, updated);
  return updated;
}

export async function cancelDistributedWork(
  state: DistributedRuntimeManagerState,
  workId: string,
  input: {
    readonly actor?: string | undefined;
    readonly reason?: string | undefined;
  } = {},
): Promise<DistributedPendingWork | null> {
  await startDistributedRuntime(state);
  const current = state.work.get(workId);
  if (!current) return null;
  releaseAdmission(state, workId);
  if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') {
    return current;
  }
  const updated: DistributedPendingWork = {
    ...current,
    status: 'cancelled',
    error: input.reason ?? current.error ?? 'operator-cancelled',
    completedAt: Date.now(),
    updatedAt: Date.now(),
    leaseExpiresAt: undefined,
  };
  state.work.set(workId, updated);
  recordDistributedRuntimeAudit(state, buildAudit('work-cancelled', input.actor ?? 'operator', {
    peerId: updated.peerId,
    workId,
    note: updated.error,
  }));
  await bridgeCompletedDistributedWork(
    state,
    state.peers.get(updated.peerId) ?? ensurePlaceholderPeer(state, updated.peerId, updated.peerKind),
    updated,
  );
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-work-cancelled', updated);
  resolveDistributedRuntimeWaiters(state, updated);
  return updated;
}

async function bridgeQueuedDistributedWork(
  state: DistributedRuntimeManagerState,
  peer: DistributedPeerRecord,
  work: DistributedPendingWork,
): Promise<void> {
  if (work.sessionId && state.sessionBridge) {
    await state.sessionBridge.appendSystemMessage(
      work.sessionId,
      `Queued remote ${peer.kind} work on ${peer.label}: ${work.command}`,
      {
        remotePeerId: peer.id,
        remotePeerKind: peer.kind,
        remoteWorkId: work.id,
        remoteWorkStatus: work.status,
        automationRunId: work.automationRunId,
        approvalId: work.approvalId,
      },
    );
  }
}

async function bridgeCompletedDistributedWork(
  state: DistributedRuntimeManagerState,
  peer: DistributedPeerRecord,
  work: DistributedPendingWork,
): Promise<void> {
  const statusLabel = work.status === 'completed'
    ? 'completed'
    : work.status === 'failed'
      ? 'failed'
      : 'cancelled';
  const summary = work.status === 'completed'
    ? summarizeValue(work.result) || 'no result'
    : (work.error ?? statusLabel);

  if (work.sessionId && state.sessionBridge) {
    await state.sessionBridge.appendSystemMessage(
      work.sessionId,
      `Remote ${peer.kind} ${peer.label} ${statusLabel}: ${work.command}${summary ? `\n${summary}` : ''}`,
      {
        remotePeerId: peer.id,
        remotePeerKind: peer.kind,
        remoteWorkId: work.id,
        remoteWorkStatus: work.status,
        automationRunId: work.automationRunId,
        approvalId: work.approvalId,
      },
    );
  }

  if (work.approvalId && state.approvalBridge) {
    await state.approvalBridge.recordRemoteUpdate(work.approvalId, {
      actor: peer.id,
      actorSurface: 'service',
      note: `Remote ${peer.kind} ${peer.label} ${statusLabel}: ${work.command}`,
      metadata: {
        remotePeerId: peer.id,
        remoteWorkId: work.id,
        remoteWorkStatus: work.status,
      },
    });
  }

  if (work.automationRunId && state.automationBridge) {
    await state.automationBridge.recordExternalRunResult(work.automationRunId, {
      status: work.status === 'completed' ? 'completed' : work.status === 'failed' ? 'failed' : 'cancelled',
      result: work.result,
      error: work.error,
      telemetry: work.telemetry,
      metadata: {
        remotePeerId: peer.id,
        remoteWorkId: work.id,
        remotePeerKind: peer.kind,
      },
    });
  }
}

function ensurePlaceholderPeer(
  state: DistributedRuntimeManagerState,
  peerId: string,
  kind: DistributedPeerRecord['kind'],
): StoredPeerRecord {
  const existing = state.peers.get(peerId);
  if (existing) return existing;
  const peer: StoredPeerRecord = {
    id: peerId,
    kind,
    label: peerId,
    requestedId: peerId,
    capabilities: [],
    commands: [],
    permissions: undefined,
    status: 'idle',
    pairedAt: Date.now(),
    tokens: [],
    metadata: {},
  };
  state.peers.set(peer.id, peer);
  return peer;
}
