/**
 * Runtime services test helper.
 *
 * CONTRACT: Importing this helper auto-registers a beforeEach that calls
 * resetAllTestServiceState(), so every test file gets a fresh singleton set
 * without needing to call reset manually. Files that need custom reset logic
 * can still call resetAllTestServiceState() or individual reset functions
 * in their own beforeEach, bun:test runs all registered beforeEach hooks.
 */
import { beforeEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ArchetypeLoader } from '@goodvibes-jev/engine/sdk/platform/agents';
import { AgentMessageBus } from '@goodvibes-jev/engine/sdk/platform/agents';
import { AgentOrchestrator } from '@goodvibes-jev/engine/sdk/platform/agents';
import { AutomationManager } from '@goodvibes-jev/engine/sdk/platform/automation';
import { ChannelPolicyManager } from '@goodvibes-jev/engine/sdk/platform/channels';
import { RouteBindingManager } from '@goodvibes-jev/engine/sdk/platform/channels';
import { ToolLLM } from '@goodvibes-jev/engine/sdk/platform/config';
import { ApprovalBroker } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { SharedSessionBroker } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { GitService } from '@goodvibes-jev/engine/sdk/platform/git';
import type { HookDispatcher } from '@goodvibes-jev/engine/sdk/platform/hooks';
import type { HookWorkbench } from '@goodvibes-jev/engine/sdk/platform/hooks';
import { CodeIntelligence } from '@goodvibes-jev/engine/sdk/platform/intelligence';
import { LspService } from '@goodvibes-jev/engine/sdk/platform/intelligence';
import { TreeSitterService } from '@goodvibes-jev/engine/sdk/platform/intelligence';
import { MediaProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/media';
import { PluginManager } from '@goodvibes-jev/engine/sdk/platform/plugins';
import { createFeatureFlagManager, type FeatureFlagManager } from '@/runtime/index.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { RemoteRunnerRegistry } from '@/runtime/index.ts';
import { RemoteSupervisor } from '@/runtime/index.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { TaskScheduler } from '@goodvibes-jev/engine/sdk/platform/scheduler';
import { SpawnTokenManager } from '@goodvibes-jev/engine/sdk/platform/security';
import { FileUndoManager } from '@goodvibes-jev/engine/sdk/platform/state';
import { MemoryEmbeddingProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/state';
import { ModeManager } from '@goodvibes-jev/engine/sdk/platform/state';
import { ProjectIndex } from '@goodvibes-jev/engine/sdk/platform/state';
import { AgentManager, type AgentExecutor } from '@goodvibes-jev/engine/sdk/platform/tools';
import { AutoHealer } from '@goodvibes-jev/engine/sdk/platform/tools';
import { ProcessManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import { ScheduleManager, TriggerManager, WorkflowManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import { VoiceProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/voice';
import { WebSearchProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/web-search';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { installAgentDaemonCredentialsClient } from '../../config/daemon-credential-routing.ts';
import { installAgentDaemonConfigClient } from '../../config/daemon-config-routing.ts';
import { makeLongLivedProjectTempDir } from './project-temp.ts';
import { buildTestModelDefinition, patchTestProviderRegistry } from './test-managers.ts';

type IntelligenceTestRoots = {
  root: string;
  workingDir: string;
  homeDir: string;
  shellPaths: ReturnType<typeof createShellPathService>;
};

let testRoots: IntelligenceTestRoots | null = null;

let runtimeServices: RuntimeServices | null = null;
let runtimeCounter = 0;
let toolLLM: ToolLLM | null = null;
let toolLLMRuntimeServices: RuntimeServices | null = null;
let autoHealer: AutoHealer | null = null;
let lspService: LspService | null = null;
let treeSitterService: TreeSitterService | null = null;
let codeIntelligence: CodeIntelligence | null = null;
let taskScheduler: TaskScheduler | null = null;
let featureFlags: FeatureFlagManager | null = null;
const spawnTokenManagers = new Map<string, SpawnTokenManager>();
const projectIndexes = new Map<string, ProjectIndex>();
const gitServices = new Map<string, GitService>();
let agentExecutorForTests: AgentExecutor | null = null;

function getTestRoots(): IntelligenceTestRoots {
  if (testRoots) return testRoots;

  // Long-lived: this root is memoized once (the `if (testRoots) return
  // testRoots` guard above) and reused by every one of the ~17 test files
  // that call getTestRuntimeServices()/getTestArchetypeLoader()/etc. across
  // the whole suite run, not just whichever file happens to create it
  // first. It must not go through makeProjectTempDir's per-test sweep,
  // which would delete it after the very first test that touches it and
  // break every later file still relying on it existing.
  const root = makeLongLivedProjectTempDir('gv-test-runtime');
  const workingDir = join(root, 'intelligence-workspace');
  const homeDir = join(root, 'intelligence-home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  makeStandaloneGitRoot(workingDir);

  testRoots = {
    root,
    workingDir,
    homeDir,
    shellPaths: createShellPathService({
      workingDirectory: workingDir,
      homeDirectory: homeDir,
    }),
  };

  // No cleanup registration here: `root` came from makeLongLivedProjectTempDir,
  // which already tracked it in the shared temp registry that the preload's
  // top-level afterAll sweeps. This used to register a second
  // `process.on('exit', …)` handler, which `bun test` never runs.

  return testRoots;
}

function nextRuntimeRoots(): { workingDir: string; configDir: string } {
  runtimeCounter += 1;
  const rootDir = join(getTestRoots().root, `runtime-${runtimeCounter}`);
  const workingDir = join(rootDir, 'workspace');
  const configDir = join(rootDir, 'config');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  makeStandaloneGitRoot(workingDir);
  return { workingDir, configDir };
}

/**
 * Make a test workspace its own git toplevel. The temp roots live under the
 * repo checkout (.test-tmp/), and the SDK's WorkspaceCheckpointManager prefers
 * the ENCLOSING git repo's top level, without this boundary every test
 * runtime resolves to the checkout itself and they all share one
 * <repo>/.goodvibes/checkpoints/git side store, racing on git's config lock
 * the first time two files initialize it concurrently on a fresh runner.
 */
function makeStandaloneGitRoot(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, timeout: 30_000 });
}

function applyExecutorIfPresent(services: RuntimeServices): void {
  services.agentManager.setExecutor(agentExecutorForTests);
}

function seedRuntimeProviderTestModels(services: RuntimeServices): void {
  patchTestProviderRegistry(services.providerRegistry);
  const mockProvider = {
    name: 'mock',
    models: ['mock-model'],
    async chat() {
      return {
        content: 'ok',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'completed' as const,
      };
    },
  };
  services.providerRegistry.registerRuntimeProvider({
    provider: mockProvider,
    replace: true,
    models: [buildTestModelDefinition('mock', 'mock-model')],
  });
}

export function resetTestRuntimeServices(): void {
  runtimeServices = null;
  toolLLM = null;
  toolLLMRuntimeServices = null;
  autoHealer = null;
}

export function getTestRuntimeServices(): RuntimeServices {
  if (!runtimeServices) {
    const { workingDir, configDir } = nextRuntimeRoots();
    runtimeServices = createRuntimeServices({
      // Opt out: this process does not outlive the unawaited sweep.
      modelDiscovery: 'skip',
      configManager: new ConfigManager({ surfaceRoot: 'agent',
        configDir,
        workingDir,
        homeDir: workingDir,
      }),
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      workingDir,
      homeDirectory: workingDir,
      getConversationTitle: () => 'test-runtime',
    });
    seedRuntimeProviderTestModels(runtimeServices);
    applyExecutorIfPresent(runtimeServices);
  }
  return runtimeServices;
}

export function getTestArchetypeLoader(): ArchetypeLoader {
  return getTestRuntimeServices().archetypeLoader;
}

export function getTestAgentMessageBus(): AgentMessageBus {
  return getTestRuntimeServices().agentMessageBus;
}

export function getTestAgentOrchestrator(): AgentOrchestrator {
  return getTestRuntimeServices().agentOrchestrator;
}

export function getTestAgentManager(): AgentManager {
  return getTestRuntimeServices().agentManager;
}

export function getTestRouteBindings(): RouteBindingManager {
  return getTestRuntimeServices().routeBindings;
}

export function getTestConfigManager(): RuntimeServices['configManager'] {
  return getTestRuntimeServices().configManager;
}

export function getTestProviderRegistry(): RuntimeServices['providerRegistry'] {
  return getTestRuntimeServices().providerRegistry;
}

export function getTestBookmarkManager(): RuntimeServices['bookmarkManager'] {
  return getTestRuntimeServices().bookmarkManager;
}

export function getTestSessionManager(): RuntimeServices['sessionManager'] {
  return getTestRuntimeServices().sessionManager;
}

export function getTestSessionOrchestration(): RuntimeServices['sessionOrchestration'] {
  return getTestRuntimeServices().sessionOrchestration;
}

export function getTestReplayEngine(): RuntimeServices['replayEngine'] {
  return getTestRuntimeServices().replayEngine;
}

export function getTestServiceRegistry(): RuntimeServices['serviceRegistry'] {
  return getTestRuntimeServices().serviceRegistry;
}

export function getTestSubscriptionManager(): RuntimeServices['subscriptionManager'] {
  return getTestRuntimeServices().subscriptionManager;
}

/**
 * The persisting session REGISTER, the one automation runs on. Named as the
 * graph names it now: `services.sessionBroker` is the client dispatch seam and
 * has none of these methods, so a test that wants ensureSession/submitMessage/
 * listSessions wants this.
 */
export function getTestSessionBroker(): SharedSessionBroker {
  return getTestRuntimeServices().automationSessionRegister;
}

/** The inbound continuation-dispatch seam this surface binds its runner onto. */
export function getTestSessionDispatch(): RuntimeServices['sessionBroker'] {
  return getTestRuntimeServices().sessionBroker;
}

/** The sessions the composed graph believes this process is hosting. */
export function getTestHostedSessions(): RuntimeServices['hostedSessions'] {
  return getTestRuntimeServices().hostedSessions;
}

export function getTestApprovalBroker(): ApprovalBroker {
  return getTestRuntimeServices().approvalBroker;
}

export function getTestAutomationManager(): AutomationManager {
  return getTestRuntimeServices().automationManager;
}

export function getTestChannelPolicyManager(): ChannelPolicyManager {
  return getTestRuntimeServices().channelPolicy;
}

export function getTestFileUndoManager(): FileUndoManager {
  return getTestRuntimeServices().fileUndoManager;
}

export function getTestModeManager(): ModeManager {
  return getTestRuntimeServices().modeManager;
}

export function getTestWorkflowManager(): WorkflowManager {
  return getTestRuntimeServices().workflow.workflowManager;
}

export function getTestTriggerManager(): TriggerManager {
  return getTestRuntimeServices().workflow.triggerManager;
}

export function getTestScheduleManager(): ScheduleManager {
  return getTestRuntimeServices().workflow.scheduleManager;
}

export function getTestGatewayMethodCatalog(): GatewayMethodCatalog {
  return getTestRuntimeServices().gatewayMethods;
}

export function getTestHookDispatcher(): HookDispatcher {
  return getTestRuntimeServices().hookDispatcher;
}

export function getTestHookWorkbench(): HookWorkbench {
  return getTestRuntimeServices().hookWorkbench;
}

export function getTestPluginManager(): PluginManager {
  return getTestRuntimeServices().pluginManager;
}

export function getTestMemoryEmbeddingRegistry(): MemoryEmbeddingProviderRegistry {
  return getTestRuntimeServices().memoryEmbeddingRegistry;
}

export function getTestVoiceProviderRegistry(): VoiceProviderRegistry {
  return getTestRuntimeServices().voiceProviders;
}

export function getTestMediaProviderRegistry(): MediaProviderRegistry {
  return getTestRuntimeServices().mediaProviders;
}

export function getTestWebSearchProviderRegistry(): WebSearchProviderRegistry {
  return getTestRuntimeServices().webSearchProviders;
}

export function getTestRemoteRunnerRegistry(): RemoteRunnerRegistry {
  return getTestRuntimeServices().remoteRunnerRegistry;
}

export function getTestRemoteSupervisor(): RemoteSupervisor {
  return getTestRuntimeServices().remoteSupervisor;
}

export function getTestToolLLM(): ToolLLM {
  const services = getTestRuntimeServices();
  if (!toolLLM || toolLLMRuntimeServices !== services) {
    toolLLM = new ToolLLM({
      configManager: services.configManager,
      providerRegistry: services.providerRegistry,
    });
    toolLLMRuntimeServices = services;
  }
  return toolLLM;
}

export function resetTestToolLLM(): void {
  toolLLM = null;
  toolLLMRuntimeServices = null;
}

export function getTestAutoHealer(): AutoHealer {
  autoHealer ??= new AutoHealer(getTestConfigManager(), getTestToolLLM());
  return autoHealer;
}

export function resetTestAutoHealer(): void {
  autoHealer = null;
}

export function getTestLspService(): LspService {
  lspService ??= new LspService(getTestRoots().shellPaths);
  return lspService;
}

export function resetTestLspService(): void {
  lspService = null;
}

export function getTestTreeSitterService(): TreeSitterService {
  treeSitterService ??= new TreeSitterService();
  return treeSitterService;
}

export function getTestCodeIntelligence(): CodeIntelligence {
  codeIntelligence ??= new CodeIntelligence({
    shellPaths: getTestRoots().shellPaths,
    treeSitter: getTestTreeSitterService(),
    lsp: getTestLspService(),
  });
  return codeIntelligence;
}

export function getTestIntelligenceShellPaths() {
  return getTestRoots().shellPaths;
}

export function resetTestCodeIntelligence(): void {
  codeIntelligence = null;
  treeSitterService = null;
  lspService = null;
}

export function getTestProcessManager(): ProcessManager {
  return getTestRuntimeServices().processManager;
}

export function resetTestProcessManager(): void {
  resetTestRuntimeServices();
}

export function getTestTaskScheduler(
  config?: string | ConstructorParameters<typeof TaskScheduler>[0],
): TaskScheduler {
  taskScheduler ??= new TaskScheduler(config ?? {
    storePath: join(getTestRoots().root, 'scheduler.json'),
    spawnTask: () => 'test-agent',
  });
  return taskScheduler;
}

export function resetTestTaskScheduler(): void {
  taskScheduler?.stop();
  taskScheduler = null;
}

export function getTestSpawnTokenManager(sessionId: string): SpawnTokenManager {
  const existing = spawnTokenManagers.get(sessionId);
  if (existing) return existing;
  const created = new SpawnTokenManager(sessionId);
  spawnTokenManagers.set(sessionId, created);
  return created;
}

export function resetTestSpawnTokenManagers(): void {
  spawnTokenManagers.clear();
}

export function getTestFeatureFlagManager(): FeatureFlagManager {
  featureFlags ??= createFeatureFlagManager();
  return featureFlags;
}

export function setTestFeatureFlagManager(manager: FeatureFlagManager): void {
  featureFlags = manager;
}

export function resetTestFeatureFlagManager(): void {
  featureFlags = null;
}

export function getTestProjectIndex(cwd: string): ProjectIndex {
  const existing = projectIndexes.get(cwd);
  if (existing) return existing;
  const created = new ProjectIndex(cwd);
  projectIndexes.set(cwd, created);
  return created;
}

export function resetTestProjectIndexes(): void {
  projectIndexes.clear();
}

export function getTestGitService(cwd = process.cwd()): GitService {
  const existing = gitServices.get(cwd);
  if (existing) return existing;
  const created = new GitService(cwd);
  gitServices.set(cwd, created);
  return created;
}

export function resetTestGitServices(cwd?: string): void {
  if (cwd) {
    gitServices.delete(cwd);
    return;
  }
  gitServices.clear();
}

export function resetAllTestServiceState(): void {
  // The two settings-routing clients are process-wide by design (five settings
  // writers reach them with no graph in scope), so a file that composed a
  // runtime would otherwise route every LATER file's secret and config writes
  // at a daemon that was never there, silently, since the refusal is a
  // rejected promise a keystroke handler swallows. Cleared first: routing is a
  // property of a live composed product, and a test that wants it installs its
  // own client and says so (see runtime/client-seams.test.ts).
  installAgentDaemonCredentialsClient(null);
  installAgentDaemonConfigClient(null);
  resetTestRuntimeServices();
  resetTestToolLLM();
  resetTestAutoHealer();
  resetTestCodeIntelligence();
  resetTestTaskScheduler();
  resetTestSpawnTokenManagers();
  resetTestFeatureFlagManager();
  resetTestProjectIndexes();
  resetTestGitServices();
}

// Auto-register a beforeEach reset so every test file that imports this helper
// starts with clean singleton state, without needing explicit reset calls.
// Files can still register additional beforeEach hooks, all registered hooks run.
beforeEach(() => {
  resetAllTestServiceState();
});

export function applyTestAgentExecutor(executor: AgentExecutor | null): void {
  agentExecutorForTests = executor;
  if (runtimeServices) {
    runtimeServices.agentManager.setExecutor(executor);
  }
}
