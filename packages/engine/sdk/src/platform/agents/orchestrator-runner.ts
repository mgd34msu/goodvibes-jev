// OrchestratorRunner, single-agent turn loop coordinator.
//
// This module implements the coordinator pattern: it orchestrates agent runs
// (LLM call → tool execution → loop) but delegates domain logic to imported
// collaborators (ConversationManager, ToolRegistry, AgentSession, etc.).
// It does not own any state beyond the duration of a single runAgentLoop() call.
import { ConversationManager } from '../core/conversation.js';
import type { ToolRegistry } from '../tools/registry.js';
import { logger } from '../utils/logger.js';
import { CIRCUIT_BREAKER_TRIPPED, ConsecutiveErrorBreaker } from '../core/circuit-breaker.js';
import { isBillingOrCreditError, isRateLimitOrQuotaError, isContextSizeExceededError, isNetworkTransportError } from '../types/errors.js';
import { AgentSession } from './session.js';
import {
  estimateTokens,
  estimateConversationTokens,
  compactSmallWindow,
} from '../core/context-compaction.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { LLMProvider, StreamDelta } from '../providers/interface.js';
import type { ToolResult } from '../types/tools.js';
import { emitCommunicationConsumed } from '../runtime/emitters/index.js';
import { maybeCompactAfterModelContextWarning, setAgentProgress, summarizeToolArgs } from './orchestrator-utils.js';
import { buildLayeredOrchestratorSystemPrompt, buildOrchestratorSystemPrompt, resolveSpawnKnowledgeInjections, withOpenTierProfileBlock } from './orchestrator-prompts.js';
import { completeOrRegenerate, recoverEmptyConversationalReply } from './conversational-reply-recovery.js';
import {
  buildPerTurnKnowledgeInjection,
  defaultTurnKnowledgeBudgetTokens,
  recordTurnInjection,
  DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
} from './turn-knowledge-injection.js';
import { summarizeError } from '../utils/error-display.js';
import { resolveScopedDirectory } from '../runtime/surface-root.js';
import { appendGoodVibesRuntimeAwarenessPrompt } from '../tools/goodvibes-runtime/index.js';
import { gateBackgroundToolCall } from './background-permission-gate.js';
import { resolveTurnBudget, formatTurnLimitError, TURN_BUDGET_EXHAUSTED, type ResolvedTurnBudget } from './turn-budget.js';
import { toolFormatTelemetry } from '../runtime/telemetry/tool-format-telemetry.js';
import {
  applyContextWindowAwareness,
  providerQualifiedRouteLabel,
  resolveContextCompactThreshold,
  resolveContextWindowModelDefinition,
} from './orchestrator-runner-context-window.js';
import type { AgentOrchestratorRunContext } from './orchestrator-run-context.js';
import { holdContractCompletion, reportContractTurnEnd } from './orchestrator-runner-contract.js';
import { cleanupLeakedProcesses, disposeSession, finishCancelledRun } from './orchestrator-runner-finish.js';

// Model-definition resolution moved to orchestrator-runner-context-window.ts and
// the run context to orchestrator-run-context.ts; both re-exported here so
// `agents/index.ts`'s `export *` surface is unchanged.
export { resolveContextWindowModelDefinition } from './orchestrator-runner-context-window.js';
export type { AgentOrchestratorRunContext } from './orchestrator-run-context.js';

const MAX_TURNS = 50; // fallback turn budget when no config source (mirrors agents.maxTurns default)
const MAX_TURNS_CAP = 200; // fallback policy bound when no config source (mirrors agents.maxTurnsCap default)
const NETWORK_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000]; // exponential back-off on transient network errors
const RATE_LIMIT_RETRY_DELAY_MS = 60_000; // fixed pause on 429/quota responses
const RATE_LIMIT_MAX_RETRIES = 3; // cap retries so a sustained quota violation terminates cleanly

/** The applied turn ceiling: agents.maxTurns default, a per-spawn override, clamped by the agents.maxTurnsCap bound. */
function resolveRunTurnBudget(context: AgentOrchestratorRunContext, record: AgentRecord): ResolvedTurnBudget {
  const cfg = context.configManager;
  return resolveTurnBudget({
    configDefault: Number(cfg?.get('agents.maxTurns') ?? MAX_TURNS),
    spawnOverride: record.maxTurns,
    policyCap: Number(cfg?.get('agents.maxTurnsCap') ?? MAX_TURNS_CAP),
  });
}

async function executeToolCalls(
  toolCalls: Awaited<ReturnType<LLMProvider['chat']>>['toolCalls'],
  toolRegistry: ToolRegistry,
  session: AgentSession,
  turn: number,
  record: AgentRecord,
  callHistory: string[],
  callHistoryWindow: number,
  context: AgentOrchestratorRunContext,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  for (const originalCall of toolCalls) {
    const call = { ...originalCall, arguments: { ...originalCall.arguments } };
    const argsSummary = summarizeToolArgs(call.arguments as Record<string, unknown>);
    // The tool trace: for the TUI's activity surfaces, never for a channel.
    setAgentProgress(record, `Turn ${turn} · ${call.name}${argsSummary}`, 'operator');
    record.toolCallCount++;
    context.emitAgentProgress(record.id, record.progress ?? '', 'operator');

    if (call.name === 'exec' || call.name === 'precision_exec') {
      call.arguments = structuredClone(call.arguments);
      const execArgs = call.arguments as Record<string, unknown>;
      if (Array.isArray(execArgs.commands)) {
        for (const cmd of execArgs.commands as Record<string, unknown>[]) {
          cmd.background = false;
          if (!cmd.timeout_ms) cmd.timeout_ms = 600_000;
        }
      }
      if (!execArgs.timeout_ms) execArgs.timeout_ms = 600_000;
    }

    const callSig = `${call.name}::${JSON.stringify(call.arguments)}`;
    // Push a result AND log the matching session record, so the denied /
    // executed / threw branches below stay uniform.
    const recordResult = (result: ToolResult, argsJson: string): void => {
      results.push(result);
      session.appendMessage({
        type: 'tool_execution',
        turn,
        toolName: call.name,
        toolCallId: call.id,
        success: result.success !== false,
        args: argsJson.slice(0, 500),
        resultPreview: (result.output ?? result.error ?? '').slice(0, 500),
        timestamp: new Date().toISOString(),
      });
    };
    try {
      // Background permission gate: consult the session permission mode exactly
      // like the foreground turn loop (denials return a structured ToolDenial).
      const permissionOutcome = await gateBackgroundToolCall(context, record, call.name, call.arguments as Record<string, unknown>);
      if (!permissionOutcome.approved) {
        recordResult(
          { callId: call.id, success: false, error: permissionOutcome.error, denial: permissionOutcome.denial },
          JSON.stringify(call.arguments),
        );
      } else {
        const effectiveArgs = permissionOutcome.modifiedArgs ?? (call.arguments as Record<string, unknown>);
        const signal = context.getCancellationSignal?.(record.id);
        const result = await toolRegistry.execute(call.id, call.name, effectiveArgs, signal ? { signal } : undefined);
        // Stage B: schedule a debounced reindex of any touched file(s). Never awaited.
        try {
          context.onToolExecuted?.(call.name, effectiveArgs, result.success !== false);
        } catch (hookErr) {
          logger.warn('onToolExecuted hook error', { tool: call.name, error: summarizeError(hookErr) });
        }
        recordResult({ ...result, callId: call.id }, JSON.stringify(effectiveArgs));
      }
    } catch (err) {
      const toolErr = summarizeError(err);
      recordResult({ callId: call.id, success: false, error: toolErr }, JSON.stringify(call.arguments));
    }

    callHistory.push(callSig);
    if (callHistory.length > callHistoryWindow) callHistory.shift();
  }

  return results;
}

async function finalizeAgentRun(
  context: AgentOrchestratorRunContext,
  record: AgentRecord,
  session: AgentSession | null,
  preAgentProcessIds: Set<string>,
): Promise<void> {
  const statusAfterLoop = (record as { status: string }).status;
  if (statusAfterLoop !== 'failed' && statusAfterLoop !== 'cancelled') {
    record.status = 'completed';
  }
  record.completedAt = Date.now();
  recoverEmptyConversationalReply(record);
  cleanupLeakedProcesses(context.processManager, preAgentProcessIds);

  if (context.runtimeBus && record.status !== 'failed' && statusAfterLoop !== 'cancelled') {
    context.emitAgentCompletedEvent(record.id, (record.completedAt ?? Date.now()) - record.startedAt, record.fullOutput ?? '', record.toolCallCount, record.usage);
  }

  if (record.status === 'failed') {
    context.emitAgentFailedEvent(record.id, record.error ?? 'Circuit breaker tripped', Date.now() - record.startedAt);
    logger.error(`Agent ${record.id} circuit-breaker terminated`, { error: record.error, toolCallCount: record.toolCallCount });
    session?.appendMessage({ type: 'session_end', status: 'failed', error: record.error, toolCallCount: record.toolCallCount, durationMs: Date.now() - record.startedAt, timestamp: new Date().toISOString() });
  } else if (statusAfterLoop === 'cancelled') {
    context.emitAgentCancelledEvent(record.id, 'Agent cancelled');
    logger.info(`Agent ${record.id} cancelled (detected post-loop)`, { toolCallCount: record.toolCallCount });
    session?.appendMessage({ type: 'session_end', status: 'cancelled', toolCallCount: record.toolCallCount, durationMs: Date.now() - record.startedAt, timestamp: new Date().toISOString() });
  } else {
    logger.info(`Agent ${record.id} completed`, { toolCallCount: record.toolCallCount });
    session?.appendMessage({
      type: 'session_end',
      status: 'completed',
      toolCallCount: record.toolCallCount,
      durationMs: Date.now() - record.startedAt,
      timestamp: new Date().toISOString(),
    });
  }

  if (session) {
    await disposeSession(session);
  }
}

async function handleAgentRunFailure(
  context: AgentOrchestratorRunContext,
  record: AgentRecord,
  conversation: ConversationManager | null,
  session: AgentSession | null,
  preAgentProcessIds: Set<string>,
  err: unknown,
): Promise<void> {
  // A retry wait that saw the cancel throws to get here; the run was cancelled, not failed.
  if ((record as { status: string }).status === 'cancelled') return finishCancelledRun(context, record, session, preAgentProcessIds);
  const message = summarizeError(err, {
    ...(record.provider ? { provider: record.provider } : {}),
  });
  if (conversation) {
    const lastMessages = conversation.getMessagesForLLM();
    const lastAssistant = [...lastMessages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant) {
      record.fullOutput = typeof lastAssistant.content === 'string' ? lastAssistant.content : '';
    }
  }
  record.status = 'failed';
  record.error = message;
  record.completedAt = Date.now();
  cleanupLeakedProcesses(context.processManager, preAgentProcessIds);
  context.emitAgentFailedEvent(record.id, message, Date.now() - record.startedAt);
  logger.error(`Agent ${record.id} failed`, { error: message });
  if (session) {
    session.appendMessage({
      type: 'session_end',
      status: 'failed',
      error: message,
      toolCallCount: record.toolCallCount,
      durationMs: Date.now() - record.startedAt,
      timestamp: new Date().toISOString(),
    });
    await disposeSession(session);
  }
}

/**
 * The configured default model, looked up only when something reads it: an
 * agent without a model of its own runs on it, but an agent routed to its own
 * model (every contract unit) must not fail because the default cannot be
 * found, for example while the provider catalog is still loading.
 */
export function lazyCurrentModel(providerRegistry: { getCurrentModel(): { readonly id: string; readonly provider: string; readonly registryKey: string } }): { readonly id: string; readonly provider: string; readonly registryKey: string } {
  let model: { readonly id: string; readonly provider: string; readonly registryKey: string } | undefined;
  const resolve = () => (model ??= providerRegistry.getCurrentModel());
  return {
    get id() { return resolve().id; },
    get provider() { return resolve().provider; },
    get registryKey() { return resolve().registryKey; },
  };
}

export async function runAgentTask(
  context: AgentOrchestratorRunContext,
  record: AgentRecord,
): Promise<void> {
  record.status = 'running';
  setAgentProgress(record, 'Initialising…', 'operator');
  record.usage = {
    inputTokens: record.usage?.inputTokens ?? 0,
    outputTokens: record.usage?.outputTokens ?? 0,
    cacheReadTokens: record.usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: record.usage?.cacheWriteTokens ?? 0,
    ...(record.usage?.reasoningTokens !== undefined ? { reasoningTokens: record.usage.reasoningTokens } : {}),
    llmCallCount: record.usage?.llmCallCount ?? 0,
    turnCount: record.usage?.turnCount ?? 0,
    reasoningSummaryCount: record.usage?.reasoningSummaryCount ?? 0,
  };
  context.emitAgentStarted(record.id);
  context.emitAgentProgress(record.id, record.progress ?? '', 'operator');

  let session: AgentSession | null = null;
  let conversation: ConversationManager | null = null;
  const preAgentProcessIds = new Set((context.processManager?.list() ?? []).map((p) => p.id));

  try {
    const providerRegistry = context.providerRegistry;
    const currentModel = lazyCurrentModel(providerRegistry);
    const primaryRoute = context.resolveProviderForRecord(providerRegistry, record, currentModel);
    let activeRoute = primaryRoute;
    let fallbackRouteIndex = 0;
    const fallbackRoutes = context.resolveFallbackModelRoutes(
      providerRegistry,
      record,
      currentModel,
      primaryRoute.requestedModelId,
    );
    const modelId = primaryRoute.modelId;
    record.model = record.model ?? primaryRoute.requestedModelId;
    record.provider = record.provider ?? activeRoute.provider.name;

    session = new AgentSession(record.id, modelId, record.provider ?? currentModel.provider ?? 'unknown', {
      // Agent journals live under sessions/agents/, a sibling of the user
      // conversation files in sessions/, never mixed with them, so a
      // conversation-scoped sweep can never touch an agent transcript and
      // vice versa (see append-only-registry.ts's session-journals store).
      sessionsDir: resolveScopedDirectory(context.workingDirectory, context.surfaceRoot, 'sessions', 'agents'),
      stateDir: resolveScopedDirectory(context.workingDirectory, context.surfaceRoot, 'state'),
    }, context.atRestPolicy);
    session.appendMessage({ type: 'session_config', template: record.template, task: record.task, tools: record.tools, model: modelId, provider: record.provider ?? 'unknown', timestamp: new Date().toISOString() });

    const toolRegistry = context.buildScopedRegistry(record.tools, context.getFullRegistry(), record.captureAuthority);
    const toolDefinitions = toolRegistry.getToolDefinitions();
    const toolTokens = toolDefinitions.length > 0
      ? estimateTokens(JSON.stringify(toolDefinitions))
      : 0;

    conversation = new ConversationManager();
    conversation.addUserMessage(record.task);
    // Steer-wake resume: a wedged (failed) agent re-triggered via
    // AgentManager.wakeWithSteer carries a resumeSteer seed. Restore honest prior
    // context (a transcript-tail summary, not a tool-call replay) and inject the
    // steer as a fresh user turn, then clear the seed so it never re-fires.
    if (record.resumeSteer) {
      if (record.resumeSteer.priorSummary) {
        conversation.addSystemMessage(record.resumeSteer.priorSummary);
      }
      conversation.addUserMessage(record.resumeSteer.steer);
      record.resumeSteer = undefined;
    }
    // Conversation-snapshot bridge (Part C6): hand AgentManager a live accessor onto THIS
    // ConversationManager instance so a fleet tab can render a full-fidelity
    // transcript while the agent runs. `activeConversation` is a separate
    // const (rather than closing over the outer `let conversation`) so the
    // closure's type is non-nullable without a runtime assertion.
    const activeConversation = conversation;
    context.registerConversationSource?.(record.id, () => activeConversation.getMessageSnapshot());

    await resolveSpawnKnowledgeInjections(record, context);
    let systemPrompt = buildOrchestratorSystemPrompt(record, undefined, context);

    // Per-turn passive-injection state (see CHANGELOG 0.38.0). `knowledgeIdsAlreadySurfaced` seeds
    // from the spawn-time baseline (record.knowledgeInjections, resolved above) and grows with
    // every id a later turn injects, so no record is listed twice across the whole run.
    // `priorTurnKnowledgeBlock` is the last successfully-built block, reused verbatim on turns
    // where nothing new arrived (see newUserInputThisTurn below); it is composed onto the CURRENT
    // `systemPrompt` fresh every turn (composeTurnSystemPrompt), never written back into it.
    const knowledgeIdsAlreadySurfaced = new Set<string>((record.knowledgeInjections ?? []).map((entry) => entry.id));
    let priorTurnKnowledgeBlock: string | null = null;

    let continueLoop = true;
    let turn = 0;
    const turnBudget = resolveRunTurnBudget(context, record);
    setAgentProgress(record, 'Turn 1 · Thinking…', 'operator');
    context.emitAgentProgress(record.id, record.progress ?? '', 'operator');

    const callHistory: string[] = [];
    const LOOP_SYSTEM_THRESHOLD = 3;
    const LOOP_USER_THRESHOLD = 5;
    const CALL_HISTORY_WINDOW = 20;
    const circuitBreaker = new ConsecutiveErrorBreaker();
    // Track which inter-agent messages have already been injected so a single
    // directive/broadcast is appended to the conversation exactly once (getMessages
    // returns all unexpired messages every turn until their TTL elapses).
    const injectedMessageIds = new Set<string>();
    // Contract nudges a completion hold added as a user turn, reported consumed
    // exactly as a drained steer is: after the next model call succeeds.
    const heldNudgeIdsAwaitingTurn: string[] = [];
    // Iteration budget for the chat retry loop. Includes one slot per fallback
    // route so fallback-model transitions don't cannibalize the network/rate-limit
    // retry allowances.
    const maxChatRetryIterations =
      NETWORK_RETRY_DELAYS_MS.length + RATE_LIMIT_MAX_RETRIES + fallbackRoutes.length + 4;

    while (continueLoop) {
      if ((record as { status: string }).status === 'cancelled') {
        await finishCancelledRun(context, record, session, preAgentProcessIds, turn);
        return;
      }
      if (++turn > turnBudget.limit) {
        const lastMessages = conversation.getMessagesForLLM();
        const lastAssistant = [...lastMessages].reverse().find(m => m.role === 'assistant');
        if (lastAssistant) {
          record.fullOutput = typeof lastAssistant.content === 'string' ? lastAssistant.content : '';
        }
        record.status = 'failed';
        // Prose unchanged; the structured outcome is stamped alongside (no regex needed downstream).
        record.error = formatTurnLimitError(turnBudget.limit);
        record.failureReason = TURN_BUDGET_EXHAUSTED;
        record.turnBudget = turnBudget;
        if (session) {
          session.appendMessage({ type: 'session_end', status: 'max_turns_exceeded', turn, timestamp: new Date().toISOString() });
          await disposeSession(session);
        }
        context.emitAgentFailedEvent(record.id, record.error, Date.now() - record.startedAt);
        return;
      }
      session.appendMessage({ type: 'llm_request', turn, messageCount: conversation.getMessagesForLLM().length, timestamp: new Date().toISOString() });
      const pending = context.messageBus.getMessages(record.id);
      // Steers drained into the conversation THIS turn (and any contract nudge a
      // completion hold added just before it), awaiting the "consumed" signal
      // below, deferred until the turn's chat call actually succeeds. See the
      // comment at the emission site for why this can't fire here.
      const drainedSteerMessageIds: string[] = heldNudgeIdsAwaitingTurn.splice(0);
      // True when this turn actually added new content to the
      // conversation the model will see, turn 1 (the initial task) or any steer/directive
      // drained just above. Gates per-turn knowledge re-retrieval: no new input means the
      // evolving-conversation query would be identical to last turn's, so the prior turn's
      // block is reused verbatim instead of re-running retrieval for no behavioral gain.
      let newUserInputThisTurn = turn === 1 || drainedSteerMessageIds.length > 0;
      for (const msg of pending) {
        // Skip the agent's own broadcasts and any message already injected on a
        // prior turn so each directive is surfaced to the model exactly once.
        if (msg.from === record.id) continue;
        if (injectedMessageIds.has(msg.id)) continue;
        injectedMessageIds.add(msg.id);
        newUserInputThisTurn = true;
        if (msg.kind === 'steer') {
          // A human steer (ProcessRegistry.steer) is a genuine user turn, not
          // an inter-agent directive, inject it verbatim, with none of the
          // "[Kind from sender]" framing used for agent-to-agent messages.
          conversation.addUserMessage(msg.content);
          drainedSteerMessageIds.push(msg.id);
        } else {
          const kindLabel = (msg.kind[0] ?? '').toUpperCase() + msg.kind.slice(1);
          conversation.addUserMessage(`[${kindLabel} from ${msg.from}]: ${msg.content}`);
        }
      }

      const contextWindowAwarenessEnabled = context.featureFlagManager?.isEnabled('agent-context-window-awareness') ?? true;
      const passiveKnowledgeInjectionEnabled = context.featureFlagManager?.isEnabled('agent-passive-knowledge-injection') ?? true;
      // Resolved once per turn (used by both the awareness check below and the per-turn
      // knowledge budget), rather than only inside the awareness branch, so the passive-
      // injection budget can derive "3% of context window" even when context-window
      // awareness itself is disabled.
      let contextWindowForTurn = 0;
      if (contextWindowAwarenessEnabled || passiveKnowledgeInjectionEnabled) {
        const modelDef = resolveContextWindowModelDefinition(providerRegistry, activeRoute);
        contextWindowForTurn = context.providerRegistry.getContextWindowForModel(modelDef);
      }

      if (contextWindowAwarenessEnabled) {
        systemPrompt = applyContextWindowAwareness(
          context,
          record,
          activeRoute.modelId,
          contextWindowForTurn,
          conversation,
          systemPrompt,
          toolTokens,
          turn,
        );
      }

      // Per-turn passive knowledge injection. Gated on the feature
      // flag AND on there being new conversation input this turn; otherwise
      // priorTurnKnowledgeBlock (unchanged) is reused. `priorTurnKnowledgeBlock` and
      // `systemPrompt` are combined into a request-time-only string just below
      // (composeTurnSystemPrompt), the block is NEVER written back into the `systemPrompt`
      // let, so it cannot compound turn over turn even across the emergency-compaction
      // retry path (which DOES reassign `systemPrompt`) inside the chat-retry loop.
      if (passiveKnowledgeInjectionEnabled && newUserInputThisTurn && context.memoryRegistry) {
        const configuredBudget = context.passiveKnowledgeInjectionBudgetTokens
          ?? defaultTurnKnowledgeBudgetTokens(
            contextWindowForTurn,
            context.configManager?.get('agents.passiveInjection.budgetTokens'),
          );
        let turnBudgetTokens = configuredBudget;
        if (contextWindowAwarenessEnabled && contextWindowForTurn > 0) {
          // Clamp the block's budget to whatever headroom is left under the SAME 85%
          // compaction threshold applyContextWindowAwareness just enforced on the base
          // prompt, so base+block can never silently exceed it even though the block is
          // composed after that check ran (risk: B-tier token dishonesty otherwise).
          const msgTokensForBudget = estimateConversationTokens(conversation.getMessagesForLLM());
          const sysTokensForBudget = estimateTokens(systemPrompt);
          const threshold = Math.floor(contextWindowForTurn * resolveContextCompactThreshold(context));
          const headroomTokens = threshold - msgTokensForBudget - sysTokensForBudget - toolTokens;
          turnBudgetTokens = Math.max(0, Math.min(configuredBudget, headroomTokens));
        }
        if (turnBudgetTokens > 0) {
          const relevanceFloor = context.passiveKnowledgeInjectionRelevanceFloor
            ?? context.configManager?.get('agents.passiveInjection.relevanceFloor')
            ?? DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR;
          // Stage B: code hits share this turn's SAME budget/floor. Gated on the separate
          // (default-off) code-injection flag AND the embedder's storage.codeIndexEnabled setting.
          const codeInjectionEnabled = !!context.codeIndex
            && (context.featureFlagManager?.isEnabled('agent-passive-code-injection') ?? false)
            && (context.isCodeInjectionSettingEnabled?.() ?? true);
          const { block, record: turnInjectionRecord } = await buildPerTurnKnowledgeInjection({
            memoryRegistry: context.memoryRegistry,
            task: record.task,
            writeScope: record.writeScope ?? [],
            conversationTail: conversation.getMessagesForLLM(),
            budgetTokens: turnBudgetTokens,
            relevanceFloor,
            alreadyInjectedIds: [...knowledgeIdsAlreadySurfaced],
            turn,
            codeIndex: context.codeIndex,
            codeInjectionEnabled,
            codeLimit: context.configManager?.get('agents.passiveInjection.codeLimit'),
          });
          priorTurnKnowledgeBlock = block;
          for (const id of turnInjectionRecord.injectedIds) knowledgeIdsAlreadySurfaced.add(id);
          record.turnInjections = recordTurnInjection(record.turnInjections, turnInjectionRecord);
          session.appendMessage({ type: 'knowledge_injection', ...turnInjectionRecord });
        } else {
          // Hard no-op: no budget headroom this turn. Never call into retrieval for a
          // budget that's already known to be zero, and never claim a block that can't
          // exist, no record, no session message, prior block cleared so the composed
          // prompt below falls back to the base systemPrompt exactly.
          priorTurnKnowledgeBlock = null;
        }
      }

      // Compose the per-turn knowledge block onto the base
      // systemPrompt fresh at EVERY call site (including each chat-retry iteration below),
      // instead of hoisting a single `const turnSystemPrompt` computed once before the
      // retry loop. This matters because the emergency-compaction retry path inside that
      // loop reassigns the outer `systemPrompt` let (buildLayeredOrchestratorSystemPrompt)
      //, a hoisted const would go stale and keep resubmitting the pre-compaction prompt,
      // silently defeating that retry. Composing here also re-validates fit on every call:
      // if base+block would exceed the SAME 85% compaction threshold applyContextWindowAwareness
      // enforces (using live, current-call token counts, not turn-start estimates), the block
      // is dropped for that call only, this is the safety net for a REUSED block (one that
      // was sized against a headroom estimate one or more turns ago and may no longer fit,
      // e.g. after several no-new-input turns of tool-result growth). It never mutates
      // `priorTurnKnowledgeBlock` or the stored TurnInjectionRecord, both of which honestly
      // reflect what retrieval computed at the time it ran.
      const composeTurnSystemPrompt = (raw: string): string => {
        const base = withOpenTierProfileBlock(raw); // owner-profile §11.2: composed fresh, never written back
        if (!priorTurnKnowledgeBlock) return base;
        if (contextWindowAwarenessEnabled && contextWindowForTurn > 0) {
          const liveMsgTokens = estimateConversationTokens(activeConversation.getMessagesForLLM());
          const liveSysTokens = estimateTokens(base);
          const liveBlockTokens = estimateTokens(priorTurnKnowledgeBlock);
          const threshold = Math.floor(contextWindowForTurn * resolveContextCompactThreshold(context));
          if (liveMsgTokens + liveSysTokens + liveBlockTokens + toolTokens > threshold) {
            return base;
          }
        }
        return `${base}\n\n${priorTurnKnowledgeBlock}`;
      };

      let response: Awaited<ReturnType<LLMProvider['chat']>> | undefined;
      {
        let networkAttempt = 0;
        let rateLimitAttempt = 0;
        let contextRetried = false;
        for (let chatRetryIteration = 0; chatRetryIteration < maxChatRetryIterations; chatRetryIteration++) {
          let streamAccumulated = '';
          record.streamingContent = undefined;

          const onDelta = (delta: StreamDelta) => {
            if (delta.content) {
              streamAccumulated += delta.content;
              // Live model output goes to streamingContent (rendered in the agent
              // inspector / detail view) and is emitted via emitStreamDelta below.
              // Do NOT overwrite record.progress with the raw output tail: progress
              // is the concise one-line status surfaced as RuntimeAgent.latestProgress
              // (e.g. the process indicator), so it must keep the last meaningful
              // status ("Turn N · <tool>" / "Thinking…") rather than firehosing output.
              record.streamingContent = streamAccumulated;
            }
            context.emitStreamDelta(record.id, delta.content ?? '', streamAccumulated);
          };

          try {
            // Thread the agent's cancellation signal into the in-flight LLM
            // request so a cancel/kill aborts the provider call mid-stream, not
            // only cooperatively at the next turn/tool boundary.
            const cancelSignal = context.getCancellationSignal?.(record.id);
            response = await activeRoute.provider.chat({
              model: activeRoute.modelId,
              messages: conversation.getMessagesForLLM(),
              tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
              systemPrompt: appendGoodVibesRuntimeAwarenessPrompt(composeTurnSystemPrompt(systemPrompt)),
              ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
              ...(cancelSignal ? { signal: cancelSignal } : {}),
              onDelta,
            });
            break;
          } catch (chatErr) {
            if (
              !contextRetried &&
              (context.featureFlagManager?.isEnabled('agent-context-window-awareness') ?? true) &&
              await isContextSizeExceededError(chatErr, 'agents.orchestrator-runner.context-exceeded')
            ) {
              contextRetried = true;
              // Learn the endpoint's real ceiling from the rejection so every
              // consumer's window math stops trusting an over-stated catalog.
              context.providerRegistry.recordContextWindowRejection(
                `${activeRoute.provider.name}:${activeRoute.modelId}`,
                estimateConversationTokens(conversation.getMessagesForLLM()),
              );
              logger.warn(
                `[AgentOrchestrator] context-window awareness: context size exceeded on turn ${turn} - emergency compaction and retry`,
                { agentId: record.id, error: chatErr instanceof Error ? chatErr.message : String(chatErr) },
              );
              setAgentProgress(record, `Turn ${turn} · Context exceeded, compacting…`, 'operator');
              context.emitAgentProgress(record.id, record.progress ?? '', 'operator');
              const currentMessages = conversation.getMessagesForLLM();
              const compacted = compactSmallWindow(
                currentMessages,
                Math.max(5, Math.floor(currentMessages.length / 3)),
              );
              conversation.replaceMessagesForLLM(compacted);
              systemPrompt = buildLayeredOrchestratorSystemPrompt(record, 0, context);
            } else if (fallbackRouteIndex < fallbackRoutes.length) {
              const previousRoute = activeRoute;
              activeRoute = fallbackRoutes[fallbackRouteIndex++]!;
              const reason = chatErr instanceof Error ? chatErr.message : String(chatErr);
              const previousRouteId = providerQualifiedRouteLabel(previousRoute);
              const activeRouteId = providerQualifiedRouteLabel(activeRoute);
              logger.warn('[AgentOrchestrator] switching to fallback model', {
                agentId: record.id,
                from: previousRouteId,
                to: activeRouteId,
                reason,
              });
              context.providerOptimizer?.recordFallbackTransition(previousRouteId, activeRouteId, reason);
              record.model = activeRouteId;
              record.provider = activeRoute.provider.name;
              setAgentProgress(record, `Model fallback → ${activeRouteId}`, 'owner'); // their reply, not the machine
              context.emitAgentProgress(record.id, record.progress ?? '', 'owner');
            } else if (networkAttempt < NETWORK_RETRY_DELAYS_MS.length && await isNetworkTransportError(chatErr, 'agents.orchestrator-runner.network-retry')) {
              const delayMs = NETWORK_RETRY_DELAYS_MS[networkAttempt]!;
              const delaySec = Math.round(delayMs / 1000);
              logger.warn(
                `Agent ${record.id}: network error on turn ${turn}, retrying in ${delaySec}s (attempt ${networkAttempt + 1}/${NETWORK_RETRY_DELAYS_MS.length})`,
                { error: chatErr instanceof Error ? chatErr.message : String(chatErr) },
              );
              setAgentProgress(record, `Network error, retrying in ${delaySec}s…`, 'owner'); // owed the reason it is late
              context.emitAgentProgress(record.id, record.progress ?? '', 'owner');
              networkAttempt++;
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, delayMs);
                timer.unref?.();
              });
              if ((record as { status: string }).status === 'cancelled') {
                throw new Error('Agent cancelled during network retry');
              }
            // A spent account matches the quota wording here but never clears by
            // waiting: excluded, it falls to `throw` with its own `billing`
            // category, not "rate limited, retrying in 60s" three times over.
            } else if (
              rateLimitAttempt < RATE_LIMIT_MAX_RETRIES &&
              await isRateLimitOrQuotaError(chatErr, 'agents.orchestrator-runner.rate-limit-retry') &&
              !(await isBillingOrCreditError(chatErr, 'agents.orchestrator-runner.rate-limit-retry'))
            ) {
              const delaySec = Math.round(RATE_LIMIT_RETRY_DELAY_MS / 1000);
              logger.warn(
                `Agent ${record.id}: rate limited on turn ${turn}, retrying in ${delaySec}s (attempt ${rateLimitAttempt + 1}/${RATE_LIMIT_MAX_RETRIES})`,
                { error: chatErr instanceof Error ? chatErr.message : String(chatErr) },
              );
              setAgentProgress(record, `Rate limited, retrying in ${delaySec}s…`, 'owner'); // as the network retry
              context.emitAgentProgress(record.id, record.progress ?? '', 'owner');
              rateLimitAttempt++;
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS);
                timer.unref?.();
              });
              if ((record as { status: string }).status === 'cancelled') {
                throw new Error('Agent cancelled during rate limit retry');
              }
            } else {
              throw chatErr;
            }
          }
        }
        if (response === undefined) {
          throw new Error(`Agent ${record.id}: chat retry loop exceeded ${maxChatRetryIterations} iterations`);
        }
        record.streamingContent = undefined;
        setAgentProgress(record, `Turn ${turn} · Thinking…`, 'operator');
      }

      // Honest "consumed at boundary" signal, emitted here (not at drain time
      // above) because this is the first point in the turn where the chat
      // call is KNOWN to have succeeded. If the call above exhausted its
      // retries/fallbacks, it throws and unwinds out of this function (caught
      // by the outer try/catch → handleAgentRunFailure) without ever reaching
      // this line, so a steer drained into a turn whose chat then fails
      // never gets a consumed signal it didn't earn. Never emit this from
      // AgentMessageBus.send() itself, that fires eagerly, before the agent
      // has any chance to see the message.
      if (context.runtimeBus) {
        for (const messageId of drainedSteerMessageIds) {
          emitCommunicationConsumed(context.runtimeBus, context.emitterContext(record.id), {
            messageId,
            agentId: record.id,
            turn,
          });
        }
      }

      session.appendMessage({ type: 'llm_response', turn, contentLength: response.content.length, toolCallCount: response.toolCalls.length, usage: response.usage, timestamp: new Date().toISOString() });
      record.usage = {
        inputTokens: (record.usage?.inputTokens ?? 0) + response.usage.inputTokens,
        outputTokens: (record.usage?.outputTokens ?? 0) + response.usage.outputTokens,
        cacheReadTokens: (record.usage?.cacheReadTokens ?? 0) + (response.usage.cacheReadTokens ?? 0),
        cacheWriteTokens: (record.usage?.cacheWriteTokens ?? 0) + (response.usage.cacheWriteTokens ?? 0),
        ...(record.usage?.reasoningTokens !== undefined ? { reasoningTokens: record.usage.reasoningTokens } : {}),
        llmCallCount: (record.usage?.llmCallCount ?? 0) + 1,
        turnCount: (record.usage?.turnCount ?? 0) + 1,
        reasoningSummaryCount: (record.usage?.reasoningSummaryCount ?? 0) + (response.reasoningSummary ? 1 : 0),
      };

      maybeCompactAfterModelContextWarning({
        response, conversation, record, turn,
        contextWindowAwarenessEnabled: context.featureFlagManager?.isEnabled('agent-context-window-awareness') ?? true,
        emitProgress: (progress) => {
          context.emitAgentProgress(record.id, progress, 'operator');
        },
      });

      if (response.toolCalls.length > 0) {
        conversation.addAssistantMessage(response.content, { toolCalls: response.toolCalls, usage: response.usage });
        const results = await executeToolCalls(
          response.toolCalls,
          toolRegistry,
          session,
          turn,
          record,
          callHistory,
          CALL_HISTORY_WINDOW,
          context,
        );
        conversation.addToolResults(results);
        reportContractTurnEnd(context, record, turn, response, results);
        // Per-model edit-failure + exec-expectation-miss telemetry (measurement only).
        toolFormatTelemetry.observeToolResults(activeRoute.modelId, response.toolCalls, results);

        const allFailed = results.length > 0 && results.every(r => r.success === false);
        if (allFailed) {
          const cbResult = circuitBreaker.recordAllFailed();
          logger.warn(`Agent ${record.id}: consecutive all-error turn ${circuitBreaker.consecutiveErrors}`);
          if (cbResult === 'break') {
            conversation.addSystemMessage(
              `CIRCUIT BREAKER: You have made ${circuitBreaker.consecutiveErrors} consecutive turns where ALL tool calls failed. ` +
              `The agent loop is stopping to prevent an infinite failure cycle. ` +
              `Report what you were trying to do and what errors you encountered.`,
            );
            record.status = 'failed';
            record.error = `Circuit breaker tripped after ${circuitBreaker.consecutiveErrors} consecutive all-error turns`;
            record.failureReason = CIRCUIT_BREAKER_TRIPPED;
            continueLoop = false;
          } else if (cbResult === 'warn') {
            conversation.addSystemMessage(
              `You have made ${circuitBreaker.consecutiveErrors} consecutive tool calls that ALL failed. ` +
              `Stop attempting the same approach. Describe what you're trying to do and what's going wrong, ` +
              `then try a completely different strategy.`,
            );
          }
        } else if (results.length > 0) {
          circuitBreaker.recordSuccess();
        }

        const sigCounts = new Map<string, { count: number; toolName: string }>();
        for (const sig of callHistory) {
          const name = sig.slice(0, sig.indexOf('::'));
          const entry = sigCounts.get(sig);
          if (entry) {
            entry.count++;
          } else {
            sigCounts.set(sig, { count: 1, toolName: name });
          }
        }
        let worstCount = 0;
        let worstTool = '';
        for (const [_sig, { count, toolName }] of sigCounts) {
          if (count > worstCount) {
            worstCount = count;
            worstTool = toolName;
          }
        }
        if (worstCount >= LOOP_USER_THRESHOLD) {
          logger.warn(`Agent ${record.id}: loop detected, ${worstTool} called ${worstCount} times with identical args`);
          conversation.addUserMessage(
            `You are repeating the same tool call. ${worstTool} has been called ${worstCount} times with identical arguments and results. Do NOT call ${worstTool} with these arguments again. Identify what you were trying to accomplish and take a different action.`,
          );
        } else if (worstCount >= LOOP_SYSTEM_THRESHOLD) {
          logger.warn(`Agent ${record.id}: possible loop, ${worstTool} called ${worstCount} times with identical args`);
          conversation.addSystemMessage(
            `You have already executed this exact call (${worstTool}) ${worstCount} times with identical arguments. The results from your previous calls are already in your conversation history. Review them and proceed to the next step.`,
          );
        }
        setAgentProgress(record, `Turn ${turn} · Thinking…`, 'operator');
      } else {
        continueLoop = completeOrRegenerate(record, conversation, response);
        if (!continueLoop) {
          continueLoop = await holdContractCompletion(context, record, conversation, turn, heldNudgeIdsAwaitingTurn);
        }
      }
    }

    await finalizeAgentRun(context, record, session, preAgentProcessIds);
  } catch (err) {
    await handleAgentRunFailure(context, record, conversation, session, preAgentProcessIds, err);
  } finally {
    // Conversation-snapshot bridge (Part C6): release on EVERY exit path (normal completion,
    // the mid-loop cancellation/MAX_TURNS early returns above, and the catch
    // above) so the live source is never retained past the run and a final
    // snapshot always lands in AgentManager's retention ring. A no-op when
    // register was never called (e.g. failure before the ConversationManager
    // was created).
    context.releaseConversationSource?.(record.id);
  }
}
