/**
 * contract-composition.ts, the contract runner as every composition builds it
 * (docs/design/contract-runner.md 2.2 and 11.3): the daemon-grade
 * `createRuntimeServices`, the pure-client `createClientRuntimeServices`, and
 * the standalone agent graph (`agent-graph-composition.ts`) all compose the
 * runner here, so its dependencies are wired in one place.
 *
 * - The route selector is the routing subsystem's route planner over the
 *   provider registry's catalog, tier readings, benchmark leaderboard and
 *   provider health (the runtime store's, and the providers the startup sweep
 *   could not reach), and picks only once the registry's startup model
 *   discovery and the leaderboard load have settled.
 * - The planner runs as a read-only sub-agent through the agent manager.
 * - Each contract gets its own orchestration engine (one per contract).
 * - The agent manager sends every spawn that is not outside a contract to the
 *   runner (`startForOwner`), and the agent orchestrator hands every sub-agent
 *   run the runner's hooks through its tool dependencies (the caller passes
 *   `runner.hooks()` there when it sets them).
 *
 * `resumeContracts` resumes every contract left on disk at startup, once per
 * project root in the process, logs what it resumed or reaped, and hands every
 * caller for the root the same promise of the report.
 */
import { resolve } from 'node:path';
import { mapLimit } from '@goodvibes-jev/judgment';
import type { ConfigManager } from '../config/manager.js';
import { ContractStore } from '../contract/store.js';
import { createContractRunner, type ContractRunner } from '../contract/runner.js';
import type { NativeContractDecisionHost } from '../contract/native-decisions.js';
import type { DurableContractBoundary } from '../contract/durable-admission.js';
import { createRoutePlannerContractSelector } from '../contract/route.js';
import type { ResumeReport } from '../contract/resume.js';
import type { ExecutionPlans, WorkPlanService } from '../contract/plan-sync.js';
import type { AgentMessageBus } from '../agents/message-bus.js';
import { createAgentManagerDecompositionRunner } from '../agents/planner-decomposition-runner.js';
import type { FleetCapacityFn } from '../orchestration/elastic-pool.js';
import { createOrchestrationEngine } from '../orchestration/engine.js';
import { compositeScore, type BenchmarkStore } from '../providers/model-benchmarks.js';
import type { ModelDefinition } from '../providers/registry.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { createRoutePlanner, type RoutePlanner, type RoutePlannerDeps } from '../routing/route-planner.js';
import { BENCHMARK_PREPARATION_ATTEMPTS, BENCHMARK_READ_CONCURRENCY } from '../routing/policy.js';
import type { AgentManager } from '../tools/agent/index.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { buildPricingSeams } from './cost/pricing-seams.js';
import type { RuntimeEventBus } from './events/index.js';
import { makeRuntimeFleetProbe } from './orchestration/fleet-count.js';
import type { RuntimeStore } from './store/index.js';
import type { ProviderStatus } from './store/domains/provider-health.js';

export interface NativeContractCompositionOwner {
  readonly decisions: NativeContractDecisionHost;
  readonly admission: DurableContractBoundary;
}

export interface ContractRunnerCompositionOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly agentManager: AgentManager;
  readonly agentMessageBus: AgentMessageBus;
  readonly configManager: ConfigManager;
  readonly providerRegistry: ProviderRegistry;
  /** The project contracts work in; their store lives under it. */
  readonly projectRoot: string;
  /** The fleet ceiling every contract's units share. */
  readonly fleetCapacity: FleetCapacityFn;
  /** Live provider health, so the route planner skips providers that are down. */
  readonly runtimeStore?: Pick<RuntimeStore, 'getState'> | undefined;
  readonly workPlanService?: WorkPlanService | undefined;
  readonly readAccessFilter?: import('../tools/shared/read-access.js').ReadAccessFilter | undefined;
  readonly planManager?: ExecutionPlans | undefined;
  /** Trusted paired native owners. Absent keeps historical composition; never sourced from config or wire input. */
  readonly nativeOwner?: NativeContractCompositionOwner | undefined;
}

/**
 * The fleet ceiling for a composition that hosts no third-party coding
 * agents (the client composition and the standalone agent graph): the fleet
 * counts native agents only.
 */
export function nativeAgentFleetCapacity(configManager: Pick<ConfigManager, 'get'>, agentManager: Pick<AgentManager, 'list'>): FleetCapacityFn {
  return makeRuntimeFleetProbe({ readConfig: (key) => configManager.get(key as never), agentManager, acpHost: { list: () => [] } });
}

/**
 * A model's benchmark fact for the route planner: the leaderboard's composite
 * score for the model, found by display name or id; null when the leaderboard
 * does not list it.
 */
export function routeBenchmarkFor(benchmarks: Pick<BenchmarkStore, 'getKnownBenchmarks'>): (model: ModelDefinition) => number | null {
  return (model) => {
    const entry = benchmarks.getKnownBenchmarks(model.displayName) ?? benchmarks.getKnownBenchmarks(model.id);
    return entry === undefined ? null : compositeScore(entry.benchmarks);
  };
}

type RouteBenchmarks = Pick<BenchmarkStore, 'getKnownBenchmarks' | 'readBenchmarks'> & Partial<Pick<BenchmarkStore, 'onRefreshed'>>;

/**
 * Resolve each eligible model's leaderboard identity before the first tier
 * shortlist is sorted. Exact names and remembered readings need no Jev call;
 * new aliases are read with bounded concurrency. A refresh retries the whole
 * batch, including aliases already read. Failed readings or repeated refreshes
 * reject the route instead of silently sorting by price with unknown identities.
 */
async function readRouteBenchmarkSnapshot(
  benchmarks: RouteBenchmarks,
  models: readonly ModelDefinition[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<ModelDefinition, number | null>> {
  signal?.throwIfAborted();
  const stop = new AbortController();
  const readingSignal = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
  let refreshed = false;
  const unsubscribe = benchmarks.onRefreshed?.(() => { refreshed = true; });
  try {
    for (let attempt = 0; attempt < BENCHMARK_PREPARATION_ATTEMPTS; attempt++) {
      refreshed = false;
      await mapLimit(models, BENCHMARK_READ_CONCURRENCY, async (model) => {
        readingSignal.throwIfAborted();
        if (benchmarks.getKnownBenchmarks(model.displayName) ?? benchmarks.getKnownBenchmarks(model.id)) return;
        const entry = await benchmarks.readBenchmarks(model.displayName, 'routing.route-planner.benchmark-identity', readingSignal);
        readingSignal.throwIfAborted();
        if (entry === undefined && model.id !== model.displayName) {
          await benchmarks.readBenchmarks(model.id, 'routing.route-planner.benchmark-identity', readingSignal);
        }
      });
      readingSignal.throwIfAborted();
      // A refresh can invalidate aliases that finished before a sibling's
      // awaited reading. Prepare the whole batch again, not just that sibling.
      if (!refreshed) {
        // Capture scores in this same synchronous turn. A refresh may run
        // after this promise resolves, before the planner resumes to read facts.
        const benchmarkFor = routeBenchmarkFor(benchmarks);
        return new Map(models.map((model) => [model, benchmarkFor(model)]));
      }
    }
    throw new Error('Benchmark leaderboard kept changing during route preparation');
  } catch (error) {
    stop.abort(error);
    throw error;
  } finally {
    unsubscribe?.();
  }
}

/**
 * Warm current benchmark identities. This does not retain a snapshot across
 * the caller's await; routing must use createBenchmarkRoutePlanner instead.
 */
export async function prepareRouteBenchmarks(
  benchmarks: RouteBenchmarks,
  models: readonly ModelDefinition[],
  signal?: AbortSignal,
): Promise<void> {
  await readRouteBenchmarkSnapshot(benchmarks, models, signal);
}

/** The contract runner's planner, with a separate stable benchmark snapshot per plan. */
export function createBenchmarkRoutePlanner(
  deps: Omit<RoutePlannerDeps, 'benchmarkFor' | 'prepareBenchmarks'>,
  benchmarks: RouteBenchmarks,
): RoutePlanner {
  return {
    planRoute(request) {
      // Routes share tier readings but never the score map: another concurrent
      // plan can prepare a newer generation while this plan is still awaiting.
      let scores: ReadonlyMap<ModelDefinition, number | null> = new Map();
      return createRoutePlanner({
        ...deps,
        prepareBenchmarks: async (models, signal) => {
          scores = await readRouteBenchmarkSnapshot(benchmarks, models, signal);
        },
        benchmarkFor: (model) => scores.get(model) ?? null,
      }).planRoute(request);
    },
  };
}

/**
 * The provider health the route planner filters on: the runtime store's
 * provider health, and every provider whose endpoint did not return its model
 * list in the registry's startup sweep marked unavailable, so no route names
 * a model on a provider nothing is serving (a local proxy that is not running,
 * credentials the provider refused).
 */
export function routeProviderHealth(
  registry: Pick<ProviderRegistry, 'unreachableAtStartup'>,
  runtimeStore?: Pick<RuntimeStore, 'getState'> | undefined,
): () => ReadonlyMap<string, { readonly status: ProviderStatus }> {
  return () => {
    const health = new Map<string, { readonly status: ProviderStatus }>(runtimeStore?.getState().providerHealth.providers ?? []);
    for (const providerId of registry.unreachableAtStartup().keys()) health.set(providerId, { status: 'unavailable' });
    return health;
  };
}

/** The composed runner and its store; `dispose` releases both. */
export interface ComposedContractRunner {
  readonly runner: ContractRunner;
  readonly store: ContractStore;
  dispose(): void;
}

export function composeContractRunner(options: ContractRunnerCompositionOptions): ComposedContractRunner {
  if (options.nativeOwner && (typeof options.readAccessFilter !== 'function' || typeof options.nativeOwner.decisions?.authorityOf !== 'function' || typeof options.nativeOwner.admission?.withCurrent !== 'function')) {
    throw new Error('Native composition requires both authenticated owners and the original read authorization');
  }
  const store = new ContractStore({ projectRoot: options.projectRoot });
  const { priceUsage, priceProvenance } = buildPricingSeams(options.providerRegistry);
  const planner = createBenchmarkRoutePlanner({
    catalog: options.providerRegistry,
    tiers: options.providerRegistry.modelTiers,
    providerHealth: routeProviderHealth(options.providerRegistry, options.runtimeStore),
  }, options.providerRegistry.benchmarks);
  const runner = createContractRunner({
    ...(options.nativeOwner === undefined ? {} : { nativeDecisions: options.nativeOwner.decisions, durableAdmission: options.nativeOwner.admission }),
    agentManager: options.agentManager,
    messageBus: options.agentMessageBus,
    runtimeBus: options.runtimeBus,
    configManager: options.configManager,
    projectRoot: options.projectRoot,
    readAccessFilter: options.readAccessFilter,
    routeSelector: createRoutePlannerContractSelector(planner, {
      catalogSettled: async () => {
        await Promise.all([options.providerRegistry.modelDiscoverySettled(), options.providerRegistry.benchmarks.benchmarksSettled()]);
      },
    }),
    decompositionRunner: createAgentManagerDecompositionRunner({ agentManager: options.agentManager }),
    createEngine: (input) => createOrchestrationEngine({
      agentManager: options.agentManager,
      configManager: options.configManager,
      runtimeBus: options.runtimeBus,
      projectRoot: input.projectRoot,
      initializeWorktree: input.initializeWorktree,
      prepareInputAuthority: input.prepareInputAuthority,
      stateRoot: input.stateRoot,
      stateNamespace: input.stateNamespace,
      contractUnitSettlement: input.contractUnitSettlement,
      fleetCapacity: input.fleetCapacity,
      judgeAttempts: input.judgeAttempts,
      priceUsage,
      priceProvenance,
    }),
    fleetCapacity: options.fleetCapacity,
    priceUsage,
    priceProvenance,
    store,
    ...(options.workPlanService === undefined ? {} : { workPlanService: options.workPlanService }),
    ...(options.planManager === undefined ? {} : { planManager: options.planManager }),
  });
  options.agentManager.setContractRunner(runner);
  return {
    runner,
    store,
    dispose: () => {
      options.agentManager.setContractRunner(null);
      runner.dispose();
      store.dispose();
    },
  };
}

/**
 * The resume of each project root this process started. Two compositions can
 * share a root in one process (the daemon's own services and a hosted-session
 * floor on the same workspace); only the first resumes what is on disk, so no
 * contract runs twice, and every later call for the root gets the same promise.
 */
const resumedRoots = new Map<string, Promise<ResumeReport | null>>();

/**
 * Resumes the contracts left on disk under `projectRoot` (design 7.2), once
 * per root in this process. Every call for a root returns the same promise: it
 * resolves to the report of what was resumed, queued or reaped (also logged),
 * or to null when resuming failed (logged, not thrown into startup). A host
 * that follows the resumed contracts (the contract CLI) awaits it.
 */
export function resumeContracts(runner: Pick<ContractRunner, 'resumeAll'>, projectRoot: string): Promise<ResumeReport | null> {
  const root = resolve(projectRoot);
  const started = resumedRoots.get(root);
  if (started !== undefined) return started;
  const resuming = runner.resumeAll().then(
    (report): ResumeReport => {
      logger.info('[contracts] resumed contracts from disk', { projectRoot: root, report });
      return report;
    },
    (error: unknown): null => {
      logger.error('[contracts] resuming contracts from disk failed', { projectRoot: root, error: summarizeError(error) });
      return null;
    },
  );
  resumedRoots.set(root, resuming);
  return resuming;
}
