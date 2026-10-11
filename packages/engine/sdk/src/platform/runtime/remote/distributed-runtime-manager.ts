import { logger } from '../../utils/logger.js';
import { PersistentStore } from '../../state/persistent-store.js';
import { StoreWriteQueue } from '../../state/store-write-queue.js';
import type {
  DistributedApprovalBridge,
  DistributedAutomationBridge,
  DistributedNodeHostContract,
  DistributedPendingWork,
  DistributedPeerAuth,
  DistributedPeerKind,
  DistributedPeerRecord,
  DistributedPeerTokenRecord,
  DistributedRuntimeAuditRecord,
  DistributedRuntimeManagerState,
  DistributedRuntimePairRequest,
  DistributedRuntimeSnapshotStore,
  DistributedSessionBridge,
  DistributedWorkAdmission,
  DistributedWorkAdmissionOwner,
  DistributedWorkPriority,
  DistributedWorkType,
  StoredPairRequest,
  StoredPeerRecord,
  DistributedRuntimeWaiter,
} from './distributed-runtime-types.js';
import { getDistributedNodeHostContract } from './distributed-runtime-contract.js';
import {
  attachDistributedRuntime,
  getDistributedRuntimeSnapshot,
  listDistributedRuntimeAudit,
  listDistributedRuntimePairRequests,
  listDistributedRuntimePeers,
  listDistributedRuntimeWork,
  startDistributedRuntime,
  persistDistributedRuntime,
} from './distributed-runtime-store.js';
import {
  approveDistributedPairRequest,
  authenticateDistributedPeerToken,
  disconnectDistributedPeer,
  rejectDistributedPairRequest,
  requestDistributedPairing,
  revokeDistributedPeerToken,
  rotateDistributedPeerToken,
  verifyDistributedPairRequest,
  heartbeatDistributedPeer,
} from './distributed-runtime-pairing.js';
import {
  cancelDistributedWork,
  claimDistributedWork,
  completeDistributedWork,
  enqueueDistributedWork,
  invokeDistributedPeer,
  reconcileDistributedWorkAdmissions,
} from './distributed-runtime-work.js';

function peerLifecycleSignature(peer: StoredPeerRecord): string {
  // Routine presence/token-use timestamps do not change device authority.
  return JSON.stringify([peer.id, peer.kind, peer.requestedId, peer.label,
    peer.platform, peer.deviceFamily, peer.version, peer.clientMode, peer.capabilities,
    peer.commands, peer.permissions, ['disconnected', 'revoked'].includes(peer.status) ? peer.status : 'available', peer.activeTokenId, peer.lastRemoteAddress,
    peer.metadata, peer.tokens.map(({ lastUsedAt: _lastUsedAt, ...token }) => token)]);
}

/** Observe mutations themselves, not just snapshots, so an A→B→A transition stays visible. */
class LifecyclePeerMap extends Map<string, StoredPeerRecord> {
  private readonly revisions = new Map<string, number>();
  private readonly signatures = new Map<string, string>();
  revision(peerId: string): number { return this.revisions.get(peerId) ?? 0; }
  invalidate(peerId: string): void { this.revisions.set(peerId, this.revision(peerId) + 1); }
  changing(peerId: string, peer: StoredPeerRecord): boolean { return this.signatures.get(peerId) !== peerLifecycleSignature(peer); }
  override set(peerId: string, peer: StoredPeerRecord): this {
    const signature = peerLifecycleSignature(peer);
    if (this.signatures.get(peerId) !== signature) {
      this.invalidate(peerId);
      this.signatures.set(peerId, signature);
    }
    return super.set(peerId, peer);
  }
  override delete(peerId: string): boolean {
    if (!super.delete(peerId)) return false;
    this.signatures.delete(peerId);
    this.invalidate(peerId);
    return true;
  }
  override clear(): void { for (const peerId of this.keys()) this.delete(peerId); }
}

export class DistributedRuntimeManager implements DistributedRuntimeManagerState {
  readonly store: PersistentStore<DistributedRuntimeSnapshotStore>;
  readonly pairRequests = new Map<string, StoredPairRequest>();
  readonly peers = new LifecyclePeerMap();
  private readonly peerMutations = new Map<string, number>();
  readonly work = new Map<string, DistributedPendingWork>();
  readonly workAdmissions = new Map<string, DistributedWorkAdmissionOwner>();
  readonly audit: DistributedRuntimeAuditRecord[] = [];
  readonly waiters = new Map<string, DistributedRuntimeWaiter[]>();
  readonly writes = new StoreWriteQueue();
  sessionBridge: DistributedSessionBridge | null = null;
  approvalBridge: DistributedApprovalBridge | null = null;
  automationBridge: DistributedAutomationBridge | null = null;
  eventPublisher: ((event: string, payload: unknown) => void) | null = null;
  loaded = false;

  constructor(storeOrPath: PersistentStore<DistributedRuntimeSnapshotStore> | string) {
    this.store = typeof storeOrPath === 'string'
      ? new PersistentStore<DistributedRuntimeSnapshotStore>(storeOrPath)
      : storeOrPath;
  }

  attachRuntime(input: {
    readonly sessionBridge?: DistributedSessionBridge | null | undefined;
    readonly approvalBridge?: DistributedApprovalBridge | null | undefined;
    readonly automationBridge?: DistributedAutomationBridge | null | undefined;
    readonly eventPublisher?: ((event: string, payload: unknown) => void) | null | undefined;
  }): void {
    attachDistributedRuntime(this, input);
  }

  async start(): Promise<void> {
    await startDistributedRuntime(this);
    if (reconcileDistributedWorkAdmissions(this)) await persistDistributedRuntime(this);
  }

  listPairRequests(limit = 100): DistributedRuntimePairRequest[] {
    return listDistributedRuntimePairRequests(this, limit);
  }

  listPeers(kind?: DistributedPeerKind, limit = 200): DistributedPeerRecord[] {
    return listDistributedRuntimePeers(this, kind, limit);
  }

  /** Host-only generation; reading it never expires leases or mutates peer state. */
  peerRevision(peerId: string): number { return this.peers.revision(peerId); }
  /** New authority cannot be captured from a peer whose requested change is still pending. */
  peerMutationPending(peerId: string): boolean { return (this.peerMutations.get(peerId) ?? 0) > 0; }
  private beginPeerMutation(peerId: string): () => void {
    this.peers.invalidate(peerId);
    this.peerMutations.set(peerId, (this.peerMutations.get(peerId) ?? 0) + 1);
    return () => {
      const remaining = (this.peerMutations.get(peerId) ?? 1) - 1;
      if (remaining > 0) this.peerMutations.set(peerId, remaining);
      else this.peerMutations.delete(peerId);
    };
  }

  listWork(limit = 200, peerId?: string): DistributedPendingWork[] {
    listDistributedRuntimeWork(this, limit, peerId); // Applies existing lease-expiry policy first.
    if (reconcileDistributedWorkAdmissions(this)) void persistDistributedRuntime(this).catch(() => logger.warn('Distributed host-admission cleanup could not be persisted.'));
    return listDistributedRuntimeWork(this, limit, peerId);
  }

  listAudit(limit = 100): DistributedRuntimeAuditRecord[] {
    return listDistributedRuntimeAudit(this, limit);
  }

  getSnapshot(): Record<string, unknown> {
    getDistributedRuntimeSnapshot(this); // Applies existing lease-expiry policy first.
    if (reconcileDistributedWorkAdmissions(this)) void persistDistributedRuntime(this).catch(() => logger.warn('Distributed host-admission cleanup could not be persisted.'));
    return getDistributedRuntimeSnapshot(this);
  }

  getNodeHostContract(): DistributedNodeHostContract {
    return getDistributedNodeHostContract();
  }

  async requestPairing(input: {
    readonly peerKind: DistributedPeerKind;
    readonly requestedId?: string | undefined;
    readonly label: string;
    readonly platform?: string | undefined;
    readonly deviceFamily?: string | undefined;
    readonly version?: string | undefined;
    readonly clientMode?: string | undefined;
    readonly capabilities?: readonly string[] | undefined;
    readonly commands?: readonly string[] | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
    readonly requestedBy?: 'remote' | 'operator' | undefined;
    readonly remoteAddress?: string | undefined;
    readonly ttlMs?: number | undefined;
  }): Promise<{ request: DistributedRuntimePairRequest; challenge: string }> {
    return requestDistributedPairing(this, input);
  }

  async approvePairRequest(
    requestId: string,
    input: {
      readonly actor?: string | undefined;
      readonly note?: string | undefined;
      readonly label?: string | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    } = {},
  ): Promise<{ request: DistributedRuntimePairRequest; peer: DistributedPeerRecord } | null> {
    return approveDistributedPairRequest(this, requestId, input);
  }

  async rejectPairRequest(
    requestId: string,
    input: {
      readonly actor?: string | undefined;
      readonly note?: string | undefined;
    } = {},
  ): Promise<DistributedRuntimePairRequest | null> {
    return rejectDistributedPairRequest(this, requestId, input);
  }

  async verifyPairRequest(
    requestId: string,
    challenge: string,
    input: {
      readonly remoteAddress?: string | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    } = {},
  ): Promise<{ peer: DistributedPeerRecord; token: DistributedPeerTokenRecord & { value: string } } | null> {
    return verifyDistributedPairRequest(this, requestId, challenge, input);
  }

  async rotatePeerToken(
    peerId: string,
    input: {
      readonly actor?: string | undefined;
      readonly label?: string | undefined;
      readonly scopes?: readonly string[] | undefined;
    } = {},
  ): Promise<{ peer: DistributedPeerRecord; token: DistributedPeerTokenRecord & { value: string } } | null> {
    const finish = this.beginPeerMutation(peerId);
    try { return await rotateDistributedPeerToken(this, peerId, input); }
    finally { finish(); }
  }

  async revokePeerToken(
    peerId: string,
    input: {
      readonly actor?: string | undefined;
      readonly tokenId?: string | undefined;
      readonly note?: string | undefined;
    } = {},
  ): Promise<DistributedPeerRecord | null> {
    const finish = this.beginPeerMutation(peerId);
    try { return await revokeDistributedPeerToken(this, peerId, input); }
    finally { finish(); }
  }

  async disconnectPeer(
    peerId: string,
    input: {
      readonly actor?: string | undefined;
      readonly note?: string | undefined;
      readonly requeueClaimedWork?: boolean | undefined;
    } = {},
  ): Promise<DistributedPeerRecord | null> {
    const finish = this.beginPeerMutation(peerId);
    try { return await disconnectDistributedPeer(this, peerId, input); }
    finally { finish(); }
  }

  async enqueueWork(input: {
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
  }): Promise<DistributedPendingWork> {
    return enqueueDistributedWork(this, input);
  }

  async invokePeer(input: {
    readonly admission?: DistributedWorkAdmission | undefined;
    readonly peerId: string;
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
  }): Promise<{ work: DistributedPendingWork; completed: boolean }> {
    return invokeDistributedPeer(this, input);
  }

  async authenticatePeerToken(tokenValue: string, remoteAddress?: string): Promise<DistributedPeerAuth | null> {
    return authenticateDistributedPeerToken(this, tokenValue, remoteAddress);
  }

  async heartbeatPeer(
    auth: DistributedPeerAuth,
    input: {
      readonly remoteAddress?: string | undefined;
      readonly capabilities?: readonly string[] | undefined;
      readonly commands?: readonly string[] | undefined;
      readonly version?: string | undefined;
      readonly clientMode?: string | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    } = {},
  ): Promise<DistributedPeerRecord> {
    const peer = this.peers.get(auth.peer.id);
    const changing = !peer || this.peers.changing(peer.id, { ...peer, status: 'connected',
      lastRemoteAddress: input.remoteAddress ?? peer.lastRemoteAddress,
      capabilities: input.capabilities ?? peer.capabilities, commands: input.commands ?? peer.commands,
      version: input.version ?? peer.version, clientMode: input.clientMode ?? peer.clientMode,
      metadata: { ...peer.metadata, ...(input.metadata ?? {}) } });
    const finish = changing ? this.beginPeerMutation(auth.peer.id) : () => {};
    try { return await heartbeatDistributedPeer(this, auth, input); }
    finally { finish(); }
  }

  async claimWork(
    auth: DistributedPeerAuth,
    input: {
      readonly maxItems?: number | undefined;
      readonly leaseMs?: number | undefined;
    } = {},
  ): Promise<DistributedPendingWork[]> {
    return claimDistributedWork(this, auth, input);
  }

  async completeWork(
    auth: DistributedPeerAuth,
    workId: string,
    input: {
      readonly status?: 'completed' | 'failed' | 'cancelled' | undefined;
      readonly result?: unknown | undefined;
      readonly error?: string | undefined;
      readonly telemetry?: DistributedPendingWork['telemetry'] | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    } = {},
  ): Promise<DistributedPendingWork | null> {
    return completeDistributedWork(this, auth, workId, input);
  }

  async cancelWork(
    workId: string,
    input: {
      readonly actor?: string | undefined;
      readonly reason?: string | undefined;
    } = {},
  ): Promise<DistributedPendingWork | null> {
    return cancelDistributedWork(this, workId, input);
  }
}
