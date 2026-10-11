/** The actual local-turn producer shared by bootstrap and product regressions. */
import { registerAllTools, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { PermissionManager, createPermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { trustGatedAsk, type WorkspaceTrustLevel } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { readExecEnvScrubAllowlist } from '../input/exec-env-scrub-config.ts';
import { createSandboxExecAsk, sandboxExecAskDepsFromRuntime } from '../permissions/sandbox-exec-gate.ts';
import type { RuntimeServices } from './services.ts';

export function registerTuiTurnTools(toolRegistry: ToolRegistry, services: RuntimeServices, options: {
  readonly resolveSessionId: () => string;
  readonly onSandboxedRun?: NonNullable<Parameters<typeof registerAllTools>[1]>['onSandboxedRun'];
}) {
  return registerAllTools(toolRegistry, {
    resolveSessionId: options.resolveSessionId, surfaceRoot: services.surface.surfaceRoot, // task refs follow the LIVE runtime session (recovery reassigns it in place); without this they fall into the shared legacy namespace
    localhostFetchApproval: services.localhostFetchApproval, // loopback-fetch ask, built once in the services composition
    sandboxEscalationHandler: services.sandboxEscalationHandler,
    execPromptAnswerHandler: services.execPromptAnswerHandler, // terminal prompt-answer path, built once in the services composition
    fileUndoManager: services.fileUndoManager,
    modeManager: services.modeManager,
    processManager: services.processManager,
    agentManager: services.agentManager,
    agentMessageBus: services.agentMessageBus,
    archetypeLoader: services.archetypeLoader,
    projectRoot: services.workingDirectory,
    contractRunner: services.contractRunner,
    webSearchService: services.webSearchService,
    channelRegistry: services.channelPlugins,
    remoteRunnerRegistry: services.remoteRunnerRegistry,
    workflowServices: services.workflow,
    mcpRegistry: services.mcpRegistry,
    sessionOrchestration: services.sessionOrchestration,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    workingDirectory: services.workingDirectory,
    configManager: services.configManager,
    providerRegistry: services.providerRegistry,
    toolLLM: services.toolLLM,
    featureFlags: services.featureFlags,
    serviceRegistry: services.serviceRegistry,
    overflowHandler: services.overflowHandler,
    changeTracker: services.sessionChangeTracker,
    // Widens the allowlist of credential-looking variable NAMES kept (master switch stays on). See exec-env-scrub-config.ts.
    credentialEnvScrub: { allowlist: readExecEnvScrubAllowlist(services.configManager) },
    // Register context_accounting against OUR holder (the Orchestrator-backed source bound at bootstrap.ts). See runtime/context-accounting-source.ts.
    contextAccountingHolder: services.contextAccountingHolder,
    // First contained (sandboxed) command run announces "commands now run contained" once, recorded and surfaced now.
    onSandboxedRun: options.onSandboxedRun,
  });
}

export function createTuiTurnPermissionManager(services: RuntimeServices, requestTrustDecision: () => Promise<WorkspaceTrustLevel>): PermissionManager {
  return new PermissionManager(
    // Composed ask layer: the workspace trust gate (outer) wraps the sandbox-aware exec gate (inner); see sandbox-exec-gate.ts. The catastrophic block is untouched. The innermost ask is the CLIENT raiser: it posts approvals.raise to the daemon and prompts here (see the SDK's platform/runtime/client/approval-raiser.ts).
    trustGatedAsk(
      services.workspaceTrustManager,
      createSandboxExecAsk(
        sandboxExecAskDepsFromRuntime(services.configManager, services.featureFlags),
        (request) => services.requestApproval({ request }),
      ),
      requestTrustDecision, // indirection through the ref, not bound early. main.ts patches the real impl in later
    ),
    createPermissionConfigReader(services.configManager),
    services.policyRuntimeState,
    services.hookDispatcher,
    services.featureFlags,
    services.userPermissionRuleStore,
    { workspaceTrust: services.workspaceTrustManager },
  );
}
