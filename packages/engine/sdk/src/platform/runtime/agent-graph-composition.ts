/**
 * agent-graph-composition.ts, the graph that runs agents.
 *
 * The default graph builds six collaborators as one: a message bus, the archetype loader, the orchestrator that executes a
 * run, the manager that owns the records, the context-accounting holder, and
 * the contract runner. Every one of them holds a reference to at least one
 * other, and two of the links are circular: the orchestrator writes
 * conversation snapshots back through the manager, and the manager hands every
 * spawn that is not outside a contract to the runner, which was built from the
 * manager. Assembled anywhere but in one place, a half-wired graph looks
 * correct and silently drops either the snapshot bridge or the contracts.
 *
 * It is also the graph whose runs `cancelHostedAgentRuns` cancels at disposal:
 * the manager returned here is the one the runtime hands to the SDK's
 * `cancelAllAgentRuns`. `dispose` releases the runner and its store.
 */
import { join } from 'node:path';
import { AgentMessageBus, AgentOrchestrator, ArchetypeLoader } from '../agents/index.js';
import type { ContractRunner } from '../contract/runner.js';
import { AgentManager, ContextAccountingHolder } from '../tools/index.js';
import type { ConfigManager } from '../config/index.js';
import type { ProviderRegistry } from '../providers/index.js';
import { composeContractRunner, nativeAgentFleetCapacity, resumeContracts } from './contract-composition.js';
import type { RuntimeEventBus } from './events/index.js';
import type { RuntimeStore } from './store/index.js';

export interface AgentExecutionGraph {
  readonly agentMessageBus: AgentMessageBus;
  readonly archetypeLoader: ArchetypeLoader;
  readonly agentOrchestrator: AgentOrchestrator;
  readonly agentManager: AgentManager;
  readonly contextAccountingHolder: ContextAccountingHolder;
}

export interface AgentExecutionGraphOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly workingDirectory: string;
  readonly configManager: ConfigManager;
  readonly providerRegistry: ProviderRegistry;
  readonly additionalFleetOwnership?: (() => ReturnType<AgentManager['fleetOwnership']>) | undefined;
}

export interface AgentGraph extends AgentExecutionGraph {
  readonly contractRunner: ContractRunner;
  /** Releases the contract runner and its store. */
  dispose(): void;
}

export interface AgentGraphOptions extends AgentExecutionGraphOptions {
  readonly readAccessFilter?: import('../tools/shared/read-access.js').ReadAccessFilter | undefined;
  /** Live provider health for the route planner. */
  readonly runtimeStore?: Pick<RuntimeStore, 'getState'> | undefined;
}

/**
 * Construct the shared execution collaborators and their snapshot bridge.
 * This does not install or resume a contract runner. A host using this lower
 * level factory must compose and own exactly one runner before admitting work;
 * use createAgentGraph when its native-only fleet and resume policy apply.
 */
export function createAgentExecutionGraph(options: AgentExecutionGraphOptions): AgentExecutionGraph {
  const agentMessageBus = new AgentMessageBus();
  agentMessageBus.setRuntimeBus(options.runtimeBus);
  const archetypeLoader = new ArchetypeLoader(join(options.workingDirectory, '.goodvibes', 'agents'));
  const agentOrchestrator = new AgentOrchestrator({
    messageBus: agentMessageBus,
  });
  agentOrchestrator.setRuntimeBus(options.runtimeBus);
  const agentManager = new AgentManager({
    archetypeLoader,
    messageBus: agentMessageBus,
    executor: agentOrchestrator,
    configManager: options.configManager,
    // The live registry lets a bare model id in a spawn() override resolve
    // through the shared resolver instead of being rejected as unqualified.
    providerRegistry: options.providerRegistry,
    additionalFleetOwnership: options.additionalFleetOwnership,
  });
  const contextAccountingHolder = new ContextAccountingHolder();
  // Conversation-snapshot bridge (mirrors the SDK's own createRuntimeServices).
  agentOrchestrator.setConversationSink({
    register: (agentId, source) => agentManager.registerConversationSource(agentId, source),
    release: (agentId) => agentManager.releaseConversationSource(agentId),
  });
  agentManager.setRuntimeBus(options.runtimeBus);
  return { agentMessageBus, archetypeLoader, agentOrchestrator, agentManager, contextAccountingHolder };
}

/** Build the complete default graph and resume its contracts once per project root. */
export function createAgentGraph(options: AgentGraphOptions): AgentGraph {
  const graph = createAgentExecutionGraph(options);
  const { agentMessageBus, agentManager } = graph;
  const composed = composeContractRunner({
    readAccessFilter: options.readAccessFilter,
    runtimeBus: options.runtimeBus,
    agentManager,
    agentMessageBus,
    configManager: options.configManager,
    providerRegistry: options.providerRegistry,
    projectRoot: options.workingDirectory,
    fleetCapacity: nativeAgentFleetCapacity(options.configManager, agentManager),
    runtimeStore: options.runtimeStore,
  });
  void resumeContracts(composed.runner, options.workingDirectory);
  return {
    ...graph,
    contractRunner: composed.runner,
    dispose: () => composed.dispose(),
  };
}
