import { publishTurnTerminal } from './turn-cancellation.js';
import type { ConversationManager } from './conversation.js';
import type { ConfigManager } from '../config/manager.js';
import type { ContentPart, LLMProvider } from '../providers/interface.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { classifyIntent, type ClassificationResult } from './intent-classifier.js';
import { logger } from '../utils/logger.js';
import { PlannerJudgmentError, type AdaptivePlanner } from './adaptive-planner.js';
import type { ExecutionPlan, PlanItem } from './execution-plan.js';
import type { ExecutionPlanManager } from './execution-plan.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { emitCommunicationConsumed, emitPlanStrategySelected, emitToolReconciled, emitTurnCompleted } from '../runtime/emitters/index.js';
import { buildSyntheticResult } from './tool-reconciliation.js';
import { autoSpawnPendingItems } from './orchestrator-tool-runtime.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import type { AgentManager, AgentRecord } from '../tools/agent/index.js';
import type { ContractSessionHooks } from '../contract/agent-hooks.js';
import { toolResultStartedContract } from '../contract/intake-route.js';

type EmitterContextFactory = (turnId: string) => import('../runtime/emitters/index.js').EmitterContext;
export type ChatResponseWithReasoning = Awaited<ReturnType<LLMProvider['chat']>> & {
  reasoning?: string | undefined;
  reasoningSummary?: string | undefined;
};

export async function maybeEmitAdaptivePlannerDecision(
  text: string,
  flagEnabled: boolean,
  adaptivePlanner: Pick<AdaptivePlanner, 'select'> | null,
  runtimeBus: RuntimeEventBus | null,
  emitterContext: EmitterContextFactory,
  turnId: string,
  classification?: ClassificationResult,
  signal?: AbortSignal,
): Promise<void> {
  if (!flagEnabled) return;
  if (!adaptivePlanner) return;
  const reading = classification ?? await classifyIntent(text, signal ? { signal } : {});
  signal?.throwIfAborted();
  if (reading.risk.outcome !== 'act') {
    reading.recordAction(`planner held: risk reading ${reading.risk.outcome}`);
    throw new PlannerJudgmentError('unsettled');
  }
  const plannerInputs = {
    riskScore: reading.risk.normalized,
    latencyBudgetMs: Infinity,
    isMultiStep: reading.intent === 'project' && reading.outcome === 'act',
    remoteAvailable: false,
    backgroundEligible: false,
    taskDescription: text,
  };
  const decision = await adaptivePlanner.select(plannerInputs, signal ? { signal } : {});
  reading.recordAction(`planner selected ${decision.selected}`);
  if (runtimeBus) {
    emitPlanStrategySelected(runtimeBus, emitterContext(turnId), decision);
  }
  logger.debug('[Orchestrator] adaptive-planner decision', {
    strategy: decision.selected,
    reasonCode: decision.reasonCode,
  });
}

export interface TurnPreparationOptions {
  readonly signal?: AbortSignal;
  /** Capture the transcript boundary before awaiting a reading or cancellation. */
  readonly onMessageAdded?: () => void;
  /** Contract intake must decide who plans before a conversational plan instruction is injected. */
  readonly deferPlanPriming?: boolean;
  /** Reuses the turn's reading for planner telemetry without another request. */
  readonly onClassification?: (reading: ClassificationResult) => Promise<void>;
}

export async function prepareConversationForTurn(
  conversation: ConversationManager,
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'>,
  text: string,
  content: ContentPart[] | undefined,
  sessionId?: string,
  planManager: Pick<ExecutionPlanManager, 'getActive' | 'toMarkdown'> | null = null,
  options: TurnPreparationOptions = {},
): Promise<ExecutionPlan | null> {
  const preTurnPlan = planManager?.getActive(sessionId) ?? null;
  if (preTurnPlan && planManager) {
    const planMd = planManager.toMarkdown(preTurnPlan);
    conversation.addSystemMessage(
      `## Current Execution Plan\n${planMd}\n\nRefer to this plan. Update item statuses as you complete work.`
    );
  }

  if (content && content.some(p => p.type === 'image')) {
    const model = providerRegistry.getCurrentModel();
    if (!model.capabilities.multimodal) {
      conversation.addSystemMessage(
        `Warning: ${model.displayName} does not support image input. Images have been removed from this message.`
      );
      const textOnly = content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map(p => p.text)
        .join('');
      conversation.addUserMessage(textOnly || text);
    } else {
      conversation.addUserMessage(content);
    }
  } else {
    conversation.addUserMessage(content ?? text);
  }

  options.onMessageAdded?.();
  // The submitted message is retained even if judgment fails or is cancelled.
  const classification = await classifyIntent(text, options.signal ? { signal: options.signal } : {});
  options.signal?.throwIfAborted();
  await options.onClassification?.(classification);
  options.signal?.throwIfAborted();
  if (options.deferPlanPriming) classification.recordAction('plan priming deferred until contract intake');
  else primeConversationForTurn(conversation, classification, planManager?.getActive(sessionId) ?? null);

  return preTurnPlan;
}

/** Apply only after contract intake leaves this as an ordinary conversational turn. */
export function primeConversationForTurn(conversation: ConversationManager, classification: ClassificationResult, activePlan: ExecutionPlan | null): void {
  if (!activePlan && classification.needsPlan.verdict === 'yes' && classification.needsPlan.outcome === 'act') {
    classification.recordAction('inject specification and execution-plan instruction');
    conversation.addSystemMessage(
      '[Project mode] This request warrants a specification and execution plan. ' +
      'Before executing, write a brief spec (goals, constraints, non-goals) ' +
      'and an execution plan (phases and tasks). ' +
      'Use the execution plan format: ## Phase [STATUS] / - [x] Task - STATUS.'
    );
  } else {
    classification.recordAction(activePlan ? 'use the existing execution plan' : `no automatic plan priming: ${classification.needsPlan.verdict} (${classification.needsPlan.outcome})`);
  }

}

export type { ContractSessionHooks };

/** Binds this turn to the session-mode unit waiting in the session, when there is one. */
export function bindContractSession(hooks: ContractSessionHooks | undefined, sessionId: string, turnId: string): ContractSessionTurn | undefined {
  const record = hooks?.sessionTurn(sessionId, turnId) ?? null;
  return hooks === undefined || record === null ? undefined : { hooks, record, turn: 0 };
}

/**
 * A session-mode contract's unit bound to this turn (contract runner design
 * 6.6): the turn is the unit's executor. Its tool turns are reported to the
 * runner, and where the turn would complete it is held for the unit's check;
 * a nudge comes back as a user message and the turn goes on.
 */
export interface ContractSessionTurn {
  readonly hooks: ContractSessionHooks;
  /** The turn's stand-in record: `id` is the turn id, and it carries the unit binding. */
  readonly record: AgentRecord;
  /** Tool rounds reported so far this turn. */
  turn: number;
}

type ConsumedEmitterArgs = { readonly runtimeBus: RuntimeEventBus | null; readonly emitterContext: EmitterContextFactory; readonly turnId: string };

function nudgeConsumed(args: ConsumedEmitterArgs, session: ContractSessionTurn, nudgeId: string): void {
  if (!args.runtimeBus) return;
  emitCommunicationConsumed(args.runtimeBus, args.emitterContext(args.turnId), { messageId: nudgeId, agentId: session.record.id, turn: session.turn });
}

/** Reports a tool round of a session-mode turn to the contract runner; a hook fault is logged, never thrown into the turn. */
export function reportSessionToolRound(session: ContractSessionTurn, round: { readonly toolCalls: readonly ToolCall[]; readonly results: readonly ToolResult[]; readonly assistantText: string }): void {
  session.turn += 1;
  try {
    session.hooks.onTurnEnd(session.record, {
      turn: session.turn,
      toolCalls: round.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments as Record<string, unknown> })),
      results: round.results,
      assistantText: round.assistantText,
    });
  } catch (error) {
    logger.warn('Orchestrator: the contract turn-end hook failed', { turnId: session.record.id, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Adds the mid-run nudges the runner queued for this session turn, as user messages, before the next model call. */
export function drainSessionNudges(args: ConsumedEmitterArgs & { readonly conversation: ConversationManager }, session: ContractSessionTurn): void {
  for (let nudge = session.hooks.takeSessionNudge(session.record); nudge !== null; nudge = session.hooks.takeSessionNudge(session.record)) {
    args.conversation.addUserMessage(nudge.message);
    nudgeConsumed(args, session, nudge.nudgeId);
  }
}

/**
 * Holds a session-mode turn where it would complete, while the runner checks
 * the unit. On a nudge, `beforeNudge` runs (the final answer joins the
 * conversation), the nudge is added as a user message, and true is returned:
 * the turn goes on with another model call. False lets the turn complete.
 */
export async function holdSessionCompletion(
  args: ConsumedEmitterArgs & { readonly conversation: ConversationManager },
  session: ContractSessionTurn,
  output: string,
  beforeNudge?: () => void,
): Promise<boolean> {
  session.record.fullOutput = output;
  const outcome = await session.hooks.holdCompletion(session.record);
  if (outcome.kind !== 'continue') return false;
  beforeNudge?.();
  args.conversation.addUserMessage(outcome.message);
  nudgeConsumed(args, session, outcome.nudgeId);
  return true;
}

/** The final-answer hold: on a nudge the answer joins the conversation before the nudge, and the turn goes on. */
export function holdSessionFinalResponse(
  args: ConsumedEmitterArgs & { readonly conversation: ConversationManager; readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'> },
  session: ContractSessionTurn,
  response: ChatResponseWithReasoning,
): Promise<boolean> {
  return holdSessionCompletion(args, session, response.content, () => args.conversation.addAssistantMessage(response.content, {
    reasoningContent: response.reasoning || undefined,
    reasoningSummary: response.reasoningSummary || undefined,
    usage: response.usage,
    model: args.providerRegistry.getCurrentModel().displayName,
    provider: args.providerRegistry.getCurrentModel().provider,
  }));
}

/** Said to the conversation model after its agent tool call started a contract. */
const CONTRACT_STARTED_NOTE = 'A contract now owns this work: its units are checked against the acceptance criteria while they work, and its answer arrives when every criterion is met. Do not start other agents for the same work; read the contract with the agent tool\'s contracts mode instead.';

function attachAuthoritativeTaskToAgentCalls(toolCalls: readonly ToolCall[], userText: string): ToolCall[] {
  const authoritativeTask = userText.trim();
  if (!authoritativeTask) return [...toolCalls];
  return toolCalls.map((call) => {
    if (call.name !== 'agent') return call;
    const args = call.arguments as Record<string, unknown>;
    const mode = args.mode;
    if (mode !== 'spawn' && mode !== 'batch-spawn') return call;
    if (typeof args.parentAgentId === 'string' && args.parentAgentId.trim().length > 0) return call;
    return {
      ...call,
      arguments: {
        ...args,
        authoritativeTask,
      },
    };
  });
}

export async function handleToolResponseOutcome(args: {
  onTurnTerminal?: ((publish: () => void) => void) | undefined;
  conversation: ConversationManager;
  agentManager: Pick<AgentManager, 'list' | 'spawn'>;
  planManager: Pick<ExecutionPlanManager, 'getActive' | 'getSummary' | 'getNextItems' | 'updateItem'> | null;
  configManager: Pick<ConfigManager, 'get'>;
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'>;
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  turnId: string;
  response: ChatResponseWithReasoning;
  userText: string;
  executeToolCalls: (turnId: string, calls: ToolCall[]) => Promise<ToolResult[]>;
  setPendingToolCalls: (calls: ToolCall[]) => void;
  messageQueueLength: number;
  requestRender: () => void;
  sessionId?: string | undefined;
  /** This turn's MEMORY-sourced injected knowledge ids, stamped onto TURN_COMPLETED as metadata.memory.recordIds when non-empty (absent otherwise). */
  memoryRecordIds?: readonly string[] | undefined;
  /** The session-mode contract unit this turn works on, when there is one. */
  contractSession?: ContractSessionTurn | undefined;
}): Promise<{ continueLoop: boolean; results: ToolResult[] }> {
  const toolCalls = attachAuthoritativeTaskToAgentCalls(args.response.toolCalls, args.userText);
  args.setPendingToolCalls(toolCalls);
  args.conversation.addAssistantMessage(args.response.content, {
    toolCalls,
    reasoningContent: args.response.reasoning || undefined,
    reasoningSummary: args.response.reasoningSummary || undefined,
    usage: args.response.usage,
    model: args.providerRegistry.getCurrentModel().displayName,
    provider: args.providerRegistry.getCurrentModel().provider,
  });

  const results = await args.executeToolCalls(args.turnId, toolCalls);
  args.conversation.addToolResults(results);
  args.setPendingToolCalls([]);
  if (args.contractSession) reportSessionToolRound(args.contractSession, { toolCalls, results, assistantText: args.response.content });

  const allImages = (results as Array<ToolResult & { _images?: Array<{ path: string; base64: string; mediaType: string; description: string }> }>)
    .filter(r => Array.isArray(r._images) && r._images.length > 0)
    .flatMap(r => r._images!);
  if (allImages.length > 0 && args.providerRegistry.getCurrentModel().capabilities.multimodal) {
    const imageParts: ContentPart[] = [
      { type: 'text', text: '[Images from read tool results]' },
      ...allImages.map(img => ({ type: 'image' as const, data: img.base64, mediaType: img.mediaType })),
    ];
    args.conversation.addUserMessage(imageParts);
  }

  const spawnedAgents = toolCalls.some((tc: ToolCall) => {
    const mode = (tc.arguments as Record<string, unknown>).mode;
    return tc.name === 'agent' && (mode === 'spawn' || mode === 'batch-spawn');
  });
  const startedContract = spawnedAgents && results.some(toolResultStartedContract);

  if (spawnedAgents || args.messageQueueLength > 0) {
    if (spawnedAgents) {
      const planManager = args.planManager;
      const activePlan = planManager?.getActive(args.sessionId) ?? null;
      if (activePlan) {
        const summary = planManager?.getSummary(activePlan) ?? '';
        if (startedContract) {
          args.conversation.addSystemMessage(`${CONTRACT_STARTED_NOTE} Plan progress: ${summary}.`);
        } else {
          const nextItems = planManager?.getNextItems(activePlan) ?? [];
          if (nextItems.length > 0) {
            const autoSpawnedDescs = autoSpawnPendingItems(
              args.conversation,
              activePlan,
              nextItems,
              args.agentManager,
              args.configManager,
              args.providerRegistry,
              args.runtimeBus,
              args.emitterContext(args.turnId),
              planManager,
            );
            if (autoSpawnedDescs.length > 0) {
              args.conversation.addSystemMessage(
                `[Plan] Auto-spawned ${autoSpawnedDescs.length} agent(s) for remaining plan items: ${autoSpawnedDescs.join(', ')}. Plan progress: ${summary}.`
              );
            } else {
              const nextDesc = nextItems.map(i => i.description).join(', ');
              args.conversation.addSystemMessage(
                `Plan progress: ${summary}. Next items ready: ${nextDesc}. Continue spawning agents for remaining work.`
              );
            }
          } else {
            args.conversation.addSystemMessage(`Plan progress: ${summary}. All items are accounted for.`);
          }
        }
      } else {
        if (startedContract) {
          args.conversation.addSystemMessage(CONTRACT_STARTED_NOTE);
        } else {
          args.conversation.addSystemMessage(
            'You spawned an agent for part of the task. If there are remaining tasks, continue spawning agents now.'
          );
        }
      }
    }
    // A session-mode unit's turn is held where it would complete, like a sub-agent (contract runner design 6.6).
    if (args.contractSession && await holdSessionCompletion(args, args.contractSession, args.response.content)) {
      return { continueLoop: true, results };
    }
    if (args.runtimeBus) {
      publishTurnTerminal(() => emitTurnCompleted(args.runtimeBus!, args.emitterContext(args.turnId), {
        turnId: args.turnId,
        response: args.response.content,
        stopReason: args.response.content.trim().length > 0 ? 'completed' : 'empty_response',
        memoryRecordIds: args.memoryRecordIds,
      }), args.onTurnTerminal);
    }
    return { continueLoop: false, results };
  }

  if (args.planManager?.getActive(args.sessionId)) {
    args.conversation.addSystemMessage(
      'Update the execution plan to reflect completed work. Mark items as COMPLETE or IN_PROGRESS with the agent ID.'
    );
  }
  if (args.contractSession) drainSessionNudges(args, args.contractSession);

  return { continueLoop: true, results };
}

export function handleFinalResponseOutcome(args: {
  onTurnTerminal?: ((publish: () => void) => void) | undefined;
  conversation: ConversationManager;
  agentManager: Pick<AgentManager, 'list' | 'spawn'>;
  planManager: Pick<ExecutionPlanManager, 'parseFromMarkdown' | 'replaceItems' | 'load' | 'save' | 'getActive' | 'getNextItems' | 'updateItem'> | null;
  configManager: Pick<ConfigManager, 'get'>;
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'>;
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  turnId: string;
  response: ChatResponseWithReasoning;
  preTurnPlan: ExecutionPlan | null;
  requestRender: () => void;
  setAutoSpawnTimeout: (timeout: ReturnType<typeof setTimeout> | null) => void;
  autoSpawnTimeoutMs: number;
  sessionId?: string | undefined;
  /** This turn's MEMORY-sourced injected knowledge ids, stamped onto TURN_COMPLETED as metadata.memory.recordIds when non-empty (absent otherwise). */
  memoryRecordIds?: readonly string[] | undefined;
}): false {
  args.conversation.addAssistantMessage(args.response.content, {
    reasoningContent: args.response.reasoning || undefined,
    reasoningSummary: args.response.reasoningSummary || undefined,
    usage: args.response.usage,
    model: args.providerRegistry.getCurrentModel().displayName,
    provider: args.providerRegistry.getCurrentModel().provider,
  });
  if (args.runtimeBus) {
    publishTurnTerminal(() => emitTurnCompleted(args.runtimeBus!, args.emitterContext(args.turnId), {
      turnId: args.turnId,
      response: args.response.content,
      stopReason: args.response.content.trim().length > 0 ? 'completed' : 'empty_response',
      memoryRecordIds: args.memoryRecordIds,
    }), args.onTurnTerminal);
  }

  const planManager = args.planManager;
  if (args.preTurnPlan && args.preTurnPlan.awaitingPlan === true && args.response.content.includes('## Phase') && planManager) {
    const parsed = planManager.parseFromMarkdown(args.response.content);
    if (parsed.items && parsed.items.length > 0) {
      planManager.replaceItems(args.preTurnPlan.id, parsed.items);
      const filledPlan = planManager.load(args.preTurnPlan.id);
      if (filledPlan) {
        filledPlan.awaitingPlan = false;
        planManager.save(filledPlan);
      }
      if (parsed.parseIssues?.length) {
        args.conversation.addSystemMessage(
          `[Plan] Parsed ${parsed.items.length} item(s) with ${parsed.parseIssues.length} formatting warning(s); unrecognized item statuses were marked pending.`
        );
      }
      const updatedPlan = planManager.getActive(args.sessionId);
      if (updatedPlan) {
        const nextItems = planManager.getNextItems(updatedPlan);
        if (nextItems.length > 0) {
          const spawned = autoSpawnPendingItems(
            args.conversation,
            updatedPlan,
            nextItems,
            args.agentManager,
            args.configManager,
            args.providerRegistry,
            args.runtimeBus,
            args.emitterContext(args.turnId),
            planManager,
          );
          if (spawned.length > 0) {
            args.conversation.addSystemMessage(
              `[Plan] Parsed ${parsed.items.length} item(s) from your plan. Auto-spawned ${spawned.length} agent(s) for items with no blockers: ${spawned.join(', ')}.`
            );
            args.requestRender();
          } else {
            args.conversation.addSystemMessage(
              `[Plan] Parsed ${parsed.items.length} item(s) from your plan. Spawn agents for the items with no blockers to begin execution.`
            );
          }
        } else {
          args.conversation.addSystemMessage(
            `[Plan] Parsed ${parsed.items.length} item(s) from your plan. No items are ready to start - check dependencies.`
          );
        }
        return false;
      }
    }
  }

  const pendingPlan = planManager?.getActive(args.sessionId) ?? null;
  if (pendingPlan) {
    const pendingItems = planManager?.getNextItems(pendingPlan) ?? [];
    if (pendingItems.length > 0) {
      const timeout = setTimeout(() => {
        args.setAutoSpawnTimeout(null);
        const stillActivePlan = planManager?.getActive(args.sessionId) ?? null;
        if (!stillActivePlan) return;
        const stillPending = planManager?.getNextItems(stillActivePlan) ?? [];
        if (stillPending.length === 0) return;

        const spawned = autoSpawnPendingItems(
          args.conversation,
          stillActivePlan,
          stillPending,
          args.agentManager,
          args.configManager,
          args.providerRegistry,
          args.runtimeBus,
          args.emitterContext(args.turnId),
          planManager,
        );
        if (spawned.length > 0) {
          args.conversation.addSystemMessage(
            `[Plan] Timeout fallback auto-spawned ${spawned.length} agent(s) for plan items the model did not address: ${spawned.join(', ')}.`
          );
          args.requestRender();
        }
      }, args.autoSpawnTimeoutMs);
      timeout.unref?.();
      args.setAutoSpawnTimeout(timeout);
    }
  }

  return false;
}

export function emitMalformedToolUseWarning(args: {
  conversation: ConversationManager;
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'>;
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  turnId: string;
  isReconciliationEnabled: boolean;
}): void {
  logger.warn('Orchestrator: provider reported stopReason=tool_use but returned no tool calls (malformed response)', {
    model: args.providerRegistry.getCurrentModel().registryKey,
    stopReason: 'tool_call',
  });
  if (args.isReconciliationEnabled) {
    args.conversation.addSystemMessage(
      '[Tool Reconciliation] Provider returned stop_reason=tool_use but no tool calls were included in the response. ' +
      'This is a malformed provider response. If this repeats, try switching models.',
    );
    if (args.runtimeBus) {
      emitToolReconciled(args.runtimeBus, args.emitterContext(args.turnId), {
        turnId: args.turnId,
        count: 0,
        callIds: [],
        toolNames: [],
        reason: 'malformed-stop-reason',
        isMalformed: true,
        timestamp: Date.now(),
      });
    }
  }
}
