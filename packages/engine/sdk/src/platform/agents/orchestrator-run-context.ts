// The context runAgentTask (orchestrator-runner.ts) runs an agent in: the
// emitters, registries and seams AgentOrchestrator.createRunContext wires.
// Split out of orchestrator-runner.ts, which re-exports it unchanged.
import type { ConversationMessageSnapshot } from '../core/conversation.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProviderOptimizer } from '../providers/optimizer.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { LLMProvider } from '../providers/interface.js';
import type { ProcessManager } from '../tools/shared/process-manager.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { ProgressAudience } from './orchestrator-utils.js';
import type { AgentMessageBus } from './message-bus.js';
import type { KnowledgeService } from '../knowledge/index.js';
import type { BackgroundPermissionManager } from './background-permission-gate.js';
import type { ContractAgentHooks } from '../contract/agent-hooks.js';

type EmitterContext = import('../runtime/emitters/index.js').EmitterContext;

export interface AgentOrchestratorRunContext {
  readonly workingDirectory: string;
  readonly surfaceRoot?: string | undefined;
  /** At-rest journal redaction + retention policy; undefined -> honest default (redaction on). */
  readonly atRestPolicy?: import('../runtime/at-rest-persistence.js').AtRestPolicy | undefined;
  readonly runtimeBus: RuntimeEventBus | null;
  readonly featureFlagManager: FeatureFlagManager | null;
  readonly emitterContext: (agentId: string) => EmitterContext;
  readonly emitAgentProgress: (recordId: string, progress: string, audience: ProgressAudience) => void;
  readonly emitOrchestrationProgress: (record: AgentRecord, progress: string) => void;
  readonly emitAgentStarted: (recordId: string) => void;
  readonly emitAgentCancelledEvent: (recordId: string, reason: string) => void;
  readonly emitOrchestrationCancelled: (record: AgentRecord, reason: string) => void;
  readonly emitAgentFailedEvent: (recordId: string, error: string, durationMs: number) => void;
  readonly emitOrchestrationFailed: (record: AgentRecord, error: string) => void;
  readonly emitAgentCompletedEvent: (
    recordId: string,
    durationMs: number,
    output: string,
    toolCallsMade: number,
    usage: AgentRecord['usage'] | undefined,
  ) => void;
  readonly emitOrchestrationCompleted: (record: AgentRecord, output: string) => void;
  readonly emitStreamDelta: (recordId: string, content: string, accumulated: string) => void;
  /**
   * Conversation-snapshot bridge (Part C6): register the running
   * agent's live snapshot accessor with AgentManager so
   * AgentManager.getConversationSnapshot(agentId) can serve a full-fidelity
   * live transcript to a fleet tab. Optional, contexts that don't wire a
   * manager (e.g. isolated tests) simply skip the bridge.
   */
  readonly registerConversationSource?: ((agentId: string, source: () => ConversationMessageSnapshot[]) => void) | undefined;
  /**
   * Release the live source at run end, freezing one final snapshot into
   * AgentManager's bounded retention ring (see manager.ts). Always safe to
   * call even when register was never called for this agentId.
   */
  readonly releaseConversationSource?: ((agentId: string) => void) | undefined;
  /**
   * Cooperative cancellation bridge: look up the AbortSignal
   * an orchestration-engine work item registered for this agent, if any.
   * Threaded into `toolRegistry.execute` opts so opted-in tools (exec,
   * fetch) can abort an in-flight child process/request the instant
   * `engine.kill(itemId)` fires, instead of waiting for the next turn
   * boundary's `record.status === 'cancelled'` poll below. Optional,
   * contexts that don't wire an orchestration engine simply omit it and
   * every tool call runs with `opts` undefined, unchanged from before.
   */
  readonly getCancellationSignal?: ((agentId: string) => AbortSignal | undefined) | undefined;
  readonly processManager?: ProcessManager | undefined;
  readonly messageBus: Pick<AgentMessageBus, 'getMessages'>;
  readonly knowledgeService?: Pick<KnowledgeService, 'buildPromptPacketSync'> | undefined;
  readonly memoryRegistry?: Pick<import('../state/index.js').MemoryRegistry, 'getAll' | 'searchSemantic' | 'vectorStats'> | undefined;
  /**
   * Stage B, repo code index for per-turn code injection in a spawned agent run.
   * Undefined is a hard no-op. Actual injection additionally requires the
   * `agent-passive-code-injection` flag (DEFAULT OFF) and `isCodeInjectionSettingEnabled`.
   */
  readonly codeIndex?: import('./turn-knowledge-injection.js').TurnCodeIndexSource | undefined;
  /** Live gate for the embedder's storage.codeIndexEnabled setting. Undefined defaults to allowed. */
  readonly isCodeInjectionSettingEnabled?: (() => boolean) | undefined;
  /**
   * Stage B, called once per executed tool (toolName, args, success) so a code-index
   * reindex scheduler can debounce an incremental reindex of touched files. Never awaited.
   */
  readonly onToolExecuted?: ((toolName: string, args: Record<string, unknown>, success: boolean) => void) | undefined;
  /**
   * The contract runner's seams (contract/agent-hooks.ts), called only for an
   * agent whose record carries a `contractUnitId`: `onTurnEnd` after each turn's
   * tool results join the conversation (never awaited), and `holdCompletion`
   * when the agent would complete (awaited; `continue` keeps the loop open with
   * the nudge as the next user turn). Undefined leaves every agent unheld.
   */
  readonly contractHooks?: ContractAgentHooks | undefined;
  /**
   * Per-turn passive-injection knobs (see CHANGELOG 0.38.0). Both optional,
   * undefined means "use the derived default" (see turn-knowledge-injection.ts:
   * defaultTurnKnowledgeBudgetTokens / DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR).
   * Setting passiveKnowledgeInjectionBudgetTokens to 0 is the config-level
   * hard no-op: the feature never runs and the base system prompt is
   * byte-identical, independent of the capability gate's own state.
   */
  readonly passiveKnowledgeInjectionBudgetTokens?: number | undefined;
  readonly passiveKnowledgeInjectionRelevanceFloor?: number | undefined;
  /**
   * Optional config source. When present, supplies the DEFAULT passive-injection
   * budget ceiling / relevance floor / code-chunk limit (agents.passiveInjection.*)
   * and the context-window compaction threshold (agents.contextCompactThreshold).
   * Explicit passiveKnowledgeInjection* context fields still override, and the
   * module constants remain the final fallback when no config source is supplied,
   * the config defaults equal those constants, so behaviour is unchanged by default.
   */
  readonly configManager?: Pick<import('../config/manager.js').ConfigManager, 'get'> | undefined;
  readonly archetypeLoader?: { loadArchetype(template: string): { systemPrompt?: string | undefined } | null | undefined } | undefined;
  /**
   * Permission gate for this run's background/subagent tool calls (see
   * gateBackgroundToolCall in background-permission-gate.ts). Undefined leaves
   * the run ungated (e.g. isolated tests that wire no manager).
   */
  readonly permissionManager?: BackgroundPermissionManager | undefined;
  readonly getFullRegistry: () => ToolRegistry;
  readonly buildScopedRegistry: (allowedNames: string[], fullRegistry: ToolRegistry, captureAuthority?: import('../personal-capture/index.js').CaptureAuthorityDecision | undefined) => ToolRegistry;
  readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'listModels' | 'getContextWindowForModel' | 'recordContextWindowRejection'>;
  readonly providerOptimizer?: Pick<ProviderOptimizer, 'recordFallbackTransition'> | undefined;
  readonly resolveProviderForRecord: (
    providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'listModels'>,
    record: AgentRecord,
    currentModel: { id: string; provider: string; registryKey: string },
  ) => { provider: LLMProvider; modelId: string; requestedModelId: string };
  readonly resolveFallbackModelRoutes: (
    providerRegistry: Pick<ProviderRegistry, 'listModels' | 'getForModel'>,
    record: AgentRecord,
    currentModel: { id: string; provider: string; registryKey: string },
    primaryRequestedModelId: string,
  ) => Array<{ provider: LLMProvider; modelId: string; requestedModelId: string }>;
}
