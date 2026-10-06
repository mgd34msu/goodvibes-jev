import type { AutonomousToolSource } from '../permissions/autonomous.js';
import { revalidateNativeConversationTurnPermit, type NativeConversationTurnPermit } from '../workflow/work-ledger/native-intake-client.js';
import { admitNativeConversationTurn, failNativeConversationTurn, NativeConversationTurnAdmissionError, readNativeConversationTurnStatus, settleNativeConversationTurn, startNativeConversationTurn, validateNativeConversationTurn, type NativeConversationTurnAdmission } from './native-turn-admission.js';
import { isNativeConversationTurn, markNativeConversationTurnEffectsPossible, nativeConversationTurnCanRetry, NATIVE_TURN_EXECUTION_REFUSAL, withNativeConversationTurn, withoutNativeConversationTurn } from './native-turn-scope.js';
import { TurnHookOwner, bindTurnHookDispatcher } from '../hooks/turn-ownership.js';
import { TurnCancellationFence, type TurnCancellationResult } from './turn-cancellation.js';
import { resolveSystemPrompt } from './orchestrator-system-prompt.js';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { JudgmentInputError } from '../gate/judgment-input.js';
import type { ClassificationResult } from './intent-classifier.js';
import { PlannerJudgmentError } from './adaptive-planner.js';
import type { ConversationManager } from './conversation.js';
import { resolveCompactionStrategy } from './conversation-compaction.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import { ProviderError, isNonTransientProviderFailure } from '../types/errors.js';
import type { HookEvent, HookResult } from '../hooks/types.js';
import { readFormattedError, summarizeError } from '../utils/error-display.js';
import type { ModelDefinition } from '../providers/registry.js';
import type { ContentPart } from '../providers/interface.js';
import { notifyCompletion } from '../utils/notify.js';
import { logger } from '../utils/logger.js';
import type { PermissionManager } from '../permissions/manager.js';
import { startTurnForOwnerInput, withTurnSurface } from '../security/turn-boundary.js';
import {
  isPassiveCodeInjectionEnabled,
  isPassiveKnowledgeInjectionEnabled,
  isReconciliationEnabled,
  turnFlagSources,
  type TurnFlagSources,
} from './orchestrator-turn-flags.js';
import { appendPlanModeInstruction } from '../permissions/plan-mode-instructions.js';
import type { AcpManager } from '../acp/manager.js';
import type { SubagentTask } from '../acp/protocol.js';
import type { ExecutionPlan, PlanItem } from './execution-plan.js';
import { estimateConversationTokens } from './context-compaction.js';
import { SessionLineageTracker } from './session-lineage.js';
import { EventReplayQueue } from './event-replay.js';
import type { ConversationFollowUpItem } from './conversation-follow-ups.js';
import { OrchestratorFollowUpRuntime } from './orchestrator-follow-up-runtime.js';
import { ToolCallAbortRegistry, listQueuedMessages, editQueuedMessage, deleteQueuedMessage } from './orchestrator-live-turn.js';
import { AgentManager } from '../tools/agent/index.js';
import type { ContractIntake, ContractRunner } from '../contract/index.js';
import { randomUUID, createHash } from 'node:crypto';
import { CacheHitTracker } from '../providers/cache-strategy.js';
import { IdempotencyStore } from '../runtime/idempotency/index.js';
import { toolFormatTelemetry } from '../runtime/telemetry/tool-format-telemetry.js';
import { type ReconciliationReason } from './tool-reconciliation.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/manager.js';
import type { CompactionManager } from '../runtime/compaction/index.js';
import { createSessionCompactionManager } from './compaction-lifecycle-route.js';
import type { RuntimeEventBus, TurnInputOrigin } from '../runtime/events/index.js';
import { HelperModel } from '../config/helper-model.js';
import {
  emitPreflightFail,
  emitQueuedMessagesChanged,
  emitStreamEnd,
  emitTurnCancel,
  emitTurnError,
  emitTurnSubmitted,
} from '../runtime/emitters/index.js';
import {
  autoSpawnPendingItems,
  executeToolCalls,
  reconcileUnresolvedToolCalls,
} from './orchestrator-tool-runtime.js';
import {
  checkContextWindowPreflight,
  emitContextOverflowError,
  handlePostTurnContextMaintenance,
} from './orchestrator-context-runtime.js';
import {
  createEmitterContext,
  estimateFreshTurnInputTokens,
  getCacheHitTracker,
  getIdempotencyStore,
  getSessionLineageTracker,
  normalizeUsage,
  requireConfigManager,
  requireProviderRegistry,
  type OrchestratorCoreServices,
} from './orchestrator-runtime.js';
import {
  type ChatResponseWithReasoning,
  maybeEmitAdaptivePlannerDecision,
  prepareConversationForTurn,
} from './orchestrator-turn-helpers.js';
import { executeOrchestratorTurnLoop } from './orchestrator-turn-loop.js';
import { recordTurnInjection, type TurnInjectionRecord } from '../agents/turn-knowledge-injection.js';
import type { OrchestratorUsageTotals } from './orchestrator-usage.js';

/** Minimal interface for hook dispatch, allows any hook dispatcher implementation */
interface HookDispatcherLike {
  fire(event: HookEvent): Promise<HookResult>;
}

/** Delay (ms) before auto-spawning plan items if the model ends its turn without spawning them. */
const AUTO_SPAWN_FALLBACK_DELAY_MS = 5_000;
const THINKING_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface LowPrioritySystemMessageSink {
  low(message: string): void;
}

export interface OrchestratorUserInputOptions {
  readonly origin?: TurnInputOrigin | undefined;
  readonly nativeConversationTurnPermit?: NativeConversationTurnPermit | undefined;
  /** Host-owned dispatch must wait for execution, never mistake queue acceptance for completion. */
  readonly requireImmediateNativeTurn?: boolean | undefined;
}

/**
 * Options for constructing an {@link Orchestrator}: the conversation, viewport
 * callbacks, tool registry, permission manager, system-prompt getter, hook
 * dispatcher, flag manager, render callback, runtime bus, and services
 * (agentManager, contractRunner, contractIntake).
 */
export interface OrchestratorOptions {
  /** Manages the conversation message history. */
  conversation: ConversationManager;
  /** Returns the current viewport height in rows/px for scrolling calculations. */
  getViewportHeight: () => number;
  /** Scrolls the UI to the given viewport height after a turn. */
  scrollToEnd: (vHeight: number) => void;
  /** Registry of all available tools. */
  toolRegistry: ToolRegistry;
  /** Manages tool-use permission grants and denials. */
  permissionManager: PermissionManager;
  /** Resolves the current system prompt before each request. Receives the operation's cancellation signal. Defaults to `() => ''`. */
  getSystemPrompt?: ((signal?: AbortSignal) => string | Promise<string>) | undefined;
  /** Optional hook dispatcher for lifecycle events. */
  hookDispatcher?: HookDispatcherLike | null | undefined;
  /** Optional capability-gate manager. */
  flagManager?: FeatureFlagManager | null | undefined;
  /** Optional render request callback, called after state changes requiring a redraw. */
  requestRender?: (() => void) | null | undefined;
  /** Optional runtime event bus for cross-system event propagation. */
  runtimeBus?: RuntimeEventBus | null | undefined;
  /**
   * Stable session id used in runtime events, hook events, idempotency keys,
   * plans, and reply correlation. Defaults to a generated private id.
   */
  sessionId?: string | undefined;
  /**
   * Per-turn passive-injection budget override for the main session,
   * mirroring agents/orchestrator-runner.ts's `passiveKnowledgeInjectionBudgetTokens`.
   * Omitted uses the derived default (defaultTurnKnowledgeBudgetTokens). `0` is a hard
   * no-op, independent of the capability gate's own state.
   */
  passiveKnowledgeInjectionBudgetTokens?: number | undefined;
  /**
   * Per-turn passive-injection relevance-floor override for the main
   * session, mirroring agents/orchestrator-runner.ts's
   * `passiveKnowledgeInjectionRelevanceFloor`. Omitted uses DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR.
   */
  passiveKnowledgeInjectionRelevanceFloor?: number | undefined;
  /** Required runtime service dependencies. */
  services: {
    readonly agentManager: Pick<AgentManager, 'list' | 'spawn'>;
    readonly contractRunner: Pick<ContractRunner, 'list'>;
    /** Reads each user turn before the model is called (contract runner design 10.3); built with createContractIntake. */
    readonly contractIntake: ContractIntake;
  };
}

/**
 * Orchestrator - Manages LLM turn lifecycle with full tool-use loop.
 * Supports multi-turn agent loops: call LLM -> execute tools -> send results -> repeat.
 */
export class Orchestrator {
  public isThinking = false;
  public thinkingFrame = 0;
  public usage: OrchestratorUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /**
   * Input tokens from the most recent LLM response (incl. cache read/write),
   * current context-window usage; 0 before the first response.
   */
  public lastInputTokens = 0;
  /** Fresh input tokens from the most recent turn (excluding cache-read reuse where applicable). */
  public lastRequestInputTokens = 0;
  /** Approximate input tokens for the current streaming turn (from prior turn's response). */
  public streamingInputTokens = 0;
  /** Output tokens received so far in the current streaming turn (one per delta chunk). */
  public streamingOutputTokens = 0;
  public messageQueue: { id: string; queuedAt: number; text: string; content?: ContentPart[] | undefined; options?: OrchestratorUserInputOptions | undefined; nativeTurn?: NativeConversationTurnAdmission | undefined }[] = [];

  private animInterval: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;
  private disposed = false;
  /** Per-tool-call abort registry (per-call cancel; see orchestrator-live-turn.ts). */
  private readonly toolCallAborts = new ToolCallAbortRegistry();
  /** Monotonic id source for queued-message ids. */
  private queuedMessageSeq = 0;
  private autoSpawnTimeout: ReturnType<typeof setTimeout> | null = null;
  private nativeConversationProjectId: string | undefined;
  private activeNativeConversationTurn = false;
  private activeNativeConversationPermit: NativeConversationTurnPermit | undefined;
  private nativeAdmissionAbort: AbortController | null = null;
  private acpManager: AcpManager | null = null;
  /** Message count at the start of a turn, used to rollback on cancel. */
  private turnStartMessageCount = 0;
  /** Whether a streaming block is currently active (for cleanup on abort). */
  private isStreaming = false;
  /** Last token warning bracket (multiples of 10%) to avoid repeat warnings at same level. */
  private lastWarningBracket = 0;
  /** Whether auto-compaction is currently in progress (prevents re-entry). */
  private isCompacting = false;
  /**
   * Pending context-window warning reported by the model/provider itself
   * (stop reason, see isContextOverflowSignal). While set, the next preflight
   * or post-turn maintenance pass compacts immediately regardless of locally
   * estimated usage; cleared when that compaction starts.
   */
  private modelContextWarning: import('./orchestrator-context-runtime.js').ModelContextWarning | null = null;

  /** Session ID for runtime and hook events. */
  private readonly sessionId: string;

  /**
   * Submission key for the active turn: generated per runTurn, used as the
   * idempotency key of the turn-level dedup fence (a duplicate in-flight
   * runTurn with the same text is rejected), reset to null on completion.
   */
  public currentSubmissionKey: string | null = null;

  /** True when the turn failed (set in catch; read in finally for markComplete vs markFailed). */
  private _turnFailed = false;

  /** Event replay queue, ensures model acknowledges significant events */
  private readonly replayQueue: EventReplayQueue;

  /** Cleanup function returned by the active replay queue attachment. */
  private detachReplay: (() => void) | null = null;
  private readonly runtimeBus: RuntimeEventBus | null;
  private readonly agentManager: Pick<AgentManager, 'list' | 'spawn'>;
  private readonly contractRunner: Pick<ContractRunner, 'list'>;
  private readonly contractIntake: ContractIntake;
  private coreServices: OrchestratorCoreServices = {};
  private readonly ownedSessionLineageTracker = new SessionLineageTracker();
  private readonly ownedIdempotencyStore = new IdempotencyStore();
  private readonly ownedCacheHitTracker = new CacheHitTracker();

  /**
   * Optional capability-gate manager: the `tool-result-reconciliation` flag is
   * consulted at each turn end (enabled = full reconciliation); null defaults
   * to enabled, matching the flag's declared defaultState.
   */
  private flagManager: FeatureFlagManager | null = null;

  /** This session's compaction lifecycle owner (compaction-lifecycle-route.ts); dispose() releases it. */
  private readonly compactionManager: CompactionManager | null;
  /**
   * Tracks the last provider response's tool calls within the current turn
   * iteration so the reconciliation pass can detect unresolved calls when
   * the loop exits early.
   */
  private _pendingToolCalls: ToolCall[] = [];
  private readonly requestRender: () => void;
  private systemMessageRouter: LowPrioritySystemMessageSink | null = null;
  private readonly followUpRuntime: OrchestratorFollowUpRuntime;

  private conversation: ConversationManager;
  private getViewportHeight: () => number;
  private scrollToEnd: (vHeight: number) => void;
  private toolRegistry: ToolRegistry;
  private permissionManager: PermissionManager;
  private getSystemPrompt: (signal?: AbortSignal) => string | Promise<string>;
  private hookDispatcher: HookDispatcherLike | null;

  /**
   * Per-turn passive-injection state for the MAIN interactive session,
   * see core/orchestrator-turn-loop.ts for the retrieval/budget wiring that reads and
   * mutates these. `turnKnowledgeIdsAlreadySurfaced` has no spawn-time baseline (unlike
   * an AgentRecord's `knowledgeInjections`) so it starts empty and grows monotonically
   * for the life of this Orchestrator. `turnInjectionRing` backs the public
   * `getTurnInjections()` accessor.
   */
  private readonly turnKnowledgeIdsAlreadySurfaced = new Set<string>();
  private turnInjectionRing: TurnInjectionRecord[] = [];
  private turnKnowledgeSequence = 0;
  private readonly passiveKnowledgeInjectionBudgetTokens: number | undefined;
  private readonly passiveKnowledgeInjectionRelevanceFloor: number | undefined;

  /** Construct an Orchestrator using a named-options object ({@link OrchestratorOptions}). */
  constructor(options: OrchestratorOptions) {
    const {
      conversation,
      getViewportHeight,
      scrollToEnd,
      toolRegistry,
      permissionManager,
      getSystemPrompt = () => '',
      hookDispatcher = null,
      flagManager = null,
      requestRender = null,
      runtimeBus = null,
      sessionId,
      passiveKnowledgeInjectionBudgetTokens,
      passiveKnowledgeInjectionRelevanceFloor,
      services,
    } = options;
    this.passiveKnowledgeInjectionBudgetTokens = passiveKnowledgeInjectionBudgetTokens;
    this.passiveKnowledgeInjectionRelevanceFloor = passiveKnowledgeInjectionRelevanceFloor;
    this.sessionId = sessionId?.trim() || randomUUID();
    this.conversation = conversation;
    this.getViewportHeight = getViewportHeight;
    this.scrollToEnd = scrollToEnd;
    this.toolRegistry = toolRegistry;
    this.permissionManager = permissionManager;
    // Plan-mode standing instruction rides on the system prompt (told every turn + re-injected through compaction).
    this.getSystemPrompt = async (signal) => appendPlanModeInstruction(
      await resolveSystemPrompt(getSystemPrompt, signal), this.permissionManager.getMode?.(),
    );
    this.hookDispatcher = hookDispatcher;
    this.replayQueue = new EventReplayQueue();
    this.detachReplay = runtimeBus
      ? EventReplayQueue.attachToRuntimeBus(runtimeBus, this.replayQueue)
      : null;
    this.flagManager = flagManager; this.requestRender = requestRender ?? (() => {});
    this.runtimeBus = runtimeBus;
    this.compactionManager = createSessionCompactionManager(this.sessionId, runtimeBus, flagManager, () => this.coreServices.providerRegistry);
    this.agentManager = services.agentManager; this.contractRunner = services.contractRunner; this.contractIntake = services.contractIntake;
    this.followUpRuntime = new OrchestratorFollowUpRuntime({
      conversation: this.conversation,
      getViewportHeight: () => this.getViewportHeight(),
      scrollToEnd: (height) => this.scrollToEnd(height),
      getSystemPrompt: (signal) => this.getSystemPrompt(signal),
      requestRender: () => this.requestRender(),
      getThinkingState: () => ({ isThinking: this.isThinking || this.turnInFlight || this.activeNativeConversationTurn, isCompacting: this.isCompacting }),
      getQueuedUserMessageCount: () => this.messageQueue.length,
      getProviderRegistry: () => requireProviderRegistry(this.coreServices),
      getCurrentModel: () => requireProviderRegistry(this.coreServices).getCurrentModel(),
      routeLowPriorityMessage: (message) => {
        if (this.systemMessageRouter) this.systemMessageRouter.low(message);
        else this.conversation.addSystemMessage(message);
      },
      applyUsage: (usage) => {
        this.usage.input += usage.inputTokens;
        this.usage.output += usage.outputTokens;
        this.usage.cacheRead += usage.cacheReadTokens ?? 0;
        this.usage.cacheWrite += usage.cacheWriteTokens ?? 0;
      },
    });
  }

  /** This session's CompactionManager, or null when composed without a runtime bus or capability gates. */
  public getCompactionManager(): CompactionManager | null { return this.compactionManager; }

  public setCoreServices(services: OrchestratorCoreServices): void {
    this.coreServices = {
      ...this.coreServices,
      ...services,
    };
    // Bind this orchestrator as the daemon's live-turn control target so remote
    // surfaces can cancel one in-flight tool call and manage the queued-message
    // list over the operator wire. dispose() unbinds.
    this.coreServices.sessionLiveTurnControls?.bind(this);
  }

  /**
   * Attach an AcpManager and register the 'delegate' tool into the ToolRegistry.
   * Call this after construction, before the first turn.
   */
  public registerDelegateTool(manager: AcpManager): void {
    this.acpManager = manager;

    this.toolRegistry.register({
      definition: {
        name: 'delegate',
        description:
          'Delegate a task to a subagent child process via ACP. ' +
          'The subagent runs autonomously and reports results when complete. ' +
          'Returns the subagent ID immediately; results are delivered via subagent events.',
        parameters: {
          type: 'object',
          required: ['description', 'context', 'tools'],
          properties: {
            description: {
              type: 'string',
              description: 'Clear description of the task for the subagent to complete.',
            },
            context: {
              type: 'string',
              description: 'Additional context, constraints, or background information.',
            },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tool names the subagent is allowed to use.',
            },
            model: {
              type: 'string',
              description: 'Optional model override (e.g. "claude-sonnet-4-5").',
            },
            provider: {
              type: 'string',
              description: 'Optional provider override (e.g. "anthropic").',
            },
          },
        },
      },
      execute: async (args): Promise<{ success: boolean; output: string }> => {
        if (isNativeConversationTurn()) return { success: false, output: NATIVE_TURN_EXECUTION_REFUSAL };
        if (!this.acpManager) {
          return { success: false, output: 'ACP manager not initialized' };
        }
        const configManager = requireConfigManager(this.coreServices);
        const workingDirectory = configManager.getWorkingDirectory();
        if (!workingDirectory) {
          return { success: false, output: 'ACP manager requires an explicit working directory.' };
        }

        const task: SubagentTask = {
          description: String(args.description ?? ''),
          context: String(args.context ?? ''),
          tools: Array.isArray(args.tools) ? args.tools.map(String) : [],
          workingDirectory,
          model: args.model ? String(args.model) : undefined,
          provider: args.provider ? String(args.provider) : undefined,
        };

        const id = await this.acpManager.spawn(task);
        return {
          success: true,
          output: `Subagent spawned with ID: ${id}. Task: "${task.description}". The subagent is running in the background.`,
        };
      },
    });
  }

  public getSpinner(): string {
    return THINKING_SPINNER_FRAMES[this.thinkingFrame % THINKING_SPINNER_FRAMES.length]!;
  }

  /**
   * Bounded ring of per-turn passive-injection honesty records for the
   * MAIN interactive session, the main-session counterpart to `AgentRecord.turnInjections`
   * on the agent path. There is no AgentRecord for the primary conversation, so this is the exact
   * accessor a `/recall`-style renderer should read as the main-session default when no
   * agent id is given. See agents/turn-knowledge-injection.ts for the record shape and
   * recordTurnInjection for the ring-eviction policy (same bounded size as the agent path).
   */
  public getTurnInjections(): readonly TurnInjectionRecord[] {
    return this.turnInjectionRing;
  }

  public setSystemMessageRouter(router: LowPrioritySystemMessageSink | null): void {
    this.systemMessageRouter = router;
  }

  public enqueueConversationFollowUp(item: ConversationFollowUpItem): void {
    this.followUpRuntime.enqueue(item);
  }

  /**
   * Cancel ONE in-flight tool call by its callId, leaving the turn and any
   * other running calls untouched: the cancelled call settles as a structured
   * "cancelled by user" result the model adapts to in the same turn.
   */
  public cancelToolCall(callId: string): boolean {
    return this.toolCallAborts.cancel(callId);
  }

  /** The callIds of tool calls currently in flight (cancellable via cancelToolCall). */
  public listRunningToolCalls(): readonly string[] {
    return this.toolCallAborts.list();
  }

  /** The pending (undelivered, still editable) mid-turn messages, in delivery order. */
  public listQueuedMessages(): ReadonlyArray<{ id: string; queuedAt: number; text: string }> {
    return listQueuedMessages(this.messageQueue);
  }

  /** Replace a still-queued message's text; false once delivered (immutable). */
  public editQueuedMessage(id: string, text: string): boolean {
    if (this.messageQueue.some(message => message.id === id && message.nativeTurn)) return false;
    const edited = editQueuedMessage(this.messageQueue, id, text);
    if (edited) {
      this.emitQueueChange('edited', id);
      this.requestRender();
    }
    return edited;
  }

  /** Remove a still-queued message before delivery; false once delivered. */
  public deleteQueuedMessage(id: string): boolean {
    const nativeTurn = this.messageQueue.find(message => message.id === id)?.nativeTurn;
    const deleted = deleteQueuedMessage(this.messageQueue, id);
    if (deleted && nativeTurn) settleNativeConversationTurn(nativeTurn);
    if (deleted) {
      this.emitQueueChange('deleted', id);
      this.requestRender();
    }
    return deleted;
  }

  /** Broadcast a pending-queue mutation as a runtime.session event (wire-honest). */
  private emitQueueChange(action: 'enqueued' | 'edited' | 'deleted' | 'delivered', messageId: string): void {
    if (!this.runtimeBus) return;
    emitQueuedMessagesChanged(this.runtimeBus, createEmitterContext(this.sessionId, 'queue'), {
      sessionId: this.sessionId, action, messageId, pendingCount: this.messageQueue.length,
    });
  }

  private readonly turnCancellation = new TurnCancellationFence();
  private turnHookOwner: TurnHookOwner | null = null;

  /** Compare and request cancellation synchronously; terminal events establish settlement. */
  public cancelTurn(expectedTurnId: string): TurnCancellationResult {
    return this.turnCancellation.cancel(expectedTurnId);
  }

  /** Abort the current in-flight LLM request, if any. */
  public abort(): void {
    this.nativeAdmissionAbort?.abort();
    this.abortController?.abort();
    this.followUpRuntime?.cancel();
    // A whole-turn abort also cancels every in-flight tool call, so cooperative
    // tools (exec children, fetches) stop instead of running to completion.
    // (Optional-chained: bare-prototype test fixtures skip field initializers.)
    this.toolCallAborts?.abortAll();
    if (this.autoSpawnTimeout !== null) {
      clearTimeout(this.autoSpawnTimeout);
      this.autoSpawnTimeout = null;
    }
    // Clear the thinking-animation interval immediately on abort so the Node
    // event loop is not kept alive by a leaked timer. stopThinking() also
    // clears this in the finally block, but abort() can be called from
    // outside the turn loop (e.g. user keypress during startup) where
    // stopThinking() may never be reached.
    if (this.animInterval !== null) {
      clearInterval(this.animInterval);
      this.animInterval = null;
    }
    this.isThinking = false;
  }

  /**
   * Dispose long-lived runtime attachments owned by this orchestrator.
   *
   * Safe to call multiple times. Intended for process shutdown and tests that
   * construct transient orchestrators against a shared RuntimeEventBus.
   */
  public dispose(): void {
    this.disposed = true;
    this.coreServices.sessionLiveTurnControls?.unbind(this);
    this.abort();
    for (const queued of this.messageQueue) if (queued.nativeTurn) failNativeConversationTurn(queued.nativeTurn, false);
    if (this.animInterval) {
      clearInterval(this.animInterval);
      this.animInterval = null;
    }
    this.isThinking = false;
    this.isStreaming = false;
    this.streamingInputTokens = 0;
    this.streamingOutputTokens = 0;
    if (this.detachReplay) {
      this.detachReplay();
      this.detachReplay = null;
    }
    this.followUpRuntime.dispose();
    this.compactionManager?.dispose();
  }

  /**
   * handleUserInput - Entry point for a user-submitted message.
   * Queues if already thinking, otherwise kicks off the LLM turn.
   * @param text - Plain text representation (for display and queuing).
   * @param content - Optional ContentPart[] for multimodal messages.
   * @param options - Optional origin metadata for external surfaces.
   */
  public async handleUserInput(
    text: string,
    content?: ContentPart[],
    options?: OrchestratorUserInputOptions | undefined,
  ): Promise<void> {
    // Authenticate and detach before any queue, transcript, or event mutation.
    if (options?.nativeConversationTurnPermit) {
      if (!this.nativeConversationProjectId) throw new NativeConversationTurnAdmissionError('identity_mismatch');
      validateNativeConversationTurn(options.nativeConversationTurnPermit, text, content, this.nativeConversationProjectId);
      if (options.requireImmediateNativeTurn && (this.disposed || this.turnInFlight || this.activeNativeConversationTurn || this.isThinking || this.isCompacting)) {
        throw new NativeConversationTurnAdmissionError('recovery_required');
      }
    }
    if (this.disposed) return;
    if (!text.trim() && !content?.length) return;
    const nativeTurn = options?.nativeConversationTurnPermit
      ? admitNativeConversationTurn(options.nativeConversationTurnPermit, text, content, this.nativeConversationProjectId) : undefined;
    if (nativeTurn === null) return;
    options = options ? Object.freeze({ ...options, ...(options.origin ? { origin: Object.freeze({ ...options.origin }) } : {}) }) : undefined;
    if (nativeTurn && content) content = [{ type: 'text', text }];

    if (this.turnInFlight || this.activeNativeConversationTurn || this.isThinking || this.isCompacting) {
      this.queuedMessageSeq += 1;
      const id = `qm-${this.queuedMessageSeq}`;
      this.messageQueue.push({ id, queuedAt: Date.now(), text, content, options, nativeTurn });
      this.emitQueueChange('enqueued', id);
      this.requestRender();
      return;
    }

    // Set the original task on the first user message (idempotent, subsequent calls are no-ops)
    getSessionLineageTracker(this.coreServices, this.ownedSessionLineageTracker).setOriginalTask(text.slice(0, 200));

    // Process any messages queued while the LLM was thinking. Draining is gated on
    // isCompacting so a queued turn cannot start while a background auto-compaction is
    // mid-flight (which would let compact() replace the message array and drop the
    // in-flight turn's freshly appended messages). Messages left queued during
    // compaction are drained by setCompacting() once compaction settles.
    try { await withTurnSurface(options?.origin, () => this.runTurn(text, content, options, nativeTurn)); }
    finally {
      if (options?.requireImmediateNativeTurn && nativeTurn) {
        // The native owner joins only this input. Other queued turns have their
        // own lifetime and must not become this dispatch's completion/cancel target.
        void this.drainMessageQueue().catch(error => logger.warn('Queued turn failed after native delivery', { error: summarizeError(error) }));
      } else await this.drainMessageQueue();
    }
  }

  /** A native owner may cancel only its exact active, nonserialized permit. */
  public cancelNativeConversationTurn(permit: NativeConversationTurnPermit): boolean {
    if (this.activeNativeConversationPermit !== permit) return false;
    this.abort(); return true;
  }

  /** Provider failover may preserve this exact binding only before effects. */
  public canRetryNativeConversationTurn(permit: NativeConversationTurnPermit): boolean {
    return readNativeConversationTurnStatus(permit) === 'retryable';
  }

  /** Product composition calls this from its authenticated native host selection. */
  public bindNativeConversationProject(projectId: string): void {
    if (!projectId.trim() || projectId.length > 200 || (this.nativeConversationProjectId !== projectId
      && (this.activeNativeConversationTurn || this.messageQueue.some(message => message.nativeTurn)))) {
      throw new NativeConversationTurnAdmissionError('identity_mismatch');
    }
    this.nativeConversationProjectId = projectId;
  }

  /**
   * Drain queued user messages sequentially. Skips draining while a turn is in
   * flight or a background auto-compaction is running; in the latter case
   * setCompacting() re-triggers the drain once compaction settles, so no queued
   * message is lost.
   */
  private async drainMessageQueue(): Promise<void> {
    let failure: unknown;
    while (!this.disposed && this.messageQueue.length > 0 && !this.turnInFlight && !this.activeNativeConversationTurn && !this.isThinking && !this.isCompacting) {
      const next = this.messageQueue.shift()!;
      this.emitQueueChange('delivered', next.id);
      try { await withTurnSurface(next.options?.origin, () => this.runTurn(next.text, next.content, next.options, next.nativeTurn)); }
      catch (error) { failure ??= error; }
    }
    this.followUpRuntime.scheduleFlush();
    if (failure !== undefined) throw failure;
  }

  /**
   * Single funnel for mutating the compaction flag. On the true->false edge it
   * resumes draining any messages that were queued while compaction was in flight.
   */
  private setCompacting(value: boolean): void {
    const wasCompacting = this.isCompacting;
    this.isCompacting = value;
    if (wasCompacting && !value && !this.turnInFlight && !this.activeNativeConversationTurn && !this.isThinking && this.messageQueue.length > 0) {
      void this.drainMessageQueue().catch((err) => logger.error('Orchestrator: queued message drain after compaction failed', {
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  private turnInFlight = false;

  /** Actual execution ownership, including cancellation and hook drainage. */
  public get isTurnInFlight(): boolean { return this.turnInFlight || this.activeNativeConversationTurn; }

  private startThinking(estimatedInputTokens?: number): void {
    this.followUpRuntime.cancel(true);
    this.isThinking = true;
    this.thinkingFrame = 0; // Reset each turn so gradient starts clean and frame never grows unbounded
    this.streamingInputTokens = estimatedInputTokens ?? this.lastRequestInputTokens;
    this.streamingOutputTokens = 0;
    this.abortController = new AbortController();
    // animInterval is always (re)started on every think call to reset the frame
    // counter and ensure a fresh animation cycle, even if already running.
    if (this.animInterval) clearInterval(this.animInterval);
    this.animInterval = setInterval(() => {
      this.thinkingFrame++;
      this.requestRender();
    }, 80);
    // unref() prevents this timer from holding the event loop open after the
    // process has otherwise completed all work. The cast is required
    // because the TypeScript setInterval return type does not expose unref();
    // Bun and Node.js both implement it on their timer handle objects.
    (this.animInterval as unknown as { unref?: () => void }).unref?.();
    this.requestRender();
  }

  private stopThinking(): void {
    if (this.animInterval) clearInterval(this.animInterval);
    this.animInterval = null;
    this.abortController = null;
    this.isThinking = false;
    this.streamingInputTokens = 0;
    this.streamingOutputTokens = 0;
    this.scrollToEnd(this.getViewportHeight());
    this.requestRender();
  }

  private async runTurn(
    text: string,
    content?: ContentPart[],
    options?: OrchestratorUserInputOptions | undefined,
    nativeTurn?: NativeConversationTurnAdmission,
  ): Promise<void> {
    const execute = async () => {
      try {
        if (nativeTurn) {
          validateNativeConversationTurn(nativeTurn.permit, text, content, this.nativeConversationProjectId);
          startNativeConversationTurn(nativeTurn);
          this.activeNativeConversationTurn = true;
          this.activeNativeConversationPermit = nativeTurn.permit;
          const admissionAbort = new AbortController();
          this.nativeAdmissionAbort = admissionAbort;
          await revalidateNativeConversationTurnPermit(nativeTurn.permit);
          admissionAbort.signal.throwIfAborted();
          if (this.disposed) throw new NativeConversationTurnAdmissionError('recovery_required');
        }
        await this.runTurnBody(text, content, options, nativeTurn);
      }
      catch (error) { if (nativeTurn) failNativeConversationTurn(nativeTurn, false); throw error; }
      finally { if (nativeTurn) { settleNativeConversationTurn(nativeTurn); this.activeNativeConversationTurn = false; this.activeNativeConversationPermit = undefined; this.nativeAdmissionAbort = null; } }
    };
    if (nativeTurn) await withNativeConversationTurn(nativeTurn.permit, execute);
    else await withoutNativeConversationTurn(execute);
  }

  private async runTurnBody(
    text: string,
    content?: ContentPart[],
    options?: OrchestratorUserInputOptions,
    nativeTurn?: NativeConversationTurnAdmission,
  ): Promise<void> {
    // Where "this turn" acquires a beginning: an owner-started turn ends the
    // previous untrusted-content window, a channel- or schedule-started one
    // deliberately does not. Here rather than in handleUserInput so a message
    // queued mid-thinking gets its own turn, and ahead of the config and
    // provider lookups because a turn the owner started is the owner's whether or not
    // this runtime can resolve a model for it, a boundary that depends on
    // unrelated resolution succeeding silently stops moving when it fails.
    // Reasoning and classification: security/turn-boundary.ts.
    startTurnForOwnerInput(options?.origin);

    const turnStartTime = Date.now();
    const configManager = requireConfigManager(this.coreServices);
    const providerRegistry = requireProviderRegistry(this.coreServices);

    // --- Phase 1: Preflight, idempotency, event emission, plan injection ---
    const preflight = this.runTurnPreflight(text, content, options, providerRegistry);
    if (!preflight) return; // duplicate in-flight turn was rejected and reported
    const { submissionKey, turnId } = preflight;
    const hookOwner = this.turnHookOwner!;
    const terminal: { publish?: () => void } = {};

    // Judgment preflight shares the same cancellation and cleanup as streaming.
    try {
      const signal = this.abortController?.signal;
      // Hooks may run external commands. A later provider error cannot prove
      // replay safe once that extensibility boundary has been entered.
      if (nativeTurn && this.hookDispatcher) markNativeConversationTurnEffectsPossible();
      let turnClassification: ClassificationResult | undefined;
      const preTurnPlan = await prepareConversationForTurn(
        this.conversation, providerRegistry, text, content, this.sessionId, this.coreServices.planManager ?? null,
        { ...(signal ? { signal } : {}), deferPlanPriming: true, onMessageAdded: () => { this.turnStartMessageCount = this.conversation.getMessageCount(); }, onClassification: (reading) => { turnClassification = reading; return maybeEmitAdaptivePlannerDecision(
          text, this.flagManager?.isEnabled('adaptive-execution-planner') ?? false,
          this.coreServices.adaptivePlanner ?? null, this.runtimeBus,
          (id) => createEmitterContext(this.sessionId, id), turnId, reading, signal,
        ); } },
      );
      signal?.throwIfAborted();
      this.turnStartMessageCount = this.conversation.getMessageCount();
      this.scrollToEnd(this.getViewportHeight());
      this.streamingInputTokens = estimateFreshTurnInputTokens(this.lastInputTokens, estimateConversationTokens(this.conversation.getMessagesForLLM()), text, content);
      await this.runTurnStream(text, content, turnId, preTurnPlan, configManager, providerRegistry, turnClassification, (publish) => { terminal.publish = publish; });

      signal?.throwIfAborted();
      // --- Phase 3: Post-turn reconciliation ---
      if (nativeTurn && this._turnFailed) failNativeConversationTurn(nativeTurn, false);
      markNativeConversationTurnEffectsPossible();
      await this.runTurnReconcile(turnId, configManager, providerRegistry);
      await hookOwner.closeAndDrain();
      signal?.throwIfAborted();
      this.turnCancellation.end(turnId);
      terminal.publish?.();
    } catch (err: unknown) {
      this._turnFailed = true;
      await hookOwner.closeAndDrain();
      // Set before TURN_ERROR: synchronous failover observers read this fence.
      if (nativeTurn) failNativeConversationTurn(nativeTurn, err instanceof ProviderError && !this.abortController?.signal.aborted && nativeConversationTurnCanRetry());
      await this.handleTurnError(err, turnId, configManager, providerRegistry);
    } finally {
      this.turnHookOwner = null;
      this.finalizeTurn(turnStartTime, submissionKey, turnId, configManager);
    }
  }

  /** Phase 1: Idempotency fence, event emission, adaptive planner, plan injection, thinking start.
   *  Returns null when the turn is a duplicate in-flight submission that should not execute. */
  private runTurnPreflight(
    text: string,
    content: ContentPart[] | undefined,
    options: OrchestratorUserInputOptions | undefined,
    providerRegistry: ReturnType<typeof requireProviderRegistry>,
  ): { submissionKey: string; turnId: string } | null {
    // Session, transcript position and prompt prefix identify one in-flight submission.
    const submissionIdentity = options?.nativeConversationTurnPermit ? randomUUID() : createHash('sha256')
      .update(`${this.sessionId}:${this.conversation.getMessageCount()}:${text.slice(0, 512)}`)
      .digest('hex')
      .slice(0, 16); // 16-char prefix is sufficient for in-process dedup
    const idempotencyStore = getIdempotencyStore(this.coreServices, this.ownedIdempotencyStore);
    const submissionKey = idempotencyStore.generateKey({
      sessionId: this.sessionId,
      turnId: submissionIdentity,
      callId:    text.slice(0, 64), // use prompt prefix for human-readable correlation
    });
    const submissionCheck = idempotencyStore.checkAndRecord(submissionKey);
    // A retried prompt can have the same transcript position. Execution IDs
    // must never alias an old cancellation target, even before admission.
    const turnId = randomUUID();
    this.currentSubmissionKey = submissionKey;

    if (submissionCheck.status === 'in-flight') {
      const reason = 'Duplicate turn submission rejected because an equivalent turn is already in flight.';
      logger.warn('Orchestrator: duplicate turn submission detected (in-flight), rejecting', {
        sessionId: this.sessionId,
        submissionKey,
      });
      if (this.runtimeBus) {
        const ctx = createEmitterContext(this.sessionId, turnId);
        emitTurnSubmitted(this.runtimeBus, ctx, {
          turnId,
          prompt: text,
          ...(options?.origin ? { origin: options.origin } : {}),
        });
        emitPreflightFail(this.runtimeBus, ctx, {
          turnId,
          reason,
          stopReason: 'preflight_failed',
        });
      }
      this.currentSubmissionKey = null;
      return null;
    }
    // 'duplicate' (completed/failed), allow re-run (user sent same text intentionally).
    // We just let it proceed; the prior record will be overwritten.

    // Reserve and bind before notifying synchronous submitted-event observers.
    this.turnInFlight = true;
    this.startThinking();
    this.turnHookOwner = new TurnHookOwner(this.sessionId, turnId, this.abortController!.signal);
    this.turnCancellation.begin(turnId, () => this.abort());

    if (this.runtimeBus) {
      emitTurnSubmitted(this.runtimeBus, createEmitterContext(this.sessionId, turnId), {
        turnId,
        prompt: text,
        ...(options?.origin ? { origin: options.origin } : {}),
      });
    }

    return { submissionKey, turnId };
  }

  /** Phase 2: Execute the LLM streaming loop and tool dispatch. */
  private async runTurnStream(
    text: string,
    content: ContentPart[] | undefined,
    turnId: string,
    preTurnPlan: Awaited<ReturnType<typeof prepareConversationForTurn>>,
    configManager: ReturnType<typeof requireConfigManager>,
    providerRegistry: ReturnType<typeof requireProviderRegistry>,
    turnClassification?: ClassificationResult,
    onTurnTerminal?: (publish: () => void) => void,
  ): Promise<void> {
    await executeOrchestratorTurnLoop({
      onTurnTerminal,
      conversation: this.conversation,
      toolRegistry: this.toolRegistry,
      getSystemPrompt: this.getSystemPrompt,
      getAbortSignal: () => this.abortController?.signal,
      hookDispatcher: bindTurnHookDispatcher(this.hookDispatcher, this.turnHookOwner),
      requestRender: this.requestRender,
      runtimeBus: this.runtimeBus,
      agentManager: this.agentManager,
      configManager,
      providerRegistry,
      favoritesStore: this.coreServices.favoritesStore,
      cacheHitTracker: getCacheHitTracker(this.coreServices, this.ownedCacheHitTracker),
      helperModel: new HelperModel({ configManager, providerRegistry, runtimeBus: this.runtimeBus, sessionId: () => this.sessionId }),
      sessionId: this.sessionId,
      preTurnPlan,
      planManager: isNativeConversationTurn() ? null : this.coreServices.planManager ?? null,
      text,
      content,
      turnId,
      emitterContext: (id) => createEmitterContext(this.sessionId, id),
      executeToolCalls: (id, calls, sourceOf) => this.executeToolCalls(id, calls, sourceOf ?? (() => ({ goal: text, criteria: [] }))),
      checkContextWindowPreflight: (id, model) => this.checkContextWindowPreflight(id, model),
      normalizeUsage,
      estimateFreshTurnInputTokens: (currentEstimatedTokens, nextText, nextContent) =>
        estimateFreshTurnInputTokens(this.lastInputTokens, currentEstimatedTokens, nextText, nextContent),
      getMessageQueueLength: () => this.messageQueue.length,
      isReconciliationEnabled: () => this.isReconciliationEnabled(),
      setPendingToolCalls: (calls) => { this._pendingToolCalls = calls; },
      setAutoSpawnTimeout: (timeout) => {
        if (this.autoSpawnTimeout !== null) clearTimeout(this.autoSpawnTimeout);
        this.autoSpawnTimeout = timeout;
      },
      setStreamingActive: (value) => { this.isStreaming = value; },
      setStreamingInputTokens: (value) => { this.streamingInputTokens = value; },
      addStreamingOutputTokens: (value) => { this.streamingOutputTokens += value; },
      setLastRequestInputTokens: (value) => { this.lastRequestInputTokens = value; },
      setLastInputTokens: (value) => { this.lastInputTokens = value; },
      markTurnFailed: () => { this._turnFailed = true; },
      noteModelContextWindowWarning: (details) => {
        this.modelContextWarning = details;
        logger.warn('Orchestrator: model reported context window exhaustion - forcing compaction at next opportunity', details);
      },
      usage: this.usage,
      memoryRegistry: this.coreServices.memoryRegistry,
      isPassiveKnowledgeInjectionEnabled: () => this.isPassiveKnowledgeInjectionEnabled(),
      passiveKnowledgeInjectionBudgetTokens: this.passiveKnowledgeInjectionBudgetTokens,
      passiveKnowledgeInjectionRelevanceFloor: this.passiveKnowledgeInjectionRelevanceFloor,
      codeIndex: this.coreServices.codeIndex,
      isPassiveCodeInjectionEnabled: () => this.isPassiveCodeInjectionEnabled(),
      getAlreadyInjectedKnowledgeIds: () => this.getAlreadyInjectedKnowledgeIds(),
      addInjectedKnowledgeIds: (ids) => { this.addInjectedKnowledgeIds(ids); },
      recordTurnKnowledgeInjection: (record) => { this.recordTurnKnowledgeInjection(record); },
      nextTurnKnowledgeSequence: () => this.nextTurnKnowledgeSequence(), contractHooks: this.coreServices.contractHooks,
      contractIntake: this.contractIntake,
      ...(turnClassification ? { turnClassification } : {}),
    });
  }

  /** Phase 3: Post-turn context maintenance (compaction, memory, plan updates). */
  private async runTurnReconcile(
    turnId: string,
    configManager: ReturnType<typeof requireConfigManager>,
    providerRegistry: ReturnType<typeof requireProviderRegistry>,
  ): Promise<void> {
    await handlePostTurnContextMaintenance({
      ...this.contextMaintenanceDeps(configManager, providerRegistry),
      lastWarningBracket: this.lastWarningBracket,
      setLastWarningBracket: (value) => { this.lastWarningBracket = value; },
    }, turnId, this.lastInputTokens);
  }

  /** The session state and compaction seams the preflight and post-turn context maintenance share. */
  private contextMaintenanceDeps(configManager: ReturnType<typeof requireConfigManager>, providerRegistry: ReturnType<typeof requireProviderRegistry>) {
    return {
      conversation: this.conversation,
      agentManager: this.agentManager,
      contractRunner: this.contractRunner,
      planManager: isNativeConversationTurn() ? null : this.coreServices.planManager ?? null,
      sessionMemoryStore: this.coreServices.sessionMemoryStore ?? null,
      configManager,
      providerRegistry,
      sessionLineageTracker: getSessionLineageTracker(this.coreServices, this.ownedSessionLineageTracker),
      runtimeBus: this.runtimeBus,
      emitterContext: (id: string) => createEmitterContext(this.sessionId, id),
      hookDispatcher: bindTurnHookDispatcher(this.hookDispatcher, this.turnHookOwner),
      sessionId: this.sessionId,
      requestRender: this.requestRender,
      isCompacting: this.isCompacting,
      setIsCompacting: (value: boolean) => { this.setCompacting(value); },
      modelContextWarning: this.modelContextWarning,
      clearModelContextWarning: () => { this.modelContextWarning = null; },
      getSystemPrompt: this.getSystemPrompt,
      signal: this.abortController?.signal,
      compactionManager: this.compactionManager,
    };
  }

  /** Catch handler: route to abort path or error path. */
  private async handleTurnError(
    err: unknown,
    turnId: string,
    configManager: ReturnType<typeof requireConfigManager>,
    providerRegistry: ReturnType<typeof requireProviderRegistry>,
  ): Promise<void> {
    if (this.abortController?.signal.aborted) {
      // Clean up streaming block if one was active when aborted
      if (this.isStreaming) {
        this.isStreaming = false;
        this.conversation.finalizeStreamingBlock();
        if (this.runtimeBus) {
          emitStreamEnd(this.runtimeBus, createEmitterContext(this.sessionId, turnId), { turnId });
        }
      }
      // Remove any partial LLM response, keep user message but mark it cancelled
      this.conversation.removeMessagesAfter(this.turnStartMessageCount);
      this.conversation.markLastUserMessageCancelled();
      this.conversation.addSystemMessage('[Response cancelled]');
      this.turnCancellation.end(turnId);
      if (this.runtimeBus) {
        emitTurnCancel(this.runtimeBus, createEmitterContext(this.sessionId, turnId), {
          turnId,
          reason: 'cancelled',
          stopReason: 'cancelled',
        });
      }
      return;
    }

    const error = err instanceof Error ? err : new Error(summarizeError(err));
    const judgmentFailed = error instanceof JudgmentError || error instanceof JudgmentPortMissingError || error instanceof JudgmentInputError || error instanceof PlannerJudgmentError;
    const msg = judgmentFailed ? `[Judgment] ${error.message}` : await readFormattedError(error, {
      site: 'core.orchestrator.turn-error',
      ...(error instanceof ProviderError
        ? { provider: providerRegistry.getCurrentModel().provider, source: 'provider' as const }
        : {}),
    });
    this.conversation.addSystemMessage(msg);
    this.requestRender();
    // Graceful degradation, suggest alternative when provider fails non-transiently
    const autoSwitch = configManager.get('behavior.suggestAlternativeOnProviderFail') as boolean;
    if (!judgmentFailed && autoSwitch && await isNonTransientProviderFailure(err, 'core.orchestrator.suggest-alternative')) {
      const currentModel = providerRegistry.getCurrentModel();
      const alt = currentModel ? providerRegistry.findAlternativeModel(currentModel.registryKey) : null;
      if (alt) {
        this.conversation.addSystemMessage(`[Provider] ${currentModel?.provider ?? 'Unknown'} failed. Alternative available: ${alt.displayName} (${alt.provider}). Use /model to switch.`);
      }
    }
    this._turnFailed = true;
    this.turnCancellation.end(turnId);
    if (this.runtimeBus) {
      emitTurnError(this.runtimeBus, createEmitterContext(this.sessionId, turnId), {
        turnId,
        error: summarizeError(error),
        stopReason: err instanceof ProviderError ? 'provider_error' : 'unexpected_error',
      });
    }
  }

  /** Finally handler: tool-call reconciliation, submission key finalization, notifications, replay queue. */
  private finalizeTurn(
    turnStartTime: number,
    submissionKey: string,
    turnId: string,
    configManager: ReturnType<typeof requireConfigManager>,
  ): void {
    // ── GC-ORCH-015: Terminal-state tool-call reconciliation ───────────────────
    // If the turn threw an exception between addAssistantMessage (which sets
    // _pendingToolCalls) and addToolResults (which clears it), there are
    // unresolved tool-call blocks in the conversation. Reconcile them now
    // so the conversation is always in a valid state on turn exit.
    if (this._pendingToolCalls.length > 0) {
      this.reconcileUnresolvedToolCalls([], 'exception-before-results');
    }

    // --- Submission key: mark turn complete or failed ---
    // Success: markComplete caches the result for duplicate callers.
    // Failure: markFailed allows retry on the next submission.
    if (this.currentSubmissionKey) {
      if (this._turnFailed) {
        getIdempotencyStore(this.coreServices, this.ownedIdempotencyStore).markFailed(this.currentSubmissionKey);
      } else {
        getIdempotencyStore(this.coreServices, this.ownedIdempotencyStore).markComplete(this.currentSubmissionKey);
      }
      this.currentSubmissionKey = null;
      this._turnFailed = false;
    }
    this.turnCancellation.end(turnId);
    this.stopThinking();
    this.turnInFlight = false;
    const durationMs = Date.now() - turnStartTime;
    const notifyEnabled = configManager.get('behavior.notifyOnComplete') as boolean | undefined;
    if (notifyEnabled !== false) {
      notifyCompletion('GoodVibes', `Response complete (${Math.round(durationMs / 1000)}s)`, durationMs);
    }

    // ── Event replay queue ────────────────────────────────────────────────
    // Inject unacknowledged events as system messages, then acknowledge them:
    // injection IS delivery, so each event reaches the conversation exactly
    // once (previously nothing ever acknowledged, so every event re-injected
    // maxReplays times with escalating [URGENT] tags, noise turns after the
    // agent had already finished).
    const eventsToReplay = this.replayQueue.onTurnComplete();
    if (eventsToReplay.length > 0) {
      const messages = this.replayQueue.formatReplays(eventsToReplay);
      for (const msg of messages) {
        if (this.systemMessageRouter) {
          this.systemMessageRouter.low(msg);
        } else {
          this.conversation.addSystemMessage(msg);
        }
      }
      for (const event of eventsToReplay) {
        this.replayQueue.acknowledge(event.id);
      }
      this.requestRender();
    }
    this.followUpRuntime.scheduleFlush();
  }

  /**
   * Pre-flight context window check: estimate the pending request's tokens vs
   * the model's window; over-limit compacts first (when enabled), then errors
   * with specific counts. Returns 'ok' | 'compacted' | 'error'.
   */
  private async checkContextWindowPreflight(
    turnId: string,
    model: ModelDefinition,
  ): Promise<'ok' | 'compacted' | 'error'> {
    return checkContextWindowPreflight({
      ...this.contextMaintenanceDeps(requireConfigManager(this.coreServices), requireProviderRegistry(this.coreServices)),
      getCompactionStrategy: () => resolveCompactionStrategy(
        requireConfigManager(this.coreServices).get('behavior.compactionStrategy'),
        this.flagManager?.isEnabled('compaction-distiller-strategy') ?? false,
      ),
    }, turnId, model);
  }

  /**
   * Auto-spawn agents for a list of ready plan items under bounded orchestration policy.
   */
  private autoSpawnPendingItems(
    turnId: string,
    plan: ExecutionPlan,
    items: PlanItem[],
  ): string[] {
    if (isNativeConversationTurn()) return [];
    const configManager = requireConfigManager(this.coreServices);
    const providerRegistry = requireProviderRegistry(this.coreServices);
    return autoSpawnPendingItems(
      this.conversation,
      plan,
      items,
      this.agentManager,
      configManager,
      providerRegistry,
      this.runtimeBus,
      createEmitterContext(this.sessionId, turnId),
      this.coreServices.planManager ?? null,
    );
  }

  /**
   * Returns `true` when the GC-ORCH-015 reconciliation feature is active.
   *
   * Defaults to `true` (flag `defaultState: 'enabled'`) when no flag manager
   * has been wired in, safe for tests that omit the optional constructor arg.
   */
  /** The per-turn flag reads, and their differing defaults: ./orchestrator-turn-flags.ts. */
  private get turnFlags(): TurnFlagSources { return turnFlagSources(this.flagManager, this.coreServices); }

  private isReconciliationEnabled(): boolean { return isReconciliationEnabled(this.turnFlags); }

  private isPassiveKnowledgeInjectionEnabled(): boolean { return isPassiveKnowledgeInjectionEnabled(this.turnFlags); }

  private isPassiveCodeInjectionEnabled(): boolean { return isPassiveCodeInjectionEnabled(this.turnFlags); }

  /**
   * Ids never to re-surface in a later per-turn knowledge block. The main
   * session has no spawn-time `AgentRecord.knowledgeInjections` baseline, so this starts
   * empty and grows monotonically for the life of the Orchestrator.
   */
  private getAlreadyInjectedKnowledgeIds(): readonly string[] {
    return [...this.turnKnowledgeIdsAlreadySurfaced];
  }

  /** Mark ids as surfaced so they are never listed twice this session. */
  private addInjectedKnowledgeIds(ids: readonly string[]): void {
    for (const id of ids) this.turnKnowledgeIdsAlreadySurfaced.add(id);
  }

  /** Append one honesty record to the bounded ring behind {@link getTurnInjections}. */
  private recordTurnKnowledgeInjection(record: TurnInjectionRecord): void {
    this.turnInjectionRing = recordTurnInjection(this.turnInjectionRing, record);
  }

  /** Monotonic per-Orchestrator-lifetime sequence number for TurnInjectionRecord.turn. */
  private nextTurnKnowledgeSequence(): number {
    return ++this.turnKnowledgeSequence;
  }

  /**
   * Reconcile unresolved tool calls at turn end (non-empty _pendingToolCalls
   * or malformed provider response): inject synthetic error results, add a
   * system message, emit TOOL_RECONCILED. Gate-off logs and no-ops.
   */
  private reconcileUnresolvedToolCalls(
    resolvedResults: ToolResult[],
    reason: ReconciliationReason,
  ): void {
    reconcileUnresolvedToolCalls({
      conversation: this.conversation,
      runtimeBus: this.runtimeBus,
      emitterContext: (id) => createEmitterContext(this.sessionId, id),
      isReconciliationEnabled: () => this.isReconciliationEnabled(),
      currentSubmissionKey: this.currentSubmissionKey,
      pendingToolCalls: this._pendingToolCalls,
      setPendingToolCalls: (calls) => { this._pendingToolCalls = calls; },
    }, resolvedResults, reason);
  }

  private async executeToolCalls(turnId: string, calls: ToolCall[], sourceOf: () => AutonomousToolSource): Promise<ToolResult[]> {
    if (calls.length > 0) markNativeConversationTurnEffectsPossible();
    const results = await executeToolCalls({
      autonomousSource: sourceOf,
      turnSignal: this.abortController?.signal,
      hookOwner: this.turnHookOwner ?? undefined,
      toolRegistry: this.toolRegistry,
      permissionManager: this.permissionManager,
      hookDispatcher: bindTurnHookDispatcher(this.hookDispatcher, this.turnHookOwner),
      runtimeBus: this.runtimeBus,
      sessionId: this.sessionId,
      emitterContext: (id) => createEmitterContext(this.sessionId, id),
      onToolExecuted: this.coreServices.codeIndexReindexScheduler
        ? (toolName, args, success) => this.coreServices.codeIndexReindexScheduler!.onToolExecuted(toolName, args, success)
        : undefined,
      toolCallSignals: this.toolCallAborts,
    }, turnId, calls);
    // Per-model edit-failure + exec-expectation-miss telemetry (measurement only;
    // must never disturb the tool-execution path, so model resolution is defensive).
    let model = 'unknown';
    try {
      model = this.coreServices.providerRegistry?.getCurrentModel()?.registryKey ?? 'unknown';
    } catch {
      // No configured provider (e.g. a bare test harness), record under 'unknown'.
    }
    toolFormatTelemetry.observeToolResults(model, calls, results);
    return results;
  }
}
