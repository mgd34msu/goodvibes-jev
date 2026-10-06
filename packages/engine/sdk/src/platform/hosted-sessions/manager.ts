import { createHash } from 'node:crypto';
import { captureNativeConversationContinuation, canonicalNativeConversationContinuation, type NativeConversationContinuation } from '../workflow/work-ledger/native-continuation-context.js';
import { readNativeConversationTurnPermit, type NativeConversationTurnPermit } from '../workflow/work-ledger/native-intake-client.js';
/**
 * manager.ts, the hosted-session engine: lifecycle, policy, durability.
 *
 * ── What a hosted session is ───────────────────────────────────────────────
 *
 * The same conversation loop a terminal runs, composed inside the daemon: the
 * real Orchestrator, the real tool registry rooted at a workspace, the product's
 * own permission manager with its trust gate. session-runtime.ts builds one;
 * workspace-floor.ts shares what a workspace's sessions have in common; this
 * file owns their lives.
 *
 * ── Detach is a policy, and its default preserves what people expect ───────
 *
 * When the last attached client goes away, the effective policy decides: `kill`
 * (the default, and what every surface has always done) terminates the session
 * with the reason `detached`; `survive` leaves it idle and reattachable. The
 * default is the SETTING `hostedSessions.detachPolicy`, and a session may carry
 * its own override chosen at creation. The capability lands; the familiar
 * behavior stays the default.
 *
 * ── Streaming ──────────────────────────────────────────────────────────────
 *
 * Token deltas, tool calls and turn transitions do NOT need a new channel. The
 * Orchestrator already emits them on the runtime bus, stamped with this
 * session's id, and the control-plane SSE stream already forwards every runtime
 * domain a client subscribed to. A client attached to a hosted session watches
 * `turn` and `tools` exactly as it would locally, and filters on the session id
 * it was handed.
 * Native sessions retain those original envelopes in the gateway's existing
 * bounded replay ring even before the first client learns their session id.
 *
 * What was genuinely missing is LIFECYCLE: which hosted sessions exist, when
 * one was created, attached, detached or terminated, and why. That is this
 * engine's own channel (`hosted-session-update`, domain `session`).
 *
 * ── Restart ────────────────────────────────────────────────────────────────
 *
 * A daemon restart is reconciled honestly, never silently. Every restored
 * session is either resumable, restored idle, with a system line in its
 * transcript saying its turn was interrupted, or it is terminated with a named
 * reason. Nothing comes back pretending it never stopped, and nothing
 * disappears without a record.
 */

import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { AnyRuntimeEvent, RuntimeEventBus, RuntimeEventEnvelope } from '../runtime/events/index.js';
import type { SessionLiveTurnControls } from '../control-plane/routes/session-runtime.js';
import { resolveHostedModelDefinition } from './model-route.js';
import { createHostedSessionRuntime, newHostedSessionId, type HostedSessionContractSink, type HostedSessionRuntime } from './session-runtime.js';
import type { HostedContractRunners } from '../contract/operator-service.js';
import { HostedWorkspaceFloors, type HostedWorkspaceFloorFactory, type HostedWorkspaceFloorLease } from './workspace-floor.js';
import { HostedSessionStore, type HostedSessionLoadReport } from './store.js';
import { HostedSessionSpineIntake, type HostedSessionSpine } from './spine-intake.js';
import {
  HOSTED_ATTACHMENT_DEFAULT_LEASE_MS,
  HostedSessionAttachments,
  attachmentSweepIntervalFor,
  clampAttachmentLease,
} from './attachments.js';
export type { HostedSessionSpine } from './spine-intake.js';
import { HostedSessionArgumentError, HostedSessionLimitError, HostedSessionNotFoundError, HostedSessionUnavailableError } from './errors.js';
export { HostedSessionArgumentError, HostedSessionLimitError, HostedSessionNotFoundError, HostedSessionUnavailableError } from './errors.js';
import type {
  CreateHostedSessionInput,
  HostedDetachPolicy,
  HostedSessionHistoryMessage,
  HostedSessionLifecycleEvent,
  HostedSessionRecord,
  HostedSessionTerminationReason,
  HostedSessionUpdatePayload,
} from './types.js';

/** The wire event every hosted-session lifecycle notice is published on. */
export const HOSTED_SESSION_WIRE_EVENT = 'hosted-session-update';

/** The subset of the control-plane gateway this engine publishes through. */
export interface HostedSessionEventPublisher {
  publishEvent(event: string, payload: unknown, filter?: { clientId?: string }): void;
  /** Retention only: native turn frames can precede the first attached reader. */
  retainRuntimeEvent?(domain: 'turn' | 'tools', envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>): void;
  /**
   * Live control-plane clients, when the publisher is the gateway. Read as the
   * second renewal signal for an attachment lease, see ./attachments.ts.
   */
  listClients?(): readonly { readonly id: string }[];
}

/** The live settings this engine reads. Read on every use, never cached. */
export interface HostedSessionSettings {
  /** `hostedSessions.detachPolicy`, the default when a session carries no override. */
  detachPolicy(): HostedDetachPolicy;
  /** `hostedSessions.maxSessions`, the cap on LIVE (non-terminated) sessions. */
  maxSessions(): number;
  /** `hostedSessions.attachmentTtlMs`, how long an attachment stands unrenewed. */
  attachmentTtlMs?(): number;
}

/** Per-session live-turn registration, so the session verbs can reach a hosted turn. */
export interface HostedLiveTurnRegistry {
  bindSession(sessionId: string, controls: SessionLiveTurnControls): void;
  unbindSession(sessionId: string, controls: SessionLiveTurnControls): void;
}

export interface HostedSessionManagerOptions {
  readonly floorFactory: HostedWorkspaceFloorFactory;
  /** Fences and drains native dispatch ownership before runtime teardown. */
  readonly closeNativeTurns?: (() => Promise<void>) | undefined;
  readonly store: HostedSessionStore;
  readonly settings: HostedSessionSettings;
  /** The runtime bus turn events are observed on, the daemon's own. */
  readonly runtimeBus: RuntimeEventBus;
  /** The base system prompt for a hosted turn, per session. */
  readonly systemPrompt: (input: { readonly sessionId: string; readonly workspaceRoot: string }) => string;
  /** Registers each hosted session's live-turn controls; omitted ⇒ the session verbs cannot reach hosted turns. */
  readonly liveTurns?: HostedLiveTurnRegistry | undefined;
  /** The shared session broker, so hosted sessions appear in `sessions.list`. */
  readonly spine?: HostedSessionSpine | undefined;
  /** Whether a workspace root is acceptable. Omitted ⇒ any absolute path. */
  readonly isWorkspaceUsable?: ((workspaceRoot: string) => boolean) | undefined;
  /**
   * How often queued inputs are collected and each live session's participant
   * heartbeat is refreshed. Default 750ms, the same order as every other
   * inbound-dispatch client here, and the reason a steer reaches a hosted turn
   * in well under a second rather than on some slower sweep.
   */
  readonly intakeIntervalMs?: number | undefined;
  /** Clock seam for tests. */
  readonly now?: (() => number) | undefined;
  /** How often lapsed attachments are swept. Omitted ⇒ see attachmentSweepIntervalFor. */
  readonly attachmentSweepIntervalMs?: number | undefined;
}

/** What `attach` hands back: the record plus the history a client renders. */
export interface HostedSessionAttachment {
  readonly session: HostedSessionRecord;
  readonly history: readonly HostedSessionHistoryMessage[];
}

interface LiveSession {
  record: HostedSessionRecord;
  /** Composed on demand: a restored session has none until it is attached or driven. */
  runtime: HostedSessionRuntime | null;
  lease: HostedWorkspaceFloorLease | null;
  /** Restored conversation payload, replayed when the runtime is composed. */
  restoredConversation: unknown;
  readonly attached: HostedSessionAttachments;
}

const RESTART_NOTICE = 'This session was interrupted by a daemon restart. The turn that was running did not finish.';

export class HostedSessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly floors: HostedWorkspaceFloors;
  private readonly now: () => number;
  private publisher: HostedSessionEventPublisher | null = null;
  private alerter: ((text: string) => void) | null = null;
  private busUnsubscribers: (() => void)[] = [];
  private disposed = false;
  private lastLoadReport: HostedSessionLoadReport | null = null;
  /** The spine half: registration, heartbeats, and collecting queued inputs. */
  private readonly spine: HostedSessionSpineIntake;
  /** Sweeps attachments whose lease ran out, see ./attachments.ts. */
  private attachmentTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: HostedSessionManagerOptions) {
    this.floors = new HostedWorkspaceFloors(options.floorFactory);
    this.now = options.now ?? ((): number => Date.now());
    this.spine = new HostedSessionSpineIntake({
      ...(options.spine === undefined ? {} : { spine: options.spine }),
      ...(options.intakeIntervalMs === undefined ? {} : { intervalMs: options.intakeIntervalMs }),
      liveSessions: () => this.list(),
      deliver: (sessionId, text, correlationId) => this.deliver(sessionId, text, correlationId),
      now: () => this.now(),
      alertOwner: (text) => this.alerter?.(text),
    });
  }

  /** Where an incident nobody is attached to see goes. Wired by the daemon. */
  setOwnerAlerter(alerter: ((text: string) => void) | null): void {
    this.alerter = alerter;
  }

  /** The configured attachment lease, clamped. Read live, never cached. */
  private attachmentLeaseMs(): number {
    return clampAttachmentLease(this.options.settings.attachmentTtlMs?.(), HOSTED_ATTACHMENT_DEFAULT_LEASE_MS);
  }

  /** Where lifecycle notices go. Wired by the composition that owns the gateway. */
  setEventPublisher(publisher: HostedSessionEventPublisher | null): void {
    this.publisher = publisher;
  }

  /**
   * Restore from disk and reconcile. Returns the load report so the caller can
   * state what happened rather than leaving it in a log line.
   */
  async init(): Promise<HostedSessionLoadReport> {
    const report = await this.options.store.load(this.now());
    this.lastLoadReport = report;
    for (const persisted of report.restored) {
      const restored = this.reconcileRestored(persisted.record);
      this.sessions.set(restored.record.id, {
        record: restored.record,
        runtime: null,
        lease: null,
        restoredConversation: persisted.conversation,
        attached: new HostedSessionAttachments(),
      });
      if (restored.terminated) {
        // Persist the reconciliation so the next restart does not repeat it.
        await this.persist(restored.record);
      }
      this.publish(restored.terminated ? 'hosted-session-terminated' : 'hosted-session-restored', restored.record, {
        detail: restored.detail,
      });
    }
    this.observeTurnEvents();
    this.spine.start();
    this.startAttachmentSweep();
    if (report.rejected.length > 0 || report.swept.length > 0 || report.evicted.length > 0) {
      logger.info('[hosted-sessions] restored persisted sessions', {
        restored: report.restored.length,
        rejected: report.rejected.length,
        swept: report.swept.length,
        evicted: report.evicted.length,
        rejectedFiles: report.rejected.map((entry) => `${entry.file}: ${entry.reason}`),
      });
    }
    return report;
  }

  /** The last load report, for status surfaces. Null before `init`. */
  loadReport(): HostedSessionLoadReport | null {
    return this.lastLoadReport;
  }

  /**
   * Decide what a record restored from disk becomes.
   *
   * A session that was alive when the process stopped is resumable only when
   * its effective policy says it should have survived. Anything else is
   * terminated with the reason that actually applies.
   */
  private reconcileRestored(record: HostedSessionRecord): {
    record: HostedSessionRecord;
    terminated: boolean;
    detail: string;
  } {
    const at = this.now();
    if (record.status === 'terminated') {
      return { record: { ...record, restoredFromDisk: true }, terminated: false, detail: 'already terminated' };
    }
    const effective = this.effectivePolicy(record.detachPolicy);
    if (effective === 'kill') {
      return {
        record: {
          ...record,
          status: 'terminated',
          terminatedAt: at,
          terminatedReason: 'daemon-shutdown',
          attachedClients: [],
          effectiveDetachPolicy: effective,
          updatedAt: at,
          restoredFromDisk: true,
        },
        terminated: true,
        detail: 'the daemon restarted and this session\'s detach policy is kill',
      };
    }
    return {
      record: {
        ...record,
        status: 'idle',
        attachedClients: [],
        effectiveDetachPolicy: effective,
        updatedAt: at,
        restoredFromDisk: true,
      },
      terminated: false,
      detail: record.status === 'running' ? 'restored idle; its in-flight turn did not survive the restart' : 'restored idle',
    };
  }

  /** The policy that applies to a session right now. */
  private effectivePolicy(override: HostedDetachPolicy | null): HostedDetachPolicy {
    return override ?? this.options.settings.detachPolicy();
  }

  /** Every hosted session, newest first. Terminated ones only when asked for. */
  list(options?: { readonly includeTerminated?: boolean | undefined }): readonly HostedSessionRecord[] {
    const includeTerminated = options?.includeTerminated === true;
    return [...this.sessions.values()]
      .map((live) => this.refreshEffective(live))
      .filter((record) => includeTerminated || record.status !== 'terminated')
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** One record, or null. */
  get(sessionId: string): HostedSessionRecord | null {
    const live = this.sessions.get(sessionId);
    return live ? this.refreshEffective(live) : null;
  }

  /** Whether this engine hosts a live (non-terminated) session with this id. */
  hosts(sessionId: string): boolean {
    const live = this.sessions.get(sessionId);
    return live !== undefined && live.record.status !== 'terminated';
  }

  /** What a session's loop reports about its contracts (session-contracts.ts): the record lists them, and a line said is persisted and announced. */
  private sessionContracts(sessionId: string): HostedSessionContractSink {
    const change = (update: (record: HostedSessionRecord) => HostedSessionRecord, event: HostedSessionLifecycleEvent, detail: string): void => {
      const live = this.sessions.get(sessionId);
      if (!live || live.record.status === 'terminated') return;
      live.record = update({ ...live.record, updatedAt: this.now() });
      this.publish(event, live.record, { detail });
      void this.persist(live.record);
    };
    return {
      contractIds: () => this.sessions.get(sessionId)?.record.contractIds ?? [],
      started: (contractId) => change((record) => ({ ...record, contractIds: [...record.contractIds, contractId] }), 'hosted-session-contract-started', contractId),
      said: (line) => change((record) => ({ ...record, messageCount: this.sessions.get(sessionId)?.runtime?.conversation.getMessageCount() ?? record.messageCount }), 'hosted-session-contract-notice', line),
    };
  }

  /** The contracts operator surface's view of this engine (contract/operator-service.ts): every floor's runner, and a live session's. */
  contractRunners(): HostedContractRunners {
    return {
      runners: () => this.floors.floors().map((floor) => floor.contractRunner),
      forSession: async (sessionId) => {
        const live = this.sessions.get(sessionId);
        if (!live || live.record.status === 'terminated') return null;
        await this.ensureComposed(live);
        return live.lease ? { runner: live.lease.floor.contractRunner, workspaceRoot: live.record.workspaceRoot } : null;
      },
    };
  }

  /** The live-turn controls for a hosted session, when its loop is composed. */
  liveTurnControls(sessionId: string): SessionLiveTurnControls | null {
    return this.sessions.get(sessionId)?.runtime?.liveTurnControls ?? null;
  }

  private refreshEffective(live: LiveSession): HostedSessionRecord {
    const effective = this.effectivePolicy(live.record.detachPolicy);
    if (effective !== live.record.effectiveDetachPolicy) {
      live.record = { ...live.record, effectiveDetachPolicy: effective };
    }
    return live.record;
  }

  /** Create a hosted session and compose its loop. */
  async create(input: CreateHostedSessionInput, ownership?: { readonly nativeConversation: true }): Promise<HostedSessionRecord> {
    this.assertUsable();
    const workspaceRoot = this.requireWorkspace(input.workspaceRoot);
    const liveCount = this.list().length;
    const maxSessions = this.options.settings.maxSessions();
    if (liveCount >= maxSessions) {
      throw new HostedSessionLimitError(
        `This daemon already hosts ${liveCount} sessions, the configured maximum (hostedSessions.maxSessions). Kill one, or raise the setting.`,
      );
    }

    const sessionId = newHostedSessionId();
    const lease = await this.floors.acquire(workspaceRoot);
    let record: HostedSessionRecord;
    try {
      const model = input.modelId
        ? resolveHostedModelDefinition(lease.floor.services.providerRegistry, input.modelId)
        : undefined;
      const at = this.now();
      const runtime = createHostedSessionRuntime({
        sessionId, workspaceRoot, floor: lease.floor,
        systemPrompt: this.options.systemPrompt({ sessionId, workspaceRoot }),
        ...(model === undefined ? {} : { model }),
        ...(input.originSurface ? { originSurface: input.originSurface } : {}),
        contracts: this.sessionContracts(sessionId),
      });
      record = {
        id: sessionId,
        ...(ownership?.nativeConversation ? { nativeConversation: true as const } : {}),
        workspaceRoot,
        title: input.title?.trim() || defaultTitle(input, workspaceRoot),
        status: 'idle',
        detachPolicy: input.detachPolicy ?? null,
        effectiveDetachPolicy: this.effectivePolicy(input.detachPolicy ?? null),
        attachedClients: input.clientId ? [input.clientId] : [],
        ...(model ? { providerId: model.provider, modelId: model.registryKey } : {}),
        createdAt: at, updatedAt: at, turnCount: 0, messageCount: 0,
        restoredFromDisk: false,
        ...(input.originSurface ? { originSurface: input.originSurface } : {}),
        contractIds: [],
      };
      const live: LiveSession = {
        record,
        runtime,
        lease,
        restoredConversation: null,
        attached: new HostedSessionAttachments(),
      };
      if (input.clientId) live.attached.renew(input.clientId, at, this.attachmentLeaseMs());
      this.sessions.set(sessionId, live);
      this.options.liveTurns?.bindSession(sessionId, runtime.liveTurnControls);
    } catch (error) {
      lease.release();
      throw error;
    }

    await this.spine.register(record);
    if (ownership?.nativeConversation) {
      const live = this.requireLive(sessionId);
      try { await this.options.store.save(record, live.runtime?.conversation.toJSON() ?? null, { durable: true }); }
      catch (error) {
        await this.terminate(live, 'killed', 'Native session initialization durability failed').catch(() => {});
        throw error;
      }
    } else await this.persist(record);
    this.publish('hosted-session-created', record, { ...(input.clientId ? { clientId: input.clientId } : {}) });

    if (input.initialPrompt && input.initialPrompt.trim().length > 0) {
      // Not awaited: create returns the record, and the turn's progress is on
      // the event stream. A failure is recorded on the session, never dropped.
      void this.deliver(sessionId, input.initialPrompt).catch(() => undefined);
    }
    return record;
  }

  /**
   * Attach a client. Composes the loop when the session came back from disk,
   * and hands back the history so the client can render what it missed.
   */
  async attach(
    sessionId: string,
    clientId: string,
    options?: { readonly leaseMs?: number | undefined },
  ): Promise<HostedSessionAttachment> {
    const live = this.requireLive(sessionId);
    await this.ensureComposed(live);
    // Attaching again is how a client renews: the call was always idempotent,
    // and this is the same "polling renews the lease" shape the rewind host
    // registration uses. See ./attachments.ts.
    live.attached.renew(clientId, this.now(), clampAttachmentLease(options?.leaseMs, this.attachmentLeaseMs()));
    live.record = {
      ...live.record,
      attachedClients: live.attached.clientIds(),
      updatedAt: this.now(),
    };
    this.publish('hosted-session-attached', live.record, { clientId });
    return { session: live.record, history: this.history(live) };
  }

  /**
   * Detach a client and apply the policy when it was the last one.
   *
   * Returns the record as it stands afterwards, terminated when the policy
   * said kill, idle and reattachable when it said survive.
   */
  async detach(sessionId: string, clientId: string): Promise<HostedSessionRecord> {
    const live = this.requireKnown(sessionId);
    live.attached.delete(clientId);
    live.record = { ...live.record, attachedClients: live.attached.clientIds(), updatedAt: this.now() };
    this.publish('hosted-session-detached', live.record, { clientId });
    if (live.attached.size > 0 || live.record.status === 'terminated') {
      await this.persist(live.record);
      return live.record;
    }
    const policy = this.effectivePolicy(live.record.detachPolicy);
    if (policy === 'kill') {
      return await this.terminate(live, 'detached', 'the last client detached and the effective policy is kill');
    }
    live.record = { ...live.record, effectiveDetachPolicy: policy };
    await this.persist(live.record);
    return live.record;
  }

  /** Begin expiring attachments nobody renewed. Idempotent. */
  private startAttachmentSweep(): void {
    if (this.attachmentTimer) return;
    const interval = this.options.attachmentSweepIntervalMs ?? attachmentSweepIntervalFor(this.attachmentLeaseMs());
    this.attachmentTimer = setInterval(() => { void this.reapAttachments(); }, interval);
    (this.attachmentTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * One sweep. A lapsed attachment goes through `detach` rather than being
   * removed quietly: the client did leave, it just never said so, and the
   * session's own policy decides whether that ends it. Public so a test can
   * drive it without waiting on a timer.
   */
  async reapAttachments(): Promise<void> {
    const publisher = this.publisher;
    const connected = publisher?.listClients
      ? (clientId: string): boolean => publisher.listClients!().some((client) => client.id === clientId)
      : undefined;
    for (const live of [...this.sessions.values()]) {
      if (live.record.status === 'terminated') continue;
      for (const clientId of live.attached.expire(this.now(), this.attachmentLeaseMs(), connected)) {
        logger.info('[hosted-sessions] an attachment lapsed without renewal; treating it as a detach', {
          sessionId: live.record.id,
          clientId,
        });
        await this.detach(live.record.id, clientId).catch(() => undefined);
      }
    }
  }

  /** End a hosted session on request. */
  async kill(sessionId: string, reason: HostedSessionTerminationReason = 'killed'): Promise<HostedSessionRecord> {
    const live = this.requireKnown(sessionId);
    if (live.record.status === 'terminated') return live.record;
    return await this.terminate(live, reason, 'terminated on request');
  }

  /**
   * Drive a turn on a hosted session: the path `sessions.steer` /
   * `sessions.followUp` reach, and the one `create`'s initial prompt uses.
   */
  async deliver(sessionId: string, text: string, correlationId?: string): Promise<void> {
    const live = this.requireLive(sessionId);
    await this.ensureComposed(live);
    const runtime = live.runtime;
    if (!runtime) throw new HostedSessionUnavailableError(sessionId, 'its loop could not be composed');
    try {
      await runtime.submit(text, correlationId);
    } finally {
      live.record = {
        ...live.record,
        messageCount: runtime.conversation.getMessageCount(),
        updatedAt: this.now(),
      };
      await this.persist(live.record);
    }
  }

  /** Dedicated native path: exact broker input, real permit, no ordinary queue/retry. */
  async deliverNative(sessionId: string, inputId: string, permit: NativeConversationTurnPermit): Promise<void> {
    const source = readNativeConversationTurnPermit(permit);
    const live = this.requireLive(sessionId);
    await this.ensureComposed(live);
    const input = this.options.spine?.getInputsSince(sessionId, {}).find(value => value.id === inputId);
    if (!input || input.state !== 'delivered' || input.body !== source.text || input.correlationId !== `session-input:${inputId}`
      || JSON.stringify(input.metadata?.['nativeConversation']) !== JSON.stringify({ projectId: source.projectId, requestId: source.requestId, sourceRef: source.sourceRef })
      || !live.runtime) throw new Error('Native hosted broker identity mismatch');
    if (source.continuation) {
      if (source.continuation.sessionId !== sessionId) throw new Error('Native continuation session mismatch');
      this.assertNativeContinuation(source.continuation);
    }
    if (!this.nativeCheckpoints.has(sessionId)) this.checkpointNative(live);
    await live.runtime.submitNative(permit, input.id, input.correlationId);
    live.record = { ...live.record, messageCount: live.runtime.conversation.getMessageCount(), updatedAt: this.now() };
    // Unlike ordinary best-effort persistence, this failure prevents a completion receipt.
    await this.options.store.save(live.record, live.runtime.conversation.toJSON(), { durable: true });
    if (!live.runtime.isRunning()) {
      try { this.checkpointNative(live); }
      catch { this.nativeCheckpoints.set(sessionId, null); }
    }
  }

  /** Native owner cancellation interrupts only its exact hosted session. */
  cancelNative(sessionId: string, permit: NativeConversationTurnPermit): void { this.sessions.get(sessionId)?.runtime?.cancelNative(permit); }

  /** The conversation as a client renders it. Empty for a session with no loop yet. */
  /** Only completed, durably stored turn checkpoints may become admission context. */
  private readonly nativeCheckpoints = new Map<string, NativeConversationContinuation | null>();
  private readonly nativeCheckpointWrites = new Map<string, { readonly context: NativeConversationContinuation; readonly done: Promise<void> }>();

  private snapshotNative(live: LiveSession): NativeConversationContinuation {
    const messages = this.history(live);
    const revision = createHash('sha256').update(canonicalNativeConversationContinuation(live.record.id, messages)).digest('hex');
    const context = captureNativeConversationContinuation({ sessionId: live.record.id, revision, messages });
    return context;
  }

  private checkpointNative(live: LiveSession): NativeConversationContinuation {
    const context = this.snapshotNative(live);
    this.nativeCheckpoints.set(live.record.id, context);
    this.nativeCheckpointWrites.delete(live.record.id);
    return context;
  }

  /** The terminal event precedes the next queued user append. Snapshot there. */
  private captureCompletedNativeCheckpoint(live: LiveSession): void {
    if (!live.runtime || (!live.record.nativeConversation && !this.nativeCheckpoints.has(live.record.id))) return;
    let context: NativeConversationContinuation;
    try { context = this.snapshotNative(live); }
    catch {
      this.nativeCheckpointWrites.delete(live.record.id);
      this.nativeCheckpoints.set(live.record.id, null);
      return;
    }
    const sessionId = live.record.id;
    const transcript: unknown = structuredClone(live.runtime.conversation.toJSON());
    let checkpoint!: { readonly context: NativeConversationContinuation; readonly done: Promise<void> };
    const write = this.options.store.save(live.record, transcript, { durable: true }).then(() => {
      if (this.nativeCheckpointWrites.get(sessionId) === checkpoint) this.nativeCheckpoints.set(sessionId, context);
    }, error => {
      if (this.nativeCheckpointWrites.get(sessionId) === checkpoint) this.nativeCheckpoints.set(sessionId, null);
      throw error;
    });
    checkpoint = { context, done: write };
    this.nativeCheckpointWrites.set(sessionId, checkpoint);
    void write.catch(() => {});
  }

  async captureNativeContinuation(sessionId: string): Promise<NativeConversationContinuation> {
    const live = this.requireLive(sessionId);
    await this.ensureComposed(live);
    if (live.runtime?.isRunning()) {
      const pending = this.nativeCheckpointWrites.get(sessionId);
      const previous = pending?.context ?? this.nativeCheckpoints.get(sessionId);
      if (!previous) throw new Error('Native continuation completed checkpoint unavailable');
      await pending?.done;
      this.assertNativeContinuation(previous);
      return captureNativeConversationContinuation(previous);
    }
    // Ordinary completed inputs may have appended since the preceding native
    // checkpoint. Freeze and durably publish the complete idle transcript now;
    // an appended new turn does not rewrite this submission-time snapshot.
    const context = this.snapshotNative(live);
    const completionAtCapture = this.nativeCheckpointWrites.get(sessionId);
    await this.options.store.save(live.record, live.runtime?.conversation.toJSON() ?? null, { durable: true });
    this.assertNativeContinuation(context);
    if (this.nativeCheckpointWrites.get(sessionId) === completionAtCapture) this.nativeCheckpoints.set(sessionId, context);
    return context;
  }

  assertNativeContinuation(value: NativeConversationContinuation): void {
    const context = captureNativeConversationContinuation(value);
    const live = this.requireLive(context.sessionId);
    if (!live.runtime || createHash('sha256').update(canonicalNativeConversationContinuation(context.sessionId, context.messages, context.selectedDiff)).digest('hex') !== context.revision) {
      throw new Error('Native continuation context changed');
    }
    const current = this.history(live);
    if (current.length < context.messages.length || context.messages.some((message, index) =>
      message.role !== current[index]?.role || message.content !== current[index]?.content)) throw new Error('Native continuation prefix changed');
  }

  /** Host FIFO waits for actual runtime ownership, never ordinary queue acceptance. */
  async waitForNativeAvailability(sessionId: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const live = this.requireLive(sessionId);
      await this.ensureComposed(live);
      signal.throwIfAborted();
      if (live.runtime && !live.runtime.isRunning() && !live.runtime.orchestrator.isThinking
        && live.runtime.liveTurnControls.listQueuedMessages().length === 0) return;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 20);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  }

  private history(live: LiveSession): readonly HostedSessionHistoryMessage[] {
    const conversation = live.runtime?.conversation;
    if (!conversation) return [];
    return conversation.getMessageSnapshot().map((message) => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    }));
  }

  /** Read a hosted session's history without attaching. */
  historyOf(sessionId: string): readonly HostedSessionHistoryMessage[] {
    const live = this.sessions.get(sessionId);
    return live ? this.history(live) : [];
  }

  /** Compose a restored session's loop on first use, replaying its transcript. */
  private async ensureComposed(live: LiveSession): Promise<void> {
    if (live.runtime) return;
    if (live.record.status === 'terminated') {
      throw new HostedSessionUnavailableError(live.record.id, `it is terminated (${live.record.terminatedReason ?? 'no reason recorded'})`);
    }
    const workspaceRoot = live.record.workspaceRoot;
    const lease = await this.floors.acquire(workspaceRoot);
    try {
      const model = live.record.modelId
        ? resolveHostedModelDefinition(lease.floor.services.providerRegistry, live.record.modelId)
        : undefined;
      const runtime = createHostedSessionRuntime({
        sessionId: live.record.id, workspaceRoot, floor: lease.floor,
        systemPrompt: this.options.systemPrompt({ sessionId: live.record.id, workspaceRoot }),
        ...(model === undefined ? {} : { model }),
        // Rebuilding as the host would move client-owned settings mid-life.
        ...(live.record.originSurface ? { originSurface: live.record.originSurface } : {}),
        contracts: this.sessionContracts(live.record.id),
      });
      this.replayConversation(live, runtime);
      live.runtime = runtime;
      live.lease = lease;
      this.options.liveTurns?.bindSession(live.record.id, runtime.liveTurnControls);
      live.record = {
        ...live.record,
        restoredFromDisk: false,
        messageCount: runtime.conversation.getMessageCount(),
        updatedAt: this.now(),
      };
    } catch (error) {
      lease.release();
      // A session whose loop cannot be rebuilt is terminated with that reason,
      // not left in a state that looks alive and answers nothing.
      await this.terminate(live, 'restart-unresumable', `its loop could not be rebuilt: ${summarizeError(error)}`);
      throw error;
    }
  }

  private replayConversation(live: LiveSession, runtime: HostedSessionRuntime): void {
    const payload = live.restoredConversation;
    if (!payload || typeof payload !== 'object') return;
    try {
      runtime.conversation.fromJSON(payload as Parameters<typeof runtime.conversation.fromJSON>[0]);
      if (live.record.status !== 'terminated') {
        runtime.conversation.addSystemMessage(RESTART_NOTICE);
      }
    } catch (error) {
      logger.warn('[hosted-sessions] a restored transcript could not be replayed; the session resumes empty', {
        sessionId: live.record.id,
        error: summarizeError(error),
      });
    } finally {
      live.restoredConversation = null;
    }
  }

  /**
   * Take a session's loop apart, keeping its transcript.
   *
   * The capture is the load-bearing half: `persist` reads the conversation off
   * the live runtime, so disposing first and persisting after would write an
   * empty transcript over a real one, a session that came back from a restart
   * with nothing in it, which is the silent loss this engine exists to avoid.
   */
  private teardownRuntime(live: LiveSession): void {
    if (live.runtime) {
      live.restoredConversation = live.runtime.conversation.toJSON();
      live.runtime.cancel();
      this.options.liveTurns?.unbindSession(live.record.id, live.runtime.liveTurnControls);
      live.runtime.dispose();
      live.runtime = null;
    }
    live.lease?.release();
    live.lease = null;
  }

  private async terminate(
    live: LiveSession,
    reason: HostedSessionTerminationReason,
    detail: string,
  ): Promise<HostedSessionRecord> {
    const at = this.now();
    this.teardownRuntime(live);
    live.attached.clear();
    live.record = {
      ...live.record,
      status: 'terminated',
      attachedClients: [],
      terminatedAt: at,
      terminatedReason: reason,
      updatedAt: at,
    };
    await this.persist(live.record);
    await this.spine.close(live.record.id);
    this.publish('hosted-session-terminated', live.record, { detail });
    return live.record;
  }

  /**
   * Turn transitions, observed on the shared bus and attributed by session id.
   *
   * The engine does not wrap the orchestrator to learn this: the events it
   * already emits are the truth, and reading them keeps one source rather than
   * two that can disagree.
   */
  private observeTurnEvents(): void {
    const bus = this.options.runtimeBus;
    // A native start can submit its turn before the caller learns the session
    // id and opens SSE. Keep the original envelopes in the gateway's bounded
    // replay ring; never re-emit them or invent a render/correlation identity.
    for (const domain of ['turn', 'tools'] as const) {
      this.busUnsubscribers.push(bus.onDomain(domain, (envelope) => {
        if (this.disposed || !envelope.sessionId) return;
        const live = this.sessions.get(envelope.sessionId);
        if (!live?.record.nativeConversation || live.record.status === 'terminated') return;
        this.publisher?.retainRuntimeEvent?.(domain, envelope);
      }));
    }
    const mark = (sessionId: string | undefined, status: 'running' | 'idle', event: HostedSessionLifecycleEvent, detail: string): void => {
      if (!sessionId) return;
      const live = this.sessions.get(sessionId);
      if (!live || live.record.status === 'terminated') return;
      live.record = {
        ...live.record,
        status,
        updatedAt: this.now(),
        ...(status === 'idle'
          ? { turnCount: live.record.turnCount + 1, lastTurnAt: this.now(), messageCount: live.runtime?.conversation.getMessageCount() ?? live.record.messageCount }
          : {}),
      };
      if (status === 'idle' && detail === 'completed') this.captureCompletedNativeCheckpoint(live);
      this.publish(event, live.record, { detail });
      if (status === 'idle') void this.persist(live.record).catch(() => undefined);
    };
    this.busUnsubscribers.push(
      bus.on('TURN_SUBMITTED', (envelope) => mark(envelope.sessionId, 'running', 'hosted-session-turn-started', 'a turn was submitted')),
      bus.on('TURN_COMPLETED', (envelope) => mark(envelope.sessionId, 'idle', 'hosted-session-turn-ended', 'completed')),
      bus.on('TURN_ERROR', (envelope) => mark(envelope.sessionId, 'idle', 'hosted-session-turn-ended', 'errored')),
      bus.on('TURN_CANCEL', (envelope) => mark(envelope.sessionId, 'idle', 'hosted-session-turn-ended', 'cancelled')),
    );
  }

  private publish(
    event: HostedSessionLifecycleEvent,
    session: HostedSessionRecord,
    extra?: { readonly clientId?: string | undefined; readonly detail?: string | undefined },
  ): void {
    const payload: HostedSessionUpdatePayload = {
      event,
      session,
      createdAt: this.now(),
      ...(extra?.clientId === undefined ? {} : { clientId: extra.clientId }),
      ...(extra?.detail === undefined ? {} : { detail: extra.detail }),
    };
    try {
      this.publisher?.publishEvent(HOSTED_SESSION_WIRE_EVENT, payload);
    } catch (error) {
      // Warn, not debug: this channel is the only account of what happened to a
      // session, so a notice that did not go out is a transition nobody saw.
      logger.warn('[hosted-sessions] publishing a lifecycle notice failed', {
        sessionId: session.id,
        error: summarizeError(error),
      });
    }
  }

  private async persist(record: HostedSessionRecord): Promise<void> {
    const live = this.sessions.get(record.id);
    const conversation = live?.runtime ? live.runtime.conversation.toJSON() : live?.restoredConversation ?? null;
    try {
      await this.options.store.save(record, conversation);
    } catch (error) {
      logger.warn('[hosted-sessions] persisting a session failed; it will not survive a restart', {
        sessionId: record.id,
        error: summarizeError(error),
      });
    }
  }

  private requireWorkspace(raw: string): string {
    const workspaceRoot = raw.trim();
    if (!workspaceRoot.startsWith('/')) {
      throw new HostedSessionArgumentError(
        `workspaceRoot must be an absolute path; '${raw}' is not. A relative path would be resolved against the daemon's own directory, which is not where the caller meant.`,
      );
    }
    if (this.options.isWorkspaceUsable && !this.options.isWorkspaceUsable(workspaceRoot)) {
      throw new HostedSessionArgumentError(`workspaceRoot '${workspaceRoot}' is not a directory this daemon can host a session in.`);
    }
    return workspaceRoot;
  }

  private requireKnown(sessionId: string): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live) throw new HostedSessionNotFoundError(sessionId);
    return live;
  }

  private requireLive(sessionId: string): LiveSession {
    const live = this.requireKnown(sessionId);
    if (live.record.status === 'terminated') {
      throw new HostedSessionUnavailableError(sessionId, `it is terminated (${live.record.terminatedReason ?? 'no reason recorded'})`);
    }
    return live;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('The hosted-session engine has been disposed.');
  }

  /**
   * Stop hosting. Every live session is terminated with `daemon-shutdown` and
   * persisted, so the next start reconciles from a record that says what
   * happened rather than from one that claims it is still running.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.spine.stop();
    await this.options.closeNativeTurns?.();
    if (this.attachmentTimer) {
      clearInterval(this.attachmentTimer);
      this.attachmentTimer = null;
    }
    for (const unsubscribe of this.busUnsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // A listener that will not detach must not block shutdown.
      }
    }
    for (const live of [...this.sessions.values()]) {
      if (live.record.status === 'terminated') continue;
      // A survive-policy session is not ended by the daemon stopping. That is
      // the whole claim `survive` makes: outliving the client is the small half,
      // outliving a restart (an update swapping the binary, a reboot) is the
      // half that makes it worth having. Its loop comes down, its transcript is
      // written, and the next start restores it idle with an honest line about
      // the turn that did not finish. A kill-policy session ends here, with the
      // reason that actually applies.
      if (this.effectivePolicy(live.record.detachPolicy) === 'survive') {
        await this.parkForShutdown(live).catch(() => undefined);
        continue;
      }
      await this.terminate(live, 'daemon-shutdown', 'the daemon is stopping').catch(() => undefined);
    }
    await this.floors.dispose();
  }

  /**
   * Park a surviving session across a shutdown: loop down, record kept idle,
   * transcript written.
   */
  private async parkForShutdown(live: LiveSession): Promise<void> {
    this.teardownRuntime(live);
    live.attached.clear();
    live.record = {
      ...live.record,
      status: 'idle',
      attachedClients: [],
      updatedAt: this.now(),
    };
    await this.persist(live.record);
    this.publish('hosted-session-detached', live.record, {
      detail: 'the daemon is stopping; this session survives and is reattachable after the restart',
    });
  }
}

function defaultTitle(input: CreateHostedSessionInput, workspaceRoot: string): string {
  const prompt = input.initialPrompt?.trim();
  if (prompt) return prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
  const leaf = workspaceRoot.replace(/\/+$/, '').split('/').pop();
  return leaf ? `Hosted session in ${leaf}` : 'Hosted session';
}
