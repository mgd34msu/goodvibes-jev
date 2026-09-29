/**
 * contract-composition.ts, the contract runner as every composition builds it
 * (docs/design/contract-runner.md 2.2 and 11.3): the daemon-grade
 * `createRuntimeServices`, the pure-client `createClientRuntimeServices`, and
 * the standalone agent graph (`agent-graph-composition.ts`) all compose the
 * runner here, so its dependencies are wired in one place.
 *
 * - The route selector is the routing subsystem's route planner over the
 *   provider registry's catalog, tier readings and live provider health.
 * - The planner runs as a read-only sub-agent through the agent manager.
 * - Each contract gets its own orchestration engine (one per contract).
 * - The agent manager sends every spawn that is not outside a contract to the
 *   runner (`startForOwner`), and the agent orchestrator hands every sub-agent
 *   run the runner's hooks through its tool dependencies (the caller passes
 *   `runner.hooks()` there when it sets them).
 *
 * `resumeContracts` resumes every contract left on disk at startup, once per
 * project root in the process, and logs what it resumed or reaped.
 */
import { resolve } from 'node:path';
import type { ConfigManager } from '../config/manager.js';
import { ContractStore } from '../contract/store.js';
import { createContractRunner, type ContractRunner } from '../contract/runner.js';
import { createRoutePlannerContractSelector } from '../contract/route.js';
import type { ExecutionPlans, WorkPlanService } from '../contract/plan-sync.js';
import type { AgentMessageBus } from '../agents/message-bus.js';
import { createAgentManagerDecompositionRunner } from '../agents/planner-decomposition-runner.js';
import type { FleetCapacityFn } from '../orchestration/elastic-pool.js';
import { createOrchestrationEngine } from '../orchestration/engine.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { createRoutePlanner } from '../routing/route-planner.js';
import type { AgentManager } from '../tools/agent/index.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { buildPricingSeams } from './cost/pricing-seams.js';
import type { RuntimeEventBus } from './events/index.js';
import { makeRuntimeFleetProbe } from './orchestration/fleet-count.js';
import type { RuntimeStore } from './store/index.js';

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
  readonly planManager?: ExecutionPlans | undefined;
}

/**
 * The fleet ceiling for a composition that hosts no third-party coding
 * agents (the client composition and the standalone agent graph): the fleet
 * counts native agents only.
 */
export function nativeAgentFleetCapacity(configManager: Pick<ConfigManager, 'get'>, agentManager: Pick<AgentManager, 'list'>): FleetCapacityFn {
  return makeRuntimeFleetProbe({ readConfig: (key) => configManager.get(key as never), agentManager, acpHost: { list: () => [] } });
}

/** The composed runner and its store; `dispose` releases both. */
export interface ComposedContractRunner {
  readonly runner: ContractRunner;
  readonly store: ContractStore;
  dispose(): void;
}

export function composeContractRunner(options: ContractRunnerCompositionOptions): ComposedContractRunner {
  const store = new ContractStore({ projectRoot: options.projectRoot });
  const { priceUsage, priceProvenance } = buildPricingSeams(options.providerRegistry);
  const planner = createRoutePlanner({
    catalog: options.providerRegistry,
    tiers: options.providerRegistry.modelTiers,
    ...(options.runtimeStore === undefined ? {} : { providerHealth: () => options.runtimeStore!.getState().providerHealth.providers }),
  });
  const runner = createContractRunner({
    agentManager: options.agentManager,
    messageBus: options.agentMessageBus,
    runtimeBus: options.runtimeBus,
    configManager: options.configManager,
    projectRoot: options.projectRoot,
    routeSelector: createRoutePlannerContractSelector(planner),
    decompositionRunner: createAgentManagerDecompositionRunner({ agentManager: options.agentManager }),
    createEngine: (input) => createOrchestrationEngine({
      agentManager: options.agentManager,
      configManager: options.configManager,
      runtimeBus: options.runtimeBus,
      projectRoot: input.projectRoot,
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
 * Project roots whose contracts this process already resumed. Two
 * compositions can share a root in one process (the daemon's own services and
 * a hosted-session floor on the same workspace); only the first resumes what
 * is on disk, so no contract runs twice.
 */
const resumedRoots = new Set<string>();

/**
 * Resumes the contracts left on disk under `projectRoot` (design 7.2), once
 * per root in this process; what was resumed or reaped is logged, and a
 * failure is logged, not thrown into startup.
 */
export function resumeContracts(runner: Pick<ContractRunner, 'resumeAll'>, projectRoot: string): Promise<void> {
  const root = resolve(projectRoot);
  if (resumedRoots.has(root)) return Promise.resolve();
  resumedRoots.add(root);
  return runner.resumeAll().then(
    (report) => { logger.info('[contracts] resumed contracts from disk', { projectRoot: root, report }); },
    (error: unknown) => { logger.error('[contracts] resuming contracts from disk failed', { projectRoot: root, error: summarizeError(error) }); },
  );
}
