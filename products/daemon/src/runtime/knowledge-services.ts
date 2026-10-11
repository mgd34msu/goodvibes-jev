// ---------------------------------------------------------------------------
// knowledge-services.ts, the knowledge/wiki + home-graph stack
//
// Constructs the three KnowledgeStores (regular wiki, agent, home-graph), their
// semantic services, the ingest services, the home-graph service, and the
// project-planning + work-plan stores. Extracted into its own module rather
// than built inline in services.ts, which sits at the architecture check's
// 800-line cap (scripts/check-architecture.ts), new/large construction blocks
// get their own module and a single wiring call there (mirrors
// createWorkstreamServices / createDurabilityServices / createCodeIndexServices).
//
// The semantic services + ingest services receive the memory-governor
// backpressure seams (isBackgroundPaused for the knowledge-self-improvement job
// + admitExpensiveWork for the critical-tier refusal), mirroring the SDK's own
// createRuntimeServices. The web-knowledge gap repairer is wired by the caller
// AFTER webSearchService exists (it is constructed later in services.ts), using
// the semantic + ingest handles this returns.
// ---------------------------------------------------------------------------

import {
  HomeGraphService,
  GOODVIBES_AGENT_KNOWLEDGE_DB_FILE,
  HOME_GRAPH_KNOWLEDGE_EXTENSION,
  KnowledgeService,
  KnowledgeSemanticService,
  KnowledgeStore,
  ProjectPlanningService,
  createProviderBackedKnowledgeSemanticLlm,
  projectPlanningProjectIdFromPath,
} from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { MemoryRegistry } from '@goodvibes-jev/engine/sdk/platform/state';
import type { RuntimeEventBus } from './index.js';
import { WorkPlanStore } from '@goodvibes-jev/engine/sdk/platform/workflow';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import type { AsyncDisposalRegistry } from '@goodvibes-jev/engine/sdk/platform/runtime/disposal';
import { createNativeWorkLedgerOwner, type NativeWorkLedgerOwner } from './work-ledger-composition.js';

const REGULAR_KNOWLEDGE_DB_FILE = 'knowledge-wiki.sqlite';
const HOME_GRAPH_KNOWLEDGE_DB_FILE = 'knowledge-home-graph.sqlite';

export interface KnowledgeServicesDeps {
  /** Acquire owners immediately, including when a later constructor fails. */
  readonly ownership: {
    readonly registry: AsyncDisposalRegistry;
    ownUntilRegistered(label: string, dispose: () => void | Promise<void>): void;
  };
  readonly configManager: ConfigManager;
  readonly providerRegistry: ProviderRegistry;
  readonly artifactStore: ArtifactStore;
  readonly memoryRegistry: MemoryRegistry;
  readonly runtimeBus: RuntimeEventBus;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** True while the 'knowledge-self-improvement' job is governor-paused. */
  readonly isBackgroundPaused: () => boolean;
  /** Critical-tier admission gate for expensive knowledge work. */
  readonly admitExpensiveWork: (label: string) => { allowed: boolean; reason?: string | undefined };
}

export interface KnowledgeServices {
  readonly knowledgeStore: KnowledgeStore;
  readonly agentKnowledgeStore: KnowledgeStore;
  readonly homeGraphKnowledgeStore: KnowledgeStore;
  readonly knowledgeSemanticService: KnowledgeSemanticService;
  readonly homeGraphSemanticService: KnowledgeSemanticService;
  readonly agentKnowledgeSemanticService: KnowledgeSemanticService;
  readonly knowledgeService: KnowledgeService;
  readonly agentKnowledgeService: KnowledgeService;
  readonly homeGraphService: HomeGraphService;
  readonly projectPlanningService: ProjectPlanningService;
  readonly projectPlanningProjectId: string;
  readonly workPlanStore: WorkPlanStore;
  /** Trusted host-local authority; the runtime exposes only its service. */
  readonly workLedgerOwner: NativeWorkLedgerOwner;
}

/** Construct the knowledge/wiki + home-graph stack with governor backpressure wired in. */
export function createKnowledgeServices(deps: KnowledgeServicesDeps): KnowledgeServices {
  const { configManager, providerRegistry, artifactStore, memoryRegistry, runtimeBus, isBackgroundPaused, admitExpensiveWork } = deps;
  const knowledgeStore = new KnowledgeStore({ configManager, dbFileName: REGULAR_KNOWLEDGE_DB_FILE });
  deps.ownership.registry.add('regular knowledge store', () => knowledgeStore.close());
  const agentKnowledgeStore = new KnowledgeStore({ configManager, dbFileName: GOODVIBES_AGENT_KNOWLEDGE_DB_FILE });
  deps.ownership.registry.add('agent knowledge store', () => agentKnowledgeStore.close());
  const homeGraphKnowledgeStore = new KnowledgeStore({ configManager, dbFileName: HOME_GRAPH_KNOWLEDGE_DB_FILE });
  deps.ownership.registry.add('home graph knowledge store', () => homeGraphKnowledgeStore.close());
  const projectPlanningProjectId = projectPlanningProjectIdFromPath(deps.workingDirectory);
  const workLedgerOwner = createNativeWorkLedgerOwner({ projectId: projectPlanningProjectId, knowledgeStore });
  deps.ownership.registry.add('native work ledger', workLedgerOwner.close);
  const knowledgeSemanticLlm = createProviderBackedKnowledgeSemanticLlm(providerRegistry, { timeoutMs: 20_000, maxConcurrent: 1 });
  const knowledgeSemanticService = new KnowledgeSemanticService(knowledgeStore, { llm: knowledgeSemanticLlm, maxLlmSourcesPerReindex: 3, isBackgroundPaused, admitExpensiveWork });
  const homeGraphSemanticService = new KnowledgeSemanticService(homeGraphKnowledgeStore, { llm: knowledgeSemanticLlm, maxLlmSourcesPerReindex: 3, objectProfiles: HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles, isBackgroundPaused, admitExpensiveWork });
  const agentKnowledgeSemanticService = new KnowledgeSemanticService(agentKnowledgeStore, { llm: knowledgeSemanticLlm, maxLlmSourcesPerReindex: 3, isBackgroundPaused, admitExpensiveWork });
  const knowledgeService = new KnowledgeService(knowledgeStore, artifactStore, undefined, { memoryRegistry, runtimeBus, semanticService: knowledgeSemanticService, admitExpensiveWork });
  deps.ownership.ownUntilRegistered('knowledge service', () => knowledgeService.dispose());
  knowledgeService.attachRuntimeBus(runtimeBus);
  const agentKnowledgeService = new KnowledgeService(agentKnowledgeStore, artifactStore, undefined, { memoryRegistry, runtimeBus, semanticService: agentKnowledgeSemanticService, admitExpensiveWork });
  deps.ownership.ownUntilRegistered('agent knowledge service', () => agentKnowledgeService.dispose());
  agentKnowledgeService.attachRuntimeBus(runtimeBus);
  const homeGraphService = new HomeGraphService(homeGraphKnowledgeStore, artifactStore, { semanticService: homeGraphSemanticService, admitExpensiveWork });
  deps.ownership.ownUntilRegistered('home graph service', () => homeGraphService.dispose());
  const projectPlanningService = new ProjectPlanningService(knowledgeStore, { defaultProjectId: projectPlanningProjectId, waitForStartup: () => knowledgeService.whenReady() });
  const workPlanStore = new WorkPlanStore({
    homeDirectory: deps.homeDirectory,
    surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
    projectId: projectPlanningProjectId,
    projectRoot: deps.workingDirectory,
    source: GOODVIBES_DAEMON_SURFACE_ROOT,
  });
  return {
    knowledgeStore, agentKnowledgeStore, homeGraphKnowledgeStore,
    knowledgeSemanticService, homeGraphSemanticService, agentKnowledgeSemanticService,
    knowledgeService, agentKnowledgeService, homeGraphService,
    projectPlanningService, projectPlanningProjectId, workPlanStore, workLedgerOwner,
  };
}
