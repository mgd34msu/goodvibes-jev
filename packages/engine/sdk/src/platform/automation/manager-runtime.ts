import type { ExternalOperationSource } from '../permissions/external-request.js';
import { captureAutomationSource } from './action-source.js';
import { ConfigManager } from '../config/manager.js';
import { logger } from '../utils/logger.js';
import { createDomainDispatch } from '../runtime/store/index.js';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { AgentManager } from '../tools/agent/index.js';
import { AgentMessageBus } from '../agents/message-bus.js';
import { computeSchedulerCapacity, type SchedulerCapacityReport } from './scheduler-capacity.js';
import { AutomationJobStore } from './store/jobs.js';
import { AutomationRunStore } from './store/runs.js';
import { AutomationJobMap, automationJobRevision, ownedAutomationJob, hasOwnedAutomationRevision, AutomationJobCommitIndeterminateError, AutomationJobMutationStaleError, retainAutomationMutation, type AutomationJobMutationOptions, type RetainedAutomationJobTarget } from './job-mutations.js';
import { types as nodeTypes } from 'node:util';
import { captureOwnedJson } from '../gate/judgment-input.js';
import { isRecord } from '../utils/record-coerce.js';
import { AutomationDeliveryManager } from './delivery-manager.js';
import { RouteBindingManager } from '../channels/index.js';
import type { AutomationJob, ManagedAutomationJob } from './jobs.js';
import type { AutomationCheckinEvaluator } from './checkin-execution.js';
import type { AutomationRun, AutomationRunContinuationMode, AutomationRunTelemetry } from './runs.js';
import type { AutomationRunTrigger, AutomationSurfaceKind } from './types.js';
import { SharedSessionBroker } from '../control-plane/index.js';
import type {
  CreateAutomationJobInput,
  SpawnAutomationTaskInput,
  UpdateAutomationJobInput,
} from './manager-runtime-helpers.js';
import {
  applyFailureToJob as applyAutomationFailureToJob,
  executeAutomationJob,
  resolveAutomationExecution,
  resolveRouteForTarget as resolveAutomationRouteForTarget,
  resolveSharedSessionExecution as resolveAutomationSharedSessionExecution,
  syncExecutionRoute as syncAutomationExecutionRoute,
  toResolvedExecution as toAutomationResolvedExecution,
} from './manager-runtime-execution.js';
import {
  formatExternalContentSource,
  normalizeExternalTelemetry,
  normalizeJobRecord,
  normalizeRunRecord,
  normalizeRunTelemetry,
  normalizeSourceRecord,
  sortJobs,
  sortRuns,
} from './manager-runtime-helpers.js';
import {
  advanceScheduledHeartbeatAutomationJob,
  cancelAutomationTimer,
  queueDueHeartbeatAutomationJobs,
  queueHeartbeatWake,
  scheduleAutomationJob,
  type AutomationHeartbeatWake,
} from './manager-runtime-scheduling.js';
import {
  maybeDeliverAutomationFailureNotice,
  maybeDeliverAutomationRun,
  readAutomationRunTransience,
  scheduleAutomationFailureFollowUp,
  type AutomationFailureFollowUpContext,
} from './manager-runtime-delivery.js';
import {
  emitAutomationManagerJobAutoDisabled,
  emitAutomationManagerJobCreated,
  emitAutomationManagerJobUpdated,
  emitAutomationManagerRunCompleted,
  emitAutomationManagerRunFailed,
  emitAutomationManagerRunQueued,
  emitAutomationManagerRunStarted,
} from './manager-runtime-events.js';
import {
  collectAutomationSources,
  syncAutomationJobToRuntime,
  syncAutomationRunToRuntime,
  syncAutomationRuntimeSnapshot,
} from './manager-runtime-sync.js';
import { reconcileAutomationActiveRuns } from './manager-runtime-reconcile.js';
import { recordAutomationMissedRun } from './manager-runtime-missed.js';
import { summarizeError } from '../utils/error-display.js';
import {
  createAutomationJobRecord,
  toggleAutomationJobEnabled,
  updateAutomationJobRecord,
} from './manager-runtime-job-mutations.js';
import type { FeatureFlagReader } from '../runtime/feature-flags/index.js';
import { isFeatureGateEnabled, requireFeatureGate } from '../runtime/feature-flags/index.js';

const retainedTargetReferences = new WeakMap<RetainedAutomationJobTarget, {
  readonly selected: ManagedAutomationJob;
  readonly job: ManagedAutomationJob;
  readonly jobBytes: string;
  readonly assertCurrent: () => void;
}>();
const nativeSelectedMethods = new Set([
  'automation.jobs.update', 'automation.jobs.enable', 'automation.jobs.disable', 'automation.jobs.delete',
  'automation.schedules.enable', 'automation.schedules.disable', 'automation.schedules.delete',
]);

export function assertRetainedAutomationTargetCurrent(target: RetainedAutomationJobTarget): void {
  const known = retainedTargetReferences.get(target);
  if (!known) throw new AutomationJobMutationStaleError();
  const identity = () => {
    const job = Object.getOwnPropertyDescriptor(target, 'job'), assertion = Object.getOwnPropertyDescriptor(target, 'assertCurrent');
    if (!hasOwnedAutomationRevision(known.selected) || Reflect.ownKeys(target).length !== 2
      || !job || !('value' in job) || job.value !== known.job
      || !assertion || !('value' in assertion) || assertion.value !== known.assertCurrent
      || JSON.stringify(captureOwnedJson(known.job, nodeTypes.isProxy)) !== known.jobBytes) throw new AutomationJobMutationStaleError();
  };
  identity(); known.assertCurrent(); identity();
}

/** Internal native adapter: only the actual retained owner can issue this reference. */
export function projectRetainedAutomationRequest(target: RetainedAutomationJobTarget, method: string, body: unknown): unknown {
  const known = retainedTargetReferences.get(target);
  if (!known || !nativeSelectedMethods.has(method)) throw new AutomationJobMutationStaleError();
  assertRetainedAutomationTargetCurrent(target);
  const captured = captureOwnedJson(body, nodeTypes.isProxy);
  const selector = method.startsWith('automation.schedules.') ? 'scheduleId' : 'jobId';
  if (!isRecord(captured) || captured[selector] !== known.selected.id
    || captured.expectedMutationRevision !== automationJobRevision(known.selected)) throw new AutomationJobMutationStaleError();
  const projected = { ...captured, expectedMutationRevision: { kind: 'selected-native-revision', target: 'selected-automation-target' } };
  assertRetainedAutomationTargetCurrent(target);
  return projected;
}

export type {
  CreateAutomationJobInput,
  UpdateAutomationJobInput,
  SpawnAutomationTaskInput,
} from './manager-runtime-helpers.js';
export type { AutomationHeartbeatWake } from './manager-runtime-scheduling.js';

interface AutomationManagerConfig {
  readonly jobStore?: AutomationJobStore | undefined;
  readonly runStore?: AutomationRunStore | undefined;
  readonly spawnTask?: ((input: SpawnAutomationTaskInput) => string) | undefined;
  readonly cancelTask?: ((agentId: string) => void) | undefined;
  readonly agentStatusProvider?: Pick<AgentManager, 'getStatus'> | undefined;
  readonly runtimeStore?: RuntimeStore | undefined;
  readonly runtimeBus?: RuntimeEventBus | undefined;
  readonly deliveryManager?: AutomationDeliveryManager | undefined;
  readonly configManager: ConfigManager;
  readonly routeBindings: RouteBindingManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly defaultSurfaceKind?: AutomationSurfaceKind | undefined;
  readonly defaultSurfaceId?: string | undefined;
  /**
   * The live provider registry, when the caller has one wired up. Enables
   * bare model id resolution for job `model`/`fallbackModels` fields
   * (unique -> auto-qualify; ambiguous/unknown -> a rich error naming real
   * candidates). Omitted callers keep the prior format-only validation.
   */
  readonly providerRegistry?: Pick<import('../providers/registry.js').ProviderRegistry, 'listModels'> | undefined;
  readonly featureFlags?: FeatureFlagReader | undefined;
}

export interface AutomationHeartbeatResult {
  readonly processed: readonly AutomationRun[];
  readonly failed: readonly {
    readonly jobId: string;
    readonly error: string;
  }[];
  readonly pending: readonly AutomationHeartbeatWake[];
  readonly checkedAt: number;
}

export class AutomationManager {
  static readonly #storeOwnershipMethods = Object.getOwnPropertyDescriptors(AutomationJobStore.prototype);
  static readonly #mapGet = Map.prototype.get;
  static readonly #mapIterator = Map.prototype[Symbol.iterator];
  readonly #retainedTargetOwner: {
    readonly jobs: AutomationJobMap;
    readonly store: AutomationJobStore;
    readonly featureFlags: FeatureFlagReader;
    readonly storeFields: PropertyDescriptorMap;
  };
  private readonly jobStore: AutomationJobStore;
  private readonly runStore: AutomationRunStore;
  private readonly spawnTask?: ((input: SpawnAutomationTaskInput) => string) | undefined;
  private readonly cancelTask?: ((agentId: string) => void) | undefined;
  private readonly agentStatusProvider?: Pick<AgentManager, 'getStatus'> | undefined;
  private readonly configManager: ConfigManager;
  private readonly routeBindings: RouteBindingManager;
  private readonly sessionBroker: SharedSessionBroker;
  private readonly defaultSurfaceKind?: AutomationSurfaceKind | undefined;
  private readonly defaultSurfaceId?: string | undefined;
  private readonly providerRegistry?: Pick<import('../providers/registry.js').ProviderRegistry, 'listModels'> | undefined;
  private readonly jobs = new AutomationJobMap();
  private mutationLifetime = {};
  private readonly runs = new Map<string, AutomationRun>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly heartbeatWakes = new Map<string, AutomationHeartbeatWake>();
  private deliveryManager: AutomationDeliveryManager | null;
  private readonly deliveryInFlight = new Set<string>();
  // Attached post-construction by the CheckinService (attachCheckinEvaluator);
  // runs the briefing→judgment→delivery loop for kind:'checkin' jobs.
  private checkinEvaluator?: AutomationCheckinEvaluator | undefined;
  // runtimeDispatch and runtimeBus are wired lazily via attachRuntime() after
  // construction; null-init here avoids a required-constructor-arg dependency.
  private runtimeDispatch: DomainDispatch | null = null;
  private runtimeBus: RuntimeEventBus | null = null;
  private readonly featureFlags: FeatureFlagReader;
  private loaded = false;
  private running = false;
  private startPromise: Promise<void> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  // Jobs already logged as having no reachable failure-notice target (reported once per job).
  private readonly warnedDeliveryGapJobs = new Set<string>();

  constructor(config: AutomationManagerConfig) {
    this.configManager = config.configManager;
    this.jobStore = config.jobStore ?? new AutomationJobStore({ configManager: this.configManager });
    this.runStore = config.runStore ?? new AutomationRunStore({ configManager: this.configManager });
    this.routeBindings = config.routeBindings;
    this.sessionBroker = config.sessionBroker;
    this.defaultSurfaceKind = config.defaultSurfaceKind;
    this.defaultSurfaceId = config.defaultSurfaceId;
    this.providerRegistry = config.providerRegistry;
    this.agentStatusProvider = config.agentStatusProvider;
    this.spawnTask = config.spawnTask;
    this.cancelTask = config.cancelTask;
    if (config.runtimeStore) {
      this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
    }
    this.runtimeBus = config.runtimeBus ?? null;
    this.deliveryManager = config.deliveryManager ?? null;
    this.featureFlags = config.featureFlags ?? null;
    this.#retainedTargetOwner = { jobs: this.jobs, store: this.jobStore, featureFlags: this.featureFlags,
      storeFields: nodeTypes.isProxy(this.jobStore) ? {} : Object.getOwnPropertyDescriptors(this.jobStore) };
  }

  #assertRetainedTargetOwner() {
    const owner = this.#retainedTargetOwner;
    const jobs = Object.getOwnPropertyDescriptor(this, 'jobs'), store = Object.getOwnPropertyDescriptor(this, 'jobStore');
    const featureFlags = Object.getOwnPropertyDescriptor(this, 'featureFlags');
    if (!jobs || !('value' in jobs) || jobs.value !== owner.jobs || !store || !('value' in store) || store.value !== owner.store
      || !featureFlags || !('value' in featureFlags) || featureFlags.value !== owner.featureFlags
      || nodeTypes.isProxy(owner.jobs) || nodeTypes.isProxy(owner.store)
      || Object.getPrototypeOf(this) !== AutomationManager.prototype
      || Object.getPrototypeOf(owner.jobs) !== AutomationJobMap.prototype
      || Object.getPrototypeOf(owner.store) !== AutomationJobStore.prototype
      || Object.getPrototypeOf(AutomationJobMap.prototype) !== Map.prototype) throw new AutomationJobMutationStaleError();
    for (const [object, prototype, key, original] of [
      [this, AutomationManager.prototype, 'requireEnabled', managerOwnershipMethods.requireEnabled],
      ...['assertCurrent', 'fileIdentity', 'directoryIdentity', 'parentIdentity'].map(key =>
        [owner.store, AutomationJobStore.prototype, key, AutomationManager.#storeOwnershipMethods[key]] as const),
    ] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key) ?? Object.getOwnPropertyDescriptor(prototype, key);
      if (!original || !('value' in original) || !descriptor || !('value' in descriptor) || descriptor.value !== original.value) throw new AutomationJobMutationStaleError();
    }
    const get = Object.getOwnPropertyDescriptor(owner.jobs, 'get') ?? Object.getOwnPropertyDescriptor(AutomationJobMap.prototype, 'get')
      ?? Object.getOwnPropertyDescriptor(Map.prototype, 'get');
    if (!get || !('value' in get) || get.value !== AutomationManager.#mapGet) throw new AutomationJobMutationStaleError();
    for (const key of ['store', 'writes', 'path', 'anchor', 'anchorIdentity', 'parents']) {
      const original = owner.storeFields[key], current = Object.getOwnPropertyDescriptor(owner.store, key);
      if (!original || !('value' in original) || !current || !('value' in current) || current.value !== original.value) throw new AutomationJobMutationStaleError();
    }
    const parents: unknown = owner.storeFields.parents?.value;
    if (!parents || typeof parents !== 'object' || nodeTypes.isProxy(parents) || !nodeTypes.isMap(parents)
      || Object.getPrototypeOf(parents) !== Map.prototype) throw new AutomationJobMutationStaleError();
    const iterator = Object.getOwnPropertyDescriptor(parents, Symbol.iterator) ?? Object.getOwnPropertyDescriptor(Map.prototype, Symbol.iterator);
    if (!iterator || !('value' in iterator) || iterator.value !== AutomationManager.#mapIterator) throw new AutomationJobMutationStaleError();
    if (Object.values(Object.getOwnPropertyDescriptors(owner.store)).some(descriptor => !('value' in descriptor))) throw new AutomationJobMutationStaleError();
    const lifetime = Object.getOwnPropertyDescriptor(this, 'mutationLifetime');
    if (!lifetime || !('value' in lifetime) || !lifetime.value || typeof lifetime.value !== 'object' || nodeTypes.isProxy(lifetime.value)) throw new AutomationJobMutationStaleError();
    return owner;
  }

  private isEnabled(): boolean {
    return isFeatureGateEnabled(this.featureFlags, 'automation-domain');
  }

  private requireEnabled(operation: string): void {
    requireFeatureGate(this.featureFlags, 'automation-domain', operation);
  }

  private requireSpawnTask(): (input: SpawnAutomationTaskInput) => string {
    if (!this.spawnTask) {
      throw new Error('AutomationManager requires an explicit spawnTask callback.');
    }
    return this.spawnTask;
  }

  private requireCancelTask(): (agentId: string) => void {
    if (!this.cancelTask) {
      throw new Error('AutomationManager requires an explicit cancelTask callback.');
    }
    return this.cancelTask;
  }

  private runtimeExecutionContext() {
    return {
      configManager: this.configManager,
      routeBindings: this.routeBindings,
      sessionBroker: this.sessionBroker,
      defaultSurfaceKind: this.defaultSurfaceKind,
      defaultSurfaceId: this.defaultSurfaceId,
      spawnTask: (input: SpawnAutomationTaskInput) => this.requireSpawnTask()(input),
      saveJobs: () => this.saveJobs(),
      saveRuns: () => this.saveRuns(),
      pruneRunHistory: (jobId?: string) => this.pruneRunHistory(jobId),
      activeRunCount: () => this.activeRunCount(),
      maxConcurrentRuns: () => this.maxConcurrentRuns(),
      syncExecutionRoute: (job: AutomationJob, run: AutomationRun) => this.syncExecutionRoute(job, run),
      syncRunToRuntime: (run: AutomationRun, source: string) => this.syncRunToRuntime(run, source),
      syncJobToRuntime: (job: AutomationJob, source: string) => this.syncJobToRuntime(job, source),
      emitRunQueued: (job: AutomationJob, run: AutomationRun) => this.emitRunQueued(job, run),
      emitRunStarted: (job: AutomationJob, run: AutomationRun) => this.emitRunStarted(job, run),
      emitRunCompleted: (job: AutomationJob, run: AutomationRun, outcome: 'success' | 'partial' | 'failed' | 'cancelled') => this.emitRunCompleted(job, run, outcome),
      emitRunFailed: (job: AutomationJob, run: AutomationRun, error: string, retryable: boolean) => emitAutomationManagerRunFailed(this.runtimeBus, job, run, error, retryable),
      maybeDeliverRun: (job: AutomationJob, run: AutomationRun) => this.maybeDeliverRun(job, run),
      applyFailureToJob: (job: AutomationJob, timestamp: number, countRun = true) => this.applyFailureToJob(job, timestamp, countRun),
      jobs: this.jobs,
      runs: this.runs,
      checkinEvaluator: this.checkinEvaluator,
    };
  }

  private jobMutationContext() {
    return {
      configManager: this.configManager,
      jobs: this.jobs,
      commitJob: (previous: AutomationJob | undefined, next: AutomationJob, options?: AutomationJobMutationOptions) => this.commitJob(previous, next, options),
      scheduleJob: (job: AutomationJob) => this.scheduleJob(job),
      syncJobToRuntime: (job: AutomationJob, source: string) => this.syncJobToRuntime(job, source),
      emitJobCreated: (job: AutomationJob) => this.emitJobCreated(job),
      emitJobUpdated: (job: AutomationJob, changedFields: string[]) => this.emitJobUpdated(job, changedFields),
      ...(this.providerRegistry ? { listModels: () => this.providerRegistry!.listModels() } : {}),
    };
  }

  private retainJobMutation(input: unknown, options: AutomationJobMutationOptions): () => void {
    const restrictions = retainAutomationMutation(options), lifetime = this.mutationLifetime;
    const store = this.jobStore, commit = store.commit, ownedInput = JSON.stringify(input);
    const current = () => {
      restrictions();
      this.requireEnabled('mutate automation job');
      if (this.mutationLifetime !== lifetime || this.jobStore !== store || store.commit !== commit || JSON.stringify(input) !== ownedInput) throw new AutomationJobMutationStaleError();
      store.assertCurrent();
    };
    current();
    return current;
  }

  retainJobTarget(jobId: string, expectedMutationRevision: string): RetainedAutomationJobTarget {
    const owner = this.#assertRetainedTargetOwner();
    const selected = this.jobs.get(jobId);
    if (!selected || !hasOwnedAutomationRevision(selected) || automationJobRevision(selected) !== expectedMutationRevision) throw new AutomationJobMutationStaleError();
    const original = JSON.stringify(selected), lifetime = this.mutationLifetime, store = this.jobStore;
    const current = () => {
      if (this.#assertRetainedTargetOwner() !== owner || this.mutationLifetime !== lifetime) throw new AutomationJobMutationStaleError();
      this.requireEnabled('update automation job');
      if (this.#assertRetainedTargetOwner() !== owner || this.mutationLifetime !== lifetime) throw new AutomationJobMutationStaleError();
      store.assertCurrent();
      if (this.#assertRetainedTargetOwner() !== owner || this.mutationLifetime !== lifetime) throw new AutomationJobMutationStaleError();
      if (this.jobStore !== store || this.mutationLifetime !== lifetime || this.jobs.get(jobId) !== selected || JSON.stringify(selected) !== original) throw new AutomationJobMutationStaleError();
    };
    current();
    const job = { ...structuredClone(selected), mutationRevision: expectedMutationRevision };
    const target = { job, assertCurrent: current };
    retainedTargetReferences.set(target, { selected, job, jobBytes: JSON.stringify(captureOwnedJson(job, nodeTypes.isProxy)), assertCurrent: current });
    return target;
  }

  private commitJob(previous: AutomationJob | undefined, next: AutomationJob, options?: AutomationJobMutationOptions): Promise<ManagedAutomationJob>;
  private commitJob(previous: AutomationJob, next: null, options?: AutomationJobMutationOptions): Promise<null>;
  private async commitJob(previous: AutomationJob | undefined, next: AutomationJob | null, options: AutomationJobMutationOptions = {}): Promise<ManagedAutomationJob | null> {
    const jobId = next?.id ?? previous?.id;
    if (!jobId) throw new Error('An automation mutation requires a job id.');
    const restrictions = retainAutomationMutation(options), original = JSON.stringify(previous);
    const candidate = next ? ownedAutomationJob(next) : null;
    const current = () => {
      restrictions();
      if (this.jobs.get(jobId) !== previous || JSON.stringify(previous) !== original) throw new AutomationJobMutationStaleError();
    };
    current();
    try {
      await this.jobStore.commit(jobId, previous ? automationJobRevision(previous) : null, candidate, { signal: options.signal, assertCurrent: current, withPublication: options.withPublication });
      current();
    } catch (error) {
      if (error instanceof AutomationJobCommitIndeterminateError && this.jobs.get(jobId) === previous) {
        // Reconcile the observed bytes, without scheduling or emitting a
        // successful mutation after its authority has gone away.
        const persisted = (await this.jobStore.load()).jobs.find(job => job.id === jobId);
        if (this.jobs.get(jobId) === previous) {
          if (persisted) this.jobs.restore(persisted);
          else this.jobs.delete(jobId);
        }
      }
      throw error;
    }
    if (candidate) this.jobs.publish(candidate);
    else this.jobs.delete(jobId);
    return candidate;
  }

  async start(): Promise<void> {
    if (!this.isEnabled()) {
      this.stop();
      return;
    }
    if (this.running) return;
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.load()
      .then(() => {
        this.running = true;
        this.reconcileActiveRuns();
        this.reconcileTimer = setInterval(() => {
          this.reconcileActiveRuns();
        }, 2_000);
        this.reconcileTimer.unref?.();
        this.reconcileSchedules();
      })
      .finally(() => {
        this.startPromise = null;
      });
    return await this.startPromise;
  }

  stop(): void {
    this.mutationLifetime = {};
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.running = false;
  }

  /**
   * Attach the check-in evaluator that runs when a `kind: 'checkin'` job fires.
   * Called once by the CheckinService after construction (the service needs the
   * manager to schedule the check-in job, so the manager cannot depend on it at
   * construction). Idempotent-ish: the last attached evaluator wins.
   */
  attachCheckinEvaluator(evaluator: AutomationCheckinEvaluator): void {
    this.checkinEvaluator = evaluator;
  }

  attachRuntime(config: {
    readonly runtimeStore?: RuntimeStore | null | undefined;
    readonly runtimeBus?: RuntimeEventBus | null | undefined;
    readonly deliveryManager?: AutomationDeliveryManager | null | undefined;
  }): void {
    if (config.runtimeStore) {
      this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
      this.syncRuntimeSnapshot();
    }
    if (config.runtimeBus) {
      this.runtimeBus = config.runtimeBus;
    }
    if (config.deliveryManager) {
      this.deliveryManager = config.deliveryManager;
      this.deliveryManager.attachRuntime({
        runtimeStore: config.runtimeStore,
        runtimeBus: config.runtimeBus,
      });
    }
  }

  listJobs(): ManagedAutomationJob[] {
    if (!this.isEnabled()) return [];
    this.reconcileActiveRuns();
    return [...this.jobs.values()].sort((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt);
  }

  listRuns(jobId?: string): AutomationRun[] {
    if (!this.isEnabled()) return [];
    this.reconcileActiveRuns();
    const runs = jobId
      ? [...this.runs.values()].filter((run) => run.jobId === jobId)
      : this.runs.values();
    return sortRuns(runs);
  }

  listHeartbeatWakes(): AutomationHeartbeatWake[] {
    if (!this.isEnabled()) return [];
    this.queueDueHeartbeatJobs('inspect');
    return [...this.heartbeatWakes.values()].sort((a, b) => a.queuedAt - b.queuedAt || a.jobId.localeCompare(b.jobId));
  }

  getRun(runId: string): AutomationRun | undefined {
    if (!this.isEnabled()) return undefined;
    this.reconcileActiveRuns();
    return this.runs.get(runId);
  }

  getJob(jobId: string): ManagedAutomationJob | undefined {
    if (!this.isEnabled()) return undefined;
    this.reconcileActiveRuns();
    return this.jobs.get(jobId);
  }

  async createJob(input: CreateAutomationJobInput, options: AutomationJobMutationOptions = {}): Promise<ManagedAutomationJob> {
    const current = this.retainJobMutation(input, options);
    this.requireEnabled('create automation job');
    await this.start();
    current();
    return await createAutomationJobRecord(this.jobMutationContext(), input, { signal: options.signal, assertCurrent: current, withPublication: options.withPublication });
  }

  async removeJob(jobId: string, options: AutomationJobMutationOptions = {}): Promise<boolean> {
    const current = this.retainJobMutation({ jobId }, options);
    this.requireEnabled('remove automation job');
    await this.start();
    current();
    const selected = this.jobs.get(jobId);
    if (!selected) return false;
    await this.commitJob(selected, null, { signal: options.signal, assertCurrent: current, withPublication: options.withPublication });
    this.cancelTimer(jobId);
    return true;
  }

  async setEnabled(jobId: string, enabled: boolean, options: AutomationJobMutationOptions = {}): Promise<ManagedAutomationJob | null> {
    const current = this.retainJobMutation({ jobId, enabled }, options);
    this.requireEnabled('set automation job enabled state');
    await this.start();
    current();
    const updated = await toggleAutomationJobEnabled(this.jobMutationContext(), jobId, enabled, { signal: options.signal, assertCurrent: current, withPublication: options.withPublication });
    if (!enabled) this.cancelTimer(jobId);
    return updated;
  }

  async updateJob(jobId: string, patch: UpdateAutomationJobInput, options: AutomationJobMutationOptions = {}): Promise<ManagedAutomationJob | null> {
    const current = this.retainJobMutation(patch, options);
    this.requireEnabled('update automation job');
    await this.start();
    current();
    const selected = this.jobs.get(jobId);
    if (patch.expectedMutationRevision !== undefined && (!selected || automationJobRevision(selected) !== patch.expectedMutationRevision)) throw new AutomationJobMutationStaleError();
    return await updateAutomationJobRecord(this.jobMutationContext(), jobId, patch, { signal: options.signal, assertCurrent: current, withPublication: options.withPublication });
  }

  private readonly sourceClaims = new Set<string>();
  async runNow(jobId: string, operation?: ExternalOperationSource): Promise<AutomationRun> {
    const source = operation ? captureAutomationSource(operation) : undefined;
    this.requireEnabled('run automation job');
    await this.start();
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Automation job not found: ${jobId}`);
    if (this.activeRunCount() >= this.maxConcurrentRuns()) {
      throw new Error(`Automation concurrency limit reached (${this.maxConcurrentRuns()})`);
    }
    source?.assertCurrent();
    if (job.execution.requiresSourceOwner) {
      if (!source) throw new Error('Automation original source owner is unavailable');
      if (this.sourceClaims.has(jobId)) throw new Error('Automation source owner is already claimed');
      this.sourceClaims.add(jobId);
    }
    return await this.executeJob(job, 'manual', false, 1, source);
  }

  async triggerHeartbeat(_input: { readonly source?: string } = {}): Promise<AutomationHeartbeatResult> {
    this.requireEnabled('trigger automation heartbeat');
    await this.start();
    this.queueDueHeartbeatJobs('heartbeat');
    const queued = this.listHeartbeatWakes();
    const processed: AutomationRun[] = [];
    const failed: Array<{ jobId: string; error: string }> = [];
    for (const wake of queued) {
      if (this.activeRunCount() >= this.maxConcurrentRuns()) break;
      const job = this.jobs.get(wake.jobId);
      this.heartbeatWakes.delete(wake.jobId);
      if (!job?.enabled) continue;
      try {
        const run = await this.executeJob(job, wake.trigger, wake.dueRun, wake.attempt);
        processed.push(run);
        this.advanceScheduledHeartbeatJob(job.id);
      } catch (error) {
        failed.push({
          jobId: wake.jobId,
          error: summarizeError(error),
        });
      }
    }
    return {
      processed,
      failed,
      pending: this.listHeartbeatWakes(),
      checkedAt: Date.now(),
    };
  }

  async retryRun(runId: string): Promise<AutomationRun> {
    this.requireEnabled('retry automation run');
    await this.start();
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Automation run not found: ${runId}`);
    const job = this.jobs.get(run.jobId);
    if (!job) throw new Error(`Automation job not found: ${run.jobId}`);
    if (this.activeRunCount() >= this.maxConcurrentRuns()) {
      throw new Error(`Automation concurrency limit reached (${this.maxConcurrentRuns()})`);
    }
    return await this.executeJob(job, 'manual', false, run.attempt + 1);
  }

  async cancelRun(runId: string, reason = 'operator-cancelled'): Promise<AutomationRun | null> {
    this.requireEnabled('cancel automation run');
    await this.start();
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.status !== 'running') return run;

    if (run.agentId) {
      this.requireCancelTask()(run.agentId);
    }

    const endedAt = Date.now();
    const updatedRun: AutomationRun = {
      ...run,
      status: 'cancelled',
      endedAt,
      durationMs: Math.max(0, endedAt - (run.startedAt ?? run.queuedAt)),
      cancelledReason: reason,
      updatedAt: endedAt,
    };
    this.runs.set(run.id, updatedRun);
    this.syncRunToRuntime(updatedRun, 'automation.cancel');

    const job = this.jobs.get(run.jobId);
    if (job) {
      const updatedJob: AutomationJob = {
        ...job,
        lastRunAt: endedAt,
        updatedAt: endedAt,
      };
      this.jobs.set(job.id, updatedJob);
      await this.syncExecutionRoute(updatedJob, updatedRun);
      if (updatedRun.sessionId && updatedRun.continuationMode !== 'continued-live') {
        await this.sessionBroker.completeAgent(updatedRun.sessionId, updatedRun.agentId ?? run.id, reason, {
          status: 'cancelled',
          automationJobId: updatedJob.id,
          automationRunId: updatedRun.id,
        });
      }
      this.syncJobToRuntime(updatedJob, 'automation.cancel');
      this.emitRunCompleted(updatedJob, updatedRun, 'cancelled');
      this.maybeDeliverRun(updatedJob, updatedRun);
    }

    await this.saveRuns();
    await this.saveJobs();
    return updatedRun;
  }

  async recordExternalRunResult(
    runId: string,
    input: {
      readonly status: 'completed' | 'failed' | 'cancelled';
      readonly result?: unknown | undefined;
      readonly error?: string | undefined;
      readonly telemetry?: AutomationRunTelemetry | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    },
  ): Promise<AutomationRun | null> {
    this.requireEnabled('record automation run result');
    await this.start();
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.status !== 'running') return run;

    const endedAt = Date.now();
    const updatedRun: AutomationRun = {
      ...run,
      status: input.status,
      endedAt,
      durationMs: Math.max(0, endedAt - (run.startedAt ?? run.queuedAt)),
      updatedAt: endedAt,
      ...(input.status === 'completed'
        ? { result: input.result }
        : input.status === 'failed'
          ? { error: input.error ?? 'Remote work failed' }
          : { cancelledReason: input.error ?? 'Remote work cancelled' }),
      ...(input.telemetry ? { telemetry: normalizeExternalTelemetry(input.telemetry, run, input.metadata) } : {}),
    };
    this.runs.set(run.id, updatedRun);
    this.syncRunToRuntime(updatedRun, 'automation.external');

    const job = this.jobs.get(run.jobId);
    if (!job) {
      await this.saveRuns();
      return updatedRun;
    }

    const wasEnabled = job.enabled;
    const updatedJob: AutomationJob = input.status === 'completed'
      ? {
          ...job,
          successCount: job.successCount + 1,
          failureCount: 0,
          updatedAt: endedAt,
        }
      : input.status === 'failed'
        ? this.applyFailureToJob(job, endedAt, false)
        : {
            ...job,
            updatedAt: endedAt,
          };
    this.jobs.set(job.id, updatedJob);
    await this.syncExecutionRoute(updatedJob, updatedRun);
    this.syncJobToRuntime(updatedJob, 'automation.external');
    const retryable = input.status === 'failed'
      && (await readAutomationRunTransience({ error: input.error ?? '' }, 'automation.run.remote', { jobId: job.id, runId: run.id }))?.failureClass === 'retryable';

    if (input.status === 'completed') {
      this.emitRunCompleted(updatedJob, updatedRun, 'success');
    } else if (input.status === 'failed') {
      emitAutomationManagerRunFailed(this.runtimeBus, updatedJob, updatedRun, updatedRun.error ?? 'Remote work failed', retryable);
    } else {
      this.emitRunCompleted(updatedJob, updatedRun, 'cancelled');
    }
    this.maybeDeliverRun(updatedJob, updatedRun);
    if (input.status === 'completed' && updatedJob.deleteAfterRun) {
      this.cancelTimer(updatedJob.id);
      this.jobs.delete(updatedJob.id);
    } else if (input.status === 'failed') {
      scheduleAutomationFailureFollowUp(this.failureFollowUpContext(), updatedJob, updatedRun, retryable);
    }
    if (!updatedJob.enabled && wasEnabled && input.status === 'failed') {
      this.emitJobAutoDisabled(updatedJob, updatedJob.pausedReason ?? 'failure-threshold-reached');
    }

    await this.saveRuns();
    await this.saveJobs();
    return updatedRun;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    let [jobSnapshot, runSnapshot] = await Promise.all([
      this.jobStore.load(),
      this.runStore.load(),
    ]);
    for (const job of jobSnapshot.jobs) {
      const normalizedJob = normalizeJobRecord(job, this.configManager);
      this.jobs.restore({ ...normalizedJob, mutationRevision: automationJobRevision(job) });
    }
    for (const run of runSnapshot.runs) {
      const normalizedRun = normalizeRunRecord(run, this.jobs.get(run.jobId));
      this.runs.set(normalizedRun.id, normalizedRun);
    }
    this.loaded = true;
    this.pruneRunHistory();
    this.syncRuntimeSnapshot();
  }

  private scheduleJob(job: AutomationJob): void {
    scheduleAutomationJob({
      configManager: this.configManager,
      jobs: this.jobs,
      timers: this.timers,
      heartbeatWakes: this.heartbeatWakes,
      running: () => this.running,
      saveJobs: () => this.saveJobs(),
      activeRunCount: () => this.activeRunCount(),
      maxConcurrentRuns: () => this.maxConcurrentRuns(),
      executeJob: (scheduledJob, trigger, dueRun, attempt) => this.executeJob(scheduledJob, trigger, dueRun, attempt),
      recordMissedRun: (missedJob, plannedRunAt) => this.recordMissedRun(missedJob, plannedRunAt),
    }, job);
  }

  private recordMissedRun(job: AutomationJob, plannedRunAt: number): void {
    recordAutomationMissedRun({
      runs: this.runs,
      saveRuns: () => this.saveRuns(),
      syncRunToRuntime: (run, source) => this.syncRunToRuntime(run, source),
      deliverFailureNotice: (deliveryJob, run) => this.maybeDeliverFailureNotice(deliveryJob, run),
      pruneRunHistory: (jobId) => this.pruneRunHistory(jobId),
    }, job, plannedRunAt);
  }

  /**
   * Reconcile every live job's schedule against the wall clock: mint a `missed`
   * run for any occurrence that slipped past the catch-up window, and (re)arm
   * each timer. Runs at daemon boot and on the reachability heartbeat so drift
   * renders as recorded outcomes, not a user chore. Idempotent per occurrence.
   */
  reconcileSchedules(): void {
    if (!this.running) return;
    for (const job of this.jobs.values()) {
      this.scheduleJob(job);
    }
  }

  private cancelTimer(jobId: string): void {
    cancelAutomationTimer(this.timers, jobId);
  }

  private queueDueHeartbeatJobs(reason: string): void {
    queueDueHeartbeatAutomationJobs(this.jobs.values(), this.heartbeatWakes, reason);
  }

  private advanceScheduledHeartbeatJob(jobId: string): void {
    advanceScheduledHeartbeatAutomationJob(
      {
        jobs: this.jobs,
        saveJobs: () => this.saveJobs(),
      },
      this.timers,
      jobId,
      (job) => this.scheduleJob(job),
    );
  }

  private async executeJob(
    job: AutomationJob,
    trigger: AutomationRunTrigger,
    dueRun: boolean,
    attempt = 1,
    operation?: ExternalOperationSource,
  ): Promise<AutomationRun> {
    return await executeAutomationJob(this.runtimeExecutionContext(), job, trigger, dueRun, attempt, operation);
  }

  private async syncExecutionRoute(job: AutomationJob, run: AutomationRun): Promise<void> {
    await syncAutomationExecutionRoute(this.runtimeExecutionContext(), job, run);
  }

  private applyFailureToJob(job: AutomationJob, timestamp: number, countRun = true): AutomationJob {
    return applyAutomationFailureToJob(job, timestamp, countRun);
  }

  private reconcileActiveRuns(): void {
    if (!this.agentStatusProvider) {
      return;
    }
    reconcileAutomationActiveRuns({
      configManager: this.configManager,
      sessionBroker: this.sessionBroker,
      agentStatusProvider: this.agentStatusProvider,
      jobs: this.jobs,
      runs: this.runs,
      saveJobs: () => this.saveJobs(),
      saveRuns: () => this.saveRuns(),
      syncExecutionRoute: (job, run) => this.syncExecutionRoute(job, run),
      syncRunToRuntime: (run, source) => this.syncRunToRuntime(run, source),
      syncJobToRuntime: (job, source) => this.syncJobToRuntime(job, source),
      emitRunCompleted: (job, run, outcome) => this.emitRunCompleted(job, run, outcome),
      followUp: this.failureFollowUpContext(),
      emitJobAutoDisabled: (job, reason) => this.emitJobAutoDisabled(job, reason),
      maybeDeliverRun: (job, run) => this.maybeDeliverRun(job, run),
      applyFailureToJob: (job, timestamp, countRun) => this.applyFailureToJob(job, timestamp, countRun),
      pruneRunHistory: () => this.pruneRunHistory(),
      cancelTimer: (jobId) => this.cancelTimer(jobId),
    });
  }

  private async saveJobs(): Promise<void> {
    await this.jobStore.save(sortJobs(this.jobs.values()));
  }

  private async saveRuns(): Promise<void> {
    this.pruneRunHistory();
    await this.runStore.save(sortRuns(this.runs.values()));
  }

  private maxConcurrentRuns(): number {
    return Math.max(1, Number(this.configManager.get('automation.maxConcurrentRuns') ?? 4));
  }

  private activeRunCount(): number {
    let total = 0;
    for (const run of this.runs.values()) {
      if (run.status === 'running') total += 1;
    }
    return total;
  }

  getSchedulerCapacity(): SchedulerCapacityReport {
    return computeSchedulerCapacity(this.maxConcurrentRuns(), this.runs.values());
  }

  private pruneRunHistory(jobId?: string): void {
    const limit = Math.max(1, Number(this.configManager.get('automation.runHistoryLimit') ?? 100));
    const runs = sortRuns(this.runs.values());
    const keep = new Set<string>();
    if (jobId) {
      const scoped = runs.filter((run) => run.jobId === jobId).slice(0, limit);
      for (const run of scoped) keep.add(run.id);
      for (const run of runs) {
        if (run.jobId !== jobId) keep.add(run.id);
      }
    } else {
      const grouped = new Map<string, number>();
      for (const run of runs) {
        const count = grouped.get(run.jobId) ?? 0;
        if (count < limit) {
          grouped.set(run.jobId, count + 1);
          keep.add(run.id);
        }
      }
    }
    for (const runId of [...this.runs.keys()]) {
      if (!keep.has(runId)) this.runs.delete(runId);
    }
  }

  private failureFollowUpContext(): AutomationFailureFollowUpContext {
    return {
      jobs: this.jobs,
      retryTimers: this.retryTimers,
      deliveryManager: this.deliveryManager,
      activeRunCount: () => this.activeRunCount(),
      maxConcurrentRuns: () => this.maxConcurrentRuns(),
      executeJob: (scheduledJob, trigger, dueRun, attempt) => this.executeJob(scheduledJob, trigger, dueRun, attempt),
      saveJobs: () => this.saveJobs(),
      scheduleJob: (scheduledJob) => this.scheduleJob(scheduledJob),
      deliverFailureNotice: (failureJob, failureRun) => this.maybeDeliverFailureNotice(failureJob, failureRun),
      emitRunFailed: (failureJob, failureRun, error, retryable) => emitAutomationManagerRunFailed(this.runtimeBus, failureJob, failureRun, error, retryable),
    };
  }

  private maybeDeliverFailureNotice(job: AutomationJob, run: AutomationRun): void {
    maybeDeliverAutomationFailureNotice(this.deliveryManager, job, run, (gapJob, gapRun) => {
      if (this.warnedDeliveryGapJobs.has(gapJob.id)) return;
      this.warnedDeliveryGapJobs.add(gapJob.id);
      logger.warn('AutomationManager: failure notice has no delivery target', { jobId: gapJob.id, jobName: gapJob.name, runId: gapRun.id, status: gapRun.status });
    });
  }

  private syncRuntimeSnapshot(): void {
    syncAutomationRuntimeSnapshot(this.runtimeDispatch, this.jobs.values(), this.runs.values());
  }

  private syncJobToRuntime(job: AutomationJob, source: string): void {
    syncAutomationJobToRuntime(this.runtimeDispatch, job, source);
  }

  private syncRunToRuntime(run: AutomationRun, source: string): void {
    syncAutomationRunToRuntime(this.runtimeDispatch, run, source);
  }

  private emitJobCreated(job: AutomationJob): void {
    emitAutomationManagerJobCreated(this.runtimeBus, job);
  }

  private emitJobUpdated(job: AutomationJob, changedFields: string[]): void {
    emitAutomationManagerJobUpdated(this.runtimeBus, job, changedFields);
  }

  private emitJobAutoDisabled(job: AutomationJob, reason: string): void {
    emitAutomationManagerJobAutoDisabled(this.runtimeBus, job, reason);
  }

  private emitRunQueued(job: AutomationJob, run: AutomationRun): void {
    emitAutomationManagerRunQueued(this.runtimeBus, job, run);
  }

  private emitRunStarted(job: AutomationJob, run: AutomationRun): void {
    emitAutomationManagerRunStarted(this.runtimeBus, job, run);
  }

  private emitRunCompleted(job: AutomationJob, run: AutomationRun, outcome: 'success' | 'partial' | 'failed' | 'cancelled'): void {
    emitAutomationManagerRunCompleted(this.runtimeBus, job, run, outcome);
  }

  private maybeDeliverRun(job: AutomationJob, run: AutomationRun): void {
    maybeDeliverAutomationRun({
      runs: this.runs,
      deliveryInFlight: this.deliveryInFlight,
      deliveryManager: this.deliveryManager,
      syncRunToRuntime: (nextRun, source) => this.syncRunToRuntime(nextRun, source),
      saveRuns: () => this.saveRuns(),
    }, job, run);
  }
}

const managerOwnershipMethods = Object.getOwnPropertyDescriptors(AutomationManager.prototype);
