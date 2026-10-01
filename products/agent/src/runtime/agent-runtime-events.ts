import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConversationFollowUpItem } from '@goodvibes-jev/engine/sdk/platform/core';
import type { AgentManager, ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import type {
  AgentEvent,
  CompactionEvent,
  PermissionEvent,
  ProviderEvent,
  RuntimeEventBus,
} from '@/runtime/index.ts';
import type { createDomainDispatch } from './store/index.ts';

const AGENT_STATUS_INTERVAL_MS = 30_000;

export interface AgentRuntimeMessageRouter {
  low(message: string): void;
  high(message: string): void;
}

export interface AgentRuntimeEventBridgeOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly domainDispatch: ReturnType<typeof createDomainDispatch>;
  readonly getSystemMessageRouter: () => AgentRuntimeMessageRouter | null;
  readonly queueConversationFollowUp?: (item: ConversationFollowUpItem) => void;
  readonly requestRender: () => void;
  readonly configManager: ConfigManager;
  readonly agentManager: AgentManager;
  readonly toolRegistry: Pick<ToolRegistry, 'execute'>;
}

function withRouter(
  getSystemMessageRouter: () => AgentRuntimeMessageRouter | null,
  action: (router: AgentRuntimeMessageRouter) => void,
): void {
  const router = getSystemMessageRouter();
  if (router) action(router);
}

function formatAgentTask(task: string): string {
  return task.length > 50 ? `${task.slice(0, 50)}...` : task;
}

/** Renders a COMPACTION_RECEIPT payload as a one-line honest summary: strategy, trigger, and outcome, with the fallback reason (`detail`) named when the compaction did not apply. */
function formatCompactionReceipt(payload: Extract<CompactionEvent, { type: 'COMPACTION_RECEIPT' }>): string {
  const { strategy, trigger, outcome, tokensBefore, tokensAfter, detail } = payload;
  if (outcome === 'applied') {
    const saved = Math.max(0, tokensBefore - tokensAfter);
    return `${strategy} (${trigger}) applied, ${saved.toLocaleString()} tokens reclaimed`;
  }
  const reason = detail ? `: ${detail}` : '';
  return `${strategy} (${trigger}) ${outcome}${reason}`;
}

interface ChildFailureEnvelopeLike {
  readonly phase?: string;
  readonly reason?: { readonly code?: string };
  readonly partialOutputs?: { readonly note?: string; readonly turnsCompleted?: number };
}

/**
 * Fetches the structured child-failure envelope the SDK's own `agent` tool
 * attaches to its `status` action result (SDK 1.6.1, child-failure
 * envelopes on the agent tool's status/get/wait results) and renders it as a
 * compact suffix: `reason: <code>, phase: <phase>[, N turns completed][, note]`.
 * Goes through `toolRegistry.execute`, the SAME tool the model calls,
 * rather than re-deriving the classification locally: `classifyChildFailureReason`
 * and `describeChildPhase` are internal to the SDK's tool module, not part of
 * its public API, so calling the tool is the only faithful way to surface
 * the real classification instead of guessing at it. Read-only, no side
 * effects (see ToolRegistry.execute's own doc comment); returns null on any
 * failure to look up the record or parse the result, so a fetch problem never
 * blocks the (already-informative) base failure message.
 */
async function fetchChildFailureSummary(toolRegistry: Pick<ToolRegistry, 'execute'>, agentId: string): Promise<string | null> {
  try {
    const result = await toolRegistry.execute('agent-runtime-events:child-failure-envelope', 'agent', { mode: 'status', agentId });
    if (!result.success || !result.output) return null;
    const parsed = JSON.parse(result.output) as { failure?: ChildFailureEnvelopeLike };
    const failure = parsed.failure;
    if (!failure) return null;
    const parts = [`reason: ${failure.reason?.code ?? 'error'}`];
    if (failure.phase) parts.push(`phase: ${failure.phase}`);
    if (failure.partialOutputs?.turnsCompleted !== undefined) parts.push(`${failure.partialOutputs.turnsCompleted} turns completed`);
    if (failure.partialOutputs?.note) parts.push(failure.partialOutputs.note);
    return parts.join(', ');
  } catch (err) {
    logger.debug('agent-runtime-events: child-failure envelope fetch failed (non-fatal)', { agentId, error: String(err) });
    return null;
  }
}

export function registerAgentRuntimeEvents(options: AgentRuntimeEventBridgeOptions): {
  unsubs: Array<() => void>;
  agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null };
} {
  const {
    runtimeBus,
    domainDispatch,
    getSystemMessageRouter,
    queueConversationFollowUp,
    requestRender,
    agentManager,
    toolRegistry,
  } = options;
  const unsubs: Array<() => void> = [];

  unsubs.push(runtimeBus.onDomain('turn', (env) => {
    domainDispatch.dispatchTurnEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('agents', (env) => {
    domainDispatch.dispatchAgentEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('orchestration', (env) => {
    domainDispatch.dispatchOrchestrationEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('communication', (env) => {
    domainDispatch.dispatchCommunicationEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('compaction', (env) => {
    domainDispatch.dispatchCompactionEvent(env.payload);
  }));
  // The mandatory post-compaction receipt (SDK 1.6.1, emitted after every
  // automatic and manual compaction path, see the SDK's own doc comment on
  // emitCompactionReceipt) is the one compaction signal a user should never
  // miss: system-message-router.ts's own tiering doc already names
  // "compaction events" as 'high' priority (conversation + activity feed),
  // but nothing routed COMPACTION_RECEIPT there before this, the domain
  // subscription above only ever updated runtime-store session state, not a
  // user-visible message. Surfaces strategy + outcome; when the compaction
  // did not apply (kept-original/failed), `detail` carries the fallback
  // reason so a silent revert is never actually silent.
  unsubs.push(runtimeBus.on<Extract<CompactionEvent, { type: 'COMPACTION_RECEIPT' }>>('COMPACTION_RECEIPT', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      router.high(`[Compaction] ${formatCompactionReceipt(payload)}`);
    });
    requestRender();
  }));
  unsubs.push(runtimeBus.onDomain('transport', (env) => {
    domainDispatch.dispatchTransportEvent(env.payload);
  }));
  // Keep the session's stored permission-mode metadata live. The SDK emits
  // PERMISSION_MODE_CHANGED on the 'permissions' domain whenever the
  // permissions.mode config value changes (see emitPermissionModeChanged), but
  // nothing consumed it before: the runtime store's permission domain was seeded
  // once at boot and never advanced, so any surface reading the stored mode went
  // stale until restart. Forwarding the domain event into the store reducer
  // (dispatchPermissionEvent -> updatePermissionState) refreshes that stored
  // metadata live from the wire event, and re-emitting it onto a remote surface's
  // bus keeps cross-surface readers current too.
  unsubs.push(runtimeBus.onDomain('permissions', (env) => {
    domainDispatch.dispatchPermissionEvent(env.payload);
  }));
  // Make the mode change visible in-session the moment it lands, rather than
  // only reflecting it the next time a surface happens to rebuild. The precise
  // previous/next mode values ride the event, so the message states both.
  unsubs.push(runtimeBus.on<Extract<PermissionEvent, { type: 'PERMISSION_MODE_CHANGED' }>>('PERMISSION_MODE_CHANGED', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      router.high(`[Permissions] Permission mode changed: ${payload.previousMode} -> ${payload.mode}.`);
    });
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<ProviderEvent, { type: 'MODEL_FALLBACK' }>>('MODEL_FALLBACK', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      router.high(`[Model] ${payload.from} exhausted across all providers. Automatically falling back to ${payload.to} via ${payload.provider}.`);
    });
    requestRender();
  }));
  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_STREAM_DELTA' }>>('AGENT_STREAM_DELTA', () => {
    requestRender();
  }));
  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_PROGRESS' }>>('AGENT_PROGRESS', () => {
    requestRender();
  }));
  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => {
    const record = agentManager.getStatus(payload.agentId);
    if (record) {
      const durationSeconds = record.completedAt !== undefined ? Math.round((record.completedAt - record.startedAt) / 1000) : 0;
      const taskSnippet = formatAgentTask(record.task);
      withRouter(getSystemMessageRouter, (router) => {
        router.low(`[Delegated task] ${record.template} ${payload.agentId.slice(-8)} completed in ${durationSeconds}s "${taskSnippet}"`);
      });
      queueConversationFollowUp?.({
        key: `agent:${payload.agentId}:completed`,
        summary: `${record.template} delegated task ${payload.agentId.slice(-8)} completed "${taskSnippet}" in ${durationSeconds}s after ${record.toolCallCount} tool calls.`,
      });
    }
    requestRender();
  }));
  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', ({ payload }) => {
    const record = agentManager.getStatus(payload.agentId);
    if (record && record.status !== 'cancelled') {
      const durationSeconds = record.completedAt !== undefined ? Math.round((record.completedAt - record.startedAt) / 1000) : 0;
      const taskSnippet = formatAgentTask(record.task);

      // The typed turn-budget-exhaustion outcome (SDK 1.8.0, agents/turn-budget.ts):
      // record.failureReason === 'max_turns' plus record.turnBudget (the applied
      // limit and which input set it, default / spawn-override / policy-bound)
      // are stamped on the record at the source, never derived from regex-matching
      // payload.error. Rendered as an honest budget line, distinct from the
      // generic infrastructure-failure path below, a spent turn budget is an
      // expected, nameable outcome, not an error to root-cause.
      if (record.failureReason === 'max_turns' && record.turnBudget) {
        const { limit, source } = record.turnBudget;
        const sourceLabel = source === 'default'
          ? 'the default agents.maxTurns'
          : source === 'spawn-override'
            ? 'a per-spawn override'
            : 'the agents.maxTurnsCap policy ceiling';
        withRouter(getSystemMessageRouter, (router) => {
          router.low(`[Delegated task] ${record.template} ${payload.agentId.slice(-8)} spent its turn budget in ${durationSeconds}s, ${limit} turns (${sourceLabel}) while working on "${taskSnippet}"`);
        });
        queueConversationFollowUp?.({
          key: `agent:${payload.agentId}:failed`,
          summary: `${record.template} delegated task ${payload.agentId.slice(-8)} spent its ${limit}-turn budget (${sourceLabel}) while working on "${taskSnippet}".`,
        });
        requestRender();
        return;
      }

      // Compact child-failure envelope enrichment (SDK 1.6.1), fetched via
      // the SAME 'agent' tool the model calls, then appended to the base
      // message. Deferred (async) rather than blocking this handler; no test
      // or downstream consumer depends on this message landing synchronously
      // with the AGENT_FAILED event.
      void fetchChildFailureSummary(toolRegistry, payload.agentId).then((envelopeSummary) => {
        withRouter(getSystemMessageRouter, (router) => {
          router.low(`[Delegated task] ${record.template} ${payload.agentId.slice(-8)} failed in ${durationSeconds}s ${payload.error.slice(0, 80)}${envelopeSummary ? ` (${envelopeSummary})` : ''}`);
        });
        requestRender();
      });
      queueConversationFollowUp?.({
        key: `agent:${payload.agentId}:failed`,
        summary: `${record.template} delegated task ${payload.agentId.slice(-8)} failed while working on "${taskSnippet}" ${payload.error.slice(0, 120)}`,
      });
    }
    requestRender();
  }));

  const agentStatusIntervalRef = { value: null as ReturnType<typeof setInterval> | null };
  agentStatusIntervalRef.value = setInterval(() => {
    const running = agentManager.list().filter((agent) => agent.status === 'running');
    if (running.length === 0) return;
    const lines = running.map((agent) => `  ${agent.id.slice(-8)} ${agent.progress ?? agent.status}`);
    withRouter(getSystemMessageRouter, (router) => {
      router.low(`[Delegated task] ${running.length} running\n${lines.join('\n')}`);
    });
    requestRender();
  }, AGENT_STATUS_INTERVAL_MS);
  agentStatusIntervalRef.value.unref?.();

  return { unsubs, agentStatusIntervalRef };
}
